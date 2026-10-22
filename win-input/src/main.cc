#include <napi.h>
#include <windows.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <mutex>
#include <vector>
#include <string>

// ── Recording Globals ────────────────────────────────────────────────────

struct ClickEvent {
    double x, y, elapsed;
};

static std::vector<ClickEvent> g_clicks;
static std::mutex g_clickMutex;
static std::thread g_hookThread;
static DWORD g_hookThreadId = 0;
static HHOOK g_hHook = nullptr;
static std::atomic<bool> g_recording{false};
static double g_recordingStartTime = 0;
static bool g_hasExclude = false;
static RECT g_excludeRect{};
static std::atomic<bool> g_hookFailed{false};

// ── Low-Level Mouse Hook ─────────────────────────────────────────────────

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0 && wParam == WM_LBUTTONDOWN) {
        auto info = reinterpret_cast<MSLLHOOKSTRUCT*>(lParam);

        POINT pt = info->pt;

        if (g_hasExclude &&
            pt.x >= g_excludeRect.left && pt.x <= g_excludeRect.right &&
            pt.y >= g_excludeRect.top && pt.y <= g_excludeRect.bottom) {
            return CallNextHookEx(NULL, nCode, wParam, lParam);
        }

        double now = GetTickCount64() / 1000.0;
        ClickEvent ce{static_cast<double>(pt.x),
                      static_cast<double>(pt.y),
                      now - g_recordingStartTime};
        {
            std::lock_guard<std::mutex> lock(g_clickMutex);
            g_clicks.push_back(ce);
        }
    }
    return CallNextHookEx(NULL, nCode, wParam, lParam);
}

// ── Hook Thread ──────────────────────────────────────────────────────────

static void hookThreadFunc() {
    g_hookThreadId = GetCurrentThreadId();

    HMODULE hMod = GetModuleHandleW(nullptr);
    g_hHook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc, hMod, 0);

    if (!g_hHook) {
        g_recording = false;
        g_hookFailed = true;
        g_hookThreadId = 0;
        return;
    }

    // Message loop — required for low-level mouse hook callbacks
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // Cleanup
    if (g_hHook) {
        UnhookWindowsHookEx(g_hHook);
        g_hHook = nullptr;
    }
    g_hookThreadId = 0;
}

// ── Helper: create error object ──────────────────────────────────────────

static Napi::Value MakeError(Napi::Env env, const char* msg) {
    auto err = Napi::Error::New(env, msg);
    err.ThrowAsJavaScriptException();
    return env.Null();
}

// ── N-API Functions ──────────────────────────────────────────────────────

Napi::Value MouseClick(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    double x = info[0].As<Napi::Number>().DoubleValue();
    double y = info[1].As<Napi::Number>().DoubleValue();

    SetCursorPos(static_cast<int>(x), static_cast<int>(y));

    INPUT inputs[2] = {};
    inputs[0].type = INPUT_MOUSE;
    inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(2, inputs, sizeof(INPUT));

    return Napi::Boolean::New(env, true);
}

Napi::Value MouseGetPosition(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    POINT pt;
    if (!GetCursorPos(&pt)) {
        return MakeError(env, "GetCursorPos failed");
    }
    auto obj = Napi::Object::New(env);
    obj.Set("x", Napi::Number::New(env, static_cast<double>(pt.x)));
    obj.Set("y", Napi::Number::New(env, static_cast<double>(pt.y)));
    return obj;
}

Napi::Value StartRecording(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (g_recording) {
        return MakeError(env, "already recording");
    }

    g_hasExclude = false;
    if (info.Length() >= 1 && info[0].IsArray()) {
        auto arr = info[0].As<Napi::Array>();
        if (arr.Length() == 4) {
            double l = arr.Get(0u).As<Napi::Number>().DoubleValue();
            double t = arr.Get(1u).As<Napi::Number>().DoubleValue();
            double r = arr.Get(2u).As<Napi::Number>().DoubleValue();
            double b = arr.Get(3u).As<Napi::Number>().DoubleValue();
            g_excludeRect.left   = static_cast<LONG>(l);
            g_excludeRect.top    = static_cast<LONG>(t);
            g_excludeRect.right  = static_cast<LONG>(r);
            g_excludeRect.bottom = static_cast<LONG>(b);
            g_hasExclude = true;
        }
    }

    {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        g_clicks.clear();
    }

    g_recording = true;
    g_hookFailed = false;
    g_recordingStartTime = GetTickCount64() / 1000.0;

    g_hookThread = std::thread(hookThreadFunc);
    g_hookThread.detach();

    return Napi::Boolean::New(env, true);
}

Napi::Value StopRecording(const Napi::CallbackInfo& info) {
    if (g_recording) {
        g_recording = false;
    }
    DWORD tid = g_hookThreadId;
    if (tid != 0) {
        PostThreadMessageW(tid, WM_QUIT, 0, 0);
    }
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value GetRecordingClicks(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::lock_guard<std::mutex> lock(g_clickMutex);
    auto arr = Napi::Array::New(env, g_clicks.size());
    for (size_t i = 0; i < g_clicks.size(); i++) {
        auto obj = Napi::Object::New(env);
        obj.Set("x", g_clicks[i].x);
        obj.Set("y", g_clicks[i].y);
        obj.Set("timestamp", g_clicks[i].elapsed);
        arr.Set(static_cast<uint32_t>(i), obj);
    }
    return arr;
}

Napi::Value ClearRecordingClicks(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_clickMutex);
    g_clicks.clear();
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value IsRecording(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_recording.load());
}

Napi::Value TapFailed(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_hookFailed.load());
}

// ── Text input diagnostics ────────────────────────────────────────────────

struct TextSendDiagnostics {
    bool ok = false;
    int utf16Units = 0;
    int packetsAttempted = 0;
    int packetsSent = 0;
    DWORD lastError = 0;
    std::vector<WORD> codeUnits;
};

static std::mutex g_textDiagMutex;
static TextSendDiagnostics g_lastTextSend;

static void StoreTextDiagnostics(const TextSendDiagnostics& diag) {
    std::lock_guard<std::mutex> lock(g_textDiagMutex);
    g_lastTextSend = diag;
}

static bool BuildUtf16Text(const std::string& utf8Text, std::wstring& out) {
    int wideLen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8Text.c_str(), -1, nullptr, 0);
    if (wideLen <= 0) return false;

    std::wstring buffer(static_cast<size_t>(wideLen), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8Text.c_str(), -1, &buffer[0], wideLen) <= 0) {
        return false;
    }
    buffer.pop_back(); // remove terminating NUL
    out = std::move(buffer);
    return true;
}

// Send a single BMP character via WM_CHAR directly to the target window.
// WM_CHAR is the FINAL output of the IME pipeline — by posting it directly
// we bypass any TSF/IMM32 IME interception that corrupts mixed CN/EN/symbol text.
static bool SendWMChar(HWND hwnd, WPARAM ch, TextSendDiagnostics& diag) {
    diag.packetsAttempted += 1;
    LRESULT result = SendMessageW(hwnd, WM_CHAR, ch, 0);
    // SendMessageW returns 0 on success (window processed the message) or
    // an error code; a non-zero return does not necessarily mean failure
    // because the window procedure may return a meaningful value.
    // We treat the send as successful if SendMessageW returned without
    // setting a last error (which is the common case for WM_CHAR).
    DWORD err = GetLastError();
    if (result != 0 && err != 0) {
        diag.lastError = err;
        diag.packetsSent += 0;
        return false;
    }
    diag.packetsSent += 1;
    return true;
}

// Legacy fallback: SendInput with KEYEVENTF_UNICODE.
// Used only when we don't have a foreground window to target with WM_CHAR.
static bool SendUnicodeCodeUnit(WORD codeUnit, TextSendDiagnostics& diag) {
    INPUT pair[2] = {};
    pair[0].type = INPUT_KEYBOARD;
    pair[0].ki.wVk = 0;
    pair[0].ki.wScan = codeUnit;
    pair[0].ki.dwFlags = KEYEVENTF_UNICODE;

    pair[1].type = INPUT_KEYBOARD;
    pair[1].ki.wVk = 0;
    pair[1].ki.wScan = codeUnit;
    pair[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

    diag.packetsAttempted += 2;
    UINT sent = SendInput(2, pair, sizeof(INPUT));
    diag.packetsSent += static_cast<int>(sent);
    if (sent != 2) {
        diag.lastError = GetLastError();
        return false;
    }
    return true;
}

static bool SendShiftEnter(TextSendDiagnostics& diag) {
    INPUT batch[4] = {};
    batch[0].type = INPUT_KEYBOARD;
    batch[0].ki.wVk = VK_SHIFT;
    batch[1].type = INPUT_KEYBOARD;
    batch[1].ki.wVk = VK_RETURN;
    batch[2].type = INPUT_KEYBOARD;
    batch[2].ki.wVk = VK_RETURN;
    batch[2].ki.dwFlags = KEYEVENTF_KEYUP;
    batch[3].type = INPUT_KEYBOARD;
    batch[3].ki.wVk = VK_SHIFT;
    batch[3].ki.dwFlags = KEYEVENTF_KEYUP;

    diag.packetsAttempted += 4;
    UINT sent = SendInput(4, batch, sizeof(INPUT));
    diag.packetsSent += static_cast<int>(sent);
    if (sent != 4) {
        diag.lastError = GetLastError();
        return false;
    }
    return true;
}

// SendText: inject Unicode text that bypasses any IME/TSF interception.
//
// Strategy (Windows):
//  - Send WM_CHAR directly to the foreground window for each character.
//    WM_CHAR is the final output AFTER IME processing — posting it directly
//    means the IME never sees or transforms the character.
//  - Newline characters (\r, \n) use SendShiftEnter (VK_SHIFT + VK_RETURN)
//    because WM_CHAR for newline behaves inconsistently across apps.
//  - Surrogate pairs (characters outside BMP) are combined into a single
//    code point and sent as one WM_CHAR.
//  - Falls back to KEYEVENTF_UNICODE only when no foreground window exists.
Napi::Value SendText(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::string utf8Text = info[0].As<Napi::String>().Utf8Value();
    if (utf8Text.empty()) return Napi::Boolean::New(env, false);

    TextSendDiagnostics diag;
    std::wstring text;
    if (!BuildUtf16Text(utf8Text, text)) {
        diag.lastError = GetLastError();
        StoreTextDiagnostics(diag);
        return Napi::Boolean::New(env, false);
    }

    // Cache the foreground window once at the start.
    // If the user switches windows mid-input, characters may land in the
    // wrong window — this is an acceptable trade-off vs. calling
    // GetForegroundWindow() per character (which adds latency).
    HWND fgHwnd = GetForegroundWindow();
    bool useWMChar = (fgHwnd != nullptr);

    diag.utf16Units = static_cast<int>(text.size());
    diag.codeUnits.reserve(text.size());
    for (size_t i = 0; i < text.size(); i++) {
        wchar_t ch = text[i];
        diag.codeUnits.push_back(static_cast<WORD>(ch));

        // ── Newline: use Shift+Enter ──
        if (ch == L'\r') {
            if (i + 1 < text.size() && text[i + 1] == L'\n') {
                diag.codeUnits.push_back(static_cast<WORD>(text[i + 1]));
                i++;
            }
            if (!SendShiftEnter(diag)) {
                StoreTextDiagnostics(diag);
                return Napi::Boolean::New(env, false);
            }
        } else if (ch == L'\n') {
            if (!SendShiftEnter(diag)) {
                StoreTextDiagnostics(diag);
                return Napi::Boolean::New(env, false);
            }
        }
        // ── Surrogate pair: combine high + low into full code point ──
        else if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < text.size()
                 && text[i + 1] >= 0xDC00 && text[i + 1] <= 0xDFFF) {
            wchar_t low = text[i + 1];
            diag.codeUnits.push_back(static_cast<WORD>(low));
            // Combine: codepoint = 0x10000 + (high - 0xD800) * 0x400 + (low - 0xDC00)
            WPARAM cp = 0x10000
                        + (static_cast<WPARAM>(ch) - 0xD800) * 0x400
                        + (static_cast<WPARAM>(low) - 0xDC00);
            bool ok;
            if (useWMChar) {
                ok = SendWMChar(fgHwnd, cp, diag);
            } else {
                // Fallback: can't send surrogates via KEYEVENTF_UNICODE reliably,
                // so send as two separate code units (best effort).
                ok = SendUnicodeCodeUnit(static_cast<WORD>(ch), diag)
                  && SendUnicodeCodeUnit(static_cast<WORD>(low), diag);
            }
            if (!ok) {
                StoreTextDiagnostics(diag);
                return Napi::Boolean::New(env, false);
            }
            i++; // skip low surrogate
        }
        // ── Normal BMP character: WM_CHAR or KEYEVENTF_UNICODE fallback ──
        else {
            bool ok;
            if (useWMChar) {
                ok = SendWMChar(fgHwnd, static_cast<WPARAM>(ch), diag);
            } else {
                ok = SendUnicodeCodeUnit(static_cast<WORD>(ch), diag);
            }
            if (!ok) {
                StoreTextDiagnostics(diag);
                return Napi::Boolean::New(env, false);
            }
        }
        Sleep(8);
    }

    diag.ok = true;
    StoreTextDiagnostics(diag);
    return Napi::Boolean::New(env, true);
}

Napi::Value GetLastTextSendDiagnostics(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    TextSendDiagnostics diag;
    {
        std::lock_guard<std::mutex> lock(g_textDiagMutex);
        diag = g_lastTextSend;
    }

    auto obj = Napi::Object::New(env);
    obj.Set("ok", Napi::Boolean::New(env, diag.ok));
    obj.Set("utf16Units", Napi::Number::New(env, diag.utf16Units));
    obj.Set("packetsAttempted", Napi::Number::New(env, diag.packetsAttempted));
    obj.Set("packetsSent", Napi::Number::New(env, diag.packetsSent));
    obj.Set("lastError", Napi::Number::New(env, diag.lastError));

    auto units = Napi::Array::New(env, diag.codeUnits.size());
    for (size_t i = 0; i < diag.codeUnits.size(); i++) {
        units.Set(static_cast<uint32_t>(i), Napi::Number::New(env, diag.codeUnits[i]));
    }
    obj.Set("codeUnits", units);
    return obj;
}

Napi::Value SendKey(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    BYTE vk = static_cast<BYTE>(info[0].As<Napi::Number>().Int32Value());
    BYTE modifiers = 0;
    if (info.Length() >= 2 && info[1].IsNumber())
        modifiers = static_cast<BYTE>(info[1].As<Napi::Number>().Int32Value());

    // Modifier mapping (bitmask)
    // bit 0 = Shift, bit 1 = Ctrl, bit 2 = Alt, bit 3 = Win
    struct { BYTE vk; bool down; } modKeys[4] = {
        {VK_SHIFT,   !!(modifiers & 1)},
        {VK_CONTROL, !!(modifiers & 2)},
        {VK_MENU,    !!(modifiers & 4)},
        {VK_LWIN,    !!(modifiers & 8)},
    };

    auto sendKey = [](BYTE vkCode, bool up) {
        INPUT input = {};
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = vkCode;
        input.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        SendInput(1, &input, sizeof(INPUT));
    };

    // Press modifiers
    for (auto& mk : modKeys) {
        if (mk.down) sendKey(mk.vk, false);
    }

    // Main key
    sendKey(vk, false);
    sendKey(vk, true);

    // Release modifiers (reverse order)
    for (int i = 3; i >= 0; i--) {
        if (modKeys[i].down) sendKey(modKeys[i].vk, true);
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value GetCurrentInputSource(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto obj = Napi::Object::New(env);
    obj.Set("id", "");
    obj.Set("name", "");
    obj.Set("isASCII", false);

    // Get current keyboard layout name (e.g. "00000409")
    wchar_t layoutName[KL_NAMELENGTH] = {};
    if (!GetKeyboardLayoutNameW(layoutName)) {
        return obj;
    }

    std::wstring idW(layoutName);
    // Strip leading zeros
    size_t start = idW.find_first_not_of(L'0');
    if (start == std::wstring::npos) start = idW.length() - 1;
    std::wstring idShort = idW.substr(start);

    // Convert to UTF-8 for the id field
    int idLen = WideCharToMultiByte(CP_UTF8, 0, idW.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (idLen > 0) {
        std::string idStr(idLen, '\0');
        WideCharToMultiByte(CP_UTF8, 0, idW.c_str(), -1, &idStr[0], idLen, nullptr, nullptr);
        if (!idStr.empty()) idStr.pop_back();  // remove the null terminator written by -1 source
        obj.Set("id", idStr);
    }

    // Get display name from locale
    HKL hkl = GetKeyboardLayout(0);
    wchar_t localeName[LOCALE_NAME_MAX_LENGTH] = {};
    LCID lcid = LOWORD(reinterpret_cast<uintptr_t>(hkl));

    wchar_t langBuf[256] = {};
    if (GetLocaleInfoW(lcid, LOCALE_SLANGUAGE, langBuf, 256) > 0) {
        int nameLen = WideCharToMultiByte(CP_UTF8, 0, langBuf, -1, nullptr, 0, nullptr, nullptr);
        if (nameLen > 0) {
            std::string nameStr(nameLen, '\0');
            WideCharToMultiByte(CP_UTF8, 0, langBuf, -1, &nameStr[0], nameLen, nullptr, nullptr);
            if (!nameStr.empty()) nameStr.pop_back();
            obj.Set("name", nameStr);
        }
    }

    // Determine if this is a Latin/ASCII layout
    // Check primary language ID
    WORD langID = PRIMARYLANGID(LANGIDFROMLCID(lcid));
    // Latin-based languages have specific primary language IDs
    bool isASCII = (langID == LANG_ENGLISH || langID == LANG_FRENCH ||
                    langID == LANG_GERMAN || langID == LANG_SPANISH ||
                    langID == LANG_ITALIAN || langID == LANG_PORTUGUESE ||
                    langID == LANG_DUTCH || langID == LANG_NORWEGIAN ||
                    langID == LANG_SWEDISH || langID == LANG_DANISH ||
                    langID == LANG_FINNISH || langID == LANG_CATALAN ||
                    langID == LANG_ROMANIAN || langID == LANG_INDONESIAN ||
                    langID == LANG_VIETNAMESE || langID == LANG_TURKISH ||
                    langID == LANG_POLISH || langID == LANG_CZECH ||
                    langID == LANG_HUNGARIAN);
    obj.Set("isASCII", isASCII);

    return obj;
}

Napi::Value SelectInputSource(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::string targetId = info[0].As<Napi::String>().Utf8Value();

    // Convert to wide string
    int wideLen = MultiByteToWideChar(CP_UTF8, 0, targetId.c_str(), -1, nullptr, 0);
    if (wideLen <= 0) return Napi::Boolean::New(env, false);

    std::wstring wideId(wideLen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, targetId.c_str(), -1, &wideId[0], wideLen);
    if (!wideId.empty()) wideId.pop_back();

    // Ensure it has the KL_NAMELENGTH format (8 chars with leading zeros)
    // "00000804" for Chinese, "00000409" for US English, etc.
    HKL hkl = LoadKeyboardLayoutW(wideId.c_str(), KLF_ACTIVATE);
    if (reinterpret_cast<uintptr_t>(hkl) == 0) {
        // Try with padding
        std::wstring padded = L"0000" + wideId;
        while (padded.length() < KL_NAMELENGTH - 1) padded = L"0" + padded;
        hkl = LoadKeyboardLayoutW(padded.c_str(), KLF_ACTIVATE);
    }

    return Napi::Boolean::New(env, reinterpret_cast<uintptr_t>(hkl) != 0);
}

// ── Init ─────────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("mouseClick",          Napi::Function::New(env, MouseClick));
    exports.Set("mouseGetPosition",    Napi::Function::New(env, MouseGetPosition));
    exports.Set("startRecording",      Napi::Function::New(env, StartRecording));
    exports.Set("stopRecording",       Napi::Function::New(env, StopRecording));
    exports.Set("getRecordingClicks",  Napi::Function::New(env, GetRecordingClicks));
    exports.Set("clearRecordingClicks",Napi::Function::New(env, ClearRecordingClicks));
    exports.Set("isRecording",         Napi::Function::New(env, IsRecording));
    exports.Set("tapFailed",           Napi::Function::New(env, TapFailed));
    exports.Set("sendText",            Napi::Function::New(env, SendText));
    exports.Set("getLastTextSendDiagnostics", Napi::Function::New(env, GetLastTextSendDiagnostics));
    exports.Set("sendKey",             Napi::Function::New(env, SendKey));
    exports.Set("getCurrentInputSource", Napi::Function::New(env, GetCurrentInputSource));
    exports.Set("selectInputSource",   Napi::Function::New(env, SelectInputSource));
    return exports;
}

NODE_API_MODULE(win_input, Init)

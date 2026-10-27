#include <napi.h>
#include <windows.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <mutex>
#include <utility>
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
static std::atomic<bool> g_hasExclude{false};
static RECT g_excludeRect{};
static std::mutex g_excludeMutex;
static std::atomic<bool> g_hookFailed{false};

// ── Control 观察器(快捷键 latch)─────────────────────────────────────────
//
// 只读观察 Control 的**按下/松开**边沿,喂给 `shortcut-latch.cjs` 的状态机
// —— 与 macOS 侧的 CGEventTap(ListenOnly 事件 tap)同口径。
//
// ## 为什么用轮询 GetAsyncKeyState,而不是低级键盘钩子
//
// - `GetAsyncKeyState` 读的是**物理键盘状态**,**不受 `RegisterHotKey` 影响**
//   ⇒ 组合键被别的程序抢走(系统热键 / 别的 App)时,照样拿得到 Control
//   的真实按下与松开 —— latch 照样解得开。
// - `WH_KEYBOARD_LL` 有 LowLevelHooksTimeout 风险:钩子回调一卡就被系统摘掉,
//   而这个观察器**丢一次边沿就等于 latch 解不开**(用户再也触发不了快捷键)。
// - 轮询间隔 25ms:用户松开 Control 之后几十毫秒内解锁,无感。
//
// ## 线程生命周期
//
// 停止 = `g_controlWatchStop` 标志 + join(在 env 清理钩子里做)
// ⇒ 进程退出时不留野线程,也不会把 Node 事件循环吊住。
static std::atomic<bool> g_controlWatchRunning{false};
static std::atomic<bool> g_controlWatchStop{false};
static std::atomic<bool> g_controlWatchReady{false};
static std::mutex g_controlTsfnMutex;
static Napi::ThreadSafeFunction g_controlTsfn;
static std::mutex g_controlThreadMutex;
static std::thread g_controlThread;

// ── Low-Level Mouse Hook ─────────────────────────────────────────────────

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0 && wParam == WM_LBUTTONDOWN) {
        auto info = reinterpret_cast<MSLLHOOKSTRUCT*>(lParam);

        POINT pt = info->pt;

        // 排除矩形由**主进程**按当前窗口位置算,并且窗口一动就刷新
        // (所以点自己界面上的按钮不算一次点击)。
        // 读它要加锁:主进程随时可能在另一个线程上刷新它。
        bool excluded = false;
        {
            std::lock_guard<std::mutex> lock(g_excludeMutex);
            if (g_hasExclude &&
                pt.x >= g_excludeRect.left && pt.x <= g_excludeRect.right &&
                pt.y >= g_excludeRect.top && pt.y <= g_excludeRect.bottom) {
                excluded = true;
            }
        }
        if (excluded) {
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

// ── Low-Level Keyboard Hook(⌃D 的「优先级」)───────────────────────────────
//
// ## 为什么需要它
//
// 2026-10-27 真人反馈:**在微信里**按 ⌃D 是微信自己的动作,我们的「读剪贴板并键入」
// 不触发;别的软件里一切正常。
//
// 当场查过(不是猜):微信**没有**用系统热键 —— 我们自己的 `RegisterHotKey(Ctrl+D)`
// 是**注册成功**的 ⇒ 微信用的是**低级键盘钩子**(`WH_KEYBOARD_LL`)。
// Windows 的输入顺序是
//
//     **低级钩子 → 系统热键 → 目标窗口**
//
// ⇒ 微信在**系统热键之前**就把 Ctrl+D 处理掉了 ⇒ 我们的 `WM_HOTKEY` 根本没来过。
//
// ## 怎么赢
//
// Windows 的规则:**后安装的钩子先被调用** ⇒ 我们自己装一个 `WH_KEYBOARD_LL`,
// 看到 Ctrl+D 就**吞掉它**(返回 1)⇒ 微信收不到、系统热键也收不到 ⇒ 只有我们响应。
//
// ⚠️ 诚实说明:这**不是**绝对保证 —— 对方**后启动**的话,它的钩子会先被调用,
// 我们就收不到。这是 Windows 的机制,用户这边绕不过去(见 ADR-0023)。
//
// ## 为什么「吞掉」不新增代价
//
// 我们本来就用 `globalShortcut.register('Ctrl+D')` 把这个键**系统级占住**了
// ⇒ 按下去本来就不会送到前台软件(Edge 的收藏夹之类的一直就不生效)。
// 吞掉只是把「谁来处理」从系统热键换成我们的钩子。
//
// ## 与 latch 的关系
//
// latch(触发一次必须松开 Control 才重新武装)仍然由**只读的** Control 观察器
// (`watchControlKey`,`GetAsyncKeyState` 轮询)负责 —— 本钩子只负责「认键」。
// JS 那边走的是**同一个** `fire()` 包装,latch 规则一字不改。
//
// ## 修饰键状态:自己跟,不用 GetAsyncKeyState
//
// 钩子能看到**所有**按键的按下/松开 ⇒ 自己的 Ctrl 状态最可靠
// (`GetAsyncKeyState` 在钩子回调里的更新时机是「异步」的,偶尔会差一拍)。
static std::atomic<bool> g_kbHookRunning{false};
static std::atomic<bool> g_kbHookReady{false};
static std::atomic<bool> g_kbHookStop{false};
static std::atomic<bool> g_kbCtrlDown{false};
static std::atomic<bool> g_kbDDown{false};
static std::atomic<bool> g_kbSwallowKeyUp{false};
static std::atomic<DWORD> g_kbHookThreadId{0};
static HHOOK g_kbHook = nullptr;
/// 钩子装不上时的错误码(在**钩子线程**上取的 —— 别的线程取到的不是同一个值)。
static DWORD g_kbHookError = 0;
static std::mutex g_kbTsfnMutex;
static Napi::ThreadSafeFunction g_kbTsfn;
static std::mutex g_kbThreadMutex;
static std::thread g_kbThread;

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode != HC_ACTION) return CallNextHookEx(nullptr, nCode, wParam, lParam);
    auto* info = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    if (!info) return CallNextHookEx(nullptr, nCode, wParam, lParam);

    const bool down = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool up = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);

    // Control 的按下/松开:自己跟,给「是不是 ⌃D」用。
    if (info->vkCode == VK_CONTROL) g_kbCtrlDown.store(down);

    // 'D' = 0x44。⌃⇧D 也算 —— 它是容错别名,同一个动作。
    if (info->vkCode == 0x44) {
        if (down) {
            if (g_kbCtrlDown.load()) {
                g_kbSwallowKeyUp.store(true);
                // 自动重复(按住不放)⇒ 只触发第一次。
                if (!g_kbDDown.exchange(true)) {
                    Napi::ThreadSafeFunction tsfn = nullptr;
                    {
                        std::lock_guard<std::mutex> lock(g_kbTsfnMutex);
                        tsfn = g_kbTsfn;
                    }
                    if (tsfn) {
                        // NonBlocking:钩子回调必须尽快返回(LowLevelHooksTimeout)。
                        tsfn.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
                            cb.Call({Napi::Undefined::New(env)});
                        });
                    }
                }
                // 吞掉:微信收不到、系统热键也收不到 ⇒ 只有我们响应,不会重复触发。
                return 1;
            }
            g_kbDDown.store(false);
        } else if (up) {
            g_kbDDown.store(false);
            // 按下被吞了 ⇒ 松开也要吞(否则前台软件会看到一个「凭空出现的松开」)。
            if (g_kbSwallowKeyUp.exchange(false)) return 1;
        }
    }
    return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

// 钩子线程:装钩子 + 消息循环(低级钩子**必须**有消息循环才会被调用)。
static void kbHookThreadFunc() {
    g_kbHookThreadId.store(GetCurrentThreadId());
    // 起始状态取当前物理状态,别凭空造一个边沿。
    g_kbCtrlDown.store((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0);

    HMODULE hMod = GetModuleHandleW(nullptr);
    HHOOK h = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, hMod, 0);
    if (!h) {
        g_kbHookError = GetLastError();
        g_kbHookReady.store(false);
        g_kbHookRunning.store(false);
        g_kbHookThreadId.store(0);
        return;
    }
    g_kbHook = h;
    g_kbHookReady.store(true);

    MSG msg;
    while (!g_kbHookStop.load()) {
        const BOOL r = GetMessageW(&msg, nullptr, 0, 0);
        if (r == 0 || r == -1) break;   // WM_QUIT / 出错
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_kbHook) {
        UnhookWindowsHookEx(g_kbHook);
        g_kbHook = nullptr;
    }
    g_kbHookReady.store(false);
    g_kbHookRunning.store(false);
    g_kbHookThreadId.store(0);
}

// 装上钩子;回调在 JS 线程上被调用(收到 ⌃D 时)。
//
// 返回 `{ ok: bool, error: string }` —— 装不上要**如实**说,别假装生效。
Napi::Value StartCtrlDHook(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "startCtrlDHook 需要一个回调函数")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    {
        std::lock_guard<std::mutex> lock(g_kbTsfnMutex);
        g_kbTsfn = Napi::ThreadSafeFunction::New(
            env, info[0].As<Napi::Function>(), "ctrl-d-hook", 0, 1);
        // Unref:别让它挡住 Electron 事件循环退出
        g_kbTsfn.Unref(env);
    }
    if (!g_kbHookRunning.load()) {
        g_kbHookStop.store(false);
        g_kbHookRunning.store(true);
        std::lock_guard<std::mutex> lock(g_kbThreadMutex);
        g_kbThread = std::thread(kbHookThreadFunc);
    }
    // 等钩子线程起来(最多 500ms)—— 起不来就**如实**告诉调用方。
    for (int i = 0; i < 50 && !g_kbHookReady.load(); i++) {
        Sleep(10);
    }
    Napi::Object out = Napi::Object::New(env);
    const bool ok = g_kbHookReady.load();
    out.Set("ok", Napi::Boolean::New(env, ok));
    const std::string error = ok
        ? std::string()
        : std::string("SetWindowsHookExW(WH_KEYBOARD_LL) 失败(错误码 ")
              + std::to_string(g_kbHookError) + ")";
    out.Set("error", Napi::String::New(env, error.c_str()));
    return out;
}

// 停掉钩子(可重复调用)。
static void stopCtrlDHook() {
    g_kbHookStop.store(true);
    const DWORD tid = g_kbHookThreadId.load();
    if (tid != 0) PostThreadMessageW(tid, WM_QUIT, 0, 0);
    std::thread t;
    {
        std::lock_guard<std::mutex> lock(g_kbThreadMutex);
        if (g_kbThread.joinable()) t = std::move(g_kbThread);
    }
    if (t.joinable()) t.join();
    g_kbHookRunning.store(false);
    g_kbHookReady.store(false);
}

// env 销毁前把钩子线程停掉 —— 否则它会往一个已经销毁的 env 上投递。
//
// ⚠️ 钩子签名必须是 **无参**的 `void()`(同 stopControlWatchOnEnvCleanup 的理由)。
static void stopCtrlDHookOnEnvCleanup() {
    stopCtrlDHook();
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
    // SendInput 返回**真正塞进去的事件数**;返回 0 = 一个都没进去
    // (被系统拦下了:目标窗口权限更高、锁屏、会话切换……)。
    //
    // 这种情况下屏幕上什么都没发生 ⇒ 必须**如实报失败**,
    // 否则上层会把它计成"执行了"(用户看到计数在涨,却什么都没发生)。
    UINT inserted = SendInput(2, inputs, sizeof(INPUT));
    if (inserted != 2) {
        return env.Null();
    }

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

    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
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

// 刷新排除矩形(左、上、右、下)。
//
// 「点自己界面上的按钮不算一次点击」靠它实现。矩形必须**跟着窗口走**:
// 只能在开始录制时拍一张快照的话,窗口一动快照就过期了,点「结束」
// 会被当成一次外部点击。所以主进程在窗口每次移动/变高时都调一次这个。
Napi::Value SetExcludeRect(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::lock_guard<std::mutex> lock(g_excludeMutex);
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
    return Napi::Boolean::New(env, true);
}

// 删掉第 index 次点击(单条删除)。返回有没有删掉。
Napi::Value RemoveRecordingClick(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
        return Napi::Boolean::New(env, false);
    }
    int64_t index = info[0].As<Napi::Number>().Int64Value();
    bool removed = false;
    {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        if (index >= 0 && static_cast<size_t>(index) < g_clicks.size()) {
            g_clicks.erase(g_clicks.begin() + static_cast<ptrdiff_t>(index));
            removed = true;
        }
    }
    return Napi::Boolean::New(env, removed);
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

// ── 快捷键 latch:观察 Control 的按下/松开 ────────────────────────────
//
// 回调参数:一个 JS 函数,收到 `true` = Control 按下、`false` = Control 松开。
//
// 返回 `true` = 只读观察起来了(latch 可用);
// 返回 `false` = **没起来** ⇒ 调用方要**如实降级**
// (没法做 latch,只能维持"按住 Ctrl 连按会连着触发"的旧行为)。
//
// 与 macOS 侧的 `watchControlKey` **同口径**(那边是 CGEventTap ListenOnly
// 事件 tap;这边是 `GetAsyncKeyState` 轮询 + 边沿检测)。
static void controlWatchThreadFunc() {
    // 起始状态取"当前物理状态",不凭空造一个边沿。
    bool prev = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    g_controlWatchReady.store(true);
    while (!g_controlWatchStop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
        bool cur = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        if (cur == prev) continue;   // 没变化 ⇒ 不是边沿 ⇒ 不回调
        prev = cur;
        Napi::ThreadSafeFunction tsfn = nullptr;
        {
            std::lock_guard<std::mutex> lock(g_controlTsfnMutex);
            tsfn = g_controlTsfn;
        }
        if (tsfn) {
            // NonBlocking:别在轮询线程上等 JS(队列是无界的,正常不会丢)。
            tsfn.NonBlockingCall([cur](Napi::Env env, Napi::Function cb) {
                cb.Call({Napi::Boolean::New(env, cur)});
            });
        }
    }
    g_controlWatchReady.store(false);
}

// 停掉观察线程(可重复调用)。
//
// **必须在 env 销毁之前**调用 —— 线程还在往 TSFN 上投递的话,
// env 一销毁就是野指针(env 清理钩子里会做这件事)。
static void stopControlWatch() {
    g_controlWatchStop.store(true);
    std::thread t;
    {
        std::lock_guard<std::mutex> lock(g_controlThreadMutex);
        if (g_controlThread.joinable()) t = std::move(g_controlThread);
    }
    if (t.joinable()) t.join();
    g_controlWatchRunning.store(false);
    g_controlWatchReady.store(false);
}

Napi::Value WatchControlKey(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "watchControlKey 需要一个回调函数")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    {
        std::lock_guard<std::mutex> lock(g_controlTsfnMutex);
        g_controlTsfn = Napi::ThreadSafeFunction::New(
            env, info[0].As<Napi::Function>(), "control-watch", 0, 1);
        // Unref:别让它挡住 Electron 事件循环退出
        g_controlTsfn.Unref(env);
    }
    if (!g_controlWatchRunning.load()) {
        g_controlWatchStop.store(false);
        g_controlWatchReady.store(false);
        g_controlWatchRunning.store(true);
        std::lock_guard<std::mutex> lock(g_controlThreadMutex);
        g_controlThread = std::thread(controlWatchThreadFunc);
    }
    // 等观察线程起来(最多 300ms)—— 起不来就**如实**告诉调用方,
    // 别让它以为 latch 生效了。
    for (int i = 0; i < 30 && !g_controlWatchReady.load(); i++) {
        Sleep(10);
    }
    return Napi::Boolean::New(env, g_controlWatchReady.load());
}

// env 销毁前把观察线程停掉 —— 否则它会往一个已经销毁的 env 上投递。
//
// ⚠️ 钩子签名必须是 **无参**的 `void()`:
//   `AddCleanupHook(Hook)` 走的是 `CleanupHook<Hook, void>`,
//   它的 wrapper 回调是 `hook()`(不带参数)——
//   传 `void(*)(void*)` 会编译报 "too few arguments for call"
//   (2026-10-24 Windows CI 第一次编原生模块就是这么红的。)
//
// (CleanupHook **没有析构函数** ⇒ 这里返回的临时对象析构时**不会**注销钩子,
//  钩子一直有效。)
static void stopControlWatchOnEnvCleanup() {
    stopControlWatch();
}

// ── Init ─────────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("mouseClick",          Napi::Function::New(env, MouseClick));
    exports.Set("mouseGetPosition",    Napi::Function::New(env, MouseGetPosition));
    exports.Set("startRecording",      Napi::Function::New(env, StartRecording));
    exports.Set("stopRecording",       Napi::Function::New(env, StopRecording));
    exports.Set("getRecordingClicks",  Napi::Function::New(env, GetRecordingClicks));
    exports.Set("clearRecordingClicks",Napi::Function::New(env, ClearRecordingClicks));
    exports.Set("setExcludeRect",      Napi::Function::New(env, SetExcludeRect));
    exports.Set("removeRecordingClick",Napi::Function::New(env, RemoveRecordingClick));
    exports.Set("isRecording",         Napi::Function::New(env, IsRecording));
    exports.Set("tapFailed",           Napi::Function::New(env, TapFailed));
    exports.Set("sendText",            Napi::Function::New(env, SendText));
    exports.Set("getLastTextSendDiagnostics", Napi::Function::New(env, GetLastTextSendDiagnostics));
    exports.Set("sendKey",             Napi::Function::New(env, SendKey));
    exports.Set("getCurrentInputSource", Napi::Function::New(env, GetCurrentInputSource));
    exports.Set("selectInputSource",   Napi::Function::New(env, SelectInputSource));
    exports.Set("watchControlKey",     Napi::Function::New(env, WatchControlKey));
    exports.Set("startCtrlDHook",       Napi::Function::New(env, StartCtrlDHook));

    // env 销毁前把观察线程停掉 —— 否则它会往一个已经销毁的 env 上投递。
    // (CleanupHook 的析构**不会**注销钩子,所以这里注册了就一直有效。)
    env.AddCleanupHook(&stopControlWatchOnEnvCleanup);
    env.AddCleanupHook(&stopCtrlDHookOnEnvCleanup);

    return exports;
}

NODE_API_MODULE(win_input, Init)

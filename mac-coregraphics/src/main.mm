#include <napi.h>
#include <CoreGraphics/CoreGraphics.h>
#include <Carbon/Carbon.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <mutex>
#include <vector>
#include <unistd.h>

// ── Recording Globals ────────────────────────────────────────────────────
// We use a polling approach instead of ThreadSafeFunction to avoid
// complex N-API threading issues. The JS side polls getRecordingClicks()
// every 100ms (matching the existing frontend pattern).

struct ClickEvent {
    double x, y, elapsed;
};

static std::vector<ClickEvent> g_clicks;
static std::mutex g_clickMutex;
static std::thread g_recordingThread;
static CFMachPortRef g_eventTap = nullptr;
static CFRunLoopRef g_runLoop = nullptr;
static std::atomic<bool> g_recording{false};
static std::atomic<bool> g_startTime{false};
static double g_recordingStartSecs = 0;
static bool g_hasExclude = false;
static CGRect g_excludeRect{};
// 排除矩形会被主进程在窗口 move/resize 时刷新,而点击判定发生在监听线程上
// → 读写要同步。单独一把锁,别跟点击列表那把混在一起(判定路径要短)。
static std::mutex g_excludeMutex;
static std::atomic<bool> g_tapFailed{false};

// ── Event Tap Callback ───────────────────────────────────────────────────

static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void*) {
    if (type == kCGEventTapDisabledByTimeout ||
        type == kCGEventTapDisabledByUserInput) {
        g_recording = false;
        g_tapFailed = true;
        if (g_runLoop) CFRunLoopStop(g_runLoop);
        return nullptr;
    }

    if (type == kCGEventLeftMouseDown) {
        CGPoint loc = CGEventGetLocation(event);
        bool excluded = false;
        {
            std::lock_guard<std::mutex> lock(g_excludeMutex);
            excluded = g_hasExclude && CGRectContainsPoint(g_excludeRect, loc);
        }
        if (excluded) {
            return event;
        }

        double now = CFAbsoluteTimeGetCurrent();
        ClickEvent ce{loc.x, loc.y, now - g_recordingStartSecs};
        {
            std::lock_guard<std::mutex> lock(g_clickMutex);
            g_clicks.push_back(ce);
        }
    }

    return event;
}

// ── 快捷键 latch:观察 Control 的按下/松开边沿 ─────────────────────
//
// ## 为什么需要它
//
// 用户的要求(2026-10-23):
// > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
// > 除非下一次重新按住 Ctrl,再点击相应的字母」
//
// Electron 的 `globalShortcut` **只在按下时回调**,不告诉你 Control 什么时候
// 松开 ⇒ latch 解不开(按住 Ctrl 连按会连着触发,而「默认执行」是回放,
// 连着触发就是往屏幕上乱点)。
//
// 这里用一个**会话级 ListenOnly** 的键盘 tap 观察 Control 的边沿:
// - **ListenOnly 不需要「辅助功能」权限**(会话级只读监听是例外)
//   —— Electron ad-hoc 签名也能用(和 globalShortcut 一样不需要权限);
// - 也**不需要** active tap 那种"能吞键"的能力 —— 吞键交给系统热键做。
static std::atomic<bool> g_controlDown{false};
static std::atomic<bool> g_controlWatchRunning{false};
static std::atomic<bool> g_controlTapReady{false};
static std::mutex g_controlTsfnMutex;
static Napi::ThreadSafeFunction g_controlTsfn = nullptr;

static CGEventRef controlTapCallback(CGEventTapProxy, CGEventType type,
                                      CGEventRef event, void*) {
    if (type == kCGEventTapDisabledByTimeout ||
        type == kCGEventTapDisabledByUserInput) {
        g_controlWatchRunning = false;
        return nullptr;
    }
    if (type == kCGEventFlagsChanged) {
        bool ctrlDown = (CGEventGetFlags(event) & kCGEventFlagMaskControl) != 0;
        bool before = g_controlDown.load();
        if (ctrlDown != before) {
            g_controlDown.store(ctrlDown);
            Napi::ThreadSafeFunction tsfn = nullptr;
            {
                std::lock_guard<std::mutex> lock(g_controlTsfnMutex);
                tsfn = g_controlTsfn;
            }
            if (tsfn) {
                // NonBlocking:别在 tap 线程上等 JS —— tap 回调一慢,
                // 系统会直接把这个 tap 关掉(监听就没了)。
                //
                // ⚠️ node-addon-api 的 `NonBlockingCall` 只有两个重载:
                //   · `NonBlockingCall(callback)` —— callback 是
                //     `void(Env, Function)`,**按值捕获**即可;
                //   · `NonBlockingCall(DataType* data, callback)` —— data 是**指针**。
                // 这里用第一个重载,把 `ctrlDown` **按值捕获**进 lambda:
                // 不需要在堆上分配、也不会有生命周期问题。
                tsfn.NonBlockingCall([ctrlDown](Napi::Env env, Napi::Function cb) {
                    cb.Call({Napi::Boolean::New(env, ctrlDown)});
                });
            }
        }
    }
    return event;
}

static void controlWatchThreadFunc() {
    CFMachPortRef tap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventFlagsChanged),
        controlTapCallback,
        nullptr);

    if (!tap) {
        g_controlTapReady = false;
        g_controlWatchRunning = false;
        return;
    }

    auto rls = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
    CFRunLoopRef rl = CFRunLoopGetCurrent();
    CFRunLoopAddSource(rl, rls, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);
    g_controlTapReady = true;

    while (g_controlWatchRunning.load()) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.2, false);
    }

    CFRunLoopRemoveSource(rl, rls, kCFRunLoopCommonModes);
    CFMachPortInvalidate(tap);
    CFRelease(tap);
    CFRelease(rls);
    g_controlTapReady = false;
}

// ── Recording Thread ────────────────────────────────────────────────────

static void recordingThreadFunc() {
    g_eventTap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionDefault,
        CGEventMaskBit(kCGEventLeftMouseDown),
        tapCallback,
        nullptr);

    if (!g_eventTap) {
        g_recording = false;
        g_tapFailed = true;
        return;
    }

    auto rls = CFMachPortCreateRunLoopSource(kCFAllocatorDefault,
                                             g_eventTap, 0);
    g_runLoop = CFRunLoopGetCurrent();
    CFRunLoopAddSource(g_runLoop, rls, kCFRunLoopCommonModes);
    CFRunLoopRun();

    // Cleanup
    CFMachPortInvalidate(g_eventTap);
    CFRelease(g_eventTap);
    CFRelease(rls);
    g_eventTap = nullptr;
    g_runLoop = nullptr;
}

// ── N-API Functions ─────────────────────────────────────────────────────

Napi::Value MouseClick(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    double x = info[0].As<Napi::Number>().DoubleValue();
    double y = info[1].As<Napi::Number>().DoubleValue();
    CGPoint pt = CGPointMake(x, y);

    CGEventRef down = CGEventCreateMouseEvent(
        nullptr, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(
        nullptr, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    return Napi::Boolean::New(env, true);
}

Napi::Value MouseGetPosition(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    CGEventRef ev = CGEventCreate(nullptr);
    CGPoint pt = CGEventGetLocation(ev);
    CFRelease(ev);
    auto obj = Napi::Object::New(env);
    obj.Set("x", Napi::Number::New(env, pt.x));
    obj.Set("y", Napi::Number::New(env, pt.y));
    return obj;
}

// 开始/停止录制的核心(**不碰 N-API**)——
// 正式流程和「自检」共用同一套,免得自检验的是另一条路径。
//
// `rect` = 排除矩形 [l, t, r, b](自身窗口的屏幕坐标范围);
// 传空 = 不排除任何位置(自检的对照组用这个)。
static bool recordingStart(const double* rect, int rectLen) {
    if (g_recording) return false;
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        g_hasExclude = false;
        if (rect && rectLen == 4) {
            g_excludeRect = CGRectMake(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
            g_hasExclude = true;
        }
    }
    {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        g_clicks.clear();
    }
    g_recording = true;
    g_tapFailed = false;
    g_recordingStartSecs = CFAbsoluteTimeGetCurrent();

    g_recordingThread = std::thread(recordingThreadFunc);
    g_recordingThread.detach();
    return true;
}

static void recordingStop() {
    if (g_recording) {
        g_recording = false;
    }
    if (g_runLoop) {
        CFRunLoopStop(g_runLoop);
    }
}

Napi::Value StartRecording(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (g_recording) {
        Napi::Error::New(env, "already recording")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    double rect[4] = {0, 0, 0, 0};
    int rectLen = 0;
    if (info.Length() >= 1 && info[0].IsArray()) {
        auto arr = info[0].As<Napi::Array>();
        if (arr.Length() == 4) {
            for (uint32_t i = 0; i < 4; i++) {
                rect[i] = arr.Get(i).As<Napi::Number>().DoubleValue();
            }
            rectLen = 4;
        }
    }

    recordingStart(rect, rectLen);
    return Napi::Boolean::New(env, true);
}

Napi::Value StopRecording(const Napi::CallbackInfo& info) {
    recordingStop();
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
        arr.Set(i, obj);
    }
    return arr;
}

Napi::Value ClearRecordingClicks(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_clickMutex);
    g_clicks.clear();
    return Napi::Boolean::New(info.Env(), true);
}

// 刷新「排除矩形」(自身窗口的屏幕坐标范围)。
//
// 落在这个矩形里的点击**不记** —— 点自己界面上的按钮(尤其「结束」)
// 不该被当成一次外部点击。
//
// 主进程在窗口 move/resize 时调用它,所以矩形始终是当前的:
// 开始录制时拍一张快照是不够的(窗口一动快照就过期了)。
// 传 null / 少于 4 个数 = 不排除任何位置。
Napi::Value SetExcludeRect(const Napi::CallbackInfo& info) {
    auto env = info.Env();
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
                g_excludeRect = CGRectMake(l, t, r - l, b - t);
                g_hasExclude = true;
            }
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
    return Napi::Boolean::New(info.Env(), g_tapFailed.load());
}

Napi::Value SendText(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::string text = info[0].As<Napi::String>().Utf8Value();
    if (text.empty()) return Napi::Boolean::New(env, false);

    CFStringRef cfStr = CFStringCreateWithCString(
        kCFAllocatorDefault, text.c_str(), kCFStringEncodingUTF8);
    if (!cfStr) return Napi::Boolean::New(env, false);
    CGEventSourceRef source =
        CGEventSourceCreate(kCGEventSourceStateHIDSystemState);

    CFIndex length = CFStringGetLength(cfStr);
    for (CFIndex i = 0; i < length; i++) {
        UniChar ch = CFStringGetCharacterAtIndex(cfStr, i);
        CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
        CGEventKeyboardSetUnicodeString(down, 1, &ch);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);

        CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
        CGEventKeyboardSetUnicodeString(up, 1, &ch);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(up);

        std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }

    CFRelease(source);
    CFRelease(cfStr);
    return Napi::Boolean::New(env, true);
}

Napi::Value SendKey(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    CGKeyCode kc = static_cast<CGKeyCode>(
        info[0].As<Napi::Number>().Int32Value());
    CGEventFlags flags = 0;
    if (info.Length() >= 2 && info[1].IsNumber())
        flags = static_cast<CGEventFlags>(
            info[1].As<Napi::Number>().Int64Value());

    CGEventRef down = CGEventCreateKeyboardEvent(nullptr, kc, true);
    CGEventSetFlags(down, flags);
    CGEventPost(kCGHIDEventTap, down);
    CGEventRef up = CGEventCreateKeyboardEvent(nullptr, kc, false);
    CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    return Napi::Boolean::New(env, true);
}

Napi::Value GetCurrentInputSource(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto obj = Napi::Object::New(env);
    obj.Set("id", "");
    obj.Set("name", "");
    obj.Set("isASCII", false);

    TISInputSourceRef src = TISCopyCurrentKeyboardInputSource();
    if (!src) return obj;

    auto id = (CFStringRef)TISGetInputSourceProperty(
        src, kTISPropertyInputSourceID);
    auto nm = (CFStringRef)TISGetInputSourceProperty(
        src, kTISPropertyLocalizedName);
    auto asc = (CFBooleanRef)TISGetInputSourceProperty(
        src, kTISPropertyInputSourceIsASCIICapable);

    char buf[256];
    if (id && CFStringGetCString(id, buf, sizeof(buf),
                                  kCFStringEncodingUTF8))
        obj.Set("id", std::string(buf));
    if (nm && CFStringGetCString(nm, buf, sizeof(buf),
                                  kCFStringEncodingUTF8))
        obj.Set("name", std::string(buf));
    if (asc) obj.Set("isASCII", bool(CFBooleanGetValue(asc)));

    CFRelease(src);
    return obj;
}

Napi::Value SelectInputSource(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    std::string targetId = info[0].As<Napi::String>().Utf8Value();
    CFStringRef cfId = CFStringCreateWithCString(
        kCFAllocatorDefault, targetId.c_str(), kCFStringEncodingUTF8);

    CFStringRef keys[] = {kTISPropertyInputSourceID};
    CFTypeRef vals[] = {cfId};
    CFDictionaryRef dict = CFDictionaryCreate(
        kCFAllocatorDefault, (const void**)keys, (const void**)vals, 1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);

    CFArrayRef results = TISCreateInputSourceList(dict, false);
    bool ok = false;
    if (results && CFArrayGetCount(results) > 0) {
        auto src = (TISInputSourceRef)
            CFArrayGetValueAtIndex(results, 0);
        if (src) ok = (TISSelectInputSource(src) == noErr);
    }

    if (results) CFRelease(results);
    CFRelease(dict);
    CFRelease(cfId);
    return Napi::Boolean::New(env, ok);
}

// 自检:「点自己界面上的按钮,会不会被记成一次点击」。
//
// 做的是一组**对照**,同一个位置、同一个合成点击,只换排除矩形:
// ① 把排除矩形**关掉** → 这个点击**应该**被记下来
//    (证明事件监听确实收到了合成点击;没收到 = 这次测不了,不是"通过");
// ② 把排除矩形设成**传入的窗口范围** → 这个点击**不应该**被记下来。
//
// 参数:info[0] = [l, t, r, b](窗口范围),info[1] = [x, y](点击位置)。
// 返回: { control, excluded, posted, conclusive }
Napi::Value DiagnoseExclusion(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
        return Napi::Boolean::New(env, false);
    }
    auto rectArr = info[0].As<Napi::Array>();
    auto ptArr = info[1].As<Napi::Array>();
    if (rectArr.Length() != 4 || ptArr.Length() != 2) {
        return Napi::Boolean::New(env, false);
    }
    double winRect[4];
    for (uint32_t i = 0; i < 4; i++) {
        winRect[i] = rectArr.Get(i).As<Napi::Number>().DoubleValue();
    }
    CGPoint pt;
    pt.x = ptArr.Get(0u).As<Napi::Number>().DoubleValue();
    pt.y = ptArr.Get(1u).As<Napi::Number>().DoubleValue();

    auto postClick = [&]() {
        CGEventRef down = CGEventCreateMouseEvent(
            nullptr, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
        CGEventRef up = CGEventCreateMouseEvent(
            nullptr, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
        if (!down || !up) {
            if (down) CFRelease(down);
            if (up) CFRelease(up);
            return false;
        }
        CGEventPost(kCGHIDEventTap, down);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down);
        CFRelease(up);
        return true;
    };

    auto countClicks = [&]() {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        return (int)g_clicks.size();
    };
    auto clearClicks = [&]() {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        g_clicks.clear();
    };

    // ① 对照组:不排除
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        g_hasExclude = false;
    }
    recordingStart(nullptr, 0);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    bool posted1 = postClick();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    int control = countClicks();
    recordingStop();
    clearClicks();
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // ② 实验组:排除矩形 = 窗口范围
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        g_excludeRect = CGRectMake(winRect[0], winRect[1],
                                   winRect[2] - winRect[0], winRect[3] - winRect[1]);
        g_hasExclude = true;
    }
    recordingStart(winRect, 4);
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    bool posted2 = postClick();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    int excluded = countClicks();
    recordingStop();
    clearClicks();

    Napi::Object out = Napi::Object::New(env);
    out.Set("control", Napi::Number::New(env, control));
    out.Set("excluded", Napi::Number::New(env, excluded));
    out.Set("posted", Napi::Boolean::New(env, posted1 && posted2));
    out.Set("conclusive", Napi::Boolean::New(env, control > 0));
    Napi::Array rectOut = Napi::Array::New(env, 4);
    for (uint32_t i = 0; i < 4; i++) rectOut.Set(i, Napi::Number::New(env, winRect[i]));
    Napi::Array ptOut = Napi::Array::New(env, 2);
    ptOut.Set(0u, Napi::Number::New(env, pt.x));
    ptOut.Set(1u, Napi::Number::New(env, pt.y));
    out.Set("rect", rectOut);
    out.Set("point", ptOut);
    return out;
}

// ── Init ────────────────────────────────────────────────────────────────

// ── 快捷键 latch:观察 Control 的按下/松开 ──────────────────────────
//
// 回调参数:一个 JS 函数,收到 `true` = Control 按下、`false` = Control 松开。
//
// 返回 `true` = 只读监听起来了(latch 可用);
// 返回 `false` = **没起来**(比如系统不让建 tap)⇒ 调用方要降级
// (没法做 latch,只能维持"按住 Ctrl 连按会连着触发"的旧行为)。
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
        g_controlTapReady = false;
        g_controlWatchRunning = true;
        std::thread(controlWatchThreadFunc).detach();
    }
    // 等 tap 建好(最多 300ms)—— 建不起来就**如实**告诉调用方,
    // 别让它以为 latch 生效了。
    for (int i = 0; i < 30 && !g_controlTapReady.load(); i++) {
        usleep(10000);
    }
    return Napi::Boolean::New(env, g_controlTapReady.load());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("mouseClick",
        Napi::Function::New(env, MouseClick));
    exports.Set("mouseGetPosition",
        Napi::Function::New(env, MouseGetPosition));
    exports.Set("startRecording",
        Napi::Function::New(env, StartRecording));
    exports.Set("stopRecording",
        Napi::Function::New(env, StopRecording));
    exports.Set("getRecordingClicks",
        Napi::Function::New(env, GetRecordingClicks));
    exports.Set("clearRecordingClicks",
        Napi::Function::New(env, ClearRecordingClicks));
    exports.Set("setExcludeRect",
        Napi::Function::New(env, SetExcludeRect));
    exports.Set("removeRecordingClick",
        Napi::Function::New(env, RemoveRecordingClick));
    exports.Set("diagnoseExclusion",
        Napi::Function::New(env, DiagnoseExclusion));
    exports.Set("isRecording",
        Napi::Function::New(env, IsRecording));
    exports.Set("tapFailed",
        Napi::Function::New(env, TapFailed));
    exports.Set("sendText",
        Napi::Function::New(env, SendText));
    exports.Set("sendKey",
        Napi::Function::New(env, SendKey));
    exports.Set("getCurrentInputSource",
        Napi::Function::New(env, GetCurrentInputSource));
    exports.Set("selectInputSource",
        Napi::Function::New(env, SelectInputSource));
    exports.Set("watchControlKey",
        Napi::Function::New(env, WatchControlKey));
    return exports;
}

NODE_API_MODULE(mac_coregraphics, Init)

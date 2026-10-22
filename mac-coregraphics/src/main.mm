#include <napi.h>
#include <CoreGraphics/CoreGraphics.h>
#include <Carbon/Carbon.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <mutex>
#include <vector>

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
        if (g_hasExclude &&
            CGRectContainsPoint(g_excludeRect, loc)) {
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

Napi::Value StartRecording(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (g_recording) {
        Napi::Error::New(env, "already recording")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

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

    {
        std::lock_guard<std::mutex> lock(g_clickMutex);
        g_clicks.clear();
    }
    g_recording = true;
    g_tapFailed = false;
    g_recordingStartSecs = CFAbsoluteTimeGetCurrent();

    g_recordingThread = std::thread(recordingThreadFunc);
    g_recordingThread.detach();

    return Napi::Boolean::New(env, true);
}

Napi::Value StopRecording(const Napi::CallbackInfo& info) {
    if (g_recording) {
        g_recording = false;
    }
    if (g_runLoop) {
        CFRunLoopStop(g_runLoop);
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
        arr.Set(i, obj);
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

// ── Init ────────────────────────────────────────────────────────────────

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
    return exports;
}

NODE_API_MODULE(mac_coregraphics, Init)

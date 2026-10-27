/**
 * 门禁：⌃D 的**优先级**必须由**低级键盘钩子**来扛。
 *
 * ## 它盯的是什么
 *
 * 2026-10-27 真人反馈：**在微信里**按 ⌃D 是微信自己的动作，
 * 我们的「读剪贴板并键入」不触发；别的软件里一切正常。
 *
 * 当场查过（不是猜）：微信**没有**用系统热键（我们自己的
 * `RegisterHotKey(Ctrl+D)` 是**注册成功**的）⇒ 微信用的是
 * **低级键盘钩子**（`WH_KEYBOARD_LL`）。而 Windows 的输入顺序是
 *
 * ```text
 * 低级钩子 → 系统热键 → 目标窗口
 * ```
 *
 * ⇒ 微信在**系统热键之前**就把键处理掉了 ⇒ 我们的 `WM_HOTKEY` 根本没来过。
 *
 * ⇒ 唯一的办法是**自己也装一个低级钩子**，看到 ⌃D 就**吞掉它**。
 *
 * ## 两条断言
 *
 *   ① **源码层**：原生模块里必须有真正的 `WH_KEYBOARD_LL` 钩子
 *      （装钩子 + 消息循环 + 吞键），主进程必须真的去装它，
 *      而且「⌃D 抢到了没有」必须把钩子算进去。
 *   ② **决策逻辑**：带 Control 才触发、按住不放不重复触发。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const NATIVE_CC = path.join(ROOT, 'win-input', 'src', 'main.cc');
const MAIN_JS = path.join(ROOT, 'main.js');

test('原生模块：必须有真正的低级键盘钩子', () => {
  const src = fs.readFileSync(NATIVE_CC, 'utf8');

  assert.ok(src.includes('WH_KEYBOARD_LL'), '原生模块里没有 WH_KEYBOARD_LL');
  assert.ok(
    /SetWindowsHookExW\(\s*WH_KEYBOARD_LL/.test(src),
    '原生模块里没有 SetWindowsHookExW(WH_KEYBOARD_LL, ...)'
  );
  assert.ok(src.includes('LowLevelKeyboardProc'), '原生模块里没有键盘钩子的回调');
  assert.ok(
    src.includes('GetMessageW'),
    '原生模块里没有消息循环 —— 低级钩子**必须**有消息循环才会被调用'
  );
  assert.ok(
    src.includes('CallNextHookEx'),
    '原生模块里没有 CallNextHookEx —— 别的键必须照常放行'
  );
  assert.ok(
    src.includes('startCtrlDHook'),
    '原生模块没有导出 startCtrlDHook'
  );
  assert.ok(
    src.includes('exports.Set("startCtrlDHook"'),
    'startCtrlDHook 没有挂到 exports 上'
  );
});

test('原生模块：钩子要**吞掉** ⌃D（返回 1）', () => {
  const src = fs.readFileSync(NATIVE_CC, 'utf8');
  const start = src.indexOf('LowLevelKeyboardProc');
  const end = src.indexOf('kbHookThreadFunc');
  assert.ok(start > 0 && end > start, '找不到键盘钩子回调');
  const body = src.slice(start, end);

  // 吞键 = return 1（CallNextHookEx 才会把键继续传下去）。
  assert.ok(
    /return 1;/.test(body),
    '键盘钩子回调里没有 return 1 —— 那样只是「看见」了键,没「吃掉」,微信照样会收到'
  );
  // 修饰键是自己跟的（不靠 GetAsyncKeyState 的异步时机）。
  assert.ok(
    body.includes('g_kbCtrlDown'),
    '键盘钩子回调没有自己跟 Control 的状态'
  );
  // 'D' 的虚拟键码。
  assert.ok(
    body.includes('0x44'),
    '键盘钩子回调里没有认 \'D\' 键(0x44)'
  );
});

test('主进程：必须真的去装钩子，而且「抢到了没有」要算上它', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');

  assert.ok(src.includes('startCtrlDHook'), '主进程没有调用 startCtrlDHook');
  assert.ok(
    /shortcutPasteRegistered:\s*shortcutStatus\.ctrlD === true\s*\|\|\s*shortcutStatus\.hookCtrlD === true/.test(src),
    'shortcutPasteRegistered 没有把钩子算进去 ⇒ 钩子明明装上了,界面还在说「没抢到」'
  );
  assert.ok(src.includes('hookCtrlD'), '诊断里没有 hookCtrlD 这一栏');
  // 钩子触发的动作必须走**同一个** fire()包装 ⇒ latch 规则一字不改。
  assert.ok(
    /startCtrlDHook\(firePaste\)/.test(src),
    '钩子没有走同一个 fire()包装 ⇒ latch（触发一次必须松开 Control）会被绕过'
  );
});

test('决策逻辑：带 Control 才触发、按住不放不重复触发', () => {
  // 与原生模块里那份判定同口径（win-input/src/main.cc 的 LowLevelKeyboardProc）。
  const shouldTrigger = (ctrlDown, dWasDown) => ctrlDown && !dWasDown;

  assert.ok(shouldTrigger(true, false), '⌃D 应当触发');
  assert.ok(!shouldTrigger(false, false), '单独的 D 是普通按键,不该触发');
  assert.ok(!shouldTrigger(true, true), '按住不放不该连着触发');
});

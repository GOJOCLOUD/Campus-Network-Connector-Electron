/**
 * 快捷键 latch(触发许可)的回归测试。
 *
 * ## 要盯住的行为
 *
 * 用户的要求(2026-10-23):
 * > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
 * > 除非下一次重新按住 Ctrl,再点击相应的字母」
 *
 * ⇒ **触发一次就被消费掉**;Control 不松开,就一直不触发;
 * **必须松开再重新按住**,才允许下一次触发。
 *
 * ## 为什么必须能自动测
 *
 * 「默认执行」的动作是**回放** —— 一次误触发就是往用户的屏幕上乱点一串
 * 合成点击。所以这个闸属于**不能靠手测**的那类:手测触发一次就得收拾一次。
 *
 * 闸本身在 `shortcut-latch.cjs`(纯函数,不需要 Electron 运行时),
 * 与 Tauri 版 `commands/native/hotkey.rs` 的 `Latch` **同口径**
 * (见 ADR-0024)。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createShortcutLatch } = require(path.resolve(__dirname, '..', '..', 'shortcut-latch.cjs'));

test('触发一次之后,Control 还按着就不许再触发', () => {
  const latch = createShortcutLatch();
  assert.strictEqual(latch.isArmed(), true, '一开始就该是武装的');
  assert.strictEqual(latch.tryFire(), true, '第一次应该放行');
  assert.strictEqual(latch.tryFire(), false, 'Control 还按着,第二次必须被挡住');
  assert.strictEqual(latch.isArmed(), false, '触发之后就不该再武装');
});

test('Control 松开 ⇒ 重新武装;再按住 Control ⇒ 还能触发一次', () => {
  const latch = createShortcutLatch();
  latch.tryFire();
  assert.strictEqual(latch.tryFire(), false, '还锁着');
  // Control 松开
  latch.onCtrlChange(false);
  assert.strictEqual(latch.isArmed(), true, '松开就该彻底解锁');
  // 重新按住 Control
  latch.onCtrlChange(true);
  assert.strictEqual(latch.tryFire(), true, '重新按住之后应该能再触发一次');
  assert.strictEqual(latch.tryFire(), false, '但仍然只能触发一次');
});

test('迟到的「Control 按下」不能解除 latch', () => {
  // 这正是 ADR-0023 描述的乱序场景:系统热键的回调与只读监听的回调
  // **谁先到不确定**。若「Control 按下」那一下能把 latch 解开,
  // 用户按住 Ctrl 连按就会连着触发 —— 正好是 latch 要防的事。
  const latch = createShortcutLatch();
  assert.strictEqual(latch.tryFire(), true, '主键先到 ⇒ 先触发');
  // 修饰键的边沿随后才到
  latch.onCtrlChange(true);
  assert.strictEqual(latch.isArmed(), false, '迟到的 Control 按下不该解除 latch');
  assert.strictEqual(latch.tryFire(), false, '还锁着');
  // Control 松开 ⇒ 才能重新武装
  latch.onCtrlChange(false);
  assert.strictEqual(latch.isArmed(), true, '松开才解锁');
});

test('没进触发路径就不会消费许可', () => {
  // 「没匹配上就不消费 latch」:调用方**只在快捷键真的匹配上时**才调
  // tryFire();没匹配上的路径压根不进这个状态机。
  const latch = createShortcutLatch();
  // 模拟"没有快捷键命中"—— 什么都不调
  assert.strictEqual(latch.isArmed(), true, '没匹配上不该把许可消费掉');
  assert.strictEqual(latch.tryFire(), true, '许可还在,第一次该放行');
});

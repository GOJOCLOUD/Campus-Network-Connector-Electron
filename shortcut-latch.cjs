/**
 * 快捷键的 **latch(触发许可)** 状态机 —— 与 Tauri 版
 * `commands/native/hotkey.rs` 里的 `Latch` **同口径**(见 ADR-0013)。
 *
 * ## 为什么需要它
 *
 * 用户的要求(2026-10-23):
 * > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
 * > 除非下一次重新按住 Ctrl,再点击相应的字母」
 *
 * `globalShortcut` **只在按下时回调**,不告诉你 Control 什么时候松开 ⇒
 * 靠它自己解不开 latch:按住 Ctrl 连按会连着触发,而「默认执行」是**回放**,
 * 连着触发就是往屏幕上乱点。
 *
 * 所以另开一个**只读**监听(CGEventTap ListenOnly,**不需要辅助功能权限**)
 * 看 Control 的按下/松开边沿,喂给这个状态机。
 *
 * ## 规则(与 Tauri 版一字不差)
 *
 * - 触发 ⇒ `armed = false` 且 `blocked = true`;
 * - **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
 * - Control 按下 ⇒ **只有 `blocked == false` 时**才武装。
 *
 * 最后一条是关键:系统热键的回调和只读监听的回调**谁先到不确定**。
 * 若「Control 按下」那一下能把 latch 解开,用户按住 Ctrl 连按就会连着触发
 * —— 正好是 latch 要防的事。
 *
 * 抽成独立模块是为了**能测**(main.js 要 Electron 运行时才起得来,
 * 这个模块是纯函数,node --test 直接跑)。
 */

/**
 * 创建一个 latch 状态机。
 *
 * 用法:快捷键回调里先 `tryFire()`,拿到 true 才执行动作;
 * 只读监听到 Control 变化时调 `onCtrlChange()`。
 */
function createShortcutLatch() {
  /** 当前允许触发吗 */
  let armed = true;
  /** 触发过了,在等 Control 松开 */
  let blocked = false;

  return {
    /**
     * Control 的状态变了(按下 / 松开)。
     * @param {boolean} ctrlDown true = 按下,false = 松开
     */
    onCtrlChange(ctrlDown) {
      if (ctrlDown) {
        // 按下:有阻塞就不武装(迟到的"按下"不能解除 latch)。
        if (!blocked) armed = true;
      } else {
        // 松开:彻底解锁 —— 必须松开再重按,才能再触发。
        blocked = false;
        armed = true;
      }
    },

    /**
     * 试一次触发:已武装 ⇒ 触发,并**消费掉**这次许可。
     * @returns {boolean} true = 允许触发;false = 还锁着,不触发
     */
    tryFire() {
      if (!armed) return false;
      armed = false;
      blocked = true;
      return true;
    },

    /** 当前是不是允许触发(诊断用) */
    isArmed() {
      return armed;
    },
  };
}

module.exports = { createShortcutLatch };

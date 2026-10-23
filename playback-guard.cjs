/**
 * 回放的安全闸 —— 与 Tauri 版 `commands/play.rs` **同口径**。
 *
 * ## 为什么需要它(2026-10-23 T0 事故)
 *
 * 回放时发出的**合成点击**如果落在 App **自己的窗口**上,
 * 就会点到自己界面上的「默认执行」按钮 → 又一次回放 → 合成点击又点自己 →
 * **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
 *
 * ## Windows 线的口径(这条分支)
 *
 * 这条分支只启用**闸 ①(重入保护)**。
 * **闸 ②(落点在自己窗口上的点击不发出去)在 Windows 上暂不启用** ——
 * 它的前提是"窗口坐标与合成点击坐标同一套",而 Windows 的 `SendInput`
 * 用的是**虚拟屏幕绝对坐标**,量纲不一样,没核实之前不能开:
 * 开错了会把「不在窗口上的点击」误当成「在窗口上」而丢掉,那是另一种功能缺失。
 *
 * 闸 ① 是**纯逻辑、跨平台**的 —— 少了它,Windows 上一次误触仍会自激,
 * 所以它是这条分支必须有的**底线**。
 *
 * `pointInRect` 留着没删:等 Windows 线把坐标系核实清楚,直接开闸 ② 就行。
 *
 * 抽成独立模块是为了**能测**(main.js 要 Electron 运行时才起得来,
 * 这个模块是纯函数,node --test 直接跑)。
 */

/**
 * 点 (x, y) 是否落在矩形里(闭区间)。
 *
 * @param {{x:number,y:number,width:number,height:number}|null} rect
 * @param {number} x
 * @param {number} y
 */
function pointInRect(rect, x, y) {
  if (!rect) return false;
  return x >= rect.x
    && x <= rect.x + rect.width
    && y >= rect.y
    && y <= rect.y + rect.height;
}

/**
 * 重入保护闸(闸 ①)。
 *
 * 用法:起回放前 `tryStart()`,结束时**必须** `finish()`(放 finally 里,
 * 哪怕中途抛错也要放开,否则回放再也起不来)。
 */
function createPlaybackGuard() {
  let inFlight = false;
  let rejected = 0;
  return {
    /** 现在有回放在跑吗 */
    isBusy() {
      return inFlight;
    },
    /** 因为"已经在放了"被拒绝过几次(诊断用) */
    rejectedCount() {
      return rejected;
    },
    /** 试着占坑:占到了返回 true,被拒绝返回 false */
    tryStart() {
      if (inFlight) {
        rejected += 1;
        return false;
      }
      inFlight = true;
      return true;
    },
    /** 放坑(回放结束时调) */
    finish() {
      inFlight = false;
    },
  };
}

module.exports = { pointInRect, createPlaybackGuard };

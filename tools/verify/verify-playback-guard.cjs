/**
 * 回放安全闸的回归测试。
 *
 * ## 复现的故障(2026-10-23 T0 事故)
 *
 * 回放时发出的**合成点击**如果落在 App **自己的窗口**上,
 * 就会点到自己界面上的「默认执行」按钮 → 又一次回放 → 合成点击又点自己 →
 * **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
 *
 * 闸①(重入保护)是**跨平台的底线**,这条分支必须有;
 * 闸②(落点在自己窗口上的点击不发出去)在 Windows 上暂不启用
 * (坐标系未核实,理由见 `playback-guard.cjs` 的说明),
 * 但判定函数 `pointInRect` 仍在这里测着 —— 等核实清楚直接开闸即可。
 *
 * ## 为什么要单独测
 *
 * 这条闸少了,一次误触就能把用户的机器搞死 —— 属于**不能靠手测**
 * 的那类改动(手测一次就得重启一次机器)。所以要有能进 CI 的回归。
 *
 * 闸本身在 `playback-guard.cjs`(纯函数,不需要 Electron 运行时)。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { pointInRect, createPlaybackGuard } = require(path.resolve(__dirname, '..', '..', 'playback-guard.cjs'));

test('闸①重入保护:已经在回放时,后来的必须被拒绝', () => {
  const guard = createPlaybackGuard();
  assert.strictEqual(guard.isBusy(), false, '一开始不该有回放在跑');
  assert.strictEqual(guard.tryStart(), true, '第一次应该拿到坑');
  assert.strictEqual(guard.isBusy(), true, '这时候应该有回放在跑');
  assert.strictEqual(guard.tryStart(), false, '已经在放了,这次必须被拒绝');
  assert.strictEqual(guard.rejectedCount(), 1, '被拒绝的次数要记下来(诊断用)');
});

test('闸①重入保护:回放结束后要能再起', () => {
  const guard = createPlaybackGuard();
  guard.tryStart();
  guard.finish();
  assert.strictEqual(guard.isBusy(), false, '结束了就不该还占着坑');
  assert.strictEqual(guard.tryStart(), true, '结束了就应该能再起一次');
});

test('闸②的判定函数:边界要算对(Windows 线核实坐标系后直接开闸)', () => {
  const rect = { x: 700, y: 111, width: 520, height: 298 };
  assert.strictEqual(pointInRect(rect, 700, 111), true, '左上角算窗口内');
  assert.strictEqual(pointInRect(rect, 960, 260), true, '正中间算窗口内');
  assert.strictEqual(pointInRect(rect, 1220, 409), true, '右下角(闭区间)算窗口内');
  assert.strictEqual(pointInRect(rect, 699, 111), false, '左边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 700, 110), false, '上边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 1221, 409), false, '右边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 960, 410), false, '下边一像素算窗口外');
  assert.strictEqual(pointInRect(null, 960, 260), false, '没有矩形时不该判成窗口内');
});

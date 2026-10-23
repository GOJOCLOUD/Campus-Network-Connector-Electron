/**
 * 回放两道安全闸的回归测试。
 *
 * ## 复现的故障(2026-10-23 T0 事故)
 *
 * 回放时发出的**合成点击**如果落在 App **自己的窗口**上,
 * 就会点到自己界面上的「默认执行」按钮 → 又一次回放 → 合成点击又点自己 →
 * **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
 *
 * 两道闸(与 Tauri 版 `commands/play.rs` 同口径):
 * ① **重入保护**:同一时刻最多一个回放,后来的直接拒绝;
 * ② **落点在自己窗口上的点击不发出去**。
 *
 * ## 为什么要单独测
 *
 * 这两条闸少任何一条,一次误触就能把用户的机器搞死 —— 属于**不能靠手测**
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

test('闸②落点在自己窗口上的点击要能识别出来', () => {
  const rect = { x: 700, y: 111, width: 520, height: 298 };
  // 窗口内
  assert.strictEqual(pointInRect(rect, 700, 111), true, '左上角算窗口内');
  assert.strictEqual(pointInRect(rect, 960, 260), true, '正中间算窗口内');
  assert.strictEqual(pointInRect(rect, 1220, 409), true, '右下角(闭区间)算窗口内');
  // 窗口外
  assert.strictEqual(pointInRect(rect, 699, 111), false, '左边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 700, 110), false, '上边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 1221, 409), false, '右边一像素算窗口外');
  assert.strictEqual(pointInRect(rect, 960, 410), false, '下边一像素算窗口外');
  // 拿不到矩形时一律不算窗口内(不能因此把点击全丢掉)
  assert.strictEqual(pointInRect(null, 960, 260), false, '没有矩形时不该判成窗口内');
});

test('闸②与闸①要能一起用:窗口内的点击被丢、回放期间不重入', () => {
  const guard = createPlaybackGuard();
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const clicks = [
    { x: 50, y: 50 },   // 在窗口里 → 丢掉
    { x: 500, y: 500 }, // 在窗口外 → 照常发
  ];
  assert.strictEqual(guard.tryStart(), true);
  let executed = 0;
  let skipped = 0;
  for (const c of clicks) {
    if (pointInRect(rect, c.x, c.y)) skipped += 1;
    else executed += 1;
  }
  guard.finish();
  assert.strictEqual(skipped, 1, '落在自己窗口上的那一条必须被丢掉');
  assert.strictEqual(executed, 1, '窗口外的那一条要照常发');
});

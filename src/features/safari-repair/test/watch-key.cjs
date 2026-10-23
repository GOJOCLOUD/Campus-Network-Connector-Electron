/**
 * 「看住的标签」这张表的键必须**只有一种写法**。
 *
 * 背景（2026-10-23 查实的一处既有偏差）：
 *   存进去用的键是 `w{windowIndex}t{tabIndex}` / String(index) / 'front'，
 *   而读表的时候用的是**裸数字的 tabIndex** → 永远取不到 →
 *   `ticksSinceInject` 永远从 1 开始 → **强制重注入从不发生** →
 *   页面里旧版守卫也就永远换不掉（守卫自己能按版本号就地升级，
 *   但前提是有人重新注入它）。
 *
 * 另外补一条：页面里的守卫**版本**对不上时，要立刻重新注入，
 * 而不是等"每几轮强制补一次"（那条路在 Electron 侧本来就是坏的）。
 *
 *   node --test src/features/safari-repair/test/watch-key.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { InjectorCoordinator } = require('../coordinator');

/** 造一个协调器，把桥换成假的：只记录"注入了几次"。 */
function makeCoordinator(pollState) {
  const coordinator = new InjectorCoordinator({ log: () => {} });
  const calls = { inject: 0, poll: 0 };
  coordinator.bridge = {
    pollState: async () => {
      calls.poll += 1;
      return pollState();
    },
    injectGuard: async () => {
      calls.inject += 1;
      return 'OK';
    },
    setMapping: async () => 'OK',
  };
  return { coordinator, calls };
}

test('看住的标签:键一致 → 强制重注入的计数能累加(到点就重新注入)', async () => {
  const { coordinator, calls } = makeCoordinator(() => ({
    guard: true,
    guardVersion: coordinator.guardVersion,
    url: 'https://example.test/quiz',
    collect: 'none',
    pending: null,
    frames: [],
  }));

  // 这个标签"出现过混淆字体" → 被看住（存进去的键带窗口号）
  coordinator.watchTab(18, 'https://example.test/quiz', 1);

  // 前 4 轮：守卫在、版本也对 → 不该注入
  for (let i = 0; i < 4; i += 1) {
    await coordinator.processTab(18, 1);
  }
  assert.equal(calls.inject, 0, '前几轮不该注入');

  // 第 5 轮：计数到点 → 必须强制重注入一次
  // （键取不到的话，计数每轮都从 1 开始 → 永远到不了 5 → 永远不注入）
  await coordinator.processTab(18, 1);
  assert.equal(calls.inject, 1, '到第 5 轮必须强制重注入一次');
});

test('页面里的守卫版本旧了 → 立刻重新注入(不等轮数到点)', async () => {
  const { coordinator, calls } = makeCoordinator(() => ({
    guard: true,
    guardVersion: 1, // 老版本
    url: 'https://example.test/quiz',
    collect: 'none',
    pending: null,
    frames: [],
  }));

  await coordinator.processTab(18, 1);
  assert.equal(calls.inject, 1, '版本对不上必须立刻重新注入');
});

test('页面里的守卫版本是最新的 → 不注入', async () => {
  const { coordinator, calls } = makeCoordinator(() => ({
    guard: true,
    guardVersion: coordinator.guardVersion,
    url: 'https://example.test/quiz',
    collect: 'none',
    pending: null,
    frames: [],
  }));

  await coordinator.processTab(18, 1);
  assert.equal(calls.inject, 0, '版本一致时不该注入');
  assert.ok(coordinator.guardVersion, '应当能从注入源里读出守卫版本号');
});

test('守卫不在 → 照常注入', async () => {
  const { coordinator, calls } = makeCoordinator(() => ({
    guard: false,
    guardVersion: 0,
    url: 'https://example.test/quiz',
    collect: 'none',
    pending: null,
    frames: [],
  }));

  await coordinator.processTab(18, 1);
  assert.equal(calls.inject, 1, '守卫不在必须注入');
});

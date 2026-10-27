/**
 * 门禁：右上角「最小化 / 叉叉」两个按钮**点得动**，而且那一栏的说明**足够短**。
 *
 * ## 为什么要有这道门禁（2026-10-27 用户真机反馈）
 *
 * 用户原话：「右上角的缩小，最小化按钮，以及关闭按钮，完全就无法生效，
 * 然后打开浏览器这一栏界面说明太详细了，看起来乱七八糟的，不够简短」。
 *
 * ### 根因（真机取证，不是猜的）
 *
 * 1. **按钮点不动**：`Stepper` 里「步骤圈 + 进度线」那一行带 `app-drag`，
 *    它的**矩形横跨整张卡片**，右上角正好压在窗口按钮上面。
 *    Chromium 的拖拽区按**矩形**算：`no-drag` 只有在**这个元素是拖拽元素的子孙**时
 *    才会把那块地方挖空；而窗口按钮那个容器（`corner`）是那一行的**兄弟** ⇒ 挖不空
 *    ⇒ **浏览器进程把真实鼠标按下当成了「拖窗口」**，点击根本进不到渲染器。
 *    ⇒ CDP 伪造的点击能过（源码看着没问题），**只有真鼠标点击才会暴露**。
 *
 * 2. **说明太长**：`description` + `hint` + 「浏览器已关闭」三段大字叠在一起，
 *    那一栏变成密密麻麻的一大块 ⇒ 用户看着乱。
 *
 * ## 断言
 *
 *   ① 步骤圈那一行**不能**是拖拽区（Electron：`app-drag`；Tauri：`data-tauri-drag-region`）。
 *   ② 窗口按钮那个容器**必须**标成「不拖拽」（Electron：`app-nodrag`；Tauri：`data-tauri-drag-region="false"`）。
 *   ③ 两个按钮**必须**真的调 `cnc.minimize` / `cnc.quit`（别变成哑按钮）。
 *   ④ 那一栏的三句文案**必须有长度上限**（防止以后又被写长）。
 *
 * 跑法：
 *   node --test tools/verify/verify-window-buttons.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const STEPPER = read('src', 'components', 'Stepper.jsx');
const APP_JSX = read('src', 'App.jsx');
const FEATURES_INDEX = read('src', 'features', 'index.js');
const FEATURE_REPAIR = read('src', 'features', 'chromium-repair', 'index.js');
const TOGGLES = read('src', 'panels', 'FeatureToggles.jsx');

/** 这套门禁跑在 Tauri 仓时改这些标记 */
const IS_TAURI = fs.existsSync(path.join(ROOT, 'tauri-app', 'src-tauri', 'Cargo.toml'));

test('右上角按钮那一行**不能**是拖拽区（它会盖住按钮、把点击吃掉）', () => {
  // 步骤圈 + 进度线那一行：<div className={`${stepContainerClassName} flex w-full items-center p-8`}>
  const rowMatch = /className=\{`\$\{stepContainerClassName\}([^`]*)`\}/.exec(STEPPER);
  assert.ok(rowMatch, 'Stepper.jsx 里找不到「步骤圈那一行」的 className（改了结构？门禁要同步）');
  const rowClasses = rowMatch[1];
  assert.ok(!rowClasses.includes('app-drag'),
    `步骤圈那一行又是拖拽区了（${rowClasses.trim()}）⇒ 它的矩形盖住右上角按钮 ⇒ 真鼠标点击被当成「拖窗口」`);
  if (IS_TAURI) {
    assert.ok(!/data-tauri-drag-region="deep"/.test(STEPPER.split(rowMatch[0])[0].slice(-600)),
      '步骤圈那一行又是 Tauri 拖拽区了 ⇒ 会盖住右上角按钮');
  }
});

test('窗口按钮那个容器**必须**标成「不拖拽」', () => {
  const cornerMatch = /className="app-nodrag absolute top-3 right-3 z-20"/.test(STEPPER)
    || /className="app-nodrag[^"]*"/.test(STEPPER);
  assert.ok(cornerMatch, 'Stepper.jsx 里找不到右上角按钮的容器（.app-nodrag absolute top-3 right-3）');
  if (IS_TAURI) {
    assert.ok(/data-tauri-drag-region="false"/.test(STEPPER),
      'Tauri：右上角按钮容器必须写 data-tauri-drag-region="false"，否则 mousedown 会被当成拖窗口');
  }
});

test('两个按钮真的调 minimize / quit', () => {
  assert.ok(/cnc\.minimize\?\.\(\)/.test(APP_JSX), '最小化按钮没有调 cnc.minimize()');
  assert.ok(/cnc\.quit\?\.\(\)/.test(APP_JSX), '叉叉按钮没有调 cnc.quit()');
});

test('那一栏的文案**必须短**（2026-10-27 用户口径）', () => {
  // 功能名旁边那句小字
  // ⚠️ 只查 **chromium-repair**（Windows 线那一栏）；
  //    safari-repair 那条是 macOS 的界面文案，**不许**在这里改。
  const block = /id:\s*'chromium-repair'[\s\S]*?description:\s*'([^']+)'/.exec(FEATURES_INDEX);
  assert.ok(block, "features/index.js 里找不到 chromium-repair 的 description");
  const desc = block[1];
  assert.ok(desc.length <= 16,
    `功能说明太长（${desc.length} 字）：「${desc}」⇒ 界面上看着乱，改到 16 字以内`);

  // 开关打开时的那句提示
  const hint = /const HINT_ON\s*=\s*'([^']+)'/.exec(FEATURE_REPAIR);
  assert.ok(hint, 'chromium-repair/index.js 里找不到 HINT_ON');
  assert.ok(hint[1].length <= 24,
    `提示太长（${hint[1].length} 字）：「${hint[1]}」⇒ 界面上看着乱，改到 24 字以内`);

  // 「浏览器已关闭」那一行
  const closed = /<span>([^<]*浏览器已关闭[^<]*)<\/span>/.exec(TOGGLES);
  assert.ok(closed, 'FeatureToggles.jsx 里找不到「浏览器已关闭」那一行');
  assert.ok(closed[1].length <= 20,
    `「浏览器已关闭」那一行太长（${closed[1].length} 字）：「${closed[1]}」`);
});

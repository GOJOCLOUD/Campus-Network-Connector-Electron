/**
 * 门禁：Windows 线的「软件自己起浏览器 + CDP 注入守卫」端到端跑通。
 *
 * ## 它盯的是什么
 *
 * 整条链路，一个环节都不能断：
 *
 *   ① 起浏览器（自己的 profile + 调试端口）
 *   ② CDP 连上 → 每个标签页 document_start 注入页面守卫
 *   ③ 守卫采到混淆字体作用域 → App 侧**真字形识别**算出「密文 → 明文」
 *   ④ 映射下发回页面
 *   ⑤ 用户按 Ctrl+C → 剪贴板里是**明文**而不是密文
 *
 * 用的全是**仓库里的生产模块**（browser.js / cdp-bridge.js / coordinator.js /
 * safari-repair/engine.js），不是另写一份玩具实现 ——
 * 所以这条门禁红了 ⇒ 装出来的包也是坏的。
 *
 * ## 为什么必须真跑浏览器
 *
 * 前面几层（守卫能不能拦到 copy 事件、映射能不能送到页面）**静态检查抓不到**：
 * 它们取决于浏览器的真实行为。2026-10-26 的实测就抓到过两条：
 *   - `Input.dispatchKeyEvent{commands:['copy']}` 不触发 DOM copy 事件（Windows 上）
 *     ⇒ 必须用**真实按键序列**
 *   - 页面自己拦复制（超星式）时，守卫必须赢过它
 *
 * ## 跑法
 *
 *   npm run build:vendor          # 先把 vendor/ 构建出来
 *   node --test tools/verify/verify-cdp-copy-repair.cjs
 *
 * 只在 Windows 上跑（其它平台直接跳过）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'src', 'features', 'safari-repair', 'test', 'fixtures');
const VENDOR = path.join(ROOT, 'vendor');

const CIPHERTEXT = '天地玄黄宇宙洪荒日月盈昃';
const PLAINTEXT = '人工智能正在改变世界科技';

const isWindows = process.platform === 'win32';

/** 剪贴板（Windows）：读出来的是 UTF-16 → 转成 base64 免掉编码坑 */
function clipGet() {
  const script =
    `$ErrorActionPreference='SilentlyContinue'; $t = Get-Clipboard -Raw; ` +
    `if ($null -eq $t) { $t = '' }; ` +
    `[Console]::Out.Write([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)))`;
  const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' });
  return Buffer.from(String(out).trim(), 'base64').toString('utf8');
}

function clipSet(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script =
    `$ErrorActionPreference='Stop'; Set-Clipboard -Value ` +
    `([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`;
  execFileSync('powershell', ['-NoProfile', '-STA', '-Command', script], { stdio: 'ignore' });
}

/** 起一个本地夹具服务：混淆字体 + 密文文本 */
function startFixtureServer() {
  const ttf = fs.readFileSync(path.join(FIXTURES, 'fonts', 'obf-same-style.ttf'));
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CDP 门禁夹具</title>
<style>
  body { font: 16px/1.9 "Microsoft YaHei", sans-serif; margin: 24px; }
  @font-face { font-family: "ObfA"; src: url("/fonts/obf-same-style.ttf") format("truetype"); }
  #target { font-family: "ObfA"; font-size: 26px; display: inline-block;
            background: #eef3ff; border: 1px solid #88aaff; padding: 10px 14px; }
</style></head>
<body><p id="target">${CIPHERTEXT}</p></body></html>`;
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (url === '/fonts/obf-same-style.ttf') {
      res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' });
      res.end(ttf);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('CDP 注入守卫端到端：按 Ctrl+C 复制出来的是明文', { skip: !isWindows && '只在 Windows 上跑' }, async (t) => {
  // vendor/ 是构建产物（不进 git）—— 缺了就直接说清楚，别让人猜
  for (const f of ['page-guard.js', 'frame-bridge.js', 'copy-repair-core.cjs', 'opentype.js', 'glyph-db-48.crdb.gz']) {
    assert.ok(
      fs.existsSync(path.join(VENDOR, f)),
      `vendor/${f} 不在 —— 先跑 npm run build:vendor`,
    );
  }

  const { ManagedBrowser } = require(path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js'));
  const { CdpCoordinator } = require(path.join(ROOT, 'src', 'features', 'chromium-repair', 'coordinator.js'));
  const { GlyphEngine } = require(path.join(ROOT, 'src', 'features', 'safari-repair', 'engine.js'));

  const { server, port } = await startFixtureServer();
  const pageUrl = `http://127.0.0.1:${port}/`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-cdp-gate-'));

  const browser = new ManagedBrowser({ profileDir, log: (m) => console.log('   [browser]', m) });
  const coordinator = new CdpCoordinator({
    log: (m) => console.log('   [coordinator]', m),
    browser,
    guardPath: path.join(VENDOR, 'page-guard.js'),
    frameBridgePath: path.join(VENDOR, 'frame-bridge.js'),
  });
  coordinator.setEngine(new GlyphEngine({ log: (m) => console.log('   [engine]', m) }));

  try {
    // ① 起浏览器（生产模块 ManagedBrowser）
    const { client } = await browser.ensure();

    // ② 接上 + 注入（生产模块 CdpBridge）
    const bridge = await coordinator.ensureBridge();

    // ③ 先开一个标签页 —— 它模拟「**功能打开之前**就已经开着的页面」。
    //    这种页面的导航在 addScriptToEvaluateOnNewDocument 注册之前就提交了
    //    ⇒ 只能靠协调器的 injectNow 补注入 ⇒ 这一条专门盯它。
    await client.send('Target.createTarget', { url: pageUrl });

    // ④ 拨开关 → 协调器自己接管（生产路径）
    coordinator.setEnabled(true);

    // ⑤ 再开一个标签页 —— 它模拟「**功能打开之后**才开的页面」，
    //    走的是 document_start 注入那条路。
    await client.send('Target.createTarget', { url: pageUrl });

    // 等标签页挂上、页面加载完
    let sessionId = null;
    for (let i = 0; i < 80; i += 1) {
      const tabs = bridge.listTabs();
      const tab = tabs.find((t) => String(t.url).includes('127.0.0.1') && t.sessionId);
      if (tab) {
        sessionId = tab.sessionId;
        const ready = await client.send(
          'Runtime.evaluate',
          { expression: 'document.readyState === "complete" && !!document.getElementById("target")', returnByValue: true },
          sessionId,
        );
        if (ready.result && ready.result.value === true) break;
      }
      await new Promise((r2) => setTimeout(r2, 200));
    }
    assert.ok(sessionId, '夹具页那个标签页没挂上来');

    // 合成按键要送达页面，页面必须「是前台」——
    // CDP 的 Input 事件不会去抢焦点，不开这个开关浏览器会直接忽略按键
    // （产品里不需要：用户是真的用鼠标点着页面的）。
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);

    // ⑥ 守卫装上了吗（document_start 注入 或 injectNow 补注入，二者必居其一）
    let guardInstalled = false;
    for (let i = 0; i < 60; i += 1) {
      const r = await client.send(
        'Runtime.evaluate',
        { expression: '!!window.__copyRepairGuard', returnByValue: true },
        sessionId,
      );
      if (r.result && r.result.value === true) { guardInstalled = true; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
    assert.ok(guardInstalled, '守卫没装上（document_start 注入与 injectNow 补注入都没生效）');

    // ③ 选中密文 → 触发守卫采集 → App 侧真字形识别 → 映射下发
    await client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const el = document.getElementById('target');
          const s = window.getSelection();
          const r = document.createRange();
          r.selectNodeContents(el);
          s.removeAllRanges(); s.addRange(r);
          return s.toString();
        })()`,
        returnByValue: true,
      },
      sessionId,
    );

    // 走**生产**的那条路：拨开关 → 协调器自己起浏览器、自己注入、自己算映射、自己下发
    coordinator.setEnabled(true);

    let delivered = 0;
    for (let i = 0; i < 80; i += 1) {
      const r = await client.send(
        'Runtime.evaluate',
        {
          expression: 'Object.keys((window.__copyRepairGuard && window.__copyRepairGuard.mappings) || {}).length',
          returnByValue: true,
        },
        sessionId,
      );
      delivered = (r.result && r.result.value) || 0;
      if (delivered > 0) break;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    assert.ok(delivered > 0, '映射没下发到页面（作用域没采到，或字形识别没出结果）');

    // ④ 合成 Ctrl+C（**真实按键序列** —— commands:['copy'] 在 Windows 上不触发 DOM copy 事件）
    clipSet('SENTINEL-<gate-ignore>');
    await new Promise((r) => setTimeout(r, 200));
    const keys = [
      { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 },
      { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2 },
      { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2 },
      { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 },
    ];
    for (const k of keys) {
      await client.send('Input.dispatchKeyEvent', k, sessionId);
    }
    await new Promise((r) => setTimeout(r, 800));

    // ⑤ 剪贴板里必须是明文
    const clip = clipGet();
    assert.strictEqual(clip, PLAINTEXT, `剪贴板里不是明文：${JSON.stringify(clip)}`);

    const guardLog = await client.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify((window.__copyRepairGuard && window.__copyRepairGuard.log) || [])', returnByValue: true },
      sessionId,
    );
    console.log('   守卫日志:', guardLog.result.value);
  } finally {
    try {
      await browser.shutdown();
    } catch (_) {
      /* ignore */
    }
    server.close();
  }
});

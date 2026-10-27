/**
 * 门禁：浏览器连不上时**绝不能**疯狂重开 Edge。
 *
 * ## 它盯的是什么（2026-10-27 真机踩出来的 bug）
 *
 * 现象：用户窗口里 Edge 一个一个弹出来（每 29 秒一个空白标签页），
 * 而且**再也没连回那个一直在跑的 Edge** ⇒ 新标签页没守卫、
 * 网页上复制出来还是密文。
 *
 * 根因链：
 *   1. CDP 的浏览器级 WebSocket 断了；
 *   2. 恢复流程只认 Chromium 自己写的 `DevToolsActivePort` 文件；
 *   3. 但**同 profile 的第二个浏览器是「转发启动」**（Chromium 单例）：
 *      它不开自己的调试端口，退出时还会把 `DevToolsActivePort` **删掉**；
 *   4. ⇒ 恢复流程永远找不到「上次那个还在跑的浏览器」⇒ 无限重开。
 *
 * ## 两条断言
 *
 *   ① **源码层**：恢复的顺序必须是「自己记的端口 → DevToolsActivePort →
 *      扫进程命令行 → 才允许起新的」，而且 tick() 的错误**要打日志**。
 *   ② **真跑一遍**（Windows）：起一个真的 Edge → 把连接关掉 →
 *      把 DevToolsActivePort 删掉 → 再 ensure() 一次
 *      ⇒ 必须**连回同一个浏览器**（端口不变、那个 profile 下只有一个浏览器进程）。
 *
 * 跑法：
 *   node --test tools/verify/verify-browser-recovery.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BROWSER_JS = path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js');
const COORDINATOR_JS = path.join(ROOT, 'src', 'features', 'chromium-repair', 'coordinator.js');

const isWindows = process.platform === 'win32';

/** 数一下「用这个 profile 的浏览器」有几个（顺带把它们的 pid / 端口列出来） */
function browsersForProfile(profileDir) {
  const script = [
    "$p = $env:CR_PROFILE",
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine -notmatch '--type=' } |",
    "  ForEach-Object {",
    "    $port = 0",
    "    if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') { $port = $Matches[1] }",
    "    \"$($_.ProcessId) $port\"",
    "  }",
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: Object.assign({}, process.env, { CR_PROFILE: profileDir }),
    });
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, port] = line.split(/\s+/);
        return { pid: Number(pid), port: Number(port) };
      })
      .filter((x) => Number.isInteger(x.pid) && x.pid > 0);
  } catch (_) {
    return [];
  }
}

test('源码层：恢复浏览器时必须先找、最后才起', () => {
  const src = fs.readFileSync(BROWSER_JS, 'utf8');
  const coord = fs.readFileSync(COORDINATOR_JS, 'utf8');

  assert.ok(src.includes('readRememberedPort'), 'browser.js 缺少 readRememberedPort（自己记的端口）');
  assert.ok(src.includes('rememberPort'), 'browser.js 缺少 rememberPort（记住我们起的那个端口）');
  assert.ok(src.includes('findRunningPorts'), 'browser.js 缺少 findRunningPorts（扫进程命令行兜底）');

  // ensure() 里的顺序：三个候选都在 launch() **之前**
  // ⚠️ 结束点要用「下一个方法定义」(`\n  browserLabel() {`)——
  //    用 'browserLabel()' 这个词会先命中 ensure() 内部的 `this.browserLabel()`
  //    ⇒ 把 ensure() 截成一小段，断言就全是假的。
  // ⚠️ 定位的是 `ensureOnce()`（真正干活的那个）——
  //    `ensure()` 现在只是「单飞外壳」（并发调用共享同一次尝试）。
  const ensureStart = src.indexOf('async ensureOnce()');
  const ensureEnd = src.indexOf('\n  browserLabel() {', ensureStart);
  assert.ok(ensureStart >= 0, 'browser.js 里找不到 ensureOnce()');
  assert.ok(ensureEnd > ensureStart, 'browser.js 里找不到 ensureOnce() 的结尾');
  const ensure = src.slice(ensureStart, ensureEnd);
  const iRemembered = ensure.indexOf('readRememberedPort()');
  const iDevTools = ensure.indexOf('readPortFromProfile()');
  const iScan = ensure.indexOf('findRunningPorts()');
  const iLaunch = ensure.indexOf('this.launch()');
  assert.ok(iRemembered >= 0, 'ensureOnce() 里没有试「自己记的端口」');
  assert.ok(iDevTools >= 0, 'ensureOnce() 里没有试 DevToolsActivePort');
  assert.ok(iScan >= 0, 'ensureOnce() 里没有扫进程命令行');
  assert.ok(iLaunch >= 0, 'ensureOnce() 里没有 launch()');
  assert.ok(iLaunch > iRemembered && iLaunch > iDevTools && iLaunch > iScan,
    'ensureOnce() 必须**先找、最后才起**新的浏览器（同 profile 的第二个是「转发启动」，起了等于白起）');

  // launch() 成功之后要记住端口（否则下次连不上就找不回来了）
  const launch = src.slice(src.indexOf('async launch()'));
  assert.ok(/rememberPort\(port\)/.test(launch), 'launch() 成功后没有 rememberPort(port)');

  // tick() 的错误**要打日志**（只写 lastError 的话日志里什么都看不到）
  const catchBlock = coord.slice(coord.indexOf('} catch (error) {'));
  assert.ok(/this\.log\('浏览器修复失败:/.test(catchBlock), "coordinator.js 的 tick() 没有把错误打进日志");
});

test('真跑：连接断了之后要连回同一个浏览器（不能再开一个）', async (t) => {
  if (!isWindows) {
    t.skip('只有 Windows 上有意义');
    return;
  }
  const { ManagedBrowser } = require(path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-recovery-'));
  const browser = new ManagedBrowser({ profileDir, log: (m) => console.log('    [browser]', m) });

  try {
    const first = await browser.ensure();
    assert.ok(first && first.client, '起浏览器失败');
    const port = browser.port;
    assert.ok(port > 0, '没记住调试端口');
    console.log('    第一次: 端口', port);

    // 模拟两件事同时发生（这正是真机上发生的那两件）：
    //   ① CDP 连接断了
    //   ② DevToolsActivePort 被「转发启动」的进程删掉了
    first.client.close();
    try {
      fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
    } catch (_) {
      /* ignore */
    }

    const second = await browser.ensure();
    assert.ok(second && second.client, '恢复失败：ensure() 没拿到客户端');
    console.log('    第二次: 端口', browser.port);

    assert.strictEqual(browser.port, port,
      '恢复之后**必须还是同一个浏览器**（端口不该变）—— 变了说明又起了一个');

    const list = browsersForProfile(profileDir);
    assert.strictEqual(list.length, 1,
      `这个 profile 下只该有**一个**浏览器进程，实际有 ${list.length} 个：${JSON.stringify(list)}`);

    // 连得上才算数
    const targets = await second.client.send('Target.getTargets');
    assert.ok(Array.isArray(targets.targetInfos), '连上了但 Target.getTargets 不对');
  } finally {
    // 只杀**用这个临时 profile 的**浏览器（不能碰用户自己的）
    for (const b of browsersForProfile(profileDir)) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${b.pid} -Force`], {
          timeout: 10_000,
          windowsHide: true,
        });
      } catch (_) {
        /* ignore */
      }
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
});

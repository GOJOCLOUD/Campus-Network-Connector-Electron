/**
 * 门禁：浏览器没了的时候，**绝不能**「反反复复拉起浏览器」。
 *
 * ## 它盯的是什么（2026-10-27 18:01 用户真机反馈）
 *
 * 用户原话：「只要我打开了，他就反反复复拉起浏览器，而且拉起浏览器一直都是失败，
 * 根本没有一个窗口，起来的浏览器根本就不能用」。
 *
 * 真机取证（带时间戳观察 + 逐条复现）得到的根因链：
 *
 *   ① **用户关掉 Edge 窗口 ⇒ Edge 退出 ⇒ 软件又偷偷拉起一个新的**
 *      （实测：关窗后约 20 秒弹出一个新 Edge，还带「还原页面」气泡、
 *        之前开的标签页全丢）—— 这就是「反反复复拉起浏览器」。
 *   ② `ensure()` **没有互斥**：主轮询(300ms) / 快轮询 / IPC 三条路各自调
 *      `ensure()`，谁先发现「浏览器没了」谁就起一个 ⇒ 会起好几个。
 *   ③ `findRunningPorts()` 用的是 **`execFileSync`（同步）** ⇒ 把 Electron
 *      主线程卡住最多 15 秒 ⇒ 界面不刷新、CDP 事件不处理、⌃D 的低级键盘钩子
 *      也拿不到回调（Windows 会把超时的钩子摘掉）。
 *   ④ 连「已经在跑的浏览器」也要等 5 秒才放弃 ⇒ 每个候选端口白等 5 秒。
 *   ⑤ 起不来就无限重试，没有上限。
 *   ⑥ Edge 自己的 stdout/stderr 被 `stdio:'ignore'` 丢掉了 ⇒ 出了事日志里
 *      一个字都没有。
 *
 * ## 断言
 *
 *   ① **源码层**：单飞锁 / 快速失败 / 不许同步阻塞 / 留住浏览器自己的输出 /
 *      失败上限 / 记退出码。
 *   ② **真跑一遍**（Windows）：并发调三次 `ensure()` ⇒ **只该起一个浏览器**。
 *
 * 跑法：
 *   node --test tools/verify/verify-browser-loop-guard.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BROWSER_JS = path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js');

const isWindows = process.platform === 'win32';

/** 数一下「用这个 profile 的浏览器」有几个 */
function browsersForProfile(profileDir) {
  const script = [
    "$p = $env:CR_PROFILE",
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine -notmatch '--type=' } |",
    "  ForEach-Object { \"$($_.ProcessId)\" }",
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: Object.assign({}, process.env, { CR_PROFILE: profileDir }),
    });
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

test('源码层：不能有「反反复复拉起」的那几个坑', () => {
  const src = fs.readFileSync(BROWSER_JS, 'utf8');

  // ① 单飞锁：并发的 ensure() 必须共享同一次尝试
  assert.ok(/pendingEnsure/.test(src), 'browser.js 缺少 pendingEnsure（ensure() 没有互斥 ⇒ 并发会起好几个浏览器）');
  assert.ok(/this\.pendingEnsure\s*=\s*this\.ensureOnce\(\)/.test(src),
    'ensure() 没有把实际工作交给 ensureOnce() 并共享那个 Promise');

  // ② 连「已经在跑的浏览器」要快速失败
  const tryAttach = src.slice(src.indexOf('async tryAttach('));
  const m = /timeoutMs\s*=\s*(\d+)/.exec(tryAttach);
  assert.ok(m, 'tryAttach() 没有可调的等待时限');
  assert.ok(Number(m[1]) <= 1000, `tryAttach() 默认要等 ${m[1]}ms，太久了（端口没开就是没开）`);

  // ③ 不许同步阻塞主线程
  //    （只看**真的调用**：`execFileSync(`；注释里提到它不算。）
  assert.ok(!/execFileSync\s*\(/.test(src), 'browser.js 里还有 execFileSync 调用 ⇒ 会把 Electron 主线程卡住最多 15 秒');
  assert.ok(/execFile\(/.test(src), 'browser.js 缺少异步 execFile（扫进程命令行）');

  // ④ 浏览器自己的输出必须留下来
  //    （早先 `stdio:'ignore'` 把它们全丢了 ⇒ 浏览器为什么挂了日志里一个字都没有。）
  assert.ok(/stdio:\s*this\.browserStdio\(\)/.test(src),
    "launch() 没有把浏览器自己的输出留下来（早先是 stdio:'ignore'，全丢了）");
  assert.ok(/browserStdio\(\)/.test(src), 'browser.js 缺少 browserStdio()');
  assert.ok(/browser-stderr\.log/.test(src), 'browser.js 没把浏览器的 stderr 落到文件里');

  // ⑤ 起不来的次数要有上限
  assert.ok(/maxLaunchFailures/.test(src), 'browser.js 缺少 maxLaunchFailures（起不来会无限重试）');
  assert.ok(/已停止重试/.test(src), 'browser.js 没有「已停止重试」的报错文案');

  // ⑥ 记住浏览器进程怎么退的（退出码 0 = 用户自己关了窗口）
  assert.ok(/child\.on\('exit'/.test(src), 'browser.js 没有监听浏览器进程的 exit（分不清「用户关的」和「崩的」）');
  assert.ok(/closedByUser\(\)/.test(src), 'browser.js 缺少 closedByUser()');
});

test('真跑：用户关掉浏览器 ⇒ 认得出是「用户关的」，而且不自动再拉一个', async (t) => {
  if (!isWindows) {
    t.skip('只有 Windows 上有意义');
    return;
  }
  const { ManagedBrowser } = require(path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-exitcode-'));
  const browser = new ManagedBrowser({ profileDir, log: (m) => console.log('    [browser]', m) });

  /** 等浏览器进程退出（最多 20 秒） */
  const waitExit = (b) =>
    new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (b.childExit) {
          clearInterval(timer);
          resolve(b.childExit);
        } else if (Date.now() - started > 20000) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });

  try {
    const { client } = await browser.ensure();
    const exited = waitExit(browser);
    // `Browser.close` = 用户点叉关掉窗口（干净退出 ⇒ 退出码 0）
    try {
      await client.send('Browser.close');
    } catch (_) {
      /* 关连接后会断，忽略 */
    }
    const exit = await exited;
    assert.ok(exit, '等不到浏览器进程退出');
    assert.strictEqual(exit.code, 0,
      `正常关掉浏览器时退出码应该是 0，实际是 ${exit.code}（非 0 ⇒ 分不清「用户关的」和「崩的」）`);
    assert.strictEqual(browser.closedByUser(), true,
      '正常关掉浏览器后，closedByUser() 应该是 true');

    // 崩溃那一条：强杀 ⇒ 退出码非 0 ⇒ **不**算「用户关的」
    const profileDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-kill-'));
    const browser2 = new ManagedBrowser({ profileDir2, log: (m) => console.log('    [browser2]', m) });
    await browser2.ensure();
    const exited2 = waitExit(browser2);
    const pid = browser2.process.pid;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
      timeout: 15000,
      windowsHide: true,
    });
    const exit2 = await exited2;
    assert.ok(exit2, '等不到被强杀的浏览器进程退出');
    assert.notStrictEqual(exit2.code, 0,
      '被强杀的浏览器退出码不该是 0（否则「崩了」也会被当成「用户关的」）');
    assert.strictEqual(browser2.closedByUser(), false,
      '浏览器被强杀（崩了）时，closedByUser() 应该是 false ⇒ 仍然自动恢复');

    for (const pid2 of browsersForProfile(profileDir2)) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid2} -Force`], {
          timeout: 10000,
          windowsHide: true,
        });
      } catch (_) {
        /* ignore */
      }
    }
    try {
      fs.rmSync(profileDir2, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  } finally {
    for (const pid of browsersForProfile(profileDir)) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
          timeout: 10000,
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

test('真跑：并发调三次 ensure() 只该起一个浏览器', async (t) => {
  if (!isWindows) {
    t.skip('只有 Windows 上有意义');
    return;
  }
  const { ManagedBrowser } = require(path.join(ROOT, 'src', 'features', 'chromium-repair', 'browser.js'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-loop-'));
  const browser = new ManagedBrowser({ profileDir, log: (m) => console.log('    [browser]', m) });

  try {
    // 三个并发调用 —— 早先没有互斥锁时，它们会各起一个 Edge
    const results = await Promise.all([
      browser.ensure(),
      browser.ensure(),
      browser.ensure(),
    ]);
    for (const r of results) {
      assert.ok(r && r.client, '并发 ensure() 有一个没拿到客户端');
    }
    assert.strictEqual(browser.port, results[0].client ? browser.port : 0, '端口读不出来');

    const list = browsersForProfile(profileDir);
    assert.strictEqual(list.length, 1,
      `并发 ensure() 起了 ${list.length} 个浏览器（应该只有 1 个）：${JSON.stringify(list)}`);
    console.log('    并发三次 ensure() ⇒ 只起了', list.length, '个浏览器，端口', browser.port);
  } finally {
    for (const pid of browsersForProfile(profileDir)) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
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

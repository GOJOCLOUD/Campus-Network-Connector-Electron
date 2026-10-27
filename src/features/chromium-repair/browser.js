/**
 * 自己起一个浏览器，并连上它的调试端口。
 *
 * ## 为什么是「自己起」而不是「接管用户平时那个」
 *
 * Chromium ≥136 对**默认 profile** 直接忽略调试端口与 pipe —— 想接管用户
 * 日常那个浏览器，就得改他的启动方式（那就不是「零点击」了）。
 * 所以本产品**自己起一个浏览器、用自己的 profile**：
 *
 *   - 绑定性满分：那个 profile 只有本程序碰得到，别人换不掉我们的守卫
 *   - 零点击：用户只要点一下开关，浏览器就带着守卫起来了
 *   - 代价：用户得在**这个**窗口里用；首次要扫码登录一次（用户已确认：只需扫码）
 *
 * ## 调试端口的连法
 *
 * - 端口写在 `--user-data-dir` 旁边（Chromium 自己会写 `DevToolsActivePort` 文件）
 *   ⇒ 程序重启后能找回**上次那个还在跑的**浏览器，不用再开一个。
 * - **绝不能**加 `--remote-allow-origins=*`：那等于把调试端口对任意网页开放。
 *   Node 的 WebSocket 不发 Origin 头，Chromium 天然放行（已实测）。
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { CdpClient, waitForEndpoint } = require('./cdp');

/** 浏览器候选：优先 Edge（我们验证过），再退到 Chrome */
const BROWSERS = [
  {
    id: 'edge',
    label: 'Edge',
    paths: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      '%LOCALAPPDATA%/Microsoft/Edge/Application/msedge.exe',
    ],
  },
  {
    id: 'chrome',
    label: 'Chrome',
    paths: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe',
    ],
  },
];

/** 把 %VAR% 展开成真实路径 */
function expandPath(p) {
  return p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name) => process.env[name] || all);
}

/** 找一个没人占用的本地端口 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 找出本机装着的浏览器（返回第一个存在的） */
function findBrowser() {
  for (const browser of BROWSERS) {
    for (const candidate of browser.paths) {
      const full = expandPath(candidate);
      try {
        if (fs.existsSync(full)) return { ...browser, executable: full };
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * 自己起的那台浏览器。
 */
class ManagedBrowser {
  /**
   * @param {{profileDir?:string, log?:(m:string)=>void}} [opts]
   */
  constructor({ profileDir, log } = {}) {
    this.log = log || (() => {});
    this.profileDir = profileDir || path.join(os.tmpdir(), 'cnc-browser-profile');
    this.process = null;
    this.client = null;
    this.browser = null;
    this.port = null;
    this.startedByUs = false;
    /** 单飞：并发的 ensure() 共享同一次尝试 */
    this.pendingEnsure = null;
    /** 我们起的浏览器进程怎么退的：{code, signal, at} */
    this.childExit = null;
    /** 连续几次起不来浏览器（到上限就不再重试） */
    this.launchFailures = 0;
    /** 连续失败的上限 */
    this.maxLaunchFailures = 3;
    /** 上一次起不来的原因（给界面/日志看的原话） */
    this.lastLaunchError = '';
    /** 上一次是我们起的那个浏览器**被用户关掉了窗口**（退出码 0）吗？ */
    this.userClosed = false;
    /**
     * 「上一个进程的退出结果」**不再参考**（用户点了「重新打开浏览器」）。
     *
     * 为什么需要它：`refreshExitState()` 会从**上一个**进程（退出码 0）
     * 再推一次「用户关的」⇒ 刚点完「重新打开」就又不弹了。
     */
    this.exitStateIgnored = false;
    /**
     * 用户自己关掉的窗口，要不要**自动**再弹一个？
     *
     * 由协调器按产品口径下发（默认 false = 不自动弹）。
     * ⚠️ 判定放在**真正起浏览器之前**才有效（见 ensureOnce 里的注释）。
     */
    this.autoReopen = false;
  }

  /**
   * 我们自己记的端口文件 —— 比 Chromium 自己写的 DevToolsActivePort 可靠。
   *
   * 为什么必须自己记:同 profile 的第二个浏览器是「转发启动」(Chromium 单例),
   * 它退出时会把 Chromium 写的 DevToolsActivePort **删掉**
   * ⇒ 正好在我们最需要找回「上次那个浏览器」的时候,那个文件没了。
   * (2026-10-27 真机踩过:每 29 秒重开一个 Edge,还再也连不回去。)
   */
  portFile() {
    return path.join(this.profileDir, 'simuinput-cdp-port.txt');
  }

  /** 记住我们起的那个浏览器的端口 */
  rememberPort(port) {
    try {
      fs.mkdirSync(this.profileDir, { recursive: true });
      fs.writeFileSync(this.portFile(), String(port), 'utf8');
    } catch (_) {
      /* ignore */
    }
  }

  /** 读回我们自己记的端口 */
  readRememberedPort() {
    try {
      const port = Number(String(fs.readFileSync(this.portFile(), 'utf8')).trim());
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 扫进程列表，找「正在用我们这个 profile」的浏览器，取它的调试端口。
   *
   * 这是最后一道兜底:前两种办法都拿不到时,至少别再去起一个「转发启动」的。
   * profile 路径经**环境变量**传进去(命令行里有中文/空格时引号不可靠)。
   */
  findRunningPorts() {
    const script = [
      "$p = $env:CR_PROFILE",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" |",
      "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine -notmatch '--type=' } |",
      "  ForEach-Object { if ($_.CommandLine -match '--remote-debugging-port=(\\d+)') { $Matches[1] } }",
    ].join('\n');
    // ⚠️ **必须异步**：早先用 execFileSync 同步扫，**把 Electron 主线程卡住最多 15 秒**。
    // 主线程一卡，界面不刷新、CDP 事件不处理、⌃D 的低级键盘钩子也拿不到回调
    // (Windows 会把超时的钩子摘掉) ⇒ 整个软件像死了一样。
    // (2026-10-27 真机踩过。)
    return new Promise((resolve) => {
      let settled = false;
      const done = (ports) => {
        if (settled) return;
        settled = true;
        resolve(ports);
      };
      let child;
      try {
        child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
          env: Object.assign({}, process.env, { CR_PROFILE: this.profileDir }),
        });
      } catch (_) {
        done([]);
        return;
      }
      let out = '';
      if (child.stdout) child.stdout.on('data', (c) => { out += c; });
      child.on('error', () => done([]));
      child.on('close', () => {
        const ports = [];
        for (const line of String(out).split(/\r?\n/)) {
          const port = Number(String(line).trim());
          if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port);
        }
        done(ports);
      });
    });
  }

  /** 从 profile 目录里读出上次那个浏览器的调试端口（Chromium 自己写的） */
  readPortFromProfile() {
    try {
      const file = path.join(this.profileDir, 'DevToolsActivePort');
      const raw = fs.readFileSync(file, 'utf8');
      const port = Number(String(raw).split(/\r?\n/)[0]);
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 试着连上「已经开着的那台」；连不上返回 null。
   *
   * @param {number} port
   * @param {{timeoutMs?:number}} [opts] 等调试端口的时限。
   *   连「**已经在跑的**浏览器」必须**短**（默认 800ms）：端口没开就是没开，
   *   早先等 5 秒 ⇒ 每个候选端口白白耗掉 5 秒，用户看到的是「半分钟才动一下」。
   */
  async tryAttach(port, { timeoutMs = 800 } = {}) {
    try {
      const version = await waitForEndpoint(port, timeoutMs);
      const client = await CdpClient.connect(version.webSocketDebuggerUrl, { log: this.log, timeoutMs: 5000 });
      this.client = client;
      this.port = port;
      this.browser = version;
      this.startedByUs = false;
      this.log(`已连上在跑的浏览器（端口 ${port}）`);
      return client;
    } catch (_) {
      return null;
    }
  }

  /**
   * 确保有一台可用的浏览器，并返回 CDP 客户端。
   * @returns {Promise<{client: CdpClient, started: boolean, browser: string}>}
   */
  async ensure() {
    if (this.client && !this.client.closed) {
      return { client: this.client, started: this.startedByUs, browser: this.browserLabel() };
    }
    // ⚠️ **单飞**：主轮询(300ms) / 快轮询 / IPC 手动检查 三条路都会调 ensure()。
    //   早先没有这把锁 ⇒ 谁先发现「浏览器没了」谁就起一个 Edge ⇒ 起好几个，
    //   用户看到的就是「反反复复拉起浏览器」。
    if (this.pendingEnsure) return this.pendingEnsure;
    this.pendingEnsure = this.ensureOnce().finally(() => {
      this.pendingEnsure = null;
    });
    return this.pendingEnsure;
  }

  /**
   * 上一次是我们起的那个浏览器**被用户关掉了窗口**吗？
   *
   * 退出码 0 = 用户关的；非 0 = 崩了。区分得出来，
   * 才能「用户关的不再弹给他看，崩了的才自动恢复」。
   */
  closedByUser() {
    return this.userClosed === true;
  }

  /** 用户点了「重新打开浏览器」⇒ 把「用户关的」这个状态清掉 */
  clearClosedByUser() {
    this.userClosed = false;
    // ⚠️ 连「上一个进程的退出结果」一起作废：
    //   refreshExitState() 是从**那个**进程推出来的 ⇒ 不作废的话，
    //   刚点完「重新打开浏览器」，下一轮又被推回「用户关的」⇒ 又不弹了。
    this.exitStateIgnored = true;
  }

  /**
   * 把「我们起的那个浏览器进程怎么退的」问清楚。
   *
   * ⚠️ **为什么不能只看 `userClosed` 标志**：
   *   那个标志是在 `child.on('exit')` 里设的，而 'exit' 事件是 Node 的事件循环
   *   **异步**派发的 ⇒ 进程已经死了、事件还没送到时，标志还是 false
   *   ⇒ 就会「明明是用户关掉了窗口，却又弹了一个」。
   *   （2026-10-27 CI 实测：`Browser.close` 之后 **2 秒**退出事件才到，
   *     而判断发生在这之前 ⇒ 门禁红、用户那边就是「又弹了一个」。）
   *
   * 所以这里**把退出码等出来**再决定。
   *
   * @param {{waitMs?:number}} [opts] 最多等多久（毫秒）
   * @returns {Promise<boolean>} true = 用户关掉了窗口（退出码 0）
   */
  async refreshExitState({ waitMs = 3000 } = {}) {
    if (this.exitStateIgnored) return false;
    const child = this.process;
    if (!child) return false;
    if (child.exitCode === null && child.signalCode === null) {
      // 退出码还没到 ⇒ 进程可能刚死、事件还没派发 ⇒ 等它（最多 waitMs）。
      await this.waitChildExit(child, waitMs);
    }
    if (child.exitCode === null && child.signalCode === null) return false;
    // 只认「当前这个进程」的退出（换了浏览器之后老进程的 exit 事件还会晚到一步）
    if (this.process === child) {
      this.userClosed = child.exitCode === 0;
    }
    return this.userClosed;
  }

  /**
   * 等 child 的退出结果（最多 waitMs 毫秒）。
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} waitMs
   */
  waitChildExit(child, waitMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    if (!waitMs) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', finish);
      child.once('close', finish);
      child.once('error', finish);
    });
  }

  /**
   * 真的找不到了 —— 这才自己起一个。
   * @returns {Promise<{client:import('./cdp').CdpClient, started:boolean, browser:string}>}
   */
  async ensureOnce() {
    // 找「已经开着的那台」—— 顺序按可靠程度:
    //   ① 我们自己记的端口（我们起的那个，最可靠）
    //   ② Chromium 写的 DevToolsActivePort（别人起的那个）
    //   ③ 扫进程命令行（前两个都拿不到时的兜底）
    //
    // ⚠️ 在这三条都试过之前**绝不能**去起新的:
    // 同 profile 的第二个浏览器是「转发启动」(Chromium 单例)—— 它不开自己的
    // 调试端口，退出时还会把 DevToolsActivePort 删掉
    // ⇒ 起了等于白起，还把「找回上次那个」这条路堵死。
    // (2026-10-27 真机踩过：每 29 秒重开一个 Edge，用户窗口一个一个弹出来，
    //  而且**再也没连回那个 Edge** ⇒ 新标签页没守卫、复制出来还是密文。)
    for (const port of [this.readRememberedPort(), this.readPortFromProfile()]) {
      if (!port) continue;
      const attached = await this.tryAttach(port);
      if (attached) {
        this.rememberPort(port);
        return { client: attached, started: false, browser: this.browserLabel() };
      }
    }
    // 扫进程命令行：可能扫出多个（其中一个是刚转发出去的、端口没真开）⇒ 逐个试
    for (const port of await this.findRunningPorts()) {
      const attached = await this.tryAttach(port, { timeoutMs: 1500 });
      if (attached) {
        this.rememberPort(port);
        return { client: attached, started: false, browser: this.browserLabel() };
      }
    }
    // ⚠️ **这个判定必须放在起浏览器之前**（而不是只在 tick 开头看一次）：
    //    tick 每 300ms 一轮，而浏览器的「进程退出事件」与 tick 之间有时间差
    //    ⇒ 只在 tick 开头判会漏掉「刚好在那一轮之前关掉」的情况
    //    ⇒ 2026-10-27 真机复验就是这样又弹了一个（明明已经认出是「用户关的」）。
    //
    //    而且这里**不是只看标志**，而是**把退出码等出来**再看
    //    （'exit' 事件是异步派发的，可能比这里晚到 2 秒 —— CI 实测过）。
    if (!this.autoReopen && await this.refreshExitState({ waitMs: 3000 })) {
      const error = new Error('浏览器被用户关掉了（不自动重开）');
      error.code = 'BROWSER_CLOSED_BY_USER';
      throw error;
    }

    // 真的没有 ⇒ 这才自己起一个
    if (this.launchFailures >= this.maxLaunchFailures) {
      throw new Error(
        `连续 ${this.launchFailures} 次起不来浏览器，已停止重试：${this.lastLaunchError || '原因未知'}`,
      );
    }
    await this.launch();
    return { client: this.client, started: this.startedByUs, browser: this.browserLabel() };
  }

  browserLabel() {
    if (!this.browser) return '未知浏览器';
    const name = this.browser['Browser'] || '';
    return name.replace(/^[A-Za-z]+\//, '') || '浏览器';
  }

  /**
   * 浏览器进程的 stdout/stderr 落到 profile 目录里。
   *
   * 早先 `stdio:'ignore'` 把它们全丢了 ⇒ 浏览器为什么起不来、为什么没窗口，
   * 日志里一个字都没有 (2026-10-27 真机查了半天就是这个坑)。
   */
  browserStdio() {
    try {
      fs.mkdirSync(this.profileDir, { recursive: true });
      const out = fs.openSync(path.join(this.profileDir, 'browser-stdout.log'), 'a');
      const err = fs.openSync(path.join(this.profileDir, 'browser-stderr.log'), 'a');
      return ['ignore', out, err];
    } catch (_) {
      return 'ignore';
    }
  }

  /** 启动浏览器并连上 */
  async launch() {
    const found = findBrowser();
    if (!found) {
      throw new Error('找不到 Edge 或 Chrome（本机没装或装在了没覆盖到的位置）');
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    const port = await findFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-default-apps',
      '--restore-last-session',
      'about:blank',
    ];
    this.log(`启动 ${found.label}：${found.executable}（端口 ${port}）`);
    const child = spawn(found.executable, args, { detached: true, stdio: this.browserStdio() });
    child.unref();
    this.process = child;
    this.startedByUs = true;
    this.port = port;
    this.childExit = null;
    // 新起了一个浏览器 ⇒ 之前那个的退出结果**不再作数**，
    // 「用户关的」这个状态也要清掉（不然新浏览器一起来就显示「浏览器已关闭」）。
    this.userClosed = false;
    this.exitStateIgnored = false;
    // 记下它**怎么退的**：退出码 0 = 用户自己关了窗口；非 0 = 崩了/被杀了。
    // 区分得出来，才能「用户关的不再弹给他看，崩了的才自动恢复」。
    child.on('exit', (code, signal) => {
      this.childExit = { code, signal, at: Date.now() };
      // 退出码 0 = **用户关掉了窗口**（干净退出）；非 0 = 崩了/被强杀。
      // ⚠️ 只认「当前这个进程」的退出 —— 换了浏览器之后老进程的 exit 事件
      //    还会晚到一步，别把它算到新浏览器头上。
      if (this.process === child) {
        this.userClosed = code === 0;
        this.log(
          `浏览器进程退出：code=${code} signal=${signal || '无'}`
          + (code === 0 ? '（用户关掉了窗口）' : '（异常退出）'),
        );
      } else {
        this.log(`旧的浏览器进程退出：code=${code} signal=${signal || '无'}`);
      }
    });

    let version;
    try {
      version = await waitForEndpoint(port, 25_000);
      this.launchFailures = 0;
      this.lastLaunchError = '';
    } catch (error) {
      this.launchFailures += 1;
      this.lastLaunchError = String((error && error.message) || error);
      // 我们起的这个进程可能只是「转发」给了一个**已经在跑**的浏览器
      // （同 profile 的单例行为）⇒ 真正在服务的那个才是我们要连的。
      for (const running of await this.findRunningPorts()) {
        if (running === port) continue;
        const attached = await this.tryAttach(running, { timeoutMs: 2000 });
        if (attached) {
          this.log(`新起的浏览器没开自己的调试端口（端口 ${port}），改连已经在跑的那个（端口 ${running}）`);
          this.startedByUs = false;
          this.rememberPort(running);
          return attached;
        }
      }
      this.log(`浏览器起不来（连续第 ${this.launchFailures} 次）：${this.lastLaunchError}`);
      throw error;
    }
    this.client = await CdpClient.connect(version.webSocketDebuggerUrl, { log: this.log });
    this.browser = version;
    this.rememberPort(port);
    return this.client;
  }

  /** 浏览器还在吗（进程没退出、调试端口还通） */
  isRunning() {
    return !!(this.client && !this.client.closed);
  }

  /** 关掉连接（不关浏览器 —— 那是用户的窗口了） */
  disconnect() {
    try {
      this.client?.close();
    } catch (_) {
      /* ignore */
    }
    this.client = null;
  }

  /**
   * 把**自己起的**那台浏览器关掉。
   * 只有在明确要求时调用（例如程序退出且浏览器仍是本程序起的）。
   */
  async shutdown() {
    try {
      await this.client?.send('Browser.close');
    } catch (_) {
      /* ignore */
    }
    this.disconnect();
    if (this.process) {
      try {
        this.process.kill();
      } catch (_) {
        /* ignore */
      }
      this.process = null;
    }
  }
}

module.exports = { ManagedBrowser, findBrowser, findFreePort, BROWSERS };

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
const { spawn } = require('child_process');
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

  /** 试着连上「已经开着的那台」；连不上返回 null */
  async tryAttach(port) {
    try {
      const version = await waitForEndpoint(port, 1500);
      const client = await CdpClient.connect(version.webSocketDebuggerUrl, { log: this.log });
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
    // 1) 先试上次那个还在跑的
    const remembered = this.readPortFromProfile();
    if (remembered) {
      const attached = await this.tryAttach(remembered);
      if (attached) {
        return { client: attached, started: false, browser: this.browserLabel() };
      }
    }
    // 2) 没有就自己起一个
    await this.launch();
    return { client: this.client, started: true, browser: this.browserLabel() };
  }

  browserLabel() {
    if (!this.browser) return '未知浏览器';
    const name = this.browser['Browser'] || '';
    return name.replace(/^[A-Za-z]+\//, '') || '浏览器';
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
    const child = spawn(found.executable, args, { detached: true, stdio: 'ignore' });
    child.unref();
    this.process = child;
    this.startedByUs = true;
    this.port = port;

    const version = await waitForEndpoint(port, 25_000);
    this.client = await CdpClient.connect(version.webSocketDebuggerUrl, { log: this.log });
    this.browser = version;
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

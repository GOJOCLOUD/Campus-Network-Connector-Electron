/**
 * 最小 CDP 客户端（Chrome DevTools Protocol over WebSocket）。
 *
 * 只实现我们需要的那几件事：
 *   - 连上浏览器的调试端口（`/json/version` 给的 webSocketDebuggerUrl）
 *   - 发命令、收结果（按 id 配对）
 *   - 收事件（按 method 分发）
 *   - 带 sessionId 的**扁平会话**（`Target.attachToTarget {flatten:true}`）
 *     ⇒ 每个标签页、每个 iframe 都是一条独立会话，但共用同一条 WebSocket
 *
 * 为什么不用第三方库：主进程里 Node 自带 `WebSocket`（Electron 41 / Node 22 起是全局），
 * 自己包一层就够了，不给安装包添依赖。
 *
 * 为什么**不需要** `--remote-allow-origins`：
 *   Node 的 WebSocket **不发 Origin 头**，而 Chromium 的调试端口只在
 *   「带了 Origin 且不在白名单」时才拒绝 ⇒ 不带 Origin 天然放行。
 *   反过来说：产品里**绝不能**加 `--remote-allow-origins=*` ——
 *   那等于把调试端口对**任意网页**开放，谁都能连上来操控用户的浏览器。
 *   （实测：Edge 156 不带该参数，Node 的 WebSocket 照连不误。）
 */
const DEFAULT_TIMEOUT_MS = 20_000;

class CdpClient {
  /**
   * @param {WebSocket} ws 已连上的 WebSocket
   * @param {{log?:(m:string)=>void}} [opts]
   */
  constructor(ws, { log } = {}) {
    this.ws = ws;
    this.log = log || (() => {});
    this.nextId = 0;
    /** id -> {resolve, reject, timer} */
    this.pending = new Map();
    /** method -> handler[]（**可以有多个**订阅者，后注册的不能把前面的顶掉） */
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => this._onClose(new Error('CDP 连接已关闭')));
    ws.addEventListener('error', () => this._onClose(new Error('CDP 连接出错')));
  }

  /** 连上并返回客户端 */
  static async connect(url, { log, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('当前 Node 运行时没有全局 WebSocket，无法使用 CDP');
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP 失败')); }, { once: true });
    });
    return new CdpClient(ws, { log });
  }

  _onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (_) {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${msg.error.message}（${msg.error.code}）`));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method);
      if (list) {
        for (const handler of list.slice()) {
          try {
            handler(msg.params || {}, msg.sessionId);
          } catch (error) {
            this.log(`CDP 事件处理出错 ${msg.method}: ${error && error.message}`);
          }
        }
      }
    }
  }

  _onClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 订阅一个事件；返回取消订阅的函数 */
  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      const cur = this.handlers.get(method);
      if (!cur) return;
      const at = cur.indexOf(handler);
      if (at >= 0) cur.splice(at, 1);
    };
  }

  /**
   * 发一条命令。
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] 扁平会话 id（浏览器级命令不用传）
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 等浏览器的调试端口起来，返回 `/json/version` 的内容。
 * @param {number} port
 * @param {number} [timeoutMs]
 */
async function waitForEndpoint(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = String((error && error.message) || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`浏览器调试端口没起来（127.0.0.1:${port}）：${lastError}`);
}

module.exports = { CdpClient, waitForEndpoint, DEFAULT_TIMEOUT_MS };

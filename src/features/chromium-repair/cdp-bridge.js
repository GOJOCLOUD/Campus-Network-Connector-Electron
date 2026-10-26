/**
 * CDP 版「桥」—— mac 线 `safari-repair/bridge.js` 的 Windows 对位物。
 *
 * ## 两条线各自怎么驱动页面
 *
 * |                | mac                                | Windows                        |
 * | -------------- | ---------------------------------- | ------------------------------ |
 * | 在页面里执行 JS | Apple Events（`runJsIn`）            | CDP `Runtime.evaluate`         |
 * | 列出标签页      | Apple Events 问 Safari             | CDP `Target.getTargets`        |
 * | 注入守卫        | 在顶层文档 eval，再由 frame-bridge 递归 | `Page.addScriptToEvaluateOnNewDocument`（document_start，**每个 frame 都装**）|
 *
 * ## 页面侧那套（守卫 + frame-bridge）是**共用资产**，一行都没改
 *
 * `frame-bridge.ts` 只在页面里干活（`report/take/setMapping/resync`），
 * 不依赖任何传输方式 —— 它本来就是给「主进程在页面里执行 JS」用的。
 * 所以 Windows 线只换「谁来执行 JS」，页面侧那套照抄。
 *
 * ## 一个刻意的设计：frame-bridge **只装在顶层**
 *
 * 守卫在**每个 frame** 都装（CDP 的 document_start 注入天然如此），
 * 但 frame-bridge 只装顶层 —— 这样子 frame 的守卫上报时，
 * 会顺着 parent 一路找到**顶层**那个 bridge（和 mac 上一样）。
 * 若每个 frame 都装，子 frame 的上报会停在它自己那一层，顶层反而收不到。
 */
const { CdpClient } = require('./cdp');

/** 顶层页面里取状态的那段脚本（对应 mac 的 pollState） */
function buildPollScript({ resync }) {
  return `(function(){
  var g = window.__copyRepairGuard;
  var out = {
    guard: !!g,
    guardVersion: g ? (g.version || 0) : 0,
    pending: null,
    collect: 'none',
    frames: [],
    unrepaired: [],
    resync: 0,
    url: String(location.href || ''),
  };
  ${resync ? `try {
    var rb = window.__copyRepairBridge;
    if (rb && typeof rb.resync === 'function') { out.resync = rb.resync(); }
    else if (typeof window.__copyRepairResync === 'function') { window.__copyRepairResync(); out.resync = 1; }
  } catch (e) { }` : ''}
  if (g) {
    if (window.__copyRepairCollect) {
      try { out.collect = String(window.__copyRepairCollect()); } catch (e) { out.collect = 'error'; }
    }
    if (g.pending && g.pending.groups && g.pending.groups.length > 0) {
      out.pending = { groups: g.pending.groups };
      g.pending = null;
      g.lastCollectedText = '';
      g.lastCollectedScope = '';
    }
    if (window.__copyRepairBridge && typeof window.__copyRepairBridge.take === 'function') {
      try {
        var taken = window.__copyRepairBridge.take();
        out.frames = taken.pending || [];
        out.unrepaired = taken.unrepaired || [];
      } catch (e) { out.frames = []; out.unrepaired = []; }
    }
  }
  return JSON.stringify(out);
})()`;
}

/**
 * 把守卫与 frame-bridge 拼成一份「document_start 脚本」。
 * @param {string} guardSource       页面守卫（vendor/page-guard.js）
 * @param {string} frameBridgeSource 顶层桥（vendor/frame-bridge.js）
 */
function buildInjectionSource(guardSource, frameBridgeSource) {
  return `(function(){
try {
${guardSource}
} catch (e) { window.__copyRepairGuardError = String(e); }
try {
  if (window.top === window) {
${frameBridgeSource}
    window.__copyRepairInstallFrameBridge({ guardSource: ${JSON.stringify(guardSource)} });
  }
} catch (e) { window.__copyRepairBridgeError = String(e); }
})();`;
}

class CdpBridge {
  /**
   * @param {{client: import('./cdp').CdpClient, injectionSource?:string, log?:(m:string)=>void}} opts
   */
  constructor({ client, injectionSource, log } = {}) {
    this.client = client;
    this.injectionSource = injectionSource || '';
    this.log = log || (() => {});
    /** targetId -> { id, url, title, sessionId, contexts:Set<number> } */
    this.targets = new Map();
    /** targetId -> 数字序号（1 起），给上层当「标签页号」用 */
    this.ordinals = new Map();
    this.nextOrdinal = 1;
    this.disposed = false;

    this.client.on('Target.attachedToTarget', (params) => {
      this._onAttached(params);
    });
    this.client.on('Target.detachedFromTarget', (params) => {
      const id = params.targetId || (this.targets.get(params.sessionId) || {}).id;
      if (id) this.targets.delete(id);
    });
    // 标签页的 URL 是在**导航之后**才变的（attach 时还是 about:blank），
    // 不订阅这个事件就永远只知道它叫 about:blank ⇒ 「按站点找标签」永远找不到。
    this.client.on('Target.targetInfoChanged', (params) => {
      const target = this.targets.get(params.targetInfo && params.targetInfo.targetId);
      if (!target) return;
      if (params.targetInfo.url) target.url = params.targetInfo.url;
      if (params.targetInfo.title) target.title = params.targetInfo.title;
    });
    this.client.on('Runtime.executionContextCreated', (params, sessionId) => {
      const target = this._targetBySession(sessionId);
      if (target) target.contexts.add(params.context.uniqueContextId);
    });
    this.client.on('Runtime.executionContextDestroyed', (params, sessionId) => {
      const target = this._targetBySession(sessionId);
      if (target) target.contexts.delete(params.contextId);
    });
  }

  _targetBySession(sessionId) {
    for (const target of this.targets.values()) {
      if (target.sessionId === sessionId) return target;
    }
    return null;
  }

  /** 记住一个 target，并给它一个稳定的数字序号 */
  _remember(targetInfo, sessionId) {
    const existing = this.targets.get(targetInfo.targetId);
    if (existing) {
      existing.sessionId = sessionId;
      existing.url = targetInfo.url || existing.url;
      existing.title = targetInfo.title || existing.title;
      return existing;
    }
    // 序号只给**页面**标签页用：后台页/扩展/service worker 也占序号的话，
    // 序号会变得又大又稀（实测跳到 8），日志和「按站点找标签」都不好读。
    const isPage = targetInfo.type === 'page';
    const ordinal = isPage ? this.nextOrdinal : 0;
    if (isPage) this.nextOrdinal += 1;
    this.ordinals.set(targetInfo.targetId, ordinal);
    const target = {
      id: targetInfo.targetId,
      ordinal,
      url: targetInfo.url || '',
      title: targetInfo.title || '',
      type: targetInfo.type,
      sessionId,
      contexts: new Set(),
    };
    this.targets.set(targetInfo.targetId, target);
    return target;
  }

  async _onAttached(params) {
    const { sessionId, targetInfo } = params;
    const target = this._remember(targetInfo, sessionId);
    if (targetInfo.type !== 'page') {
      try {
        await this.client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    try {
      await this.client.send('Page.enable', {}, sessionId);
      await this.client.send('Runtime.enable', {}, sessionId);
      await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source: this.injectionSource }, sessionId);
    } catch (error) {
      this.log(`标签页 ${target.ordinal} 准备失败：${error && error.message}`);
    }
    try {
      await this.client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    } catch (_) {
      /* ignore */
    }
  }

  /** 装好监听：自动挂接新标签页 + 补挂已经存在的 */
  async setup() {
    await this.client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await this.client.send('Target.setDiscoverTargets', { discover: true });
    // 已经开着的标签页（程序重启、浏览器没关）要补挂一次
    const { targetInfos } = await this.client.send('Target.getTargets', {});
    for (const info of targetInfos || []) {
      if (info.type !== 'page') continue;
      if (this.targets.has(info.targetId)) continue;
      try {
        const { sessionId } = await this.client.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true,
        });
        const target = this._remember(info, sessionId);
        await this.client.send('Page.enable', {}, sessionId);
        await this.client.send('Runtime.enable', {}, sessionId);
        await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source: this.injectionSource }, sessionId);
        try {
          await this.client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        } catch (_) {
          /* ignore */
        }
        this.log(`补挂标签页 ${target.ordinal}：${String(info.url).slice(0, 60)}`);
      } catch (error) {
        this.log(`补挂标签页失败：${error && error.message}`);
      }
    }
  }

  /** 页面标签页列表（对应 mac 的 listTabs） */
  listTabs() {
    const out = [];
    for (const target of this.targets.values()) {
      if (target.type !== 'page') continue;
      out.push({
        window: 1,
        index: target.ordinal,
        url: target.url,
        targetId: target.id,
        title: target.title,
        sessionId: target.sessionId,
      });
    }
    return out;
  }

  /** 按 URL 前缀找标签页（对应 mac 的 findTabByUrl） */
  findTabByUrl(prefix) {
    if (!prefix) return -1;
    for (const target of this.targets.values()) {
      if (target.type !== 'page') continue;
      if (String(target.url || '').includes(prefix)) return target.ordinal;
    }
    return -1;
  }

  /** 序号 → target */
  targetByOrdinal(ordinal) {
    for (const target of this.targets.values()) {
      if (target.ordinal === ordinal) return target;
    }
    return null;
  }

  /**
   * 读一个标签页的状态（对应 mac 的 pollState）。
   * @param {{ordinal:number, resync?:boolean}} param
   */
  async pollState({ ordinal, resync = false } = {}) {
    const target = this.targetByOrdinal(ordinal);
    if (!target || !target.sessionId) {
      return { guard: false, pending: null, collect: 'evaluate-failed', frames: [], unrepaired: [], url: '' };
    }
    try {
      const result = await this.client.send(
        'Runtime.evaluate',
        { expression: buildPollScript({ resync }), returnByValue: true },
        target.sessionId,
      );
      const value = result && result.result ? result.result.value : null;
      if (!value) {
        return { guard: false, pending: null, collect: 'parse-failed', frames: [], unrepaired: [], url: '' };
      }
      const parsed = JSON.parse(value);
      if (parsed.url) target.url = parsed.url;
      return parsed;
    } catch (error) {
      return {
        guard: false,
        pending: null,
        collect: 'evaluate-failed',
        frames: [],
        unrepaired: [],
        url: target.url || '',
        error: String((error && error.message) || error),
      };
    }
  }

  /**
   * **立刻**把守卫装进当前这个文档。
   *
   * 为什么需要这一步：`Page.addScriptToEvaluateOnNewDocument` 只对**之后**的
   * 导航生效 —— 已经打开的页面不会因为它而重新执行守卫。
   * mac 上是 `runJsIn`（当场 eval），所以那边不需要这一步；CDP 这边必须补上，
   * 否则「打开开关 → 已经在开着的标签页」这一路是失效的。
   */
  async injectNow(ordinal) {
    const target = this.targetByOrdinal(ordinal);
    if (!target || !target.sessionId || !this.injectionSource) return 'NO-TARGET';
    try {
      const result = await this.client.send(
        'Runtime.evaluate',
        { expression: this.injectionSource, returnByValue: true },
        target.sessionId,
      );
      const err = result && result.result ? result.result.value : null;
      if (err && typeof err === 'object' && (err.__copyRepairGuardError || err.__copyRepairBridgeError)) {
        return 'INJECT-ERROR';
      }
      return 'OK';
    } catch (error) {
      return 'FAILED:' + String((error && error.message) || error);
    }
  }

  /** 在标签页里执行一段 JS（调试用） */
  async evaluate(ordinal, expression) {
    const target = this.targetByOrdinal(ordinal);
    if (!target || !target.sessionId) return null;
    const result = await this.client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      target.sessionId,
    );
    return result && result.result ? result.result.value : null;
  }

  /** 下发映射（对应 mac 的 setMapping） */
  async setMapping({ ordinal, scopeKey, mapping }) {
    const target = this.targetByOrdinal(ordinal);
    if (!target || !target.sessionId) return 'NO-TARGET';
    const expression = `(function(){
      var b = window.__copyRepairBridge;
      if (b && typeof b.setMapping === 'function') return 'FRAMES:' + b.setMapping(${JSON.stringify(scopeKey)}, ${JSON.stringify(mapping)});
      var g = window.__copyRepairGuard;
      if (!g) return 'NO-GUARD';
      if (!window.__copyRepairSetMapping) return 'NO-API';
      return window.__copyRepairSetMapping(${JSON.stringify(scopeKey)}, ${JSON.stringify(mapping)});
    })()`;
    try {
      const result = await this.client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        target.sessionId,
      );
      const value = result && result.result ? result.result.value : 'FAILED';
      return value === undefined || value === null ? 'FAILED' : String(value);
    } catch (error) {
      return 'FAILED:' + String((error && error.message) || error);
    }
  }

  dispose() {
    this.disposed = true;
  }
}

module.exports = { CdpBridge, buildInjectionSource, buildPollScript };

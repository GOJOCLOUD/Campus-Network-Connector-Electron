/**
 * Windows 线的注入协调器 —— mac 线 `safari-repair/coordinator.js` 的 Windows 对位物。
 *
 * ## 它管什么
 *
 *   1. 让浏览器保持可用（我们自己起的那个），断开了就重连/重开
 *   2. 每个标签页装上页面守卫（CDP document_start 注入 + 已开页面当场注入）
 *   3. 收页面上报的字体作用域 → App 侧算「密文 → 明文」映射 → 下发回页面
 *   4. 用户按下 Ctrl+C 时，页面守卫在 copy 事件里把明文写进剪贴板
 *
 * ## 和 mac 版的差别（只有这一处是本质的）
 *
 * mac 的「标签页」是 Safari 的「第几个标签、第几个窗口」；
 * Windows 的「标签页」是 CDP 的 target（一个 target = 一个标签页）。
 * 其余逻辑（阈值、只对**真建出映射**的作用域下发、换题后重报、
 * 带混淆字体的标签走快轮询）**逐条照抄 mac**，保持两条线行为一致。
 *
 * ## 为什么快轮询要单独拎出来
 *
 * 换题后站点会换一套新的加密字体，新字体的映射需要「发现 → 解析 → 下发」一圈。
 * 主轮次一圈要轮询所有标签（每个标签一次 CDP 往返），用户「切完题立刻复制」
 * 时映射还没就绪 → 剪贴板里是原始密文（mac 实测：换题后 1956ms 才正确）。
 * 所以带混淆字体的标签走独立的快轮询（~200ms 一轮）。
 */
const fs = require('fs');
const path = require('path');
const { CdpBridge } = require('./cdp-bridge');

const DEFAULT_INTERVAL_MS = 300;
const CIPHER_TAB_POLL_MS = 200;
const WATCH_EVERY_ROUNDS = 10;
/** 同一个标签连续几轮没有守卫就强制重新注入 */
const FORCE_INJECT_EVERY = 5;

class CdpCoordinator {
  /**
   * @param {{
   *   log?:(m:string)=>void,
   *   browser: import('./browser').ManagedBrowser,
   *   guardPath?:string,
   *   frameBridgePath?:string,
   *   siteFilter?:string[],
   *   onWatch?:(urls:string[])=>void,
   * }} opts
   */
  constructor({ log, browser, guardPath, frameBridgePath, onWatch = null } = {}) {
    this.log = log || (() => {});
    this.browser = browser;
    this.onWatch = onWatch;
    this.guardSource = fs.readFileSync(guardPath, 'utf8');
    this.frameBridgeSource = fs.existsSync(frameBridgePath)
      ? fs.readFileSync(frameBridgePath, 'utf8')
      : '';
    /** 我们注入的守卫是第几版（页面里可能留着上一任注入的旧版） */
    const versionMatch = /GUARD_VERSION\s*=\s*(\d+)/.exec(this.guardSource);
    this.guardVersion = versionMatch ? Number(versionMatch[1]) : null;

    this.bridge = null;
    this.engine = null;
    this.timer = null;
    this.fastTimer = null;
    this.enabled = false;
    this.running = false;
    this.fastRunning = false;
    this.backoffUntil = 0;
    /**
     * 用户自己关掉了那个浏览器窗口，要不要**自动**再开一个？
     *
     * 机制见 browser.js 的 `closedByUser()`（退出码 0 = 用户关的）。
     *
     * 默认 **false**：用户自己关的窗口**不再自动弹一个**给他
     * （2026-10-27 用户口径：「反反复复拉起浏览器」）⇒ 界面给一个
     * 「重新打开浏览器」按钮。**崩溃/被强杀仍然自动恢复**
     * （那不是「用户关的」，退出码非 0）。
     */
    this.autoReopen = false;
    // 把口径告诉浏览器那边：**判定必须发生在真正起浏览器之前**（见 browser.js 的注释）。
    if (this.browser) this.browser.autoReopen = false;
    /** ordinal -> { url, ticksSinceInject, resynced } */
    this.watched = new Map();
    /** ordinal -> { url }：带混淆字体的标签，走快轮询 */
    this.cipherTabs = new Map();
    this.loggedReasons = new Set();
    this.state = {
      running: false,
      injected: false,
      browserRunning: false,
      lastError: '',
      lastTickAt: 0,
      injections: 0,
      mappings: 0,
      unresolved: 0,
      ticks: 0,
      watchedTabs: 0,
      /** 浏览器**被用户关掉了**（⇒ 界面要说清楚，而不是装作还在跑） */
      browserClosedByUser: false,
    };
  }

  /** 装上字形引擎（两条线共用同一个引擎实现，见 safari-repair/engine.js） */
  setEngine(engine) {
    this.engine = engine;
  }

  /**
   * 用户自己关掉了浏览器窗口之后，要不要自动重开。
   *
   * @param {boolean} autoReopen true = 自动重开（会退避、失败有上限）；
   *                          false = 不自动重开，由界面给一个「重新打开」按钮。
   */
  setAutoReopen(autoReopen) {
    this.autoReopen = autoReopen !== false;
    if (this.browser) this.browser.autoReopen = this.autoReopen;
    if (this.autoReopen) {
      // 改成自动重开 ⇒ 立刻把「用户关的」这个状态清掉，下一轮就能重开。
      this.browser.clearClosedByUser();
      this.state.browserClosedByUser = false;
    }
    return this.autoReopen;
  }

  /** 用户点了「重新打开浏览器」⇒ 清掉状态并立刻起一个 */
  async reopenBrowser() {
    this.state.browserClosedByUser = false;
    this.browser.clearClosedByUser();
    this.backoffUntil = 0;
    return this.tick();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      this.start();
    } else {
      this.stop();
    }
    this.log(`浏览器复制修复：${this.enabled ? '已启用' : '已停用'}`);
    return this.enabled;
  }

  start() {
    if (this.timer) return;
    this.fastTimer = setInterval(() => {
      this.fastTick().catch(() => {
        /* ignore */
      });
    }, CIPHER_TAB_POLL_MS);
    if (this.fastTimer.unref) this.fastTimer.unref();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        const message = String((error && error.message) || error);
        this.state.lastError = message;
        this.log('浏览器修复失败:' + message);
      });
    }, DEFAULT_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
    this.running = false;
    this.state.running = false;
    this.state.injected = false;
  }

  /** 确保浏览器在跑、CDP 连着；返回 bridge */
  async ensureBridge() {
    if (this.bridge && this.bridge.client && !this.bridge.client.closed) return this.bridge;
    const { client } = await this.browser.ensure();
    const { buildInjectionSource } = require('./cdp-bridge');
    const injectionSource = buildInjectionSource(this.guardSource, this.frameBridgeSource);
    this.bridge = new CdpBridge({ client, injectionSource, log: this.log });
    await this.bridge.setup();
    this.log('浏览器已就绪，页面守卫已挂上（每个标签页 document_start 注入）');
    return this.bridge;
  }

  /** 登记一个「出现过混淆字体」的标签，之后走快轮询 */
  watchTab(ordinal, url) {
    const existing = this.watched.get(ordinal);
    if (existing && existing.url === url) return;
    this.watched.set(ordinal, { url: url || '', ticksSinceInject: (existing && existing.ticksSinceInject) || 0, resynced: !!(existing && existing.resynced) });
    this.state.watchedTabs = this.watched.size;
    this.cipherTabs.set(ordinal, { url: url || '' });
  }

  persistWatch() {
    if (!this.onWatch) return;
    try {
      this.onWatch([...this.cipherTabs.values()].map((info) => info.url).filter(Boolean));
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * 这一轮要处理哪些标签页。
   *
   * ## 为什么是**全部**标签页,而不是只处理命中站点过滤的那些
   *
   * mac 侧只处理「前台标签 + 命中站点的标签 + 看住的标签」,因为在 Safari 上
   * 一次 Apple Event 要 110ms,标签多了受不了。
   * CDP 一次 `Runtime.evaluate` 往返只有毫秒级 ⇒ **全部标签页都轮询**更划算。
   *
   * 更重要的是**功能完整性**:
   * 守卫在**每个**页面都装了(document_start 注入),它一发现混淆字体就会
   * 把作用域挂到自己的 `state.pending` 上 —— 如果 App 不去读那个页面,
   * 就永远发现不了这个字体、也就永远下发不了映射 ⇒ 那个页面上复制出来是密文。
   * 只处理站点过滤命中的标签 ⇒ 这个缺口就存在(超星之外的混淆站点直接失效)。
   *
   * ⇒ 结论:Windows 线**不按站点过滤**,全部标签页都轮询。
   * 「看住的标签」只用于**快轮询**(带混淆字体的标签,换题后要立刻跟上)。
   */
  planJobs() {
    const jobs = [];
    const bridge = this.bridge;
    if (!bridge) return jobs;
    for (const tab of bridge.listTabs()) {
      jobs.push(tab.index);
    }
    return jobs;
  }

  /**
   * 快轮询：只处理「带混淆字体的标签」。
   *
   * 用户换题后往往**立刻**选中复制，这一轮必须尽快把新字体的映射下发，
   * 否则剪贴板里就是原始密文（mac 实测：换题后 1956ms 才正确）。
   * 它独立于主轮次（不共用 running 标志），否则主轮次一圈会把快轮询饿死。
   */
  async fastTick() {
    if (!this.enabled || this.fastRunning || !this.cipherTabs.size) return;
    this.fastRunning = true;
    try {
      const bridge = this.bridge;
      if (!bridge) return;
      for (const ordinal of [...this.cipherTabs.keys()]) {
        try {
          await this.processTab(ordinal);
        } catch (error) {
          this.log('快轮询 ' + ordinal + ' 出错: ' + String((error && error.message) || error));
        }
      }
    } finally {
      this.fastRunning = false;
    }
  }

  /**
   * 处理一个标签页：读状态 → 必要时注入 → 消费待处理队列并下发映射。
   */
  async processTab(ordinal) {
    const bridge = this.bridge;
    if (!bridge) return { action: 'no-bridge' };
    const watched = this.watched.get(ordinal) || { ticksSinceInject: 0, resynced: false };
    // **第一次**处理这个标签时喊一声「重报」：让页面把已知作用域重新报一遍，
    // 否则 App 重启后页面以为「App 已经知道」→ App 永远学不到 → 映射发不下去。
    const resync = !watched.resynced;
    watched.resynced = true;

    const state = await bridge.pollState({ ordinal, resync });
    if (state.collect === 'evaluate-failed') {
      this.state.lastError = '浏览器连接已断，正在重连…';
      this.state.injected = false;
      return { action: 'evaluate-failed' };
    }
    if (state.url && watched.url && state.url !== watched.url) {
      // 标签换了页面 → 之前的账本作废
      watched.url = state.url;
      watched.ticksSinceInject = 0;
    }
    watched.url = state.url || watched.url;

    // 守卫不在 / 版本对不上 / 太久没注入 → 重新注入
    const guardStale =
      !!state.guard && this.guardVersion !== null && state.guardVersion !== this.guardVersion;
    watched.ticksSinceInject = (watched.ticksSinceInject || 0) + 1;
    const forceInject = watched.ticksSinceInject >= FORCE_INJECT_EVERY;
    if (!state.guard || guardStale || forceInject) {
      watched.ticksSinceInject = 0;
      const result = await bridge.injectNow(ordinal);
      if (result !== 'OK') {
        this.state.lastError = '注入失败: ' + result;
        return { action: 'inject-failed' };
      }
      this.state.injections += 1;
      this.state.injected = true;
      if (guardStale) {
        this.log(`页面里的守卫是第 ${state.guardVersion} 版，重新注入第 ${this.guardVersion} 版`);
      }
    } else {
      this.state.injected = true;
    }
    this.watched.set(ordinal, watched);

    // 待处理队列：顶层自己的 + 各层 frame 上报的
    //
    // 同一个作用域可能**从两条路**进来（顶层守卫自己挂的 pending + 帧桥 take() 收上来的），
    // 不去重就会把同一个作用域算两遍、下发两遍（mac 侧也有这个现象）。
    // 作用域 key 里带着字体内容指纹 ⇒ 同一个 key 就是同一份映射 ⇒ 去重不会丢信息。
    const queue = [];
    const seenScopes = new Set();
    const pushGroups = (item) => {
      if (!item || !Array.isArray(item.groups)) return;
      const fresh = item.groups.filter((g) => {
        const key = g && g.scopeKey;
        if (!key || seenScopes.has(key)) return false;
        seenScopes.add(key);
        return true;
      });
      if (fresh.length) queue.push({ groups: fresh });
    };
    if (state.pending) pushGroups(state.pending);
    if (Array.isArray(state.frames)) {
      for (const item of state.frames) pushGroups(item);
    }

    let mapped = 0;
    for (const item of queue) {
      for (const group of item.groups) {
        const result = await this.engine.processScope(group.scopeKey, group.chars, group.font, {
          prefetch: group.prefetch === true,
        });
        this.state.mappings = Object.keys(result.mapping).length;
        this.state.unresolved = result.unresolved;
        let reasonText = '';
        if (result.reason) {
          const reasonKey = group.scopeKey + '|' + result.reason;
          if (!this.loggedReasons.has(reasonKey)) {
            this.loggedReasons.add(reasonKey);
            reasonText = `（${result.reason}）`;
          }
        }
        this.log(
          `作用域 ${group.scopeKey.slice(0, 60)}：${result.obfuscated ? '混淆字体' : '普通字体'}，` +
            `映射 ${Object.keys(result.mapping).length} 个，未还原 ${result.unresolved} 个` +
            reasonText,
        );
        if (group.font && Object.keys(result.mapping).length > 0) {
          this.watchTab(ordinal, state.url);
          this.persistWatch();
        }
        // **只有真建出映射才下发**（和 mac 同口径）：
        // 建不出映射时不下发 → 页面会继续上报 → 字体恢复后能自动补上。
        if (Object.keys(result.mapping).length === 0) {
          if (process.env.CR_DEBUG) {
            this.log('setMapping 跳过（没建出映射）: ' + String(group.scopeKey).slice(0, 60));
          }
        } else {
          const setResult = await bridge.setMapping({
            ordinal,
            scopeKey: group.scopeKey,
            mapping: result.mapping,
          });
          if (process.env.CR_DEBUG) this.log('setMapping => ' + JSON.stringify(setResult));
          if (!setResult || String(setResult).indexOf('NO-') === 0 || String(setResult).indexOf('FAILED') === 0) {
            this.state.lastError = '映射下发失败: ' + setResult;
          }
          mapped += 1;
        }
      }
    }
    return { action: mapped === 0 ? 'idle' : 'mapped', count: mapped };
  }

  /** 一轮调度（异步，不阻塞主进程） */
  async tick() {
    this.state.lastTickAt = Date.now();
    this.state.ticks += 1;
    if (!this.enabled) return { action: 'disabled' };
    if (this.running) return { action: 'busy' };
    if (Date.now() < this.backoffUntil) return { action: 'backoff' };

    this.running = true;
    this.state.running = true;
    try {
      // 用户自己关掉了那个浏览器窗口 ⇒ **不要**再偷偷弹一个给他
      // （2026-10-27 用户口径：「反反复复拉起浏览器」）。
      // 界面会显示「浏览器已关闭」+ 一个「重新打开」按钮。
      if (!this.autoReopen && this.browser.closedByUser()) {
        this.state.browserClosedByUser = true;
        this.state.browserRunning = false;
        this.state.injected = false;
        return { action: 'browser-closed-by-user' };
      }
      let bridge;
      try {
        bridge = await this.ensureBridge();
      } catch (error) {
        // 「用户自己关掉了那个浏览器窗口」**不是故障** ⇒ 不打错误日志，
        // 如实把状态报给界面（界面显示「重新打开浏览器」按钮）。
        if (error && error.code === 'BROWSER_CLOSED_BY_USER') {
          this.state.browserClosedByUser = true;
          this.state.browserRunning = false;
          this.state.injected = false;
          return { action: 'browser-closed-by-user' };
        }
        throw error;
      }
      this.state.browserRunning = this.browser.isRunning();
      let mapped = 0;
      let action = 'idle';
      for (const ordinal of this.planJobs()) {
        const r = await this.processTab(ordinal);
        if (r.action === 'evaluate-failed' || r.action === 'inject-failed') return r;
        if (r.count) {
          mapped += r.count;
          action = 'mapped';
        }
      }
      if (mapped === 0) return { action };
      return { action, count: mapped };
    } catch (error) {
      const message = String((error && error.message) || error);
      this.state.lastError = message;
      // ⚠️ **要打日志**：只写 lastError 的话，界面上一闪而过、日志里什么都没有
      // ⇒ 2026-10-27 真机「每 29 秒重开一个 Edge」就是这么查了半天。
      this.log('浏览器修复失败:' + message);
      this.backoffUntil = Date.now() + 4000;
      return { action: 'error', error: message };
    } finally {
      this.running = false;
      this.state.running = false;
    }
  }

  getStatus() {
    return {
      ...this.state,
      enabled: this.enabled,
      ...(this.engine ? this.engine.stats() : {}),
    };
  }
}

module.exports = { CdpCoordinator, DEFAULT_INTERVAL_MS, CIPHER_TAB_POLL_MS };

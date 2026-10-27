const { contextBridge, clipboard, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cnc', {
  // Clipboard
  clipboardReadText() { try { return clipboard.readText() || ''; } catch (_) { return ''; } },

  // Window
  platform: process.platform,
  quit() { ipcRenderer.invoke('window:quit').catch(() => {}); },
  minimize() { ipcRenderer.invoke('window:minimize').catch(() => {}); },
  maximize() { ipcRenderer.invoke('window:maximize').catch(() => {}); },
  // 关窗口但**进程留着**(Windows 线的「后台挂着」= 右上角小叉「放到后台」)。
  // 唤回:托盘图标 / 再运行一次程序。
  // 彻底退出:右上角「关闭软件」按钮(一次点击就退)或托盘菜单的「退出程序」。
  hide() { ipcRenderer.invoke('window:hide').catch(() => {}); },

  // Activation
  getActivationSnapshot() { return ipcRenderer.invoke('activation:getSnapshot'); },
  startTrial(expiresAt) { return ipcRenderer.invoke('activation:startTrial', expiresAt); },
  saveLicense(license) { return ipcRenderer.invoke('activation:saveLicense', license); },
  clearLicense() { return ipcRenderer.invoke('activation:clearLicense'); },
  migrateLegacyActivation(legacy) { return ipcRenderer.invoke('activation:migrateLegacy', legacy); },

  // Mouse
  mouseClick(x, y) { return ipcRenderer.invoke('native:mouseClick', x, y); },
  mouseGetPosition() { return ipcRenderer.invoke('native:mouseGetPosition'); },

  // Keyboard
  sendText(text) { return ipcRenderer.invoke('native:sendText', text); },
  sendKey(keyCode, flags) { return ipcRenderer.invoke('native:sendKey', keyCode, flags); },

  // Input source
  getInputSource() { return ipcRenderer.invoke('native:getCurrentInputSource'); },
  selectInputSource(sourceId) { return ipcRenderer.invoke('native:selectInputSource', sourceId); },
  getInputSourceConfig() { return ipcRenderer.invoke('native:getInputSourceConfig'); },
  saveInputSourceConfig(config) { return ipcRenderer.invoke('native:saveInputSourceConfig', config); },
  setCurrentAsInputSource(role) { return ipcRenderer.invoke('native:setCurrentAsInputSource', role); },

  // Recording
  // 注意:开始录制**不传排除矩形** ——
  // 「点自己界面上的按钮不算一次点击」由**原生层**负责:
  // 排除矩形用主进程手里的窗口位置算,并且窗口每次移动/变高时刷新。
  // 前端传的那份只是「开始那一刻」的一张快照,窗口一动就过期
  // (点「结束」会被记成一次点击)。
  startRecording() { return ipcRenderer.invoke('native:startRecording'); },
  stopRecording() { return ipcRenderer.invoke('native:stopRecording'); },
  getRecordingClicks() { return ipcRenderer.invoke('native:getRecordingClicks'); },
  clearRecordingClicks() { return ipcRenderer.invoke('native:clearRecordingClicks'); },
  removeRecordingClick(index) { return ipcRenderer.invoke('native:removeRecordingClick', index); },
  isRecording() { return ipcRenderer.invoke('native:isRecording'); },
  tapFailed() { return ipcRenderer.invoke('native:tapFailed'); },

  // File management
  listFiles() { return ipcRenderer.invoke('file:listFiles'); },
  saveFile(clicks, filename) { return ipcRenderer.invoke('file:saveFile', clicks, filename); },
  renameFile(oldName, newName) { return ipcRenderer.invoke('file:renameFile', oldName, newName); },
  deleteFile(filename) { return ipcRenderer.invoke('file:deleteFile', filename); },
  readFile(filename) { return ipcRenderer.invoke('file:readFile', filename); },

  // Playback
  playFile(fileName, interval, inputText) {
    return ipcRenderer.invoke('play:playFile', fileName, interval, inputText);
  },
  playData(clicks, interval) {
    return ipcRenderer.invoke('play:playData', clicks, interval);
  },
  pinyinInput(text, delaySeconds, autoSwitchIme) {
    return ipcRenderer.invoke('play:pinyinInput', text, delaySeconds, autoSwitchIme);
  },

  // Settings
  settings: {
    setSelectedJson(fileName) { ipcRenderer.send('settings:setSelectedJson', String(fileName || '')); },
    getSelectedJson() { return ipcRenderer.invoke('settings:getSelectedJson'); },
    setPinyinText(text) { ipcRenderer.send('settings:setPinyinText', String(text || '')); },
    setPinyinSources(sources) { ipcRenderer.send('settings:setPinyinSources', sources || {}); },
    setAutoSwitchIme(enabled) { ipcRenderer.send('settings:setAutoSwitchIme', !!enabled); },
  },

  // Keepalive
  getKeepaliveStatus() { return ipcRenderer.invoke('keepalive:getStatus'); },
  setKeepaliveEnabled(enabled) { ipcRenderer.send('keepalive:setEnabled', !!enabled); },

  // 原生模块状态（模拟输入等能力是否可用）
  getNativeStatus() { return ipcRenderer.invoke('native:getStatus'); },

  // 功能模块（通用接口；新增功能前端不用改）
  getFeatures() { return ipcRenderer.invoke('features:list'); },
  getFeatureStatus(prefix) { return ipcRenderer.invoke(prefix + ':getStatus'); },
  setFeatureEnabled(prefix, enabled) { ipcRenderer.send(prefix + ':setEnabled', !!enabled); },
  setFeatureEnabledSetting(prefix, enabled) { ipcRenderer.send(prefix + ':setEnabledSetting', !!enabled); },
  // 「重新打开浏览器」—— Windows 线的「浏览器复制修复」用；
  // 别的功能没有这个 IPC ⇒ 调用会失败，前端 catch 掉即可。
  reopenFeatureBrowser(prefix) { return ipcRenderer.invoke(prefix + ':reopenBrowser'); },

  // 注意:Safari 复制修复走 Apple Events,只在 macOS 上存在 —— Windows 版
  // 没有这个能力,所以不暴露这组接口(免得调用方拿到一个必然失败的 Promise)。
});

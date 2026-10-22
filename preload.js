const { contextBridge, clipboard, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cnc', {
  // Clipboard
  clipboardReadText() { try { return clipboard.readText() || ''; } catch (_) { return ''; } },

  // Window
  platform: process.platform,
  quit() { ipcRenderer.invoke('window:quit').catch(() => {}); },
  minimize() { ipcRenderer.invoke('window:minimize').catch(() => {}); },
  maximize() { ipcRenderer.invoke('window:maximize').catch(() => {}); },

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
  startRecording(excludeRect) { return ipcRenderer.invoke('native:startRecording', excludeRect); },
  stopRecording() { return ipcRenderer.invoke('native:stopRecording'); },
  getRecordingClicks() { return ipcRenderer.invoke('native:getRecordingClicks'); },
  clearRecordingClicks() { return ipcRenderer.invoke('native:clearRecordingClicks'); },
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

  // Safari 复制修复（字体混淆还原 + 复制劫持拦截）
  safariRepair: {
    getStatus() { return ipcRenderer.invoke('safariRepair:getStatus'); },
    setEnabled(enabled) { ipcRenderer.send('safariRepair:setEnabled', !!enabled); },
    setEnabledSetting(enabled) { ipcRenderer.send('safariRepair:setEnabledSetting', !!enabled); },
    checkNow() { return ipcRenderer.invoke('safariRepair:checkNow'); },
  },
});

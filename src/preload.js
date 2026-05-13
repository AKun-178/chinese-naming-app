const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  readSettings: () => ipcRenderer.invoke("settings:read"),
  writeSettings: (settings) => ipcRenderer.invoke("settings:write", settings),
  selectVideo: () => ipcRenderer.invoke("dialog:video"),
  selectAudio: () => ipcRenderer.invoke("dialog:audio"),
  selectBackgroundAudio: () => ipcRenderer.invoke("dialog:backgroundAudio"),
  selectVoiceSample: () => ipcRenderer.invoke("dialog:voiceSample"),
  selectOutput: () => ipcRenderer.invoke("dialog:output"),
  openExternal: (target) => ipcRenderer.invoke("open:external", target),
  cloneFishVoice: (payload) => ipcRenderer.invoke("fish:cloneVoice", payload),
  renderBatch: (payload) => ipcRenderer.invoke("render:batch", payload),
  cancelRender: () => ipcRenderer.invoke("render:cancel"),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("render:progress", listener);
    return () => ipcRenderer.removeListener("render:progress", listener);
  },
});

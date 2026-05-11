const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  readSettings: () => ipcRenderer.invoke("settings:read"),
  writeSettings: (settings) => ipcRenderer.invoke("settings:write", settings),
  selectVideo: () => ipcRenderer.invoke("dialog:video"),
  selectAudio: () => ipcRenderer.invoke("dialog:audio"),
  selectOutput: () => ipcRenderer.invoke("dialog:output"),
  renderBatch: (payload) => ipcRenderer.invoke("render:batch", payload),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("render:progress", listener);
    return () => ipcRenderer.removeListener("render:progress", listener);
  },
});


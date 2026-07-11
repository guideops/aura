// CommonJS preload (Electron requires CJS here unless sandbox is disabled).
const { contextBridge, ipcRenderer } = require("electron");

// Renderer-facing bridge. The token string passes through here once on save
// and is never readable back — status only reports whether one is stored.
contextBridge.exposeInMainWorld("aura", {
  github: {
    save: (token: string, projectId: string) =>
      ipcRenderer.invoke("github:save", token, projectId),
    status: () => ipcRenderer.invoke("github:status"),
    clear: () => ipcRenderer.invoke("github:clear"),
  },
});

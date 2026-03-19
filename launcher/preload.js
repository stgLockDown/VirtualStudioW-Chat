const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Screen capture ──────────────────────────────────────────────────────────
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // ── Chat pop-out window ─────────────────────────────────────────────────────
  openChatWindow: (token) => ipcRenderer.send('open-chat-window', token),

  // ── Send a notification to the main window from chat ───────────────────────
  chatNotify: (data) => ipcRenderer.send('chat-notify', data),

  // ── Listen for chat notification badge/sound from main process ─────────────
  onChatNotification: (callback) => {
    ipcRenderer.on('chat-notification', (_event, data) => callback(data));
  },

  // ── App info ────────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('get-version'),

  // ── Environment flags ───────────────────────────────────────────────────────
  isElectron: true,
});
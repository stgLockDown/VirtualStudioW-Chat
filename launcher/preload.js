const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── App info ──────────────────────────────────────────────────────────────
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('get-version'),

  // ── Updates ───────────────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),

  // ── Screen share sources ──────────────────────────────────────────────────
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // ── Chat pop-out ──────────────────────────────────────────────────────────
  openChatWindow: (token) => ipcRenderer.send('open-chat-window', token),
  chatNotify:     (data)  => ipcRenderer.send('chat-notify', data),
  onChatNotification: (callback) => {
    ipcRenderer.on('chat-notification', (_event, data) => callback(data));
  },

  // ── Remote control input injection ───────────────────────────────────────
  injectInput: (event) => ipcRenderer.send('inject-input', event),

  // ── Floating toolbar (Electron only) ─────────────────────────────────────
  // Called by app.js when a meeting starts/ends
  toolbarShow: () => ipcRenderer.send('toolbar-show'),
  toolbarHide: () => ipcRenderer.send('toolbar-hide'),

  // Called by app.js to sync button state to the floating toolbar window
  toolbarSetState: (state) => ipcRenderer.send('toolbar-state', state),

  // Listen for button clicks that come FROM the floating toolbar window
  onToolbarAction: (callback) => {
    ipcRenderer.on('toolbar-action', (_event, action) => callback(action));
  },

  // ── For toolbar.html (runs inside toolbarWin) ─────────────────────────────
  // Send a button click to mainWin
  toolbarAction: (action) => ipcRenderer.send('toolbar-action', action),

  // Listen for state updates sent from mainWin
  onToolbarState: (callback) => {
    ipcRenderer.on('toolbar-state', (_event, state) => callback(state));
  },

  // ── Cursor / screen position helpers (for drag) ───────────────────────────
  getCursorScreenPoint: () => ipcRenderer.invoke('get-cursor-screen-point'),
  getToolbarBounds:     () => ipcRenderer.invoke('toolbar-get-bounds'),
});
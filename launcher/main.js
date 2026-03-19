const { app, BrowserWindow, screen, ipcMain, desktopCapturer, session, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

// ── Target server URL ──────────────────────────────────────────────────────────
// Change this to your Railway deployment URL
const SERVER_URL = process.env.VS_SERVER_URL || 'https://virtualstudiow-chat-production.up.railway.app';

const IS_DEV = process.argv.includes('--dev');

let splash, mainWin, chatWin, tray;

// ── Splash screen ──────────────────────────────────────────────────────────────
function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  splash.loadURL('data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', system-ui, sans-serif;
        background: transparent;
        display: flex; align-items: center; justify-content: center;
        height: 100vh;
        -webkit-app-region: drag;
      }
      .card {
        background: linear-gradient(145deg, #1a1d21, #19171d);
        border: 1px solid #2e2c32;
        border-radius: 20px;
        padding: 44px 48px;
        text-align: center;
        box-shadow: 0 24px 64px rgba(0,0,0,0.6);
        min-width: 400px;
      }
      .logo { font-size: 52px; margin-bottom: 14px; }
      h1 { color: #d1d2d3; font-size: 22px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
      .sub { color: #696c71; font-size: 13px; margin-bottom: 32px; }
      .loader {
        width: 220px; height: 3px;
        background: #2e2c32;
        border-radius: 3px;
        margin: 0 auto 16px;
        overflow: hidden; position: relative;
      }
      .loader::after {
        content: '';
        position: absolute; left: -45%; width: 45%; height: 100%;
        background: linear-gradient(90deg, transparent, #1d9bd1, #2bac76, transparent);
        border-radius: 3px;
        animation: slide 1.5s ease-in-out infinite;
      }
      @keyframes slide { 0% { left: -45%; } 100% { left: 100%; } }
      .status { color: #4a4d52; font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; }
      .version { color: #3a3d42; font-size: 10px; margin-top: 20px; }
    </style></head><body>
      <div class="card">
        <div class="logo">🎓</div>
        <h1>Virtual Studio</h1>
        <p class="sub">Interactive Learning Platform</p>
        <div class="loader"></div>
        <p class="status" id="status">Connecting to server...</p>
        <p class="version">v${app.getVersion()}</p>
      </div>
    </body></html>
  `));
}

// ── Error page ─────────────────────────────────────────────────────────────────
function getErrorPage(errorDesc) {
  return 'data:text/html,' + encodeURIComponent(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', system-ui, sans-serif;
        background: #1a1d21; color: #d1d2d3;
        display: flex; align-items: center; justify-content: center;
        height: 100vh;
      }
      .card { text-align: center; padding: 48px; max-width: 480px; }
      .icon { font-size: 52px; margin-bottom: 20px; }
      h1 { color: #cd2553; font-size: 22px; margin-bottom: 12px; }
      p { color: #696c71; font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
      .url { font-size: 11px; color: #4a4d52; font-family: monospace; margin: 16px 0; word-break: break-all; }
      .btn-row { display: flex; gap: 12px; justify-content: center; margin-top: 28px; }
      button {
        padding: 11px 28px; border-radius: 6px; font-size: 14px;
        cursor: pointer; border: none; font-weight: 600;
        transition: opacity 0.15s;
      }
      button:hover { opacity: 0.85; }
      .btn-primary { background: #1d9bd1; color: #fff; }
      .btn-secondary { background: #2e2c32; color: #d1d2d3; }
    </style></head><body>
      <div class="card">
        <div class="icon">⚠️</div>
        <h1>Cannot Connect</h1>
        <p>Unable to reach the Virtual Studio server.</p>
        <p>${errorDesc || 'Please check your internet connection and try again.'}</p>
        <div class="url">${SERVER_URL}</div>
        <div class="btn-row">
          <button class="btn-primary" onclick="location.href='${SERVER_URL}'">Retry</button>
          <button class="btn-secondary" onclick="window.close()">Close</button>
        </div>
      </div>
    </body></html>
  `);
}

// ── Main window ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Remove default menu bar
  Menu.setApplicationMenu(null);

  createSplash();

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 900,
    minHeight: 600,
    title: 'Virtual Studio',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    show: false,
    backgroundColor: '#1a1d21'
  });

  // ── App version ───────────────────────────────────────────────────────────
  ipcMain.handle('get-version', () => app.getVersion());

  // ── Screen share: provide sources to renderer ──────────────────────────────
  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon ? s.appIcon.toDataURL() : null
    }));
  });

  // ── Chat Pop-out Window ────────────────────────────────────────────────────
  ipcMain.on('open-chat-window', (event, token) => {
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.focus();
      return;
    }

    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const chatWidth  = Math.min(960, Math.floor(sw * 0.45));
    const chatHeight = Math.min(720, Math.floor(sh * 0.85));

    // Position to the right of main window, or centre of screen
    let chatX, chatY;
    if (mainWin && !mainWin.isDestroyed()) {
      const mb = mainWin.getBounds();
      chatX = mb.x + mb.width + 10;
      chatY = mb.y;
      // If it would go off-screen, place it overlapping instead
      if (chatX + chatWidth > sw) chatX = Math.max(0, mb.x - chatWidth - 10);
    }

    chatWin = new BrowserWindow({
      width: chatWidth,
      height: chatHeight,
      minWidth: 520,
      minHeight: 420,
      title: 'Virtual Studio — Chat',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      x: chatX,
      y: chatY,
      parent: null,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      },
      backgroundColor: '#1a1d21',
      show: false
    });

    const chatUrl = `${SERVER_URL}/chat/index.html?token=${encodeURIComponent(token)}`;
    chatWin.loadURL(chatUrl);

    chatWin.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(true);
    });

    chatWin.webContents.on('did-finish-load', () => {
      chatWin.show();
    });

    chatWin.on('closed', () => { chatWin = null; });
  });

  // ── Notify main window of new chat message (badge / sound) ────────────────
  ipcMain.on('chat-notify', (event, data) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('chat-notification', data);
    }
  });

  // ── Allow media permissions (camera, mic, screen) ─────────────────────────
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'display-capture'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  // ── Override getDisplayMedia for screen sharing in Electron ───────────────
  mainWin.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      const entireScreen = sources.find(s =>
        s.name === 'Entire Screen' || s.name === 'Entire screen' || s.id.startsWith('screen:')
      );
      callback({ video: entireScreen || sources[0] });
    });
  });

  // ── Load app ───────────────────────────────────────────────────────────────
  mainWin.loadURL(SERVER_URL);

  mainWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (splash && !splash.isDestroyed()) { splash.close(); splash = null; }
      mainWin.show();
      if (IS_DEV) mainWin.webContents.openDevTools();
    }, 600);
  });

  mainWin.webContents.on('did-fail-load', (e, errorCode, errorDesc) => {
    if (splash && !splash.isDestroyed()) { splash.close(); splash = null; }
    mainWin.show();
    mainWin.loadURL(getErrorPage(errorDesc));
  });

  // ── Window lifecycle ───────────────────────────────────────────────────────
  mainWin.on('closed', () => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
    if (tray) { tray.destroy(); tray = null; }
    mainWin = null;
    app.quit();
  });

  // ── Dev tools shortcut (F12 / Ctrl+Shift+I) ───────────────────────────────
  mainWin.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWin.webContents.toggleDevTools();
    }
  });
});

app.on('window-all-closed', () => app.quit());

// ── Security: block navigation to unknown origins ─────────────────────────────
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (navigationEvent, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    const serverHost = new URL(SERVER_URL).hostname;
    // Allow navigation within the server domain only
    if (parsedUrl.hostname !== serverHost) {
      navigationEvent.preventDefault();
    }
  });

  // Open external links in system browser
  contents.setWindowOpenHandler(({ url }) => {
    const parsedUrl = new URL(url);
    const serverHost = new URL(SERVER_URL).hostname;
    if (parsedUrl.hostname === serverHost) {
      return { action: 'allow' };
    }
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
});
const { app, BrowserWindow, screen, ipcMain, desktopCapturer, session, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const https = require('https');

// ── Target server URL ────────────────────────────────────────────────────────
// Change this to your Railway deployment URL
const SERVER_URL = process.env.VS_SERVER_URL || 'https://virtualstudiow-chat-production.up.railway.app';

const IS_DEV = process.argv.includes('--dev');
const CURRENT_VERSION = app.getVersion(); // e.g. "1.3.0"

// ── Fix taskbar pinning for portable EXE ────────────────────────────────────
app.setAppUserModelId('com.virtualstudio.chat');

if (process.env.PORTABLE_EXECUTABLE_FILE) {
  app.setPath('userData', path.join(path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), '.virtualstudio-data'));
}

let splash, mainWin, chatWin, toolbarWin, tray;

// ── Auto-update check ────────────────────────────────────────────────────────
function checkForUpdates(silent = false) {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/stgLockDown/VirtualStudioW-Chat/releases/latest',
    headers: { 'User-Agent': 'VirtualStudio-Launcher/' + CURRENT_VERSION }
  };

  https.get(options, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const latestTag = (release.tag_name || '').replace(/^v/, '');
        if (!latestTag) return;

        if (compareVersions(latestTag, CURRENT_VERSION) > 0) {
          const exeAsset = (release.assets || []).find(a => a.name.endsWith('.exe'));
          const downloadUrl = exeAsset ? exeAsset.browser_download_url : release.html_url;

          dialog.showMessageBox(mainWin, {
            type: 'info',
            title: 'Update Available',
            message: `Virtual Studio v${latestTag} is available!`,
            detail: `You are running v${CURRENT_VERSION}.\n\nNote: Your app content is always up-to-date via the server — this update only includes launcher improvements.\n\n${release.body ? release.body.slice(0, 300) : ''}`,
            buttons: ['Download Update', 'Remind Me Later'],
            defaultId: 0,
            cancelId: 1,
            icon: nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
          }).then(({ response }) => {
            if (response === 0) shell.openExternal(downloadUrl);
          });
        } else if (!silent) {
          dialog.showMessageBox(mainWin, {
            type: 'info',
            title: 'No Updates',
            message: `You're running the latest version (v${CURRENT_VERSION}).`,
            detail: 'Your app content is always up-to-date via the server — no action needed!',
            buttons: ['OK']
          });
        }
      } catch (e) { /* silently ignore parse errors */ }
    });
  }).on('error', () => { /* silently ignore network errors */ });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Splash screen ─────────────────────────────────────────────────────────────
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

// ── Error page ────────────────────────────────────────────────────────────────
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

// ── Floating Toolbar Window ───────────────────────────────────────────────────
// A separate always-on-top frameless transparent window that hosts the toolbar.
// It can be dragged anywhere on screen — even outside the main app window.
function createToolbarWin() {
  // Start it hidden; show it when the main app signals a meeting has started
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Estimate toolbar size: roughly 900px wide x 72px tall (auto-sized)
  const tbWidth  = 920;
  const tbHeight = 80;
  const tbX = Math.round((width - tbWidth) / 2);
  const tbY = height - tbHeight - 12;

  toolbarWin = new BrowserWindow({
    width:  tbWidth,
    height: tbHeight,
    x: tbX,
    y: tbY,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    // Allow moving beyond screen edges
    enableLargerThanScreen: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false
  });

  toolbarWin.loadURL(`${SERVER_URL}/toolbar.html`);

  // Once loaded, size the window to fit the actual toolbar content
  toolbarWin.webContents.on('did-finish-load', () => {
    // Auto-resize after a tick to let the DOM settle
    setTimeout(() => {
      toolbarWin.webContents.executeJavaScript(`
        (() => {
          const outer = document.getElementById('outer');
          if (!outer) return [920, 80];
          const r = outer.getBoundingClientRect();
          return [Math.ceil(r.width) || 920, Math.ceil(r.height) || 80];
        })()
      `).then(([w, h]) => {
        if (toolbarWin && !toolbarWin.isDestroyed()) {
          toolbarWin.setSize(w + 2, h + 2);
          // Re-centre horizontally after resize
          const b = toolbarWin.getBounds();
          const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
          toolbarWin.setPosition(Math.round((sw - b.width) / 2), b.y);
        }
      }).catch(() => {});
    }, 300);
  });

  toolbarWin.on('closed', () => { toolbarWin = null; });
}

// ── Main window ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
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

  // ── App version ──────────────────────────────────────────────────────────
  ipcMain.handle('get-version', () => app.getVersion());

  // ── Manual update check ──────────────────────────────────────────────────
  ipcMain.on('check-for-updates', () => checkForUpdates(false));

  // ── Screen share sources ─────────────────────────────────────────────────
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

  // ── Chat Pop-out Window ──────────────────────────────────────────────────
  ipcMain.on('open-chat-window', (event, token) => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.focus(); return; }

    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const chatWidth  = Math.min(960, Math.floor(sw * 0.45));
    const chatHeight = Math.min(720, Math.floor(sh * 0.85));

    let chatX, chatY;
    if (mainWin && !mainWin.isDestroyed()) {
      const mb = mainWin.getBounds();
      chatX = mb.x + mb.width + 10;
      chatY = mb.y;
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

    chatWin.loadURL(`${SERVER_URL}/chat/index.html?token=${encodeURIComponent(token)}`);
    chatWin.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(true);
    });
    chatWin.webContents.on('did-finish-load', () => chatWin.show());
    chatWin.on('closed', () => { chatWin = null; });
  });

  // ── Chat notification (main ↔ chat window) ───────────────────────────────
  ipcMain.on('chat-notify', (event, data) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('chat-notification', data);
    }
  });

  // ── Floating Toolbar: show/hide ──────────────────────────────────────────
  ipcMain.on('toolbar-show', () => {
    if (!toolbarWin || toolbarWin.isDestroyed()) createToolbarWin();
    // Show after a brief delay to let it load
    const showIt = () => {
      if (toolbarWin && !toolbarWin.isDestroyed() && !toolbarWin.isVisible()) {
        toolbarWin.show();
      }
    };
    if (toolbarWin.webContents.isLoading()) {
      toolbarWin.webContents.once('did-finish-load', () => setTimeout(showIt, 400));
    } else {
      setTimeout(showIt, 100);
    }
  });

  ipcMain.on('toolbar-hide', () => {
    if (toolbarWin && !toolbarWin.isDestroyed()) toolbarWin.hide();
  });

  // ── Floating Toolbar: relay button clicks back to mainWin ────────────────
  // toolbar.html sends toolbar-action → main.js forwards to mainWin renderer
  ipcMain.on('toolbar-action', (event, action) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('toolbar-action', action);
    }
  });

  // ── Floating Toolbar: receive state updates from mainWin ─────────────────
  // mainWin sends toolbar-state → main.js forwards to toolbarWin
  // Special key _resetPosition: re-centre the toolbar window on screen
  ipcMain.on('toolbar-state', (event, state) => {
    if (!toolbarWin || toolbarWin.isDestroyed()) return;

    if (state._resetPosition) {
      // Re-centre toolbar on the primary display
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      const b = toolbarWin.getBounds();
      toolbarWin.setPosition(
        Math.round((sw - b.width) / 2),
        sh - b.height - 12
      );
      return;
    }

    toolbarWin.webContents.send('toolbar-state', state);
  });

  // ── Floating Toolbar: move to absolute screen position ───────────────────
  // toolbar.html can request a position change (used during drag)
  ipcMain.on('toolbar-move', (event, { x, y }) => {
    if (!toolbarWin || toolbarWin.isDestroyed()) return;
    const allScreens = screen.getAllDisplays();
    // Allow positioning anywhere across all monitors
    toolbarWin.setPosition(Math.round(x), Math.round(y));
  });

  // ── Floating Toolbar: get current screen position ────────────────────────
  ipcMain.handle('toolbar-get-bounds', () => {
    if (!toolbarWin || toolbarWin.isDestroyed()) return null;
    return toolbarWin.getBounds();
  });

  // ── Cursor screen point (for drag calculations) ──────────────────────────
  ipcMain.handle('get-cursor-screen-point', () => {
    return screen.getCursorScreenPoint();
  });

  // ── Remote Control: inject mouse/keyboard events ─────────────────────────
  ipcMain.on('inject-input', (event, data) => {
    const targetWin = mainWin;
    if (!targetWin || targetWin.isDestroyed()) return;

    const wc = targetWin.webContents;
    const bounds = targetWin.getBounds();

    if (['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick'].includes(data.type)) {
      const x = Math.round((data.x || 0) * bounds.width);
      const y = Math.round((data.y || 0) * bounds.height);

      if (data.type === 'mousemove') {
        wc.sendInputEvent({ type: 'mouseMove', x, y });
      } else if (data.type === 'mousedown') {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      } else if (data.type === 'mouseup') {
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else if (data.type === 'click') {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else if (data.type === 'dblclick') {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
      }
    } else if (data.type === 'wheel') {
      const x = Math.round((data.x || 0) * bounds.width);
      const y = Math.round((data.y || 0) * bounds.height);
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: data.deltaX || 0, deltaY: -(data.deltaY || 0) });
    } else if (data.type === 'keydown' || data.type === 'keyup') {
      const keyCode = data.key || '';
      const keyMap = {
        'Enter': 'Return', 'Backspace': 'Backspace', 'Tab': 'Tab',
        'Escape': 'Escape', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
        'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'Delete': 'Delete',
        ' ': 'Space', 'Home': 'Home', 'End': 'End',
        'PageUp': 'PageUp', 'PageDown': 'PageDown'
      };
      const electronKey = keyMap[keyCode] || keyCode;
      const modifiers = [];
      if (data.shiftKey) modifiers.push('shift');
      if (data.ctrlKey) modifiers.push('control');
      if (data.altKey) modifiers.push('alt');
      if (data.metaKey) modifiers.push('meta');

      if (data.type === 'keydown') {
        if (keyCode.length === 1) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: electronKey, modifiers });
          wc.sendInputEvent({ type: 'char', keyCode: electronKey, modifiers });
        } else {
          wc.sendInputEvent({ type: 'keyDown', keyCode: electronKey, modifiers });
        }
      } else {
        wc.sendInputEvent({ type: 'keyUp', keyCode: electronKey, modifiers });
      }
    }
  });

  // ── Media permissions ────────────────────────────────────────────────────
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'fullscreen', 'display-capture'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler(() => true);

  // ── Override getDisplayMedia for screen sharing ──────────────────────────
  mainWin.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      const entireScreen = sources.find(s =>
        s.name === 'Entire Screen' || s.name === 'Entire screen' || s.id.startsWith('screen:')
      );
      callback({ video: entireScreen || sources[0] });
    });
  });

  // ── Load app ─────────────────────────────────────────────────────────────
  mainWin.loadURL(SERVER_URL);

  mainWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (splash && !splash.isDestroyed()) { splash.close(); splash = null; }
      mainWin.show();
      if (IS_DEV) mainWin.webContents.openDevTools();
      // Check for launcher updates silently (after 5s)
      setTimeout(() => checkForUpdates(true), 5000);
    }, 600);
  });

  mainWin.webContents.on('did-fail-load', (e, errorCode, errorDesc) => {
    if (splash && !splash.isDestroyed()) { splash.close(); splash = null; }
    mainWin.show();
    mainWin.loadURL(getErrorPage(errorDesc));
  });

  // ── Window lifecycle ─────────────────────────────────────────────────────
  mainWin.on('closed', () => {
    if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); chatWin = null; }
    if (toolbarWin && !toolbarWin.isDestroyed()) { toolbarWin.close(); toolbarWin = null; }
    if (tray) { tray.destroy(); tray = null; }
    mainWin = null;
    app.quit();
  });

  // ── Dev tools shortcut (F12 / Ctrl+Shift+I) ─────────────────────────────
  mainWin.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWin.webContents.toggleDevTools();
    }
  });
});

app.on('window-all-closed', () => app.quit());

// ── Security: block navigation to unknown origins ────────────────────────────
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (navigationEvent, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    const serverHost = new URL(SERVER_URL).hostname;
    if (parsedUrl.hostname !== serverHost) {
      navigationEvent.preventDefault();
    }
  });

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
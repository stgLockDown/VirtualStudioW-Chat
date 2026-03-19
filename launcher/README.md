# Virtual Studio — Electron Launcher

Thin-client Electron launcher for [VirtualStudioW-Chat](https://github.com/stgLockDown/VirtualStudioW-Chat) deployed on Railway.

The launcher is a lightweight shell — it loads your Railway server URL in a native desktop window with full screen-share, camera/mic permissions, and a Slack-style chat pop-out. **No server code lives here.**

---

## Quick Start (Development)

```bash
npm install
npm start
```

To open DevTools on launch:

```bash
npm run dev
```

---

## Building Installers

### Prerequisites
- Node.js 18+
- Windows: no extra tools needed
- macOS: Xcode CLI tools (`xcode-select --install`)
- Linux: `fakeroot`, `dpkg` for `.deb`

### Commands

| Command | Output |
|---------|--------|
| `npm run build:win` | `dist/VirtualStudio-1.3.0-x64.exe` (portable) + NSIS installer |
| `npm run build:mac` | `dist/VirtualStudio-1.3.0-x64.dmg` + ARM64 DMG |
| `npm run build:linux` | `dist/VirtualStudio-1.3.0-x64.AppImage` + `.deb` |
| `npm run build:all` | All of the above |

Built artifacts go into the `dist/` folder.

---

## Changing the Server URL

The launcher points to your Railway deployment. Update the URL in **one of two ways**:

**Option 1 — Edit `main.js` directly:**
```js
const SERVER_URL = 'https://your-app.up.railway.app';
```

**Option 2 — Environment variable (no rebuild needed):**
```bash
VS_SERVER_URL=https://your-app.up.railway.app npm start
```

---

## Project Structure

```
VS-Chat-Launcher/
├── main.js          # Electron main process — windows, IPC, permissions
├── preload.js       # Context bridge — exposes safe APIs to renderer
├── package.json     # Dependencies + electron-builder config
├── build/
│   ├── icon.ico     # Windows icon (256x256)
│   ├── icon.icns    # macOS icon
│   └── icon.png     # Linux icon (512x512)
└── dist/            # Built installers (git-ignored)
```

---

## Features

| Feature | Details |
|---------|---------|
| 🖥️ Splash screen | Animated loading card while server loads |
| 💬 Chat pop-out | Opens `/chat/index.html` as a separate native window |
| 📺 Screen share | Uses `desktopCapturer` to enumerate windows/screens |
| 🎤 Media permissions | Camera, mic, display-capture auto-approved |
| ❌ Error page | Retry button if Railway server is unreachable |
| 🔒 Navigation guard | Blocks navigation to external domains |
| 🔗 External links | Opens in system browser via `shell.openExternal` |
| 🛠️ DevTools | F12 or Ctrl+Shift+I toggles DevTools |
| 📦 Portable + NSIS | Windows: portable EXE and full installer |
| 🍎 macOS DMG | Universal (x64 + arm64) |
| 🐧 Linux AppImage | Self-contained, no install needed |

---

## Icons

Place your icons in `build/`:

- `build/icon.ico` — Windows (must include 256×256 layer)
- `build/icon.icns` — macOS
- `build/icon.png` — Linux (512×512 recommended)

You can convert a PNG to ICO/ICNS using [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder):

```bash
npx electron-icon-builder --input=icon-source.png --output=build/
```

---

## Deployment Workflow

```
┌─────────────────────────────────────┐
│  Railway                            │
│  VirtualStudioW-Chat server         │  ← WebSocket, REST API, chat
│  https://your-app.up.railway.app    │
└─────────────────────────────────────┘
             ▲
             │  HTTPS / WSS
             │
┌─────────────────────────────────────┐
│  User's PC                          │
│  Virtual Studio.exe  (this repo)    │  ← Electron thin client
└─────────────────────────────────────┘
```

The Electron app is just a browser window pointed at your Railway URL — update your server and users get the latest version automatically on next launch.
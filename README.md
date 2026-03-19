# 🎓 Virtual Studio

> An all-in-one online learning & teaching platform with video conferencing, persistent Slack-style chat, recording, transcription, and AI-powered meeting summaries.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/stgLockDown/VirtualStudioW-Chat)

---

## ✨ Features

- **📹 Video Conferencing** — WebRTC peer-to-peer mesh, screen sharing, annotations, breakout rooms
- **💬 Persistent Chat** — Native Slack-like chat with channels, DMs, threads, reactions, and pop-out window
- **🎬 Recording** — In-browser meeting recording with upload and playback
- **📝 Transcription** — Real-time transcript during meetings
- **🤖 AI Summaries** — Automatic meeting summaries via OpenAI (optional)
- **👥 5-Tier Roles** — Owner → Developer → Admin → Instructor → Student
- **🎨 Theme Customizer** — Per-room color themes and backgrounds
- **🖥️ Electron Desktop App** — Packaged as a Windows portable EXE

---

## 🚀 Deploy on Railway

### One-Click Deploy

Click the button above, or follow these steps:

### Manual Railway Setup

1. **Fork or clone this repo** to your GitHub account

2. **Create a new Railway project**
   - Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
   - Select this repository

3. **Add a PostgreSQL database**
   - In your Railway project → Add Service → Database → PostgreSQL
   - Railway will automatically inject `DATABASE_URL` into your app

4. **Set required environment variables** in Railway → Variables:

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `JWT_SECRET` | ✅ **Required** | Random secret for JWT signing. Use: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
   | `DATABASE_URL` | Auto-set | Injected automatically by Railway PostgreSQL plugin |
   | `NODE_ENV` | Recommended | Set to `production` |
   | `JWT_EXPIRY` | Optional | Default: `7d` |
   | `OPENAI_API_KEY` | Optional | For AI meeting summaries |
   | `AI_MODEL` | Optional | Default: `gpt-4o-mini` |
   | `RECORDINGS_DIR` | Optional | Default: `./recordings` |
   | `FRONTEND_URL` | Optional | Restrict CORS to specific origin |

5. **Deploy** — Railway will build and deploy automatically

6. **First login** — The first registered user automatically gets the `owner` role

---

## 💻 Local Development

```bash
# Clone the repository
git clone https://github.com/stgLockDown/VirtualStudioW-Chat.git
cd VirtualStudioW-Chat

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
# For local dev, you can leave DATABASE_URL empty to use SQLite

# Start the server
npm start
# → Server running at http://localhost:3000
```

---

## 🗂️ Project Structure

```
VirtualStudioW-Chat/
├── server/
│   ├── index.js          # Main Express + Socket.IO server (~1500 lines)
│   ├── database.js       # Dual-mode DB layer (PostgreSQL + SQLite)
│   ├── auth.js           # JWT auth, role middleware
│   └── chat.js           # Native chat system (Socket.IO /chat namespace)
├── public/
│   ├── index.html        # Main platform SPA
│   ├── chat/
│   │   └── index.html    # Chat pop-out window (Slack-style)
│   ├── css/
│   │   ├── styles.css    # Platform styles
│   │   └── chat.css      # Slack-authentic dark mode chat styles
│   └── js/
│       ├── app.js        # Main frontend (~2900 lines)
│       └── chat.js       # Chat window frontend
├── recordings/           # Uploaded recording files (ephemeral on Railway)
├── railway.json          # Railway deployment config
├── nixpacks.toml         # Railway build config
├── package.json
└── .env.example          # Environment variable template
```

---

## 🔑 Role System

| Role | Level | Capabilities |
|------|-------|-------------|
| `owner` | 5 | Full access, manage all users and settings |
| `developer` | 4 | Owner-level + platform debugging |
| `admin` | 3 | Manage classrooms, rooms, users |
| `instructor` | 2 | Host meetings, view recordings |
| `student` | 1 | Join meetings, view assigned content |

The **first registered user** on a fresh deployment is automatically promoted to `owner`.

---

## 💬 Chat System

The built-in chat system is designed to work alongside live classes:

- **Channels** — Public `#` and private 🔒 channels
- **Direct Messages** — Private 1:1 conversations
- **Meeting Bridge** — In-meeting chats automatically persist as DMs after the meeting
- **Privacy Protection** — Adding someone to an existing DM starts a new thread; they can't see old messages
- **Host Control** — Channel owners approve/deny member additions to prevent thread spam
- **Pop-out Window** — Opens as a separate window to use side-by-side while teaching

### Opening Chat
- From dashboard → Click **💬 Chat** in the left sidebar
- During a meeting → Click **Studio Chat** in the meeting toolbar

---

## 🔒 Security Notes

- Always set a strong `JWT_SECRET` in production
- `DATABASE_URL` is auto-injected by Railway — never commit it to code
- The `.env` file is gitignored
- File uploads are limited to 500MB per recording

---

## 📦 Electron Desktop App

The Electron wrapper (`VS-fresh/`) creates a portable Windows EXE that loads this Railway deployment. Update the `URL` constant in `VS-fresh/main.js` to point to your Railway deployment URL.

---

## 🛠️ API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Register new user |
| `POST` | `/api/auth/login` | Login and receive JWT |
| `GET` | `/api/auth/me` | Get current user info |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health check (used by Railway) |

### Rooms
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/meeting-rooms` | List all rooms |
| `POST` | `/api/meeting-rooms` | Create a room |
| `GET` | `/api/classrooms` | List classrooms |

---

## 📄 License

MIT — Built by NinjaTech AI
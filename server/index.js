/* ═══════════════════════════════════════════════════════════════════════
   Virtual Studio — Main Server
   Railway-ready Express + Socket.IO + PostgreSQL
   ═══════════════════════════════════════════════════════════════════════ */
// ── Process-level error logging (Railway/production safe — stdout only) ──
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const IS_ELECTRON = !!process.env.ELECTRON_APP;

function writeErrorLog(label, err) {
  try {
    const ts = new Date().toISOString();
    const msg = `[${ts}] ${label}: ${err && err.stack ? err.stack : err}\n`;
    console.error(msg);
    // Write to file only in Electron/desktop mode (not Railway)
    if (IS_ELECTRON && !IS_RAILWAY) {
      const _fs = require('fs');
      const _path = require('path');
      const _os = require('os');
      const _logDir = process.env.APPDATA
        ? _path.join(process.env.APPDATA, 'virtual-studio-launcher')
        : _path.join(_os.homedir(), '.virtual-studio');
      try { _fs.mkdirSync(_logDir, { recursive: true }); _fs.appendFileSync(_path.join(_logDir, 'server-error.log'), msg); } catch(_) {}
    }
  } catch(_) {}
}

process.on('uncaughtException', (err) => {
  writeErrorLog('UNCAUGHT_EXCEPTION', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  writeErrorLog('UNHANDLED_REJECTION', err);
  process.exit(1);
});

console.log('[Server] Starting... CWD:', process.cwd());
console.log('[Server] __dirname:', __dirname);
console.log('[Server] Node version:', process.version);
console.log('[Server] Platform:', process.platform);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { generateToken, verifyToken, authMiddleware, optionalAuth, requireRole, canAssignRole, isPrivilegedRole, autoRoleFromEmail, hashPassword, comparePassword, hasRoleAtLeast } = require('./auth');
const { setupChat } = require('./chat');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e8,
  pingTimeout: 60000,
  pingInterval: 25000
});

// ─── Middleware ──────────────────────────────────────────────────────
// ── CORS ── Allow all origins in dev; restrict to FRONTEND_URL in production
const corsOrigin = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, /\.railway\.app$/, /\.up\.railway\.app$/]
  : '*';
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Health Check ── Used by Railway healthcheck probe
const _startTime = Date.now();
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - _startTime) / 1000),
    environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    version: require('../package.json').version
  });
});

// Launcher version endpoint — tells the web app what the minimum launcher version is
// The web app compares this against electronAPI.getVersion() and prompts to update if needed
app.get('/api/launcher-version', (req, res) => {
  res.json({
    minVersion: '1.3.0',        // Minimum launcher version required
    latestVersion: '1.3.0',     // Latest available launcher version
    downloadUrl: 'https://github.com/stgLockDown/VirtualStudioW-Chat/releases/latest',
    updateRequired: false,       // Set true to force-block old launchers
    message: ''                  // Optional message to show users
  });
});

// Recording uploads
const recordingsDir = process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
fs.mkdirSync(recordingsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, recordingsDir),
    filename: (req, file, cb) => {
      // Smart file naming: {instructor_name}_{date}_{session_type}.webm
      const name = (req.body.recordedByName || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const type = (req.body.sessionType || req.body.roomType || 'meeting').toLowerCase();
      const uid = uuidv4().slice(0, 6);
      cb(null, `${name}_${date}_${type}_${uid}.webm`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// ─── In-Memory Live State ───────────────────────────────────────────
const liveRooms = new Map();
const socketToUser = new Map();
const waitingArea = new Map();

async function getRoomTheme(id, type) {
  try {
    const table = type === 'classroom' ? 'classrooms' : 'meeting_rooms';
    const row = await db.getOne(`SELECT theme FROM ${table} WHERE id = $1`, [id]);
    if (row && row.theme) return JSON.parse(row.theme);
  } catch(e) {}
  return {};
}

function autoThemeFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return {
    preset: 'auto',
    primaryColor: `hsl(${hue}, 65%, 55%)`,
    secondaryColor: `hsl(${(hue + 30) % 360}, 50%, 40%)`,
    accentColor: `hsl(${(hue + 180) % 360}, 70%, 60%)`,
    bgColor: `hsl(${hue}, 20%, 10%)`,
    bgSecondary: `hsl(${hue}, 18%, 14%)`,
    headerBg: `hsl(${hue}, 22%, 12%)`,
    toolbarBg: `hsl(${hue}, 20%, 11%)`,
    panelBg: `hsl(${hue}, 18%, 13%)`,
    textColor: '#e8eaed',
    textSecondary: '#9aa0a6',
    borderColor: `hsl(${hue}, 15%, 22%)`,
    fontFamily: 'Inter, sans-serif',
    bgPattern: 'none', bgImage: '', logoUrl: '', bannerText: '',
    layout: 'default', videoGridRadius: '12', toolbarStyle: 'default'
  };
}


// Broadcast waiting room update to all privileged participants (host + instructor+)
function emitWaitingRoomUpdate(room, roomId) {
  const waitingList = Array.from(room.waitingList.entries()).map(([id, w]) => ({ id, name: w.name, role: w.role, joinedAt: w.joinedAt }));
  // Send to host
  io.to(room.hostId).emit('waiting-room-update', { waitingList });
  // Also send to all other privileged users (instructor+) in the room
  room.participants.forEach((p, pid) => {
    if (pid !== room.hostId && db.hasRoleAtLeast(p.role || 'student', 'instructor')) {
      io.to(pid).emit('waiting-room-update', { waitingList });
    }
  });
}

async function createLiveRoom(id, type, name, hostId, hostName, settings = {}) {
  let theme = await getRoomTheme(id, type);
  if (!theme || !theme.preset) theme = autoThemeFromName(name);
  const room = {
    id, type, name, hostId, hostName, createdAt: Date.now(), theme,
    settings: {
      waitingRoom: type === 'classroom', muteOnEntry: settings.muteOnEntry || false,
      allowChat: true, allowScreenShare: true, allowAnnotations: true,
      allowRemoteControl: false, locked: false, maxParticipants: settings.maxParticipants || 100,
    },
    participants: new Map(), waitingList: new Map(), chatMessages: [], annotations: [],
    activeTranscript: [], isRecording: false, recordingStartedBy: null,
    screenController: null, screenSharer: null, breakoutRooms: new Map()
  };
  liveRooms.set(id, room);
  try {
    await db.run(
      `INSERT INTO live_rooms (id, type, name, host_id, host_name, participant_count, is_recording, settings, theme, chat_messages, annotations, transcript, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET host_id=$4, host_name=$5, participant_count=$6, is_recording=$7, settings=$8, theme=$9`,
      [id, type, name, hostId, hostName, 0, false, JSON.stringify(room.settings), JSON.stringify(theme), '[]', '[]', '[]', Date.now()]
    );
  } catch(e) { console.error('live_rooms insert error:', e.message); }
  return room;
}

async function updateLiveRoomInDB(room) {
  try {
    // Persist full room state for permanent rooms
    const settingsJson = JSON.stringify(room.settings);
    const chatJson = JSON.stringify(room.chatMessages.slice(-500)); // Keep last 500 messages
    const annotationsJson = JSON.stringify(room.annotations.slice(-200)); // Keep last 200 annotations
    const transcriptJson = JSON.stringify(room.activeTranscript.slice(-200));
    
    await db.run(`UPDATE live_rooms SET participant_count=$1, is_recording=$2, host_id=$3, host_name=$4, settings=$5, chat_messages=$6, annotations=$7, transcript=$8, theme=$9 WHERE id=$10`,
      [room.participants.size, room.isRecording, room.hostId, room.hostName, settingsJson, chatJson, annotationsJson, transcriptJson, JSON.stringify(room.theme), room.id]);
  } catch(e) { console.error('updateLiveRoomInDB error:', e.message); }
}

async function removeLiveRoomFromDB(roomId) {
  try { await db.run(`DELETE FROM live_rooms WHERE id = $1`, [roomId]); } catch(e) {}
}

// Restore a room from database (for permanent rooms)
async function restoreRoomFromDB(roomId) {
  try {
    const dbRoom = await db.getOne('SELECT * FROM live_rooms WHERE id = $1', [roomId]);
    if (!dbRoom) return null;
    
    const room = {
      id: dbRoom.id,
      type: dbRoom.type,
      name: dbRoom.name,
      hostId: null, // Will be set when someone joins
      hostName: dbRoom.host_name,
      createdAt: dbRoom.created_at,
      theme: dbRoom.theme ? JSON.parse(dbRoom.theme) : null,
      settings: dbRoom.settings ? JSON.parse(dbRoom.settings) : {
        waitingRoom: dbRoom.type === 'classroom',
        muteOnEntry: false,
        allowChat: true,
        allowScreenShare: true,
        allowAnnotations: true,
        allowRemoteControl: false,
        locked: false,
        maxParticipants: 100
      },
      participants: new Map(),
      waitingList: new Map(),
      chatMessages: dbRoom.chat_messages ? JSON.parse(dbRoom.chat_messages) : [],
      annotations: dbRoom.annotations ? JSON.parse(dbRoom.annotations) : [],
      activeTranscript: dbRoom.transcript ? JSON.parse(dbRoom.transcript) : [],
      isRecording: false,
      recordingStartedBy: null,
      screenController: null,
      screenSharer: null,
      breakoutRooms: new Map(),
      _restored: true // Flag to indicate this was restored
    };
    
    liveRooms.set(roomId, room);
    return room;
  } catch(e) {
    console.error('restoreRoomFromDB error:', e.message);
    return null;
  }
}

function getParticipantList(room) {
  const list = [];
  room.participants.forEach((p, id) => {
    list.push({ id, name: p.name, role: p.role, isHost: id === room.hostId,
      audioEnabled: p.audioEnabled, videoEnabled: p.videoEnabled,
      screenSharing: p.screenSharing, handRaised: p.handRaised, joinedAt: p.joinedAt });
  });
  return list;
}

// ═══════════════════════════════════════════════════════════════════════
//  AUTH API
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Username, password, and name are required' });
    const existing = await db.getOne(
      "SELECT id FROM users WHERE username = $1 OR (email = $2 AND email IS NOT NULL AND email != '')", [username, email || '']);
    if (existing) return res.status(409).json({ error: 'Username or email already exists' });
    const id = 'usr-' + uuidv4().slice(0, 8);
    const passwordHash = await hashPassword(password);
    // Role assignment: first real user → owner, @game-u.com → instructor, otherwise student
    // Check if any non-seeded owner/admin/developer exists
    const hasPrivileged = await db.getOne(
      "SELECT id FROM users WHERE role IN ('owner','admin','developer') AND id != 'admin-001'", []);
    let userRole;
    if (!hasPrivileged) {
      userRole = 'owner'; // First real user becomes owner
    } else {
      const autoRole = autoRoleFromEmail(email);
      userRole = autoRole || 'student';
    }
    await db.run(`INSERT INTO users (id, username, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, username, email || null, passwordHash, name, userRole]);
    const token = generateToken({ id, username, name, role: userRole });
    res.json({ token, user: { id, username, name, email, role: userRole } });
  } catch (e) { console.error('Register error:', e.message); res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const user = await db.getOne('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await comparePassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    await db.run('UPDATE users SET last_seen = $1 WHERE id = $2', [Date.now(), user.id]);
    const token = generateToken({ id: user.id, username: user.username, name: user.name, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role } });
  } catch (e) { console.error('Login error:', e.message); res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.getOne('SELECT id, username, email, name, role, avatar_color, basic_mode, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch user' }); }
});

app.get('/api/auth/users', authMiddleware, async (req, res) => {
  try {
    const users = await db.getAll('SELECT id, username, email, name, role, avatar_color, created_at, last_seen FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch users' }); }
});

// Chat user list — accessible to any authenticated user (for DM user picker)
app.get('/api/chat/users', authMiddleware, async (req, res) => {
  try {
    const users = await db.getAll('SELECT id, username, name, role, avatar_color FROM users ORDER BY name ASC');
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch users' }); }
});

// ═══════════════════════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════════════════════

// ── Classrooms ──
app.get('/api/classrooms', optionalAuth, async (req, res) => {
  try {
    let rows;
    // Students only see classrooms they're assigned to
    if (req.user && req.user.role === 'student') {
      rows = await db.getAll(
        `SELECT c.* FROM classrooms c
         INNER JOIN classroom_assignments ca ON ca.classroom_id = c.id
         WHERE ca.student_id = $1
         ORDER BY c.created_at DESC`, [req.user.id]);
    } else {
      rows = await db.getAll('SELECT * FROM classrooms ORDER BY created_at DESC');
    }
    res.json(rows.map(r => ({ ...r, settings: JSON.parse(r.settings || '{}'), theme: JSON.parse(r.theme || '{}') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/classrooms', async (req, res) => {
  try {
    const { name, description, instructorId, instructorName, maxStudents } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = 'cls-' + uuidv4().slice(0, 8);
    await db.run('INSERT INTO classrooms (id, name, description, instructor_id, max_students) VALUES ($1,$2,$3,$4,$5)',
      [id, name, description || '', instructorId || '', maxStudents || 50]);
    if (instructorId && instructorName) {
      await db.run(`INSERT INTO users (id, name, role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [instructorId, instructorName, 'instructor']);
    }
    res.json({ id, name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/classrooms/:id/theme', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) return res.status(400).json({ error: 'Theme data required' });
    await db.run('UPDATE classrooms SET theme = $1, updated_at = $2 WHERE id = $3', [JSON.stringify(theme), Date.now(), req.params.id]);
    res.json({ success: true, theme });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/classrooms/:id/theme', async (req, res) => {
  try {
    const row = await db.getOne('SELECT theme FROM classrooms WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Classroom not found' });
    res.json(JSON.parse(row.theme || '{}'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/classrooms/:id', async (req, res) => {
  try { await db.run('DELETE FROM classrooms WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Meeting Rooms ──
app.get('/api/meeting-rooms', async (req, res) => {
  try {
    const rows = await db.getAll('SELECT * FROM meeting_rooms ORDER BY created_at DESC');
    res.json(rows.map(r => ({ ...r, settings: JSON.parse(r.settings || '{}'), theme: JSON.parse(r.theme || '{}') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/meeting-rooms', async (req, res) => {
  try {
    const { name, description, createdBy, maxParticipants } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = 'mtg-' + uuidv4().slice(0, 8);
    await db.run('INSERT INTO meeting_rooms (id, name, description, created_by, max_participants) VALUES ($1,$2,$3,$4,$5)',
      [id, name, description || '', createdBy || '', maxParticipants || 100]);
    res.json({ id, name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/meeting-rooms/:id/theme', async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) return res.status(400).json({ error: 'Theme data required' });
    await db.run('UPDATE meeting_rooms SET theme = $1 WHERE id = $2', [JSON.stringify(theme), req.params.id]);
    res.json({ success: true, theme });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meeting-rooms/:id/theme', async (req, res) => {
  try {
    const row = await db.getOne('SELECT theme FROM meeting_rooms WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Meeting room not found' });
    res.json(JSON.parse(row.theme || '{}'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/meeting-rooms/:id', async (req, res) => {
  try { await db.run('DELETE FROM meeting_rooms WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Recordings (enhanced with search/filter) ──
app.get('/api/recordings', async (req, res) => {
  try {
    const { search, instructor, dateFrom, dateTo, tag, status, roomType, classId, sortBy, sortDir, limit, offset } = req.query;
    let sql = 'SELECT * FROM recordings WHERE 1=1';
    const params = [];
    let idx = 1;
    if (search) {
      sql += ` AND (LOWER(room_name) LIKE $${idx} OR LOWER(recorded_by_name) LIKE $${idx} OR LOWER(instructor_name) LIKE $${idx} OR LOWER(description) LIKE $${idx} OR LOWER(class_name) LIKE $${idx})`;
      params.push(`%${search.toLowerCase()}%`); idx++;
    }
    if (instructor) { sql += ` AND recorded_by = $${idx}`; params.push(instructor); idx++; }
    if (dateFrom) { sql += ` AND created_at >= $${idx}`; params.push(parseInt(dateFrom)); idx++; }
    if (dateTo) { sql += ` AND created_at <= $${idx}`; params.push(parseInt(dateTo)); idx++; }
    if (status) { sql += ` AND recording_status = $${idx}`; params.push(status); idx++; }
    if (roomType) { sql += ` AND room_type = $${idx}`; params.push(roomType); idx++; }
    if (classId) { sql += ` AND class_id = $${idx}`; params.push(classId); idx++; }
    if (tag) {
      sql += ` AND id IN (SELECT recording_id FROM recording_tags WHERE LOWER(tag) = $${idx})`;
      params.push(tag.toLowerCase()); idx++;
    }
    // Sorting
    const validSorts = ['created_at', 'duration', 'file_size', 'view_count', 'recorded_by_name'];
    const sort = validSorts.includes(sortBy) ? sortBy : 'created_at';
    const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sort} ${dir}`;
    // Pagination
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;
    sql += ` LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(lim, off);
    const rows = await db.getAll(sql, params);
    // Get total count for pagination
    let countSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as count').replace(/ ORDER BY.*$/, '').replace(/ LIMIT.*$/, '');
    const countResult = await db.getOne(countSql, params.slice(0, -2));
    res.json({ recordings: rows, total: parseInt(countResult?.count || rows.length), limit: lim, offset: off });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recordings/:id', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Get tags for this recording
    const tags = await db.getAll('SELECT tag FROM recording_tags WHERE recording_id = $1', [req.params.id]);
    row.tagList = tags.map(t => t.tag);
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recordings/upload', upload.single('recording'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { roomId, roomName, roomType, recordedBy, recordedByName, duration, transcript, summary,
            classId, className, sessionType, description, tags } = req.body;
    const id = 'rec-' + uuidv4().slice(0, 8);
    await db.run(
      `INSERT INTO recordings (id, room_id, room_name, room_type, recorded_by, recorded_by_name, file_path, file_size, duration, status, transcript, summary, instructor_name, session_type, class_id, class_name, description, tags, recording_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, roomId || '', roomName || '', roomType || 'meeting', recordedBy || '', recordedByName || '',
       req.file.filename, req.file.size, parseInt(duration) || 0, 'ready', transcript || '', summary || '',
       recordedByName || '', sessionType || roomType || 'meeting', classId || '', className || '',
       description || '', JSON.stringify(tags ? (Array.isArray(tags) ? tags : [tags]) : []), 'new']);
    // Insert tags into recording_tags table
    if (tags) {
      const tagList = Array.isArray(tags) ? tags : [tags];
      for (const tag of tagList) {
        await db.run('INSERT INTO recording_tags (id, recording_id, tag) VALUES ($1, $2, $3)',
          ['tag-' + uuidv4().slice(0, 8), id, tag.trim()]);
      }
    }
    // Auto-tag with instructor name and room name
    const autoTags = [recordedByName, roomName, sessionType || roomType].filter(Boolean);
    for (const tag of autoTags) {
      await db.run('INSERT INTO recording_tags (id, recording_id, tag) VALUES ($1, $2, $3)',
        ['tag-' + uuidv4().slice(0, 8), id, tag.trim()]);
    }
    res.json({ id, filename: req.file.filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recordings/:id/download', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (!row || !row.file_path) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(recordingsDir, row.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    // Track download count
    await db.run('UPDATE recordings SET download_count = COALESCE(download_count, 0) + 1 WHERE id = $1', [req.params.id]);
    // Use smart filename for download
    const downloadName = row.file_path || `recording-${row.id}.webm`;
    res.download(filePath, downloadName);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Video Streaming (for YouTube-like player) ──
app.get('/api/recordings/:id/stream', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (!row || !row.file_path) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(recordingsDir, row.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/webm'
      });
      file.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/webm' });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/recordings/:id', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (row && row.file_path) { const fp = path.join(recordingsDir, row.file_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await db.run('DELETE FROM recordings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Summaries ──
app.get('/api/summaries', async (req, res) => {
  try {
    const rows = await db.getAll('SELECT * FROM meeting_summaries ORDER BY generated_at DESC');
    res.json(rows.map(r => ({ ...r, key_points: JSON.parse(r.key_points || '[]'), action_items: JSON.parse(r.action_items || '[]'), attendees: JSON.parse(r.attendees || '[]') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/summaries/:id', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM meeting_summaries WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, key_points: JSON.parse(row.key_points || '[]'), action_items: JSON.parse(row.action_items || '[]'), attendees: JSON.parse(row.attendees || '[]') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/summaries', async (req, res) => {
  try {
    const { recordingId, roomId, roomName, title, summary, keyPoints, actionItems, attendees, duration } = req.body;
    const id = 'sum-' + uuidv4().slice(0, 8);
    await db.run(
      `INSERT INTO meeting_summaries (id, recording_id, room_id, room_name, title, summary, key_points, action_items, attendees, duration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, recordingId || '', roomId || '', roomName || '', title || '', summary || '', JSON.stringify(keyPoints || []), JSON.stringify(actionItems || []), JSON.stringify(attendees || []), parseInt(duration) || 0]);
    if (recordingId) { await db.run('UPDATE recordings SET summary = $1, summary_generated_at = $2 WHERE id = $3', [summary || '', Date.now(), recordingId]); }
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/summaries/:id', async (req, res) => {
  try { await db.run('DELETE FROM meeting_summaries WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Transcripts ──
app.post('/api/transcripts', async (req, res) => {
  try {
    const { recordingId, roomId, content, language } = req.body;
    const id = 'trn-' + uuidv4().slice(0, 8);
    await db.run('INSERT INTO transcripts (id, recording_id, room_id, content, language) VALUES ($1,$2,$3,$4,$5)',
      [id, recordingId || '', roomId || '', JSON.stringify(content || []), language || 'en']);
    if (recordingId) {
      const text = (content || []).map(c => `[${c.speaker || 'Unknown'}]: ${c.text}`).join('\n');
      await db.run('UPDATE recordings SET transcript = $1 WHERE id = $2', [text, recordingId]);
    }
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Integrations API ──
app.get('/api/integrations', async (req, res) => {
  try {
    const rows = await db.getAll('SELECT * FROM integrations ORDER BY created_at DESC');
    res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}'), events: JSON.parse(r.events || '[]') })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/integrations', async (req, res) => {
  try {
    const { type, name, config, events, enabled } = req.body;
    if (!type || !name) return res.status(400).json({ error: 'Type and name required' });
    const id = 'int-' + uuidv4().slice(0, 8);
    await db.run('INSERT INTO integrations (id, type, name, config, events, enabled) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, type, name, JSON.stringify(config || {}), JSON.stringify(events || ['summary_generated']), enabled !== false ? 1 : 0]);
    res.json({ id, name, type });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/integrations/:id', async (req, res) => {
  try {
    const { name, config, events, enabled } = req.body;
    const sets = []; const vals = []; let idx = 1;
    if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
    if (config !== undefined) { sets.push(`config = $${idx++}`); vals.push(JSON.stringify(config)); }
    if (events !== undefined) { sets.push(`events = $${idx++}`); vals.push(JSON.stringify(events)); }
    if (enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(enabled ? 1 : 0); }
    sets.push(`updated_at = $${idx++}`); vals.push(Date.now());
    vals.push(req.params.id);
    await db.run(`UPDATE integrations SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/integrations/:id', async (req, res) => {
  try { await db.run('DELETE FROM integrations WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/integrations/:id/test', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM integrations WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const config = JSON.parse(row.config || '{}');
    const result = await sendWebhook(row.type, config, { event: 'test', message: '🧪 Test notification from Virtual Studio', timestamp: new Date().toISOString() });
    res.json({ success: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Webhook Dispatch System ──
async function sendWebhook(type, config, payload) {
  const url = config.webhookUrl || config.url;
  if (!url) throw new Error('No webhook URL configured');
  if (type === 'slack') {
    const body = { text: payload.message || 'Virtual Studio Notification', blocks: [] };
    if (payload.event === 'summary_generated' && payload.summary) {
      body.blocks = [
        { type: 'header', text: { type: 'plain_text', text: `📝 Meeting Summary: ${payload.summary.title || payload.summary.roomName || 'Meeting'}` } },
        { type: 'section', text: { type: 'mrkdwn', text: payload.summary.summary || 'No summary available' } },
      ];
      if (payload.summary.keyPoints?.length) body.blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Key Points:*\n${payload.summary.keyPoints.map(k => `• ${k}`).join('\n')}` } });
      if (payload.summary.actionItems?.length) body.blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Action Items:*\n${payload.summary.actionItems.map(a => `☐ ${a}`).join('\n')}` } });
      if (payload.summary.attendees?.length) body.blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `👥 *Attendees:* ${payload.summary.attendees.join(', ')}` }] });
      body.blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⏱ Duration: ${payload.summary.duration || 'N/A'} | Generated: ${new Date().toLocaleString()}` }] });
      body.text = `Meeting Summary: ${payload.summary.title || 'Meeting'}`;
    } else if (payload.event === 'test') {
      body.blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🧪 Virtual Studio Test' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'This is a test notification from Virtual Studio. Your integration is working!' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Sent at ${new Date().toLocaleString()}` }] }
      ];
    }
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`Slack returned ${resp.status}`);
    return { status: resp.status };
  } else if (type === 'discord') {
    const body = { content: payload.message || 'Virtual Studio Notification', embeds: [] };
    if (payload.event === 'summary_generated' && payload.summary) {
      body.embeds.push({
        title: `📝 ${payload.summary.title || payload.summary.roomName || 'Meeting Summary'}`,
        description: payload.summary.summary || '', color: 3447003,
        fields: [
          ...(payload.summary.keyPoints?.length ? [{ name: 'Key Points', value: payload.summary.keyPoints.map(k => `• ${k}`).join('\n') }] : []),
          ...(payload.summary.actionItems?.length ? [{ name: 'Action Items', value: payload.summary.actionItems.map(a => `☐ ${a}`).join('\n') }] : []),
          ...(payload.summary.attendees?.length ? [{ name: 'Attendees', value: payload.summary.attendees.join(', '), inline: true }] : []),
        ],
        footer: { text: `Duration: ${payload.summary.duration || 'N/A'}` }, timestamp: new Date().toISOString()
      });
      body.content = `📝 New meeting summary generated`;
    }
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
    return { status: resp.status };
  } else {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify({ ...payload, source: 'virtual-studio', timestamp: new Date().toISOString() }) });
    if (!resp.ok) throw new Error(`Webhook returned ${resp.status}`);
    return { status: resp.status };
  }
}

async function dispatchToIntegrations(eventType, payload) {
  try {
    const rows = await db.getAll('SELECT * FROM integrations WHERE enabled = 1');
    for (const row of rows) {
      const events = JSON.parse(row.events || '[]');
      if (!events.includes(eventType) && !events.includes('*')) continue;
      const config = JSON.parse(row.config || '{}');
      try { await sendWebhook(row.type, config, { event: eventType, ...payload }); }
      catch (e) { console.error(`Integration ${row.name} (${row.type}) failed:`, e.message); }
    }
  } catch (e) { console.error('dispatchToIntegrations error:', e.message); }
}

// ── AI Summary Generation ──
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

app.post('/api/recordings/:id/generate-summary', async (req, res) => {
  try {
    const row = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Recording not found' });
    const transcript = row.transcript || '';
    const roomName = row.room_name || 'Meeting';
    const duration = row.duration || 0;
    const durationStr = `${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s`;
    const speakerSet = new Set();
    transcript.split('\n').forEach(line => { const m = line.match(/^\[(.+?)\]:/); if (m) speakerSet.add(m[1]); });
    const attendees = Array.from(speakerSet);
    let summaryData;
    if (OPENAI_API_KEY) {
      try {
        const systemPrompt = `You are a meeting summary assistant. Generate a structured JSON summary. Return ONLY valid JSON: {"title":"...","summary":"...","keyPoints":[...],"actionItems":[...],"decisions":[...],"topics":[...]}`;
        const userPrompt = `Meeting: "${roomName}"\nDuration: ${durationStr}\nAttendees: ${attendees.join(', ') || 'Unknown'}\n\nTranscript:\n${transcript.slice(0, 12000)}\n\nGenerate a comprehensive meeting summary.`;
        const aiResp = await fetch(`${AI_BASE_URL}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.3, max_tokens: 2000, response_format: { type: 'json_object' } })
        });
        if (!aiResp.ok) throw new Error(`AI API returned ${aiResp.status}`);
        const aiData = await aiResp.json();
        summaryData = JSON.parse(aiData.choices?.[0]?.message?.content || '{}');
      } catch (e) { console.error('AI summary failed:', e.message); summaryData = generateLocalSummary(transcript, roomName, durationStr, attendees); }
    } else { summaryData = generateLocalSummary(transcript, roomName, durationStr, attendees); }

    const summaryId = 'sum-' + uuidv4().slice(0, 8);
    const title = summaryData.title || `${roomName} Summary`;
    const summaryText = summaryData.summary || '';
    const keyPoints = summaryData.keyPoints || [];
    const actionItems = summaryData.actionItems || [];
    await db.run(`INSERT INTO meeting_summaries (id, recording_id, room_id, room_name, title, summary, key_points, action_items, attendees, duration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [summaryId, row.id, row.room_id, roomName, title, summaryText, JSON.stringify(keyPoints), JSON.stringify(actionItems), JSON.stringify(attendees), duration]);
    await db.run('UPDATE recordings SET summary = $1, summary_generated_at = $2 WHERE id = $3', [summaryText, Date.now(), row.id]);
    const fullSummary = { id: summaryId, title, summary: summaryText, keyPoints, actionItems, decisions: summaryData.decisions || [], topics: summaryData.topics || [], attendees, roomName, duration: durationStr };
    dispatchToIntegrations('summary_generated', { summary: fullSummary });
    res.json(fullSummary);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function generateLocalSummary(transcript, roomName, durationStr, attendees) {
  const lines = transcript.split('\n').filter(l => l.trim());
  const speakerLines = {};
  lines.forEach(line => { const m = line.match(/^\[(.+?)\]:\s*(.+)/); if (m) { if (!speakerLines[m[1]]) speakerLines[m[1]] = []; speakerLines[m[1]].push(m[2]); } });
  const words = lines.join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const freq = {}; words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  const speakerSummaries = Object.entries(speakerLines).map(([s, msgs]) => `${s} contributed ${msgs.length} message${msgs.length > 1 ? 's' : ''}`).join('. ');
  const summary = lines.length > 0
    ? `Meeting "${roomName}" lasted ${durationStr} with ${attendees.length || 'unknown number of'} participants. ${speakerSummaries}. The discussion covered ${lines.length} transcript segments including ${topWords.slice(0, 4).join(', ') || 'general discussion'}.`
    : `Meeting "${roomName}" lasted ${durationStr}. No transcript was captured.`;
  const keyPoints = [];
  if (lines.length > 0) keyPoints.push(`${lines.length} transcript segments captured`);
  if (attendees.length > 0) keyPoints.push(`${attendees.length} participants: ${attendees.join(', ')}`);
  if (topWords.length > 0) keyPoints.push(`Main topics: ${topWords.slice(0, 5).join(', ')}`);
  return { title: `${roomName} - Meeting Summary`, summary, keyPoints, actionItems: lines.length > 3 ? ['Review meeting recording', 'Follow up on discussed topics'] : ['Review meeting recording'], decisions: [], topics: topWords.slice(0, 6) };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROLE MANAGEMENT API
// ═══════════════════════════════════════════════════════════════════════════

// Get all users with roles (admin+ only)
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const users = await db.getAll(
      'SELECT id, username, email, name, role, avatar_color, role_assigned_by, role_assigned_at, created_at, last_seen FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a user's role (requires appropriate hierarchy)
app.put('/api/admin/users/:id/role', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'Role is required' });
    const validRoles = ['student', 'instructor', 'admin', 'developer', 'owner'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Check if actor can assign this role
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({ error: `Your role (${req.user.role}) cannot assign the role: ${role}` });
    }
    // Cannot change own role
    if (req.params.id === req.user.id) {
      return res.status(403).json({ error: 'Cannot change your own role' });
    }
    // Check target user exists and their current role
    const target = await db.getOne('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Cannot modify someone with equal or higher role
    if (!hasRoleAtLeast(req.user.role, target.role) || db.roleLevel(target.role) >= db.roleLevel(req.user.role)) {
      return res.status(403).json({ error: 'Cannot modify a user with equal or higher role' });
    }
    await db.run('UPDATE users SET role = $1, role_assigned_by = $2, role_assigned_at = $3 WHERE id = $4',
      [role, req.user.id, Date.now(), req.params.id]);
    res.json({ success: true, userId: req.params.id, newRole: role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ENHANCED RECORDINGS MANAGEMENT API
// ═══════════════════════════════════════════════════════════════════════════

// Update recording status (new/watched/flagged/archived)
app.put('/api/recordings/:id/status', authMiddleware, requireRole('instructor'), async (req, res) => {
  try {
    const { recording_status } = req.body;
    const validStatuses = ['new', 'watched', 'flagged', 'archived'];
    if (!validStatuses.includes(recording_status)) return res.status(400).json({ error: 'Invalid status' });
    await db.run('UPDATE recordings SET recording_status = $1 WHERE id = $2', [recording_status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update recording metadata (description, tags)
app.put('/api/recordings/:id/metadata', authMiddleware, requireRole('instructor'), async (req, res) => {
  try {
    const { description, tags, class_name, class_id } = req.body;
    const sets = []; const vals = []; let idx = 1;
    if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
    if (class_name !== undefined) { sets.push(`class_name = $${idx++}`); vals.push(class_name); }
    if (class_id !== undefined) { sets.push(`class_id = $${idx++}`); vals.push(class_id); }
    if (tags !== undefined) {
      sets.push(`tags = $${idx++}`); vals.push(JSON.stringify(tags));
      // Update recording_tags table
      await db.run('DELETE FROM recording_tags WHERE recording_id = $1', [req.params.id]);
      for (const tag of (Array.isArray(tags) ? tags : [])) {
        await db.run('INSERT INTO recording_tags (id, recording_id, tag) VALUES ($1, $2, $3)',
          ['tag-' + uuidv4().slice(0, 8), req.params.id, tag.trim()]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    await db.run(`UPDATE recordings SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a view event
app.post('/api/recordings/:id/view', authMiddleware, async (req, res) => {
  try {
    const { watched_duration, completed } = req.body;
    const viewId = 'view-' + uuidv4().slice(0, 8);
    await db.run(
      'INSERT INTO recording_views (id, recording_id, user_id, user_name, watched_duration, completed) VALUES ($1,$2,$3,$4,$5,$6)',
      [viewId, req.params.id, req.user.id, req.user.name, parseInt(watched_duration) || 0, completed || false]
    );
    await db.run('UPDATE recordings SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = $1 WHERE id = $2',
      [Date.now(), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get recording analytics (admin+ only)
app.get('/api/recordings/:id/analytics', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const recording = await db.getOne('SELECT * FROM recordings WHERE id = $1', [req.params.id]);
    if (!recording) return res.status(404).json({ error: 'Not found' });
    const views = await db.getAll(
      'SELECT user_name, watched_duration, completed, created_at FROM recording_views WHERE recording_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    const tags = await db.getAll('SELECT tag FROM recording_tags WHERE recording_id = $1', [req.params.id]);
    res.json({
      recording,
      views,
      tags: tags.map(t => t.tag),
      totalViews: recording.view_count || 0,
      totalDownloads: recording.download_count || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all unique tags (for filter dropdowns)
app.get('/api/recordings/meta/tags', async (req, res) => {
  try {
    const tags = await db.getAll('SELECT DISTINCT tag FROM recording_tags ORDER BY tag ASC');
    res.json(tags.map(t => t.tag));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all instructors (for filter dropdowns)
app.get('/api/recordings/meta/instructors', async (req, res) => {
  try {
    const instructors = await db.getAll(
      "SELECT DISTINCT recorded_by as id, recorded_by_name as name FROM recordings WHERE recorded_by != '' ORDER BY recorded_by_name ASC"
    );
    res.json(instructors);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CLASSROOM ASSIGNMENT API (admin+ assigns students to classrooms)
// ═══════════════════════════════════════════════════════════════════════════

// Get assignments for a classroom
app.get('/api/classrooms/:id/assignments', authMiddleware, requireRole('instructor'), async (req, res) => {
  try {
    const rows = await db.getAll(
      `SELECT ca.*, u.name as student_name, u.username as student_username, u.email as student_email
       FROM classroom_assignments ca
       JOIN users u ON u.id = ca.student_id
       WHERE ca.classroom_id = $1
       ORDER BY u.name ASC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all classrooms a student is assigned to
app.get('/api/users/:id/assignments', authMiddleware, async (req, res) => {
  try {
    // Students can only see their own, admin+ can see anyone's
    if (req.user.role === 'student' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Cannot view other users assignments' });
    }
    const rows = await db.getAll(
      `SELECT ca.*, c.name as classroom_name, c.description as classroom_description
       FROM classroom_assignments ca
       JOIN classrooms c ON c.id = ca.classroom_id
       WHERE ca.student_id = $1
       ORDER BY ca.assigned_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign student(s) to a classroom (admin+)
app.post('/api/classrooms/:id/assignments', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { studentIds } = req.body; // array of student IDs
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'studentIds array is required' });
    }
    // Verify classroom exists
    const classroom = await db.getOne('SELECT id FROM classrooms WHERE id = $1', [req.params.id]);
    if (!classroom) return res.status(404).json({ error: 'Classroom not found' });

    let assigned = 0;
    for (const sid of studentIds) {
      try {
        const id = 'asgn-' + require('uuid').v4().slice(0, 8);
        await db.run(
          `INSERT INTO classroom_assignments (id, classroom_id, student_id, assigned_by)
           VALUES ($1, $2, $3, $4) ON CONFLICT (classroom_id, student_id) DO NOTHING`,
          [id, req.params.id, sid, req.user.id]);
        assigned++;
      } catch (_) {}
    }
    res.json({ success: true, assigned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove student from classroom (admin+)
app.delete('/api/classrooms/:id/assignments/:studentId', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    await db.run('DELETE FROM classroom_assignments WHERE classroom_id = $1 AND student_id = $2',
      [req.params.id, req.params.studentId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk assignment: get all students (for assignment dropdown)
app.get('/api/users/students', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const students = await db.getAll(
      "SELECT id, username, name, email FROM users WHERE role = 'student' ORDER BY name ASC");
    res.json(students);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  USER PREFERENCES API (basic mode)
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/auth/preferences', authMiddleware, async (req, res) => {
  try {
    const { basic_mode } = req.body;
    if (basic_mode !== undefined) {
      await db.run('UPDATE users SET basic_mode = $1 WHERE id = $2', [!!basic_mode, req.user.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin Stats (enhanced) ──
app.get('/api/admin/stats', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const classrooms = parseInt((await db.getOne('SELECT COUNT(*) as count FROM classrooms')).count) || 0;
    const meetings = parseInt((await db.getOne('SELECT COUNT(*) as count FROM meeting_rooms')).count) || 0;
    const recordings = parseInt((await db.getOne('SELECT COUNT(*) as count FROM recordings')).count) || 0;
    const summaries = parseInt((await db.getOne('SELECT COUNT(*) as count FROM meeting_summaries')).count) || 0;
    const users = parseInt((await db.getOne('SELECT COUNT(*) as count FROM users')).count) || 0;
    const activeRooms = liveRooms.size;
    let totalParticipants = 0;
    liveRooms.forEach(r => { totalParticipants += r.participants.size; });
    // Enhanced: role breakdown + storage stats
    const roleCounts = await db.getAll("SELECT role, COUNT(*) as count FROM users GROUP BY role");
    const roleBreakdown = {};
    roleCounts.forEach(r => { roleBreakdown[r.role] = parseInt(r.count); });
    const storageResult = await db.getOne('SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM recordings');
    const totalStorageBytes = parseInt(storageResult?.total_bytes || 0);
    const totalViews = (await db.getOne('SELECT COALESCE(SUM(view_count), 0) as total FROM recordings')).total;
    const totalDownloads = (await db.getOne('SELECT COALESCE(SUM(download_count), 0) as total FROM recordings')).total;
    res.json({
      classrooms, meetings, recordings, summaries, users, activeRooms,
      totalParticipants, waitingArea: waitingArea.size,
      roleBreakdown, totalStorageBytes, totalViews: parseInt(totalViews),
      totalDownloads: parseInt(totalDownloads)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Live rooms status ──
// ── Overview stats (accessible to all authenticated users) ──
app.get('/api/overview/stats', optionalAuth, async (req, res) => {
  try {
    const classrooms = parseInt((await db.getOne('SELECT COUNT(*) as count FROM classrooms')).count) || 0;
    const meetings = parseInt((await db.getOne('SELECT COUNT(*) as count FROM meeting_rooms')).count) || 0;
    const recordings = parseInt((await db.getOne('SELECT COUNT(*) as count FROM recordings')).count) || 0;
    const summaries = parseInt((await db.getOne('SELECT COUNT(*) as count FROM meeting_summaries')).count) || 0;
    const activeRooms = liveRooms.size;
    let totalParticipants = 0;
    liveRooms.forEach(r => { totalParticipants += r.participants.size; });
    res.json({
      classrooms, meetings, recordings, summaries,
      activeRooms, totalParticipants, waitingArea: waitingArea.size
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/live-rooms', async (req, res) => {
  try {
    const rooms = [];
    liveRooms.forEach((room, id) => {
      rooms.push({ id, type: room.type, name: room.name, hostName: room.hostName,
        participantCount: room.participants.size, waitingCount: room.waitingList.size,
        isRecording: room.isRecording, createdAt: room.createdAt });
    });
    const dbRooms = await db.getAll('SELECT * FROM live_rooms');
    for (const dbRoom of dbRooms) {
      if (!liveRooms.has(dbRoom.id)) {
        rooms.push({ id: dbRoom.id, type: dbRoom.type, name: dbRoom.name, hostName: dbRoom.host_name,
          participantCount: dbRoom.participant_count || 0, waitingCount: 0,
          isRecording: dbRoom.is_recording || false, createdAt: dbRoom.created_at });
      }
    }
    res.json(rooms);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback
app.get('/{*splat}', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); });

// ═══════════════════════════════════════════════════════════════════════
//  CHAT SYSTEM — Native Slack-like /chat namespace
// ═══════════════════════════════════════════════════════════════════════
setupChat(io);

// ═══════════════════════════════════════════════════════════════════════
//  SOCKET.IO — Real-time Signaling
// ═══════════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  socket.on('register-user', ({ name, role, userId }, cb) => {
    socketToUser.set(socket.id, { name, role: role || 'student', socketId: socket.id, id: userId || null });
    if (cb) cb({ success: true });
  });

  socket.on('create-room', async ({ roomId, type, name, hostName, settings }, callback) => {
    try {
      const id = roomId || (type === 'classroom' ? 'cls-' : 'mtg-') + uuidv4().slice(0, 8);
      // If room exists in memory, reuse it
      let room = liveRooms.get(id);
      if (room && room._cleanupTimer) {
        clearTimeout(room._cleanupTimer);
        room._cleanupTimer = null;
        room.hostId = socket.id;
      } else if (room) {
        // Room exists and is active - just reassign host
        room.hostId = socket.id;
      } else {
        // Check if room exists in database (permanent room restoration)
        room = await restoreRoomFromDB(id);
        if (room) {
          console.log(`Room ${id} restored from database for host`);
          room.hostId = socket.id;
          if (room._cleanupTimer) { clearTimeout(room._cleanupTimer); room._cleanupTimer = null; }
        } else {
          // Create new room
          room = await createLiveRoom(id, type || 'meeting', name, socket.id, hostName, settings);
        }
      }
      const hostUser = socketToUser.get(socket.id);
      const hostRole = hostUser?.role || 'instructor';
      const participant = { name: hostName, role: hostRole, isHost: true, audioEnabled: true, videoEnabled: true, screenSharing: false, handRaised: false, joinedAt: Date.now() };
      room.participants.set(socket.id, participant);
      const existingUser = socketToUser.get(socket.id);
      socketToUser.set(socket.id, { name: hostName, role: hostRole, roomId: id, socketId: socket.id, id: existingUser?.id || null });
      socket.join(id);
      if (type === 'classroom') { await db.run('UPDATE classrooms SET status = $1 WHERE id = $2', ['active', id]); }
      else { await db.run('UPDATE meeting_rooms SET status = $1 WHERE id = $2', ['active', id]); }
      await updateLiveRoomInDB(room);
      callback({ success: true, roomId: id, meetingName: name, participants: getParticipantList(room), settings: room.settings, theme: room.theme });
    } catch(e) { console.error('create-room error:', e.message); callback({ success: false, error: e.message }); }
  });

  socket.on('join-room', async ({ roomId, userName, userRole }, callback) => {
    try {
      let room = liveRooms.get(roomId);
      
      // If room not in memory, try to restore from database (permanent rooms)
      if (!room) {
        room = await restoreRoomFromDB(roomId);
        if (!room) {
          // Check if this is a valid classroom or meeting room that exists
          const classroom = await db.getOne('SELECT id FROM classrooms WHERE id = $1', [roomId]);
          const meetingRoom = await db.getOne('SELECT id FROM meeting_rooms WHERE id = $1', [roomId]);
          if (!classroom && !meetingRoom) {
            return callback({ success: false, error: 'Room not found.' });
          }
          // Room exists but has never been started - create fresh
          const roomData = classroom || meetingRoom;
          const type = classroom ? 'classroom' : 'meeting';
          room = await createLiveRoom(roomId, type, roomData.name || 'Room', socket.id, userName);
        } else {
          console.log(`Room ${roomId} restored from database`);
        }
      }
      
      // Clear cleanup timer if someone rejoins
      if (room._cleanupTimer) { clearTimeout(room._cleanupTimer); room._cleanupTimer = null; }
      
      if (room.settings.locked) return callback({ success: false, error: 'Room is locked' });
      if (room.participants.size >= room.settings.maxParticipants) return callback({ success: false, error: 'Room is full' });
      const role = userRole || 'student';
      if (room.settings.waitingRoom && !db.hasRoleAtLeast(role, 'instructor')) {
        room.waitingList.set(socket.id, { name: userName, role, joinedAt: Date.now() });
        const existWait = socketToUser.get(socket.id);
        socketToUser.set(socket.id, { name: userName, role, roomId, socketId: socket.id, id: existWait?.id || null });
        socket.join(roomId + '-waiting');
        emitWaitingRoomUpdate(room, roomId);
        return callback({ success: true, waiting: true });
      }
      // Clear grace period timer if someone rejoins
      if (room._graceTimer) { clearTimeout(room._graceTimer); room._graceTimer = null; }
      const isNewHost = room.participants.size === 0; // First to rejoin becomes host
      const participant = { name: userName, role, isHost: isNewHost, audioEnabled: !room.settings.muteOnEntry, videoEnabled: true, screenSharing: false, handRaised: false, joinedAt: Date.now() };
      if (isNewHost) room.hostId = socket.id;
      room.participants.set(socket.id, participant);
      const existJoin = socketToUser.get(socket.id);
      socketToUser.set(socket.id, { name: userName, role, roomId, socketId: socket.id, id: existJoin?.id || null });
      socket.join(roomId);
      socket.to(roomId).emit('user-joined', { userId: socket.id, userName, userRole: role, audioEnabled: participant.audioEnabled, videoEnabled: participant.videoEnabled });
      io.to(roomId).emit('participants-update', { participants: getParticipantList(room) });
      await updateLiveRoomInDB(room);
      callback({ success: true, waiting: false, roomId, meetingName: room.name, participants: getParticipantList(room), settings: room.settings, chatHistory: room.chatMessages.slice(-200), isRecording: room.isRecording, muteOnEntry: room.settings.muteOnEntry, transcript: room.activeTranscript.slice(-100), theme: room.theme });
    } catch(e) { console.error('join-room error:', e.message); callback({ success: false, error: e.message }); }
  });

  // ── Admit / Deny from Waiting Room ──
  socket.on('admit-participant', ({ participantId }) => {
    const user = socketToUser.get(socket.id); if (!user) return;
    const room = liveRooms.get(user.roomId); if (!room) return;
    const canAdmit = socket.id === room.hostId || db.hasRoleAtLeast(user.role || 'student', 'instructor');
    if (!canAdmit) return;
    const waiting = room.waitingList.get(participantId); if (!waiting) return;
    room.waitingList.delete(participantId);
    const participant = { name: waiting.name, role: waiting.role, isHost: false, audioEnabled: !room.settings.muteOnEntry, videoEnabled: true, screenSharing: false, handRaised: false, joinedAt: Date.now() };
    room.participants.set(participantId, participant);
    const ts = io.sockets.sockets.get(participantId);
    if (ts) { ts.leave(user.roomId + '-waiting'); ts.join(user.roomId); }
    io.to(participantId).emit('admitted', { roomId: user.roomId, meetingName: room.name, participants: getParticipantList(room), settings: room.settings, chatHistory: room.chatMessages.slice(-200), transcript: room.activeTranscript.slice(-100) });
    socket.to(user.roomId).emit('user-joined', { userId: participantId, userName: waiting.name, userRole: waiting.role, audioEnabled: participant.audioEnabled, videoEnabled: participant.videoEnabled });
    io.to(user.roomId).emit('participants-update', { participants: getParticipantList(room) });
    emitWaitingRoomUpdate(room, user.roomId);
    updateLiveRoomInDB(room);
  });

  socket.on('admit-all', () => {
    const user = socketToUser.get(socket.id); if (!user) return;
    const room = liveRooms.get(user.roomId); if (!room) return;
    const canAdmit = socket.id === room.hostId || db.hasRoleAtLeast(user.role || 'student', 'instructor');
    if (!canAdmit) return;
    Array.from(room.waitingList.entries()).forEach(([pid, w]) => {
      room.waitingList.delete(pid);
      const participant = { name: w.name, role: w.role, isHost: false, audioEnabled: !room.settings.muteOnEntry, videoEnabled: true, screenSharing: false, handRaised: false, joinedAt: Date.now() };
      room.participants.set(pid, participant);
      const ts = io.sockets.sockets.get(pid);
      if (ts) { ts.leave(user.roomId + '-waiting'); ts.join(user.roomId); }
      io.to(pid).emit('admitted', { roomId: user.roomId, meetingName: room.name, participants: getParticipantList(room), settings: room.settings, chatHistory: room.chatMessages.slice(-200), transcript: room.activeTranscript.slice(-100) });
      socket.to(user.roomId).emit('user-joined', { userId: pid, userName: w.name, userRole: w.role, audioEnabled: participant.audioEnabled, videoEnabled: participant.videoEnabled });
    });
    io.to(user.roomId).emit('participants-update', { participants: getParticipantList(room) });
    emitWaitingRoomUpdate(room, user.roomId);
    updateLiveRoomInDB(room);
  });

  socket.on('deny-participant', ({ participantId }) => {
    const user = socketToUser.get(socket.id); if (!user) return;
    const room = liveRooms.get(user.roomId); if (!room) return;
    const canAdmit = socket.id === room.hostId || db.hasRoleAtLeast(user.role || 'student', 'instructor');
    if (!canAdmit) return;
    room.waitingList.delete(participantId);
    io.to(participantId).emit('denied');
    emitWaitingRoomUpdate(room, user.roomId);
  });

  // ── WebRTC Signaling ──
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // ── Media Toggles ──
  socket.on('toggle-audio', ({ enabled }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (p) { p.audioEnabled = enabled; socket.to(u.roomId).emit('user-toggle-audio', { userId: socket.id, enabled }); } });
  socket.on('toggle-video', ({ enabled }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (p) { p.videoEnabled = enabled; socket.to(u.roomId).emit('user-toggle-video', { userId: socket.id, enabled }); } });

  // ── Screen Sharing ──
  socket.on('screen-share-started', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (p) { p.screenSharing = true; r.screenSharer = socket.id; socket.to(u.roomId).emit('user-screen-share', { userId: socket.id, sharing: true }); } });
  socket.on('screen-share-stopped', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (p) { p.screenSharing = false; r.screenSharer = null; r.screenController = null; socket.to(u.roomId).emit('user-screen-share', { userId: socket.id, sharing: false }); io.to(u.roomId).emit('remote-control-ended'); } });

  // ── Remote Screen Control ──
  socket.on('request-remote-control', ({ targetId }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; io.to(targetId).emit('remote-control-request', { fromId: socket.id, fromName: u.name }); });
  socket.on('grant-remote-control', ({ toId }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (r) r.screenController = toId; io.to(toId).emit('remote-control-granted', { sharerId: socket.id, sharerName: u.name }); io.to(u.roomId).emit('remote-control-active', { controllerId: toId, controllerName: socketToUser.get(toId)?.name, sharerId: socket.id, sharerName: u.name }); });
  socket.on('deny-remote-control', ({ toId }) => { const u = socketToUser.get(socket.id); if (!u) return; io.to(toId).emit('remote-control-denied', { sharerName: u.name }); });
  socket.on('revoke-remote-control', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (r) { if (r.screenController) io.to(r.screenController).emit('remote-control-revoked'); r.screenController = null; } io.to(u.roomId).emit('remote-control-ended'); });
  socket.on('remote-control-event', ({ targetId, event }) => { io.to(targetId).emit('remote-control-event', { fromId: socket.id, event }); });

  // ── Theme Updates ──
  socket.on('update-room-theme', async (themeData) => {
    const u = socketToUser.get(socket.id); if (!u?.roomId) return;
    const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return;
    r.theme = { ...r.theme, ...themeData };
    const table = r.type === 'classroom' ? 'classrooms' : 'meeting_rooms';
    try { await db.run(`UPDATE ${table} SET theme = $1 WHERE id = $2`, [JSON.stringify(r.theme), r.id]); } catch(e) {}
    io.to(u.roomId).emit('theme-updated', r.theme);
  });

  // ── Annotations ──
  socket.on('annotation-draw', (data) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || !r.settings.allowAnnotations) return; const a = { ...data, userId: socket.id, userName: u.name, timestamp: Date.now() }; r.annotations.push(a); if (r.annotations.length > 1000) r.annotations = r.annotations.slice(-500); socket.to(u.roomId).emit('annotation-draw', a); });
  socket.on('annotation-clear', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (r) { r.annotations = []; io.to(u.roomId).emit('annotation-clear'); } });
  socket.on('annotation-undo', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (r) { for (let i = r.annotations.length - 1; i >= 0; i--) { if (r.annotations[i].userId === socket.id) { r.annotations.splice(i, 1); break; } } io.to(u.roomId).emit('annotation-sync', r.annotations); } });

  // ── Chat ──
  socket.on('chat-message', ({ message, type }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || !r.settings.allowChat) return; const msg = { id: uuidv4(), senderId: socket.id, senderName: u.name, senderRole: u.role, message, type: type || 'text', timestamp: Date.now() }; r.chatMessages.push(msg); if (r.chatMessages.length > 500) r.chatMessages.shift(); io.to(u.roomId).emit('chat-message', msg); });

  // ── Hand Raise ──
  socket.on('toggle-hand', ({ raised }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (p) { p.handRaised = raised; io.to(u.roomId).emit('user-hand-raised', { userId: socket.id, raised, userName: u.name }); } });

  // ── Reactions ──
  socket.on('reaction', ({ emoji }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; io.to(u.roomId).emit('reaction', { userId: socket.id, userName: u.name, emoji }); });

  // ── Live Transcription ──
  socket.on('transcript-segment', ({ text, isFinal }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const seg = { speaker: u.name, text, isFinal, timestamp: Date.now() }; if (isFinal) { r.activeTranscript.push(seg); if (r.activeTranscript.length > 500) r.activeTranscript.shift(); } io.to(u.roomId).emit('transcript-segment', seg); });

  // ── Recording ──
  // Only instructor+ can record (uses role hierarchy)
  socket.on('toggle-recording', ({ recording }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const p = r.participants.get(socket.id); if (!p || (socket.id !== r.hostId && !isPrivilegedRole(p.role))) return; r.isRecording = recording; r.recordingStartedBy = recording ? socket.id : null; io.to(u.roomId).emit('recording-status', { recording, startedBy: u.name }); updateLiveRoomInDB(r); });

  // ── Host Controls ──
  socket.on('mute-participant', ({ participantId }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return; const p = r.participants.get(participantId); if (p) { p.audioEnabled = false; io.to(participantId).emit('force-mute'); io.to(u.roomId).emit('user-toggle-audio', { userId: participantId, enabled: false }); } });
  socket.on('mute-all', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return; r.participants.forEach((p, pid) => { if (pid !== socket.id) { p.audioEnabled = false; io.to(pid).emit('force-mute'); } }); io.to(u.roomId).emit('participants-update', { participants: getParticipantList(r) }); });
  socket.on('remove-participant', ({ participantId }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return; io.to(participantId).emit('removed-from-meeting'); const ts = io.sockets.sockets.get(participantId); if (ts) ts.leave(u.roomId); r.participants.delete(participantId); socketToUser.delete(participantId); io.to(u.roomId).emit('user-left', { userId: participantId }); io.to(u.roomId).emit('participants-update', { participants: getParticipantList(r) }); updateLiveRoomInDB(r); });
  socket.on('lock-meeting', ({ locked }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return; r.settings.locked = locked; io.to(u.roomId).emit('meeting-locked', { locked }); });
  socket.on('update-settings', (newSettings) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return; Object.assign(r.settings, newSettings); io.to(u.roomId).emit('settings-updated', r.settings); });

  // ── Breakout Rooms ──
  socket.on('create-breakout', async ({ name, assignedStudents }) => {
    const u = socketToUser.get(socket.id); if (!u?.roomId) return;
    const r = liveRooms.get(u.roomId); if (!r) return;
    // Allow host OR privileged roles (instructor+)
    const isHost = socket.id === r.hostId;
    const isPriv = db.hasRoleAtLeast(u.role || 'student', 'instructor');
    if (!isHost && !isPriv) return;
    const boId = 'bo-' + uuidv4().slice(0, 8);
    const breakout = await createLiveRoom(boId, 'breakout', name || `Breakout ${r.breakoutRooms.size + 1}`, socket.id, u.name);
    breakout.parentRoomId = u.roomId;
    r.breakoutRooms.set(boId, { id: boId, name: breakout.name, assignedStudents: assignedStudents || [] });
    io.to(u.roomId).emit('breakout-rooms-update', { breakoutRooms: Array.from(r.breakoutRooms.values()) });
    (assignedStudents || []).forEach(sid => { io.to(sid).emit('breakout-invitation', { breakoutId: boId, breakoutName: breakout.name }); });
  });

  socket.on('close-breakout', ({ breakoutId }) => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const isHost = socket.id === r.hostId; const isPriv = db.hasRoleAtLeast(u.role || 'student', 'instructor'); if (!isHost && !isPriv) return; const bo = liveRooms.get(breakoutId); if (bo) { bo.participants.forEach((p, pid) => { io.to(pid).emit('breakout-closed', { returnTo: u.roomId }); }); liveRooms.delete(breakoutId); removeLiveRoomFromDB(breakoutId); } r.breakoutRooms.delete(breakoutId); io.to(u.roomId).emit('breakout-rooms-update', { breakoutRooms: Array.from(r.breakoutRooms.values()) }); });

  socket.on('close-all-breakouts', () => { const u = socketToUser.get(socket.id); if (!u?.roomId) return; const r = liveRooms.get(u.roomId); if (!r) return; const isHost = socket.id === r.hostId; const isPriv = db.hasRoleAtLeast(u.role || 'student', 'instructor'); if (!isHost && !isPriv) return; r.breakoutRooms.forEach((bo, boId) => { const b = liveRooms.get(boId); if (b) { b.participants.forEach((p, pid) => { io.to(pid).emit('breakout-closed', { returnTo: u.roomId }); }); liveRooms.delete(boId); removeLiveRoomFromDB(boId); } }); r.breakoutRooms.clear(); io.to(u.roomId).emit('breakout-rooms-update', { breakoutRooms: [] }); });

  // ── Bot Injection (developer+ only, for stress testing) ──────────────
  const activeBots = new Map(); // botId -> { roomId, intervalId }

  socket.on('inject-bots', async ({ roomId, count, options }, callback) => {
    try {
      const user = socketToUser.get(socket.id);
      if (!user) return callback?.({ success: false, error: 'Not authenticated' });
      // Only developer+ can inject bots
      const dbUser = await db.getOne('SELECT role FROM users WHERE id = $1', [user.id || '']);
      const userRole = dbUser?.role || user.role || 'student';
      if (!db.hasRoleAtLeast(userRole, 'developer')) {
        return callback?.({ success: false, error: 'Developer+ role required for bot injection' });
      }
      const room = liveRooms.get(roomId);
      if (!room) return callback?.({ success: false, error: 'Room not found' });

      const botCount = Math.min(parseInt(count) || 1, 50); // Max 50 bots at once
      const botNames = [
        'Alex Chen', 'Maria Garcia', 'James Wilson', 'Sarah Kim', 'David Brown',
        'Emma Davis', 'Michael Lee', 'Olivia Martinez', 'Daniel Taylor', 'Sophia Anderson',
        'Ethan Thomas', 'Isabella Jackson', 'Noah White', 'Mia Harris', 'Liam Clark',
        'Ava Lewis', 'Mason Robinson', 'Charlotte Walker', 'Logan Hall', 'Amelia Young',
        'Lucas Allen', 'Harper King', 'Aiden Wright', 'Evelyn Scott', 'Jackson Green',
        'Abigail Adams', 'Sebastian Baker', 'Emily Nelson', 'Mateo Hill', 'Elizabeth Ramirez',
        'Benjamin Campbell', 'Sofia Mitchell', 'Henry Roberts', 'Scarlett Carter', 'Alexander Phillips',
        'Victoria Evans', 'Owen Turner', 'Chloe Torres', 'Jack Parker', 'Penelope Collins',
        'Leo Edwards', 'Layla Stewart', 'Theodore Flores', 'Zoey Morris', 'Gabriel Murphy',
        'Nora Rivera', 'Samuel Cook', 'Lily Rogers', 'Caleb Morgan', 'Hannah Peterson'
      ];

      const botsCreated = [];
      for (let i = 0; i < botCount; i++) {
        const botId = 'bot-' + require('uuid').v4().slice(0, 8);
        const botName = botNames[i % botNames.length] + (i >= botNames.length ? ` (${Math.floor(i / botNames.length) + 1})` : '');
        const botRole = options?.role || 'student';

        const participant = {
          name: botName + ' 🤖',
          role: botRole,
          isHost: false,
          audioEnabled: options?.audioEnabled !== false,
          videoEnabled: options?.videoEnabled !== false,
          screenSharing: false,
          handRaised: false,
          joinedAt: Date.now(),
          isBot: true,
          botId: botId
        };

        room.participants.set(botId, participant);
        botsCreated.push({ botId, name: participant.name });

        // Notify room of new participant
        io.to(roomId).emit('user-joined', {
          userId: botId,
          userName: participant.name,
          userRole: botRole,
          audioEnabled: participant.audioEnabled,
          videoEnabled: participant.videoEnabled,
          isBot: true
        });

        // Simulate periodic activity if enabled
        if (options?.simulateActivity) {
          const intervalId = setInterval(() => {
            if (!liveRooms.has(roomId) || !room.participants.has(botId)) {
              clearInterval(intervalId);
              activeBots.delete(botId);
              return;
            }
            // Random actions: toggle hand, send chat, toggle audio
            const action = Math.random();
            if (action < 0.05) {
              // Raise/lower hand
              const p = room.participants.get(botId);
              if (p) {
                p.handRaised = !p.handRaised;
                io.to(roomId).emit('user-hand-raised', { userId: botId, raised: p.handRaised, userName: p.name });
              }
            } else if (action < 0.1) {
              // Send chat message
              const messages = [
                'Great point!', 'I agree', 'Can you repeat that?', 'Interesting!',
                'Makes sense', 'Thank you!', 'Could you share that link?', '👍',
                'I have a question', 'That helps a lot', 'Let me take a note',
                'Good explanation!', 'Can we go back to that slide?', 'Got it!'
              ];
              const msg = {
                id: require('uuid').v4(), senderId: botId,
                senderName: botName + ' 🤖', senderRole: botRole,
                message: messages[Math.floor(Math.random() * messages.length)],
                type: 'text', timestamp: Date.now()
              };
              room.chatMessages.push(msg);
              if (room.chatMessages.length > 500) room.chatMessages.shift();
              io.to(roomId).emit('chat-message', msg);
            }
          }, 5000 + Math.random() * 15000); // Random interval 5-20 seconds
          activeBots.set(botId, { roomId, intervalId });
        }
      }

      // Update participant list
      io.to(roomId).emit('participants-update', { participants: getParticipantList(room) });
      await updateLiveRoomInDB(room);

      callback?.({ success: true, botsCreated, totalParticipants: room.participants.size });
    } catch (e) {
      console.error('inject-bots error:', e.message);
      callback?.({ success: false, error: e.message });
    }
  });

  socket.on('remove-bots', async ({ roomId, botIds }, callback) => {
    try {
      const user = socketToUser.get(socket.id);
      if (!user) return callback?.({ success: false, error: 'Not authenticated' });
      const dbUser = await db.getOne('SELECT role FROM users WHERE id = $1', [user.id || '']);
      if (!db.hasRoleAtLeast(dbUser?.role || 'student', 'developer')) {
        return callback?.({ success: false, error: 'Developer+ role required' });
      }
      const room = liveRooms.get(roomId);
      if (!room) return callback?.({ success: false, error: 'Room not found' });

      const toRemove = botIds || Array.from(room.participants.entries())
        .filter(([_, p]) => p.isBot)
        .map(([id]) => id);

      let removed = 0;
      for (const botId of toRemove) {
        const p = room.participants.get(botId);
        if (p && p.isBot) {
          room.participants.delete(botId);
          // Clear activity interval
          const botData = activeBots.get(botId);
          if (botData) { clearInterval(botData.intervalId); activeBots.delete(botId); }
          io.to(roomId).emit('user-left', { userId: botId, userName: p.name });
          removed++;
        }
      }

      io.to(roomId).emit('participants-update', { participants: getParticipantList(room) });
      await updateLiveRoomInDB(room);
      callback?.({ success: true, removed, totalParticipants: room.participants.size });
    } catch (e) {
      callback?.({ success: false, error: e.message });
    }
  });

  socket.on('get-bot-count', ({ roomId }, callback) => {
    const room = liveRooms.get(roomId);
    if (!room) return callback?.({ bots: 0, total: 0 });
    const botCount = Array.from(room.participants.values()).filter(p => p.isBot).length;
    callback?.({ bots: botCount, total: room.participants.size });
  });

  // ── Leave / Disconnect ──
  socket.on('leave-room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  socket.on('end-meeting', async () => {
    const u = socketToUser.get(socket.id); if (!u?.roomId) return;
    const r = liveRooms.get(u.roomId); if (!r || socket.id !== r.hostId) return;
    r.breakoutRooms.forEach((bo, boId) => { const b = liveRooms.get(boId); if (b) { b.participants.forEach((p, pid) => io.to(pid).emit('meeting-ended')); liveRooms.delete(boId); removeLiveRoomFromDB(boId); } });
    io.to(u.roomId).emit('meeting-ended');
    r.participants.forEach((_, pid) => { const s = io.sockets.sockets.get(pid); if (s) s.leave(u.roomId); socketToUser.delete(pid); });
    if (r.type === 'classroom') { await db.run('UPDATE classrooms SET status = $1 WHERE id = $2', ['inactive', u.roomId]); }
    else { await db.run('UPDATE meeting_rooms SET status = $1 WHERE id = $2', ['inactive', u.roomId]); }
    liveRooms.delete(u.roomId);
    await removeLiveRoomFromDB(u.roomId);
  });
});

async function handleLeave(socket) {
  const user = socketToUser.get(socket.id);
  if (!user || !user.roomId) { socketToUser.delete(socket.id); return; }
  const room = liveRooms.get(user.roomId);
  if (!room) { socketToUser.delete(socket.id); return; }
  room.waitingList.delete(socket.id);
  const participant = room.participants.get(socket.id);
  if (participant) {
    room.participants.delete(socket.id);
    socket.to(user.roomId).emit('user-left', { userId: socket.id, userName: user.name });
    io.to(user.roomId).emit('participants-update', { participants: getParticipantList(room) });
    if (room.screenSharer === socket.id) { room.screenSharer = null; room.screenController = null; io.to(user.roomId).emit('remote-control-ended'); }
    if (socket.id === room.hostId && room.participants.size > 0) {
      const newHostId = room.participants.keys().next().value;
      room.hostId = newHostId;
      const newHost = room.participants.get(newHostId);
      if (newHost) newHost.isHost = true;
      io.to(user.roomId).emit('new-host', { hostId: newHostId, hostName: newHost?.name });
      io.to(user.roomId).emit('participants-update', { participants: getParticipantList(room) });
    }
    if (room.participants.size === 0) {
      // Keep room in memory for a short time for quick rejoin, but persist state to DB
      // Room will remain in live_rooms table permanently until explicitly deleted
      await updateLiveRoomInDB(room); // Save full state including chat, annotations, etc.
      
      // After 5 minutes of inactivity, remove from memory but keep in database
      if (room._cleanupTimer) clearTimeout(room._cleanupTimer);
      room._cleanupTimer = setTimeout(async () => {
        const r = liveRooms.get(user.roomId);
        if (r && r.participants.size === 0) {
          // Remove from memory but keep in database for later restoration
          liveRooms.delete(user.roomId);
          console.log(`Room ${user.roomId} removed from memory, persisted to database`);
        }
      }, 300000); // 5 minutes - remove from memory but keep persisted
    } else { 
      if (room._cleanupTimer) { clearTimeout(room._cleanupTimer); room._cleanupTimer = null; }
      await updateLiveRoomInDB(room); 
    }
  }
  socket.leave(user.roomId);
  socket.leave(user.roomId + '-waiting');
  socketToUser.delete(socket.id);
}

// ─── Start Server ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
async function startServer() {
  try {
    await db.initDatabase();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🎓 Virtual Studio Server running on port ${PORT}`);
      console.log(`   Local: http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}
startServer();
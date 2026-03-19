/* ═══════════════════════════════════════════════════════════════════════════
   Virtual Studio — Dual-Mode Database Layer (PostgreSQL + SQLite)
   
   Uses PostgreSQL when DATABASE_URL is set (Railway / production).
   Falls back to SQLite (sql.js / pure WASM) for desktop/EXE mode.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');

const USE_POSTGRES = !!process.env.DATABASE_URL;
console.log(`[DB] DATABASE_URL present: ${!!process.env.DATABASE_URL}`);
console.log(`[DB] ELECTRON_APP: ${process.env.ELECTRON_APP || 'not set'}`);

/* ─── Role Hierarchy ─────────────────────────────────────────────────────
   owner (5) > developer (4) > admin (3) > instructor (2) > student (1)
   ──────────────────────────────────────────────────────────────────────── */
const ROLE_LEVELS = { student: 1, instructor: 2, admin: 3, developer: 4, owner: 5 };

function roleLevel(role) {
  return ROLE_LEVELS[role] || 0;
}

function hasRoleAtLeast(userRole, requiredRole) {
  return roleLevel(userRole) >= roleLevel(requiredRole);
}

// ─── Adapter: PostgreSQL ────────────────────────────────────────────────
let pgPool = null;

function createPgAdapter() {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.RAILWAY_ENVIRONMENT ||
          process.env.DATABASE_URL.includes('railway') ||
          process.env.DATABASE_URL.includes('rlwy.net') ||
          process.env.DB_SSL === 'true')
      ? { rejectUnauthorized: false }
      : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pgPool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });

  return {
    async query(text, params) {
      return pgPool.query(text, params);
    },
    async getOne(text, params) {
      const result = await pgPool.query(text, params);
      return result.rows[0] || null;
    },
    async getAll(text, params) {
      const result = await pgPool.query(text, params);
      return result.rows;
    },
    async run(text, params) {
      return pgPool.query(text, params);
    },
    async initDatabase() {
      const client = await pgPool.connect();
      try {
        await initSchemaPostgres(client);
        console.log('✅ PostgreSQL database initialized');
      } finally {
        client.release();
      }
    },
    pool: pgPool
  };
}

// ─── Adapter: SQLite ────────────────────────────────────────────────────
let sqliteDb = null;
let sqliteDbPath = null;

function createSqliteAdapter() {
  // Determine SQLite file path
  const dbDir = process.env.DB_DIR || (process.env.RECORDINGS_DIR
    ? path.dirname(process.env.RECORDINGS_DIR)
    : (process.env.APPDATA
      ? path.join(process.env.APPDATA, 'virtual-studio-launcher')
      : path.join(require('os').homedir(), '.virtual-studio')));
  
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  sqliteDbPath = process.env.DB_PATH || path.join(dbDir, 'virtual-studio.db');
  console.log(`[DB] Using SQLite (sql.js): ${sqliteDbPath}`);

  // Save database to disk periodically and on changes
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (sqliteDb) {
        try {
          const data = sqliteDb.export();
          fs.writeFileSync(sqliteDbPath, Buffer.from(data));
        } catch(e) {
          console.error('[DB] Save error:', e.message);
        }
      }
    }, 500);
  }

  // Convert PostgreSQL $1,$2... params to SQLite ?
  function convertQuery(text, params) {
    if (!params || params.length === 0) return { sql: text, args: [] };

    const sql = text.replace(/\$(\d+)/g, '?');

    // Reorder params to match ? ordering (PostgreSQL $1 is 1-indexed)
    const args = [];
    const matches = text.match(/\$(\d+)/g) || [];
    for (const m of matches) {
      const paramIdx = parseInt(m.substring(1)) - 1;
      args.push(params[paramIdx] !== undefined ? params[paramIdx] : null);
    }

    // Convert JS booleans to 0/1 for SQLite
    const safeArgs = args.map(a => a === true ? 1 : a === false ? 0 : a);
    return { sql, args: safeArgs };
  }

  // Convert PostgreSQL-specific SQL to SQLite-compatible
  function adaptSQL(text) {
    let sql = text;
    sql = sql.replace(/\(EXTRACT\(EPOCH FROM NOW\(\)\) \* 1000\)::BIGINT/gi, "(strftime('%s','now') * 1000)");
    sql = sql.replace(/EXTRACT\(EPOCH FROM NOW\(\)\) \* 1000/gi, "strftime('%s','now') * 1000");
    sql = sql.replace(/BOOLEAN DEFAULT FALSE/gi, 'INTEGER DEFAULT 0');
    sql = sql.replace(/BOOLEAN DEFAULT TRUE/gi, 'INTEGER DEFAULT 1');
    return sql;
  }

  // Convert sql.js result to row objects
  function resultToRows(result) {
    if (!result || result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }

  // Ensure db is initialized before any query
  function ensureDb() {
    if (!sqliteDb) throw new Error('SQLite not initialized. Call initDatabase() first.');
  }

  return {
    async query(text, params) {
      ensureDb();
      const adapted = adaptSQL(text);
      const { sql, args } = convertQuery(adapted, params);
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        try {
          const result = sqliteDb.exec(sql, args);
          const rows = resultToRows(result);
          return { rows, rowCount: rows.length };
        } catch(e) {
          if (e.message.includes('no tables') || e.message.includes('no such table')) {
            return { rows: [], rowCount: 0 };
          }
          throw e;
        }
      } else {
        sqliteDb.run(sql, args);
        const changes = sqliteDb.getRowsModified();
        scheduleSave();
        return { rows: [], rowCount: changes };
      }
    },
    async getOne(text, params) {
      ensureDb();
      const adapted = adaptSQL(text);
      const { sql, args } = convertQuery(adapted, params);
      try {
        const stmt = sqliteDb.prepare(sql);
        stmt.bind(args);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return null;
      } catch(e) {
        if (e.message.includes('no such table')) return null;
        throw e;
      }
    },
    async getAll(text, params) {
      ensureDb();
      const adapted = adaptSQL(text);
      const { sql, args } = convertQuery(adapted, params);
      try {
        const result = sqliteDb.exec(sql, args);
        return resultToRows(result);
      } catch(e) {
        if (e.message.includes('no such table')) return [];
        throw e;
      }
    },
    async run(text, params) {
      ensureDb();
      const adapted = adaptSQL(text);
      const { sql, args } = convertQuery(adapted, params);
      sqliteDb.run(sql, args);
      const changes = sqliteDb.getRowsModified();
      scheduleSave();
      return { rows: [], rowCount: changes };
    },
    async initDatabase() {
      // Load sql.js WASM
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();

      // Load existing database or create new
      if (fs.existsSync(sqliteDbPath)) {
        const fileBuffer = fs.readFileSync(sqliteDbPath);
        sqliteDb = new SQL.Database(fileBuffer);
        console.log('[DB] Loaded existing SQLite database');
      } else {
        sqliteDb = new SQL.Database();
        console.log('[DB] Created new SQLite database');
      }

      // Enable foreign keys
      sqliteDb.run('PRAGMA foreign_keys = ON');

      initSchemaSQLite(sqliteDb);

      // Save to disk
      const data = sqliteDb.export();
      fs.writeFileSync(sqliteDbPath, Buffer.from(data));
      console.log('✅ SQLite database initialized');
    },
    pool: null
  };
}

// ─── PostgreSQL Schema ──────────────────────────────────────────────────
async function initSchemaPostgres(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      avatar_color TEXT DEFAULT '#2d8cff',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      last_seen BIGINT
    );

    CREATE TABLE IF NOT EXISTS classrooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      instructor_id TEXT,
      status TEXT DEFAULT 'inactive',
      max_students INTEGER DEFAULT 50,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS meeting_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      type TEXT DEFAULT 'meeting',
      parent_classroom_id TEXT,
      status TEXT DEFAULT 'inactive',
      max_participants INTEGER DEFAULT 100,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT,
      room_type TEXT DEFAULT 'meeting',
      recorded_by TEXT,
      recorded_by_name TEXT,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      status TEXT DEFAULT 'uploading',
      transcript TEXT,
      summary TEXT,
      summary_generated_at BIGINT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      recording_id TEXT,
      room_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '[]',
      language TEXT DEFAULT 'en',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS meeting_summaries (
      id TEXT PRIMARY KEY,
      recording_id TEXT,
      room_id TEXT NOT NULL,
      room_name TEXT,
      title TEXT,
      summary TEXT,
      key_points TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      attendees TEXT DEFAULT '[]',
      duration INTEGER DEFAULT 0,
      generated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS breakout_rooms (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL,
      name TEXT NOT NULL,
      assigned_students TEXT DEFAULT '[]',
      status TEXT DEFAULT 'inactive',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      events TEXT DEFAULT '["summary_generated"]',
      enabled INTEGER DEFAULT 1,
      created_by TEXT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS live_rooms (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      host_id TEXT,
      host_name TEXT,
      participant_count INTEGER DEFAULT 0,
      is_recording BOOLEAN DEFAULT FALSE,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      chat_messages TEXT DEFAULT '[]',
      annotations TEXT DEFAULT '[]',
      transcript TEXT DEFAULT '[]',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      expires_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_tags (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS recording_views (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      user_name TEXT,
      watched_duration INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS classroom_assignments (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      UNIQUE(classroom_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_recording_tags_recording ON recording_tags(recording_id);
    CREATE INDEX IF NOT EXISTS idx_recording_tags_tag ON recording_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_recording_views_recording ON recording_views(recording_id);
    CREATE INDEX IF NOT EXISTS idx_recording_views_user ON recording_views(user_id);
    CREATE INDEX IF NOT EXISTS idx_recordings_recorded_by ON recordings(recorded_by);
    CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
    CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_classroom_assignments_student ON classroom_assignments(student_id);
    CREATE INDEX IF NOT EXISTS idx_classroom_assignments_classroom ON classroom_assignments(classroom_id);

    /* ═══════════ Chat System Tables ═══════════ */
    CREATE TABLE IF NOT EXISTS chat_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'public',
      description TEXT DEFAULT '',
      created_by TEXT,
      room_id TEXT,
      max_members INTEGER DEFAULT 8,
      is_archived BOOLEAN DEFAULT FALSE,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS chat_channel_members (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      channel_role TEXT DEFAULT 'member',
      joined_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      last_read_at BIGINT DEFAULT 0,
      UNIQUE(channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id TEXT,
      user_name TEXT,
      user_role TEXT DEFAULT 'student',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      parent_id TEXT,
      reply_count INTEGER DEFAULT 0,
      reactions TEXT DEFAULT '{}',
      is_edited BOOLEAN DEFAULT FALSE,
      edited_at BIGINT,
      meeting_id TEXT,
      sent_from_meeting BOOLEAN DEFAULT FALSE,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      deleted_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS chat_files (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT,
      filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT,
      storage_path TEXT NOT NULL,
      uploaded_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS chat_user_status (
      user_id TEXT PRIMARY KEY,
      status_text TEXT DEFAULT '',
      status_emoji TEXT DEFAULT '',
      is_dnd BOOLEAN DEFAULT FALSE,
      last_active_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS chat_member_requests (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      user_to_add TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      reviewed_at BIGINT,
      reviewed_by TEXT,
      review_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_channel_members_user ON chat_channel_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_channel_members_channel ON chat_channel_members(channel_id);
    CREATE INDEX IF NOT EXISTS idx_chat_member_requests_channel ON chat_member_requests(channel_id, status);
  `);

  // Migrations
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role_assigned_by TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role_assigned_at BIGINT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS thumbnail_path TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]'`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS last_viewed_at BIGINT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recording_status TEXT DEFAULT 'new'`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS class_id TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS class_name TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS resolution TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS instructor_name TEXT`,
    `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS session_type TEXT DEFAULT 'meeting'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS basic_mode BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS chat_messages TEXT DEFAULT '[]'`,
    `ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS annotations TEXT DEFAULT '[]'`,
    `ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS transcript TEXT DEFAULT '[]'`,
  ];

  for (const sql of migrations) {
    try { await client.query(sql); } catch (_) {}
  }

  // Seed owner
  const ownerCheck = await client.query(
    "SELECT id FROM users WHERE role IN ('owner','admin','developer') LIMIT 1"
  );
  if (ownerCheck.rows.length === 0) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (id, username, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      ['admin-001', 'admin', 'admin@studio.local', hash, 'Admin', 'owner']
    );
  }
}

// ─── SQLite Schema ──────────────────────────────────────────────────────
function initSchemaSQLite(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      avatar_color TEXT DEFAULT '#2d8cff',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      last_seen INTEGER,
      role_assigned_by TEXT,
      role_assigned_at INTEGER,
      basic_mode INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS classrooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      instructor_id TEXT,
      status TEXT DEFAULT 'inactive',
      max_students INTEGER DEFAULT 50,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS meeting_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      type TEXT DEFAULT 'meeting',
      parent_classroom_id TEXT,
      status TEXT DEFAULT 'inactive',
      max_participants INTEGER DEFAULT 100,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT,
      room_type TEXT DEFAULT 'meeting',
      recorded_by TEXT,
      recorded_by_name TEXT,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      status TEXT DEFAULT 'uploading',
      transcript TEXT,
      summary TEXT,
      summary_generated_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      thumbnail_path TEXT,
      tags TEXT DEFAULT '[]',
      view_count INTEGER DEFAULT 0,
      last_viewed_at INTEGER,
      download_count INTEGER DEFAULT 0,
      recording_status TEXT DEFAULT 'new',
      class_id TEXT,
      class_name TEXT,
      resolution TEXT,
      description TEXT,
      instructor_name TEXT,
      session_type TEXT DEFAULT 'meeting'
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      recording_id TEXT,
      room_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '[]',
      language TEXT DEFAULT 'en',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS meeting_summaries (
      id TEXT PRIMARY KEY,
      recording_id TEXT,
      room_id TEXT NOT NULL,
      room_name TEXT,
      title TEXT,
      summary TEXT,
      key_points TEXT DEFAULT '[]',
      action_items TEXT DEFAULT '[]',
      attendees TEXT DEFAULT '[]',
      duration INTEGER DEFAULT 0,
      generated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS breakout_rooms (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL,
      name TEXT NOT NULL,
      assigned_students TEXT DEFAULT '[]',
      status TEXT DEFAULT 'inactive',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      events TEXT DEFAULT '["summary_generated"]',
      enabled INTEGER DEFAULT 1,
      created_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS live_rooms (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      host_id TEXT,
      host_name TEXT,
      participant_count INTEGER DEFAULT 0,
      is_recording INTEGER DEFAULT 0,
      settings TEXT DEFAULT '{}',
      theme TEXT DEFAULT '{}',
      chat_messages TEXT DEFAULT '[]',
      annotations TEXT DEFAULT '[]',
      transcript TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_tags (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS recording_views (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      user_name TEXT,
      watched_duration INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS classroom_assignments (
      id TEXT PRIMARY KEY,
      classroom_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(classroom_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_recording_tags_recording ON recording_tags(recording_id);
    CREATE INDEX IF NOT EXISTS idx_recording_tags_tag ON recording_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_recording_views_recording ON recording_views(recording_id);
    CREATE INDEX IF NOT EXISTS idx_recording_views_user ON recording_views(user_id);
    CREATE INDEX IF NOT EXISTS idx_recordings_recorded_by ON recordings(recorded_by);
    CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
    CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_classroom_assignments_student ON classroom_assignments(student_id);
    CREATE INDEX IF NOT EXISTS idx_classroom_assignments_classroom ON classroom_assignments(classroom_id);

    /* ═══════════ Chat System Tables ═══════════ */
    CREATE TABLE IF NOT EXISTS chat_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'public',
      description TEXT DEFAULT '',
      created_by TEXT,
      room_id TEXT,
      max_members INTEGER DEFAULT 8,
      is_archived INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS chat_channel_members (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      channel_role TEXT DEFAULT 'member',
      joined_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      last_read_at INTEGER DEFAULT 0,
      UNIQUE(channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      user_id TEXT,
      user_name TEXT,
      user_role TEXT DEFAULT 'student',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      parent_id TEXT,
      reply_count INTEGER DEFAULT 0,
      reactions TEXT DEFAULT '{}',
      is_edited INTEGER DEFAULT 0,
      edited_at INTEGER,
      meeting_id TEXT,
      sent_from_meeting INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_files (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT,
      filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT,
      storage_path TEXT NOT NULL,
      uploaded_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS chat_user_status (
      user_id TEXT PRIMARY KEY,
      status_text TEXT DEFAULT '',
      status_emoji TEXT DEFAULT '',
      is_dnd INTEGER DEFAULT 0,
      last_active_at INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS chat_member_requests (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL,
      user_to_add TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      reviewed_at INTEGER,
      reviewed_by TEXT,
      review_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_parent ON chat_messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_channel_members_user ON chat_channel_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_channel_members_channel ON chat_channel_members(channel_id);
    CREATE INDEX IF NOT EXISTS idx_chat_member_requests_channel ON chat_member_requests(channel_id, status);
  `);

  // SQLite migrations for existing databases
  const sqliteMigrations = [
    "ALTER TABLE live_rooms ADD COLUMN chat_messages TEXT DEFAULT '[]'",
    "ALTER TABLE live_rooms ADD COLUMN annotations TEXT DEFAULT '[]'",
    "ALTER TABLE live_rooms ADD COLUMN transcript TEXT DEFAULT '[]'",
  ];
  for (const sql of sqliteMigrations) {
    try { db.run(sql); } catch (_) {} // Ignore if column already exists
  }

  // Seed owner
  const ownerResult = db.exec("SELECT id FROM users WHERE role IN ('owner','admin','developer') LIMIT 1");
  const hasOwner = ownerResult.length > 0 && ownerResult[0].values.length > 0;
  if (!hasOwner) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    db.run(
      `INSERT OR IGNORE INTO users (id, username, email, password_hash, name, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['admin-001', 'admin', 'admin@studio.local', hash, 'Admin', 'owner']
    );
  }
}

// ─── Create the right adapter ───────────────────────────────────────────
const adapter = USE_POSTGRES ? createPgAdapter() : createSqliteAdapter();

console.log(`[DB] Mode: ${USE_POSTGRES ? 'PostgreSQL' : 'SQLite (local)'}`);

module.exports = {
  pool: adapter.pool,
  query: adapter.query.bind(adapter),
  getOne: adapter.getOne.bind(adapter),
  getAll: adapter.getAll.bind(adapter),
  run: adapter.run.bind(adapter),
  initDatabase: adapter.initDatabase.bind(adapter),
  ROLE_LEVELS,
  roleLevel,
  hasRoleAtLeast
};
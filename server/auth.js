/* ═══════════════════════════════════════════════════════════════════════════
   Virtual Studio — Authentication & Role Middleware
   ═══════════════════════════════════════════════════════════════════════════ */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { ROLE_LEVELS, roleLevel, hasRoleAtLeast } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'virtual-studio-secret-change-me';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Express middleware — attaches req.user if valid token
// Always fetches fresh role from database to handle role changes
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Fetch fresh role from DB so role changes take effect immediately
  const db = require('./database');
  db.getOne('SELECT role FROM users WHERE id = $1', [decoded.id]).then(user => {
    if (user) decoded.role = user.role;
    req.user = decoded;
    next();
  }).catch(() => {
    req.user = decoded;
    next();
  });
}

// Optional auth — sets req.user if token present, but doesn't block
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded) req.user = decoded;
  }
  next();
}

/* ─── Role-based access middleware ───────────────────────────────────────
   Usage:  router.get('/admin', authMiddleware, requireRole('admin'), handler)
   Ensures the authenticated user has AT LEAST the specified role level.
   ──────────────────────────────────────────────────────────────────────── */
function requireRole(minimumRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!hasRoleAtLeast(req.user.role, minimumRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: minimumRole,
        current: req.user.role
      });
    }
    next();
  };
}

/* ─── Helper: can the actor assign `targetRole` to someone? ─────────────
   Rules:
     • Only developer or owner can grant admin
     • Only admin or above can grant instructor
     • No one can assign a role higher than their own
   ──────────────────────────────────────────────────────────────────────── */
function canAssignRole(actorRole, targetRole) {
  const actor = roleLevel(actorRole);
  const target = roleLevel(targetRole);
  // Cannot assign role equal to or above your own
  if (target >= actor) return false;
  // Admin requires developer+ to grant
  if (targetRole === 'admin' && actor < roleLevel('developer')) return false;
  // Instructor requires admin+ to grant
  if (targetRole === 'instructor' && actor < roleLevel('admin')) return false;
  return true;
}

/* ─── Helper: is this a privileged role (instructor+)? ──────────────────*/
function isPrivilegedRole(role) {
  return hasRoleAtLeast(role, 'instructor');
}

/* ─── Helper: auto-detect role from email domain ────────────────────────*/
function autoRoleFromEmail(email) {
  if (email && email.toLowerCase().endsWith('@game-u.com')) {
    return 'instructor';
  }
  return null; // no auto-role
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  generateToken,
  verifyToken,
  authMiddleware,
  optionalAuth,
  requireRole,
  canAssignRole,
  isPrivilegedRole,
  autoRoleFromEmail,
  hashPassword,
  comparePassword,
  JWT_SECRET,
  ROLE_LEVELS,
  roleLevel,
  hasRoleAtLeast
};
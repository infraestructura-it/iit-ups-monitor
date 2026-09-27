// Seguridad: usuarios con roles, sesiones por cookie, tokens de API, redes permitidas,
// bloqueo por intentos fallidos y bitácora de auditoría. Todo en la misma base SQLite.
import { hashPassword, verifyPassword, randomToken, sha256, passwordProblem } from './crypto.js';
import { ipAllowed, normalizeIp, parseCidr } from './cidr.js';
import { log } from '../util/log.js';

export const ROLES = { viewer: 1, operator: 2, admin: 3 };
export const ROLE_TXT = { viewer: 'Lectura', operator: 'Operador', admin: 'Administrador' };

// Permiso -> rol mínimo
export const PERMS = {
  read: 'viewer', 'report.export': 'viewer',
  'ups.command': 'operator', 'gpio.set': 'operator', 'bypass.operate': 'operator', 'ai.confirm': 'operator',
  'gpio.configure': 'admin', 'bypass.reset': 'admin', 'security.admin': 'admin',
};

export const DEFAULT_SETTINGS = {
  requireLoginForRead: true,   // false = panel de solo lectura sin sesión (pantalla de pared)
  sessionHours: 12,
  maxLoginAttempts: 5,
  lockMinutes: 15,
  allowedNetworks: [],         // vacío = cualquier red
  networkScope: 'actions',     // 'actions' | 'all'
  aiEnabled: true,
  aiMinRole: 'operator',
  aiMaxRequestsPerHour: 60,
};

const COOKIE = 'iit_sid';

export class Security {
  constructor(db, { legacyKey } = {}) {
    this.db = db;
    this.legacyKey = legacyKey || null;
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT,
        role TEXT NOT NULL, pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created INTEGER, last_login INTEGER,
        must_change INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER, expires INTEGER,
        ip TEXT, ua TEXT);
      CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL, created INTEGER, created_by TEXT, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT, ip TEXT, action TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.failures = new Map(); // "ip|usuario" -> { count, until }
    this.setupToken = null;
    if (this.userCount() === 0) {
      this.setupToken = randomToken(9);
      log.warn('================================================================');
      log.warn(` CONFIGURACIÓN INICIAL: no hay usuarios. Abre /login.html y usa el`);
      log.warn(` código de instalación: ${this.setupToken}`);
      log.warn('================================================================');
    }
    setInterval(() => this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600_000).unref();
  }

  // ---------- Configuración ----------
  settings() {
    const s = { ...DEFAULT_SETTINGS };
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (r.key in s) s[r.key] = JSON.parse(r.value);
    }
    return s;
  }

  saveSettings(patch, actor, ip) {
    const cur = this.settings(), next = { ...cur };
    const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Valor fuera de rango (${lo} a ${hi})`); return n; };
    if ('requireLoginForRead' in patch) next.requireLoginForRead = !!patch.requireLoginForRead;
    if ('sessionHours' in patch) next.sessionHours = num(patch.sessionHours, 1, 720);
    if ('maxLoginAttempts' in patch) next.maxLoginAttempts = num(patch.maxLoginAttempts, 3, 50);
    if ('lockMinutes' in patch) next.lockMinutes = num(patch.lockMinutes, 1, 1440);
    if ('networkScope' in patch) { if (!['actions', 'all'].includes(patch.networkScope)) throw new Error('Alcance inválido'); next.networkScope = patch.networkScope; }
    if ('allowedNetworks' in patch) {
      const list = (Array.isArray(patch.allowedNetworks) ? patch.allowedNetworks : String(patch.allowedNetworks).split(/[\s,;]+/)).map((x) => x.trim()).filter(Boolean);
      for (const c of list) if (!parseCidr(c)) throw new Error(`Red inválida: ${c} (usa formato 192.168.1.0/24)`);
      // Evita que el administrador se deje por fuera
      if (list.length && !ipAllowed(ip, list)) throw new Error(`Tu IP actual (${normalizeIp(ip)}) quedaría bloqueada. Inclúyela en la lista.`);
      next.allowedNetworks = list;
    }
    if ('aiEnabled' in patch) next.aiEnabled = !!patch.aiEnabled;
    if ('aiMinRole' in patch) { if (!ROLES[patch.aiMinRole]) throw new Error('Rol inválido'); next.aiMinRole = patch.aiMinRole; }
    if ('aiMaxRequestsPerHour' in patch) next.aiMaxRequestsPerHour = num(patch.aiMaxRequestsPerHour, 1, 1000);
    const ins = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const changed = [];
    for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(cur[k])) { ins.run(k, JSON.stringify(next[k])); changed.push(k); }
    if (changed.length) this.audit(actor, ip, 'settings.update', changed.map((k) => `${k}=${JSON.stringify(next[k])}`).join('; '));
    return next;
  }

  // ---------- Auditoría ----------
  audit(actor, ip, action, detail = '') {
    this.db.prepare('INSERT INTO audit (ts, actor, ip, action, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), actor || 'anónimo', normalizeIp(ip), action, String(detail).slice(0, 500));
  }
  auditList({ limit = 200, action } = {}) {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(limit, 2000));
    return action ? rows.filter((r) => r.action.startsWith(action)) : rows;
  }

  // ---------- Usuarios ----------
  userCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  users() {
    return this.db.prepare('SELECT id, username, name, role, active, created, last_login, must_change FROM users ORDER BY username').all();
  }
  #admins() { return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n; }

  createUser({ username, name, role, password, mustChange = true }, actor, ip) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Usuario: 3 a 32 caracteres (letras, números, punto, guion)');
    if (!ROLES[role]) throw new Error('Rol inválido');
    const p = passwordProblem(password); if (p) throw new Error(p);
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('Ese usuario ya existe');
    this.db.prepare('INSERT INTO users (username, name, role, pass_hash, created, must_change) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, String(name || username).slice(0, 80), role, hashPassword(password), Date.now(), mustChange ? 1 : 0);
    this.audit(actor, ip, 'user.create', `${username} (${role})`);
    return this.users().find((u) => u.username === username);
  }

  updateUser(id, patch, actor, ip) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new Error('Usuario no encontrado');
    const losingAdmin = u.role === 'admin' && u.active && ((patch.role && patch.role !== 'admin') || patch.active === false);
    if (losingAdmin && this.#admins() <= 1) throw new Error('Debe quedar al menos un administrador activo');
    if (patch.role) { if (!ROLES[patch.role]) throw new Error('Rol inválido'); this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id); }
    if ('active' in patch) {
      this.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(patch.active ? 1 : 0, id);
      if (!patch.active) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if ('name' in patch) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(patch.name).slice(0, 80), id);
    if (patch.password) {
      const p = passwordProblem(patch.password); if (p) throw new Error(p);
      this.db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(hashPassword(patch.password), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    this.audit(actor, ip, 'user.update', `${u.username}: ${Object.keys(patch).map((k) => (k === 'password' ? 'contraseña restablecida' : `${k}=${patch[k]}`)).join(', ')}`);
    return this.users().find((x) => x.id === id);
  }

  deleteUser(id, actor, ip) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new Error('Usuario no encontrado');
    if (u.role === 'admin' && u.active && this.#admins() <= 1) throw new Error('No puedes eliminar el último administrador');
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    this.audit(actor, ip, 'user.delete', u.username);
  }

  changeOwnPassword(userId, current, next, ip) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !verifyPassword(current, u.pass_hash)) throw new Error('La contraseña actual no es correcta');
    const p = passwordProblem(next); if (p) throw new Error(p);
    if (current === next) throw new Error('La nueva contraseña debe ser diferente');
    this.db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(next), userId);
    this.audit(u.username, ip, 'user.password', 'cambió su contraseña');
  }

  // ---------- Configuración inicial ----------
  setup({ token, username, name, password }, ip) {
    if (!this.setupToken || this.userCount() > 0) throw new Error('La configuración inicial ya se completó');
    if (token !== this.setupToken) { this.audit('instalación', ip, 'setup.fail', 'código incorrecto'); throw new Error('Código de instalación incorrecto'); }
    const u = this.createUser({ username, name, role: 'admin', password, mustChange: false }, 'instalación', ip);
    this.setupToken = null;
    return u;
  }

  // ---------- Sesiones ----------
  login(username, password, ip, ua) {
    const s = this.settings();
    username = String(username || '').trim().toLowerCase();
    const key = `${normalizeIp(ip)}|${username}`;
    const f = this.failures.get(key);
    if (f?.until && f.until > Date.now()) {
      throw new Error(`Demasiados intentos. Intenta de nuevo en ${Math.ceil((f.until - Date.now()) / 60000)} min`);
    }
    const u = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // Se verifica siempre (aunque el usuario no exista) para no revelar cuáles existen por tiempo de respuesta
    const ok = verifyPassword(password || '', u?.pass_hash || 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAA') && u?.active;
    if (!ok) {
      const count = (f?.count || 0) + 1;
      const until = count >= s.maxLoginAttempts ? Date.now() + s.lockMinutes * 60_000 : null;
      this.failures.set(key, { count: until ? 0 : count, until });
      this.audit(username || '—', ip, until ? 'login.locked' : 'login.fail', until ? `bloqueado ${s.lockMinutes} min` : `intento ${count}`);
      throw new Error('Usuario o contraseña incorrectos');
    }
    this.failures.delete(key);
    const token = randomToken();
    const expires = Date.now() + s.sessionHours * 3600_000;
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), u.id, Date.now(), expires, normalizeIp(ip), String(ua || '').slice(0, 200));
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), u.id);
    this.audit(u.username, ip, 'login.ok', '');
    return { token, expires, user: this.#public(u) };
  }

  logout(token, actor, ip) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    this.audit(actor, ip, 'logout', '');
  }

  #public(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, mustChange: !!u.must_change }; }

  // Identifica al solicitante: sesión (cookie) o token de API (cabecera x-api-key)
  identify({ cookieHeader, apiKey }) {
    if (apiKey) {
      if (this.legacyKey && apiKey === this.legacyKey) return { kind: 'token', username: 'API_COMMAND_KEY', name: 'Clave heredada (.env)', role: 'operator' };
      const t = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0').get(sha256(apiKey));
      if (t) {
        this.db.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').run(Date.now(), t.id);
        return { kind: 'token', username: `token:${t.name}`, name: t.name, role: t.role };
      }
      return null;
    }
    const sid = parseCookies(cookieHeader)[COOKIE];
    if (!sid) return null;
    const row = this.db.prepare(`SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`).get(sha256(sid), Date.now());
    return row ? { kind: 'session', ...this.#public(row), expires: row.expires, sid } : null;
  }

  static can(user, perm) {
    const need = PERMS[perm] || 'admin';
    return !!user && ROLES[user.role] >= ROLES[need];
  }

  // ---------- Tokens de API ----------
  tokens() { return this.db.prepare('SELECT id, name, role, created, created_by, last_used, revoked FROM api_tokens ORDER BY id DESC').all(); }
  createToken({ name, role }, actor, ip) {
    if (!ROLES[role]) throw new Error('Rol inválido');
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new Error('Ponle un nombre al token (ej.: Home Assistant)');
    const token = `iit_${randomToken(24)}`;
    this.db.prepare('INSERT INTO api_tokens (name, role, token_hash, created, created_by) VALUES (?, ?, ?, ?, ?)').run(name, role, sha256(token), Date.now(), actor);
    this.audit(actor, ip, 'token.create', `${name} (${role})`);
    return { token, name, role };
  }
  revokeToken(id, actor, ip) {
    const t = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);
    if (!t) throw new Error('Token no encontrado');
    this.db.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?').run(id);
    this.audit(actor, ip, 'token.revoke', t.name);
  }

  // ---------- Revisión de seguridad ----------
  review({ secure, aiKey }) {
    const s = this.settings(), users = this.users();
    const admins = users.filter((u) => u.role === 'admin' && u.active).length;
    const tokensActive = this.tokens().filter((t) => !t.revoked).length;
    return [
      { ok: users.length > 0, text: 'Hay usuarios configurados', fix: 'Completa la configuración inicial' },
      { ok: s.requireLoginForRead, text: 'Se exige iniciar sesión para ver el panel', fix: 'La lectura sin sesión está activa: cualquiera en la red ve los datos' },
      { ok: admins >= 2, text: 'Al menos dos administradores', fix: 'Crea un segundo administrador para no perder el acceso', level: 'warn' },
      { ok: !this.legacyKey, text: 'Sin clave heredada API_COMMAND_KEY', fix: 'Reemplázala por un token de API y bórrala del .env', level: 'warn' },
      { ok: s.allowedNetworks.length > 0, text: 'Redes permitidas definidas', fix: 'Limita el acceso a tu LAN y a ZeroTier', level: 'warn' },
      { ok: secure, text: 'Acceso por HTTPS', fix: 'Para acceso remoto usa Cloudflare Tunnel o ZeroTier; nunca abras el puerto 8080 a internet', level: 'warn' },
      { ok: users.every((u) => !u.must_change), text: 'Todos cambiaron su contraseña inicial', fix: 'Hay usuarios con contraseña temporal', level: 'warn' },
      { ok: !s.aiEnabled || aiKey, text: s.aiEnabled ? 'Clave de la IA configurada' : 'Asistente IA deshabilitado', fix: 'Falta ANTHROPIC_API_KEY en el .env', level: 'info' },
      { ok: true, text: `${tokensActive} token(s) de API activos`, level: 'info' },
    ];
  }
}

export function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, expires, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expires).toUTCString()}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
export { ipAllowed, normalizeIp };

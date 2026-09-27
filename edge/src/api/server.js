// Capa de servicio local: REST + WebSocket + dashboard web, con control de acceso por roles
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { METRICS } from '../storage/store.js';
import { Security, ROLES, ROLE_TXT, sessionCookie, clearCookie, ipAllowed, normalizeIp } from '../security/security.js';
import { buildReport } from '../reports/report.js';
import { writeExcel, validateExport, excelFilename } from '../reports/excel.js';

export function createServer({ cfg, store, driver, alarms, state, gpio, bypass, assistant, security }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // Cloudflare Tunnel local: respeta X-Forwarded-*
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // ---------- Identidad, red y permisos ----------
  const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

  app.use((req, _res, next) => {
    req.user = security.identify({ cookieHeader: req.headers.cookie, apiKey: req.get('x-api-key') });
    req.actor = req.user?.username || 'anónimo';
    const s = security.settings();
    if (s.allowedNetworks.length && s.networkScope === 'all' && !ipAllowed(req.ip, s.allowedNetworks)) {
      return next(err(403, `Acceso no permitido desde ${normalizeIp(req.ip)}`));
    }
    // Protección CSRF para sesiones de navegador: mismo origen y cuerpo JSON
    if (req.user?.kind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return next(err(403, 'Origen no permitido'));
      if (req.headers['content-length'] > 0 && !req.is('application/json')) return next(err(415, 'Se esperaba JSON'));
    }
    next();
  });

  const need = (perm) => (req, _res, next) => {
    const s = security.settings();
    if (perm === 'read' && !req.user && !s.requireLoginForRead) return next();
    if (!req.user) return next(err(401, 'Inicia sesión para continuar', { login: true }));
    const pwPage = req.method === 'GET' && req.path === '/api/security';
    if (req.user.mustChange && !pwPage) return next(err(403, 'Debes cambiar tu contraseña temporal', { mustChange: true }));
    if (!Security.can(req.user, perm)) return next(err(403, `Tu rol (${ROLE_TXT[req.user.role]}) no permite esta acción`));
    const isAction = !['read', 'report.export'].includes(perm);
    if (isAction && s.allowedNetworks.length && !ipAllowed(req.ip, s.allowedNetworks)) {
      return next(err(403, `Acciones no permitidas desde ${normalizeIp(req.ip)}`));
    }
    next();
  };
  const wrap = (fn) => async (req, res, next) => { try { res.json(await fn(req, res)); } catch (e) { next(e.status ? e : err(400, e.message)); } };
  const range = (q) => { const to = Number(q.to) || Date.now(); return { from: Number(q.from) || to - 3600_000, to }; };

  function log(code, message, req) {
    const ev = { ts: Date.now(), code, severity: 'info', state: 'raised', message: `${message} (${req?.user?.name || req?.actor || 'sistema'})`, value: null };
    store.saveEvent(ev); broadcast('event', ev);
    if (req) security.audit(req.actor, req.ip, code.toLowerCase(), message);
  }

  // Páginas estáticas: públicas (los datos se protegen en la API)
  app.use(express.static(path.join(cfg.root, 'public')));

  // ================= Autenticación (públicas) =================
  app.get('/api/auth/status', (req, res) => {
    const s = security.settings();
    res.json({
      setupRequired: security.userCount() === 0, requireLoginForRead: s.requireLoginForRead,
      user: req.user ? { username: req.user.username, name: req.user.name, role: req.user.role, roleText: ROLE_TXT[req.user.role], mustChange: !!req.user.mustChange, kind: req.user.kind } : null,
      device: { name: cfg.device.name, site: cfg.device.site },
    });
  });
  app.post('/api/auth/setup', wrap((req) => { security.setup(req.body || {}, req.ip); return { ok: true }; }));
  app.post('/api/auth/login', wrap((req, res) => {
    const { token, expires, user } = security.login(req.body?.username, req.body?.password, req.ip, req.get('user-agent'));
    res.setHeader('Set-Cookie', sessionCookie(token, expires, req.secure));
    return { ok: true, user };
  }));
  app.post('/api/auth/logout', wrap((req, res) => {
    security.logout(req.user?.sid, req.actor, req.ip);
    res.setHeader('Set-Cookie', clearCookie());
    return { ok: true };
  }));
  app.post('/api/auth/password', wrap((req) => {
    if (req.user?.kind !== 'session') throw err(401, 'Inicia sesión para continuar');
    security.changeOwnPassword(req.user.id, req.body?.current, req.body?.next, req.ip);
    return { ok: true };
  }));

  // ================= UPS =================
  app.get('/api/health', need('read'), (_req, res) => res.json({
    ok: true, uptimeSec: Math.round(process.uptime()), driver: driver.name,
    lastReadingTs: state.latest?.ts ?? null, commOk: state.commOk, lastError: state.lastError,
    cloud: state.cloud ? state.cloud.status() : { enabled: false },
    gpio: { backend: gpio.backend.name, simulated: gpio.simulated },
    bypass: { enabled: cfg.bypass.enabled, state: bypass.state }, ai: { available: assistant.available },
  }));
  app.get('/api/device', need('read'), (req, res) => res.json({
    ...cfg.device, driver: driver.name, info: driver.info,
    commands: Security.can(req.user, 'ups.command') ? driver.capabilities.commands : [],
    thresholds: cfg.alarms, metrics: METRICS,
  }));
  app.get('/api/status', need('read'), (_req, res) => res.json({ reading: state.latest, alarms: alarms.list(), commOk: state.commOk }));
  app.get('/api/raw', need('read'), (_req, res) => res.json(state.latest?.raw ?? {}));
  app.get('/api/history', need('read'), (req, res) => {
    const { from, to } = range(req.query);
    res.json({ from, to, ...store.history(from, to, Math.min(Number(req.query.points) || 300, 2000)) });
  });
  app.get('/api/stats', need('read'), (req, res) => {
    const { from, to } = range(req.query);
    res.json({ from, to, ...store.stats(from, to), energyKWh: store.energyKWh(from, to) });
  });
  app.get('/api/events', need('read'), (req, res) => {
    const { from, to } = range({ ...req.query, from: req.query.from || 1 });
    let ev = store.events({ from, to, limit: Math.min(Number(req.query.limit) || 200, 2000) });
    if (req.query.prefix) ev = ev.filter((e) => e.code.startsWith(req.query.prefix));
    res.json(ev);
  });
  app.post('/api/command', need('ups.command'), wrap(async (req) => {
    const { command } = req.body || {};
    if (!driver.capabilities.commands.includes(command)) throw new Error(`Comando no soportado por el driver ${driver.name}`);
    const result = await driver.command(command);
    log('COMMAND', `Comando enviado a la UPS: ${command}`, req);
    return { ok: true, result };
  }));

  // ================= Reportes =================
  app.get('/api/report', need('read'), wrap((req) => buildReport(store, req.query)));
  app.get('/api/report.xlsx', need('report.export'), async (req, res, next) => {
    try { validateExport(store, req.query); } catch (e) { return next(err(400, e.message)); }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${excelFilename(cfg, req.query)}"`);
    try {
      const r = await writeExcel(res, { store, cfg, driver, user: req.user?.name || 'lectura pública', q: req.query });
      security.audit(req.actor, req.ip, 'report.export', `${r.rows} filas`);
    } catch (e) { res.destroy(e); }
  });
  app.get('/api/export.csv', need('report.export'), (req, res) => {
    const { from, to } = range(req.query);
    const rows = store.rawRange(from, to);
    const cols = ['ts', 'fecha', ...Object.keys(METRICS), 'status'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cfg.device.id}_${new Date(from).toISOString().slice(0, 10)}.csv"`);
    res.write('\uFEFF' + cols.join(';') + '\n');
    for (const r of rows) res.write(cols.map((c) => (c === 'fecha' ? new Date(r.ts).toLocaleString('es-CO') : r[c] ?? '')).join(';') + '\n');
    res.end();
  });

  // ================= GPIO =================
  app.get('/api/gpio', need('read'), (_req, res) => res.json(gpio.list()));
  app.put('/api/gpio/:gpio', need('gpio.configure'), wrap(async (req) => {
    const d = await gpio.configure(Number(req.params.gpio), req.body || {});
    log('GPIO_CONFIG', `GPIO${d.gpio} configurado como ${d.mode}${d.name ? ` (${d.name})` : ''}`, req);
    return d;
  }));
  app.post('/api/gpio/:gpio/set', need('gpio.set'), wrap(async (req) => {
    const d = await gpio.set(Number(req.params.gpio), !!req.body?.active, 'user');
    log('GPIO_SET', `${d.name} (GPIO${d.gpio}) ${d.active ? 'activada' : 'desactivada'}`, req);
    return d;
  }));
  app.post('/api/gpio/:gpio/simulate', need('gpio.set'), wrap(async (req) => {
    gpio.simulateInput(Number(req.params.gpio), !!req.body?.active);
    return gpio.describe(Number(req.params.gpio));
  }));

  // ================= Bypass =================
  app.get('/api/bypass', need('read'), (_req, res) => res.json(bypass.status()));
  app.post('/api/bypass', need('bypass.operate'), wrap(async (req) => {
    const body = req.body || {};
    if (body.action === 'reset' && !Security.can(req.user, 'bypass.reset')) throw err(403, 'Solo un administrador puede restablecer el bloqueo');
    const r = await bypass.command(body);
    security.audit(req.actor, req.ip, `bypass.${body.action}`, JSON.stringify(body));
    return r;
  }));

  // ================= IA =================
  const aiAllowed = (req) => {
    const s = security.settings();
    if (!s.aiEnabled) throw err(403, 'El asistente IA está deshabilitado en Seguridad');
    if (!req.user || ROLES[req.user.role] < ROLES[s.aiMinRole]) throw err(403, `El asistente requiere rol ${ROLE_TXT[s.aiMinRole]} o superior`);
    assistant.cfg.maxRequestsPerHour = s.aiMaxRequestsPerHour;
  };
  app.get('/api/ai', need('read'), (req, res) => {
    const s = security.settings();
    res.json({ ...assistant.info(), enabled: s.aiEnabled, allowed: !!req.user && ROLES[req.user.role] >= ROLES[s.aiMinRole], minRole: ROLE_TXT[s.aiMinRole] });
  });
  app.post('/api/ai/chat', need('read'), wrap(async (req) => {
    aiAllowed(req);
    const r = await assistant.chat(req.body?.messages || []);
    security.audit(req.actor, req.ip, 'ai.chat', `${r.tools.length} herramientas, ${r.usage.input_tokens + r.usage.output_tokens} tokens`);
    return r;
  }));
  app.post('/api/ai/confirm', need('ai.confirm'), wrap(async (req) => {
    const r = await assistant.confirm(req.body?.id, req.body?.approve !== false);
    if (r.action) log('AI_ACTION', `Acción propuesta por la IA y confirmada: ${r.action.name} ${r.action.activar ? 'activada' : 'desactivada'}`, req);
    return r;
  }));

  // ================= Seguridad (administración) =================
  app.get('/api/security', need('read'), wrap((req) => {
    const admin = Security.can(req.user, 'security.admin');
    const base = { roles: ROLE_TXT, me: req.user && { username: req.user.username, name: req.user.name, role: req.user.role, kind: req.user.kind }, secure: req.secure, ip: normalizeIp(req.ip) };
    if (!admin) return base;
    return {
      ...base, admin: true, settings: security.settings(), users: security.users(), tokens: security.tokens(),
      review: security.review({ secure: req.secure, aiKey: assistant.available }),
    };
  }));
  app.put('/api/security/settings', need('security.admin'), wrap((req) => security.saveSettings(req.body || {}, req.actor, req.ip)));
  app.post('/api/security/users', need('security.admin'), wrap((req) => security.createUser(req.body || {}, req.actor, req.ip)));
  app.put('/api/security/users/:id', need('security.admin'), wrap((req) => {
    if (Number(req.params.id) === req.user.id && req.body?.role && req.body.role !== 'admin') throw err(400, 'No puedes quitarte tu propio rol de administrador');
    return security.updateUser(Number(req.params.id), req.body || {}, req.actor, req.ip);
  }));
  app.delete('/api/security/users/:id', need('security.admin'), wrap((req) => {
    if (Number(req.params.id) === req.user.id) throw err(400, 'No puedes eliminar tu propio usuario');
    security.deleteUser(Number(req.params.id), req.actor, req.ip); return { ok: true };
  }));
  app.post('/api/security/tokens', need('security.admin'), wrap((req) => security.createToken(req.body || {}, req.actor, req.ip)));
  app.delete('/api/security/tokens/:id', need('security.admin'), wrap((req) => { security.revokeToken(Number(req.params.id), req.actor, req.ip); return { ok: true }; }));
  app.get('/api/security/audit', need('security.admin'), wrap((req) => security.auditList({ limit: Number(req.query.limit) || 300, action: req.query.action })));

  // Errores
  app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message, ...(e.extra || {}) }));

  // ================= WebSocket =================
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server, path: '/ws',
    verifyClient: (info, cb) => {
      const s = security.settings();
      const ip = info.req.socket.remoteAddress;
      if (s.allowedNetworks.length && s.networkScope === 'all' && !ipAllowed(ip, s.allowedNetworks)) return cb(false, 403);
      const user = security.identify({ cookieHeader: info.req.headers.cookie });
      if (!user && s.requireLoginForRead) return cb(false, 401);
      cb(true);
    },
  });
  wss.on('connection', (ws) => {
    if (state.latest) ws.send(JSON.stringify({ type: 'reading', data: state.latest }));
    ws.send(JSON.stringify({ type: 'alarms', data: alarms.list() }));
    ws.send(JSON.stringify({ type: 'bypass', data: bypass.status() }));
  });

  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  }

  return {
    broadcast,
    listen: () => new Promise((r) => server.listen(cfg.api.port, cfg.api.host, r)),
    close: () => new Promise((r) => { wss.close(); server.close(() => r()); }),
  };
}

// Capa de servicio local: REST + WebSocket + servidor del dashboard web
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { METRICS } from '../storage/store.js';

export function createServer({ cfg, store, driver, alarms, state, gpio, bypass, assistant }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(cfg.root, 'public')));

  const range = (q) => {
    const to = Number(q.to) || Date.now();
    const from = Number(q.from) || to - 3600_000;
    return { from, to };
  };
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  };
  // Operaciones que cambian el mundo físico exigen la clave de comandos
  const requireKey = (req, _res, next) => {
    if (!cfg.api.commandKey) return next(Object.assign(new Error('Acciones deshabilitadas: define API_COMMAND_KEY en .env'), { status: 403 }));
    if (req.get('x-api-key') !== cfg.api.commandKey) return next(Object.assign(new Error('Clave de comandos incorrecta'), { status: 401 }));
    next();
  };

  // ---------------- UPS ----------------
  app.get('/api/health', (_req, res) => res.json({
    ok: true, uptimeSec: Math.round(process.uptime()), driver: driver.name,
    lastReadingTs: state.latest?.ts ?? null, commOk: state.commOk, lastError: state.lastError,
    cloud: state.cloud ? state.cloud.status() : { enabled: false },
    gpio: { backend: gpio.backend.name, simulated: gpio.simulated },
    bypass: { enabled: cfg.bypass.enabled, state: bypass.state }, ai: { available: assistant.available },
  }));

  app.get('/api/device', (_req, res) => res.json({
    ...cfg.device, driver: driver.name, info: driver.info,
    commands: cfg.api.commandKey ? driver.capabilities.commands : [],
    keyRequired: !!cfg.api.commandKey, thresholds: cfg.alarms, metrics: METRICS,
  }));

  app.get('/api/status', (_req, res) => res.json({ reading: state.latest, alarms: alarms.list(), commOk: state.commOk }));
  app.get('/api/raw', (_req, res) => res.json(state.latest?.raw ?? {}));

  app.get('/api/history', (req, res) => {
    const { from, to } = range(req.query);
    res.json({ from, to, ...store.history(from, to, Math.min(Number(req.query.points) || 300, 2000)) });
  });

  app.get('/api/stats', (req, res) => {
    const { from, to } = range(req.query);
    res.json({ from, to, ...store.stats(from, to), energyKWh: store.energyKWh(from, to) });
  });

  app.get('/api/events', (req, res) => {
    const { from, to } = range({ ...req.query, from: req.query.from || 1 });
    let ev = store.events({ from, to, limit: Math.min(Number(req.query.limit) || 200, 2000) });
    if (req.query.prefix) ev = ev.filter((e) => e.code.startsWith(req.query.prefix));
    res.json(ev);
  });

  app.get('/api/export.csv', (req, res) => {
    const { from, to } = range(req.query);
    const rows = store.rawRange(from, to);
    const cols = ['ts', 'fecha', ...Object.keys(METRICS), 'status'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cfg.device.id}_${new Date(from).toISOString().slice(0, 10)}.csv"`);
    res.write('\uFEFF' + cols.join(';') + '\n');
    for (const r of rows) res.write(cols.map((c) => (c === 'fecha' ? new Date(r.ts).toLocaleString('es-CO') : r[c] ?? '')).join(';') + '\n');
    res.end();
  });

  app.post('/api/command', requireKey, wrap(async (req) => {
    const { command } = req.body || {};
    if (!driver.capabilities.commands.includes(command)) throw new Error(`Comando no soportado por el driver ${driver.name}`);
    const result = await driver.command(command);
    log('COMMAND', `Comando enviado a la UPS: ${command}`);
    return { ok: true, result };
  }));

  // ---------------- GPIO ----------------
  app.get('/api/gpio', (_req, res) => res.json(gpio.list()));
  app.put('/api/gpio/:gpio', requireKey, wrap(async (req) => {
    const d = await gpio.configure(Number(req.params.gpio), req.body || {});
    log('GPIO_CONFIG', `GPIO${d.gpio} configurado como ${d.mode}${d.name ? ` (${d.name})` : ''}`);
    return d;
  }));
  app.post('/api/gpio/:gpio/set', requireKey, wrap(async (req) => {
    const d = await gpio.set(Number(req.params.gpio), !!req.body?.active, 'user');
    log('GPIO_SET', `${d.name} (GPIO${d.gpio}) ${d.active ? 'activada' : 'desactivada'}`);
    return d;
  }));
  app.post('/api/gpio/:gpio/simulate', wrap(async (req) => {
    gpio.simulateInput(Number(req.params.gpio), !!req.body?.active);
    return gpio.describe(Number(req.params.gpio));
  }));

  // ---------------- Bypass ----------------
  app.get('/api/bypass', (_req, res) => res.json(bypass.status()));
  app.post('/api/bypass', requireKey, wrap((req) => bypass.command(req.body || {})));

  // ---------------- IA ----------------
  app.get('/api/ai', (_req, res) => res.json(assistant.info()));
  app.post('/api/ai/chat', wrap((req) => assistant.chat(req.body?.messages || [])));
  app.post('/api/ai/confirm', requireKey, wrap(async (req) => {
    const r = await assistant.confirm(req.body?.id, req.body?.approve !== false);
    if (r.action) log('AI_ACTION', `Acción propuesta por la IA y confirmada: ${r.action.name} ${r.action.activar ? 'activada' : 'desactivada'}`);
    return r;
  }));

  // Manejo de errores de requireKey
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  function log(code, message) {
    const ev = { ts: Date.now(), code, severity: 'info', state: 'raised', message, value: null };
    store.saveEvent(ev); broadcast('event', ev);
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
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

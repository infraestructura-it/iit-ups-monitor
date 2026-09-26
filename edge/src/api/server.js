// Capa de servicio local: REST + WebSocket + servidor del dashboard web
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { METRICS } from '../storage/store.js';

export function createServer({ cfg, store, driver, alarms, state }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(cfg.root, 'public')));

  const range = (q) => {
    const to = Number(q.to) || Date.now();
    const from = Number(q.from) || to - 3600_000;
    return { from, to };
  };

  app.get('/api/health', (_req, res) => res.json({
    ok: true, uptimeSec: Math.round(process.uptime()), driver: driver.name,
    lastReadingTs: state.latest?.ts ?? null, commOk: state.commOk, lastError: state.lastError,
    cloud: state.cloud ? state.cloud.status() : { enabled: false },
  }));

  app.get('/api/device', (_req, res) => res.json({
    ...cfg.device, driver: driver.name, info: driver.info,
    commands: cfg.api.commandKey ? driver.capabilities.commands : [],
    thresholds: cfg.alarms, metrics: METRICS,
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
    res.json(store.events({ from, to, limit: Math.min(Number(req.query.limit) || 200, 2000) }));
  });

  app.get('/api/export.csv', (req, res) => {
    const { from, to } = range(req.query);
    const rows = store.rawRange(from, to);
    const cols = ['ts', 'fecha', ...Object.keys(METRICS), 'status'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cfg.device.id}_${new Date(from).toISOString().slice(0, 10)}.csv"`);
    res.write('\uFEFF' + cols.join(';') + '\n');
    for (const r of rows) {
      res.write(cols.map((c) => (c === 'fecha' ? new Date(r.ts).toLocaleString('es-CO') : r[c] ?? '')).join(';') + '\n');
    }
    res.end();
  });

  app.post('/api/command', async (req, res) => {
    if (!cfg.api.commandKey) return res.status(403).json({ error: 'Comandos deshabilitados: define API_COMMAND_KEY en .env' });
    if (req.get('x-api-key') !== cfg.api.commandKey) return res.status(401).json({ error: 'Clave de comandos incorrecta' });
    const { command } = req.body || {};
    if (!driver.capabilities.commands.includes(command)) return res.status(400).json({ error: `Comando no soportado por el driver ${driver.name}` });
    try {
      const result = await driver.command(command);
      const ev = { ts: Date.now(), code: 'COMMAND', severity: 'info', state: 'raised', message: `Comando enviado: ${command}`, value: null };
      store.saveEvent(ev); broadcast('event', ev);
      res.json({ ok: true, result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    if (state.latest) ws.send(JSON.stringify({ type: 'reading', data: state.latest }));
    ws.send(JSON.stringify({ type: 'alarms', data: alarms.list() }));
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

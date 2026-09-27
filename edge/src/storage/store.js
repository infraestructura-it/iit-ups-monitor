// Persistencia local en SQLite (WAL). Guarda métricas, eventos y la cola de salida hacia la nube.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // SQLite nativo de Node (sin compilar nada)

export const METRICS = {
  in_v: 'Voltaje entrada (V)', in_f: 'Frecuencia entrada (Hz)', out_v: 'Voltaje salida (V)',
  out_f: 'Frecuencia salida (Hz)', out_a: 'Corriente salida (A)', load: 'Carga (%)',
  out_va: 'Potencia aparente (VA)', out_w: 'Potencia activa (W)', batt_v: 'Voltaje batería (V)',
  batt_pct: 'Carga batería (%)', runtime: 'Autonomía (s)', temp: 'Temperatura (°C)',
};

export function flatten(r) {
  return {
    ts: r.ts, in_v: r.input.voltage, in_f: r.input.frequency, out_v: r.output.voltage,
    out_f: r.output.frequency, out_a: r.output.current, load: r.output.loadPct,
    out_va: r.output.apparentPowerVA, out_w: r.output.realPowerW, batt_v: r.battery.voltage,
    batt_pct: r.battery.chargePct, runtime: r.battery.runtimeSec, temp: r.ups.temperatureC,
    status: r.status.codes.join(' '),
  };
}

export class Store {
  constructor(cfg) {
    this.cfg = cfg;
    fs.mkdirSync(path.dirname(cfg.path), { recursive: true });
    this.db = new DatabaseSync(cfg.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
    const cols = Object.keys(METRICS).map((k) => `${k} REAL`).join(', ');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (ts INTEGER PRIMARY KEY, ${cols}, status TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, code TEXT, severity TEXT,
        state TEXT, message TEXT, value REAL);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, payload TEXT);
    `);
    const keys = ['ts', ...Object.keys(METRICS), 'status'];
    this.insReading = this.db.prepare(`INSERT OR REPLACE INTO readings (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`);
    this.insEvent = this.db.prepare('INSERT INTO events (ts, code, severity, state, message, value) VALUES (@ts,@code,@severity,@state,@message,@value)');
    this.insOutbox = this.db.prepare('INSERT INTO outbox (kind, payload) VALUES (?, ?)');
    this.purge();
    this.purgeTimer = setInterval(() => this.purge(), 3600_000);
    this.purgeTimer.unref?.();
  }

  saveReading(r) { this.insReading.run(flatten(r)); }
  saveEvent(e) {
    const { ts, code, severity, state, message, value } = e;
    return this.insEvent.run({ ts, code, severity, state, message, value: value ?? null }).lastInsertRowid;
  }

  history(from, to, points = 300) {
    const bucket = Math.max(1000, Math.floor((to - from) / points));
    const agg = Object.keys(METRICS).map((k) => (k === 'batt_pct' || k === 'runtime' ? `MIN(${k}) AS ${k}` : `ROUND(AVG(${k}),2) AS ${k}`)).join(', ');
    const rows = this.db.prepare(`
      SELECT CAST(ts / @bucket AS INTEGER) * @bucket AS t, ${agg}, MAX(load) AS load_max, MIN(in_v) AS in_v_min, MAX(in_v) AS in_v_max
      FROM readings WHERE ts BETWEEN @from AND @to GROUP BY t ORDER BY t`).all({ from, to, bucket });
    return { bucket, rows };
  }

  rawRange(from, to, limit = 200000) {
    return this.db.prepare('SELECT * FROM readings WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?').all(from, to, limit);
  }

  events({ from = 0, to = Date.now(), limit = 200 } = {}) {
    return this.db.prepare('SELECT * FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?').all(from, to, limit);
  }

  stats(from, to) {
    return this.db.prepare(`
      SELECT COUNT(*) AS samples, MIN(in_v) AS in_v_min, MAX(in_v) AS in_v_max, ROUND(AVG(in_v),1) AS in_v_avg,
             MAX(load) AS load_max, ROUND(AVG(load),1) AS load_avg, ROUND(AVG(out_w),0) AS out_w_avg,
             MAX(temp) AS temp_max, MIN(batt_pct) AS batt_pct_min
      FROM readings WHERE ts BETWEEN ? AND ?`).get(from, to);
  }

  // Energía consumida (kWh) integrando la potencia activa
  energyKWh(from, to) {
    const rows = this.db.prepare('SELECT ts, out_w FROM readings WHERE ts BETWEEN ? AND ? AND out_w IS NOT NULL ORDER BY ts').all(from, to);
    let wh = 0;
    for (let i = 1; i < rows.length; i++) {
      const dt = (rows[i].ts - rows[i - 1].ts) / 3600_000;
      if (dt < 0.05) wh += ((rows[i].out_w + rows[i - 1].out_w) / 2) * dt; // ignora huecos > 3 min
    }
    return Math.round(wh) / 1000;
  }

  enqueue(kind, payload, max) {
    this.insOutbox.run(kind, JSON.stringify(payload));
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get();
    if (n > max) this.db.prepare('DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id LIMIT ?)').run(n - max);
  }
  peekOutbox(limit = 500) { return this.db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').all(limit); }
  ackOutbox(ids) {
    if (!ids.length) return;
    this.db.prepare(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  outboxSize() { return this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n; }

  purge() {
    const limit = Date.now() - this.cfg.retentionDays * 86400_000;
    this.db.prepare('DELETE FROM readings WHERE ts < ?').run(limit);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(limit);
  }

  close() { clearInterval(this.purgeTimer); this.db.close(); }
}

// Consultas de reportes: agregación por intervalo (prom/mín/máx), estadísticas y cortes de energía
import { METRICS } from '../storage/store.js';

export const UNITS = {
  in_v: 'V', in_f: 'Hz', out_v: 'V', out_f: 'Hz', out_a: 'A', load: '%', out_va: 'VA',
  out_w: 'W', batt_v: 'V', batt_pct: '%', runtime: 's', temp: '°C',
};
export const BUCKETS = [0, 60_000, 300_000, 900_000, 3_600_000, 86_400_000]; // 0 = cada lectura
const AUTO_STEPS = [5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 21_600_000, 86_400_000];

export function parseQuery(q, maxDays = 400) {
  const to = Number(q.to) || Date.now();
  const from = Number(q.from) || to - 86_400_000;
  if (from >= to) throw new Error('El inicio debe ser anterior al fin');
  if (to - from > maxDays * 86_400_000) throw new Error(`Rango máximo: ${maxDays} días`);
  const metrics = (q.metrics ? String(q.metrics).split(',') : Object.keys(METRICS)).filter((m) => METRICS[m]);
  if (!metrics.length) throw new Error('Selecciona al menos una variable');
  const bucket = q.bucket === 'auto' || q.bucket == null ? 'auto' : Number(q.bucket);
  if (bucket !== 'auto' && !BUCKETS.includes(bucket)) throw new Error('Resolución inválida');
  return { from, to, metrics, bucket };
}

export function autoBucket(from, to, maxPoints = 600) {
  const span = to - from;
  return AUTO_STEPS.find((s) => span / s <= maxPoints) || 86_400_000;
}

// Serie agregada: una fila por intervalo con prom/mín/máx de cada métrica
export function aggregate(db, { from, to, metrics, bucketMs }) {
  const cols = metrics.map((m) => `ROUND(AVG(${m}),3) AS ${m}_avg, MIN(${m}) AS ${m}_min, MAX(${m}) AS ${m}_max`).join(', ');
  return db.prepare(`SELECT CAST(ts / @b AS INTEGER) * @b AS t, COUNT(*) AS n, ${cols}
    FROM readings WHERE ts BETWEEN @from AND @to GROUP BY t ORDER BY t`).all({ from, to, b: bucketMs });
}

// Lecturas crudas, en streaming (para exportar sin cargar todo en memoria)
export function rawIterator(db, { from, to, metrics }) {
  return db.prepare(`SELECT ts, ${metrics.join(', ')}, status FROM readings WHERE ts BETWEEN ? AND ? ORDER BY ts`).iterate(from, to);
}

export function countRows(db, from, to) {
  return db.prepare('SELECT COUNT(*) AS n FROM readings WHERE ts BETWEEN ? AND ?').get(from, to).n;
}

export function metricStats(db, { from, to, metrics }) {
  const cols = metrics.map((m) => `MIN(${m}) AS ${m}_min, ROUND(AVG(${m}),3) AS ${m}_avg, MAX(${m}) AS ${m}_max`).join(', ');
  const r = db.prepare(`SELECT COUNT(*) AS samples, MIN(ts) AS first, MAX(ts) AS last, ${cols} FROM readings WHERE ts BETWEEN ? AND ?`).get(from, to);
  const per = Object.fromEntries(metrics.map((m) => [m, { min: r[`${m}_min`], avg: r[`${m}_avg`], max: r[`${m}_max`] }]));
  return { samples: r.samples, first: r.first, last: r.last, metrics: per };
}

// Cortes de energía: pares ON_BATTERY raised/cleared dentro del rango
export function outages(db, from, to) {
  const ev = db.prepare(`SELECT ts, state FROM events WHERE code = 'ON_BATTERY' AND ts BETWEEN ? AND ? ORDER BY ts`).all(from, to);
  const list = [];
  let start = null;
  const prev = db.prepare(`SELECT state FROM events WHERE code = 'ON_BATTERY' AND ts < ? ORDER BY ts DESC LIMIT 1`).get(from);
  if (prev?.state === 'raised') start = from; // el corte venía de antes del rango
  for (const e of ev) {
    if (e.state === 'raised' && start == null) start = e.ts;
    else if (e.state === 'cleared' && start != null) { list.push({ start, end: e.ts, sec: Math.round((e.ts - start) / 1000) }); start = null; }
  }
  if (start != null) list.push({ start, end: null, sec: Math.round((Math.min(to, Date.now()) - start) / 1000), ongoing: true });
  return { count: list.length, totalSec: list.reduce((a, o) => a + o.sec, 0), longestSec: Math.max(0, ...list.map((o) => o.sec)), list };
}

export function eventsInRange(db, from, to, limit = 5000) {
  return db.prepare('SELECT * FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?').all(from, to, limit);
}

export function buildReport(store, q) {
  const { from, to, metrics, bucket } = parseQuery(q);
  const bucketMs = bucket === 'auto' ? autoBucket(from, to) : bucket || autoBucket(from, to);
  const db = store.db;
  return {
    from, to, metrics, bucketMs, requestedBucket: bucket,
    rows: aggregate(db, { from, to, metrics, bucketMs }),
    stats: metricStats(db, { from, to, metrics }),
    energyKWh: store.energyKWh(from, to),
    outages: outages(db, from, to),
    events: db.prepare(`SELECT severity, COUNT(*) AS n FROM events WHERE ts BETWEEN ? AND ? AND state = 'raised' GROUP BY severity`).all(from, to),
    labels: METRICS, units: UNITS,
  };
}

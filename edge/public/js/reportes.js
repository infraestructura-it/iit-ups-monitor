import { ready } from './auth.js';
import { $, $$, api, startClock, toast, fmt, esc } from './lib.js';
import { LineChart } from './chart.js';
await ready;

const GROUPS = [
  { name: 'Entrada', keys: ['in_v', 'in_f'] },
  { name: 'Salida', keys: ['out_v', 'out_f', 'out_a', 'load'] },
  { name: 'Potencia', keys: ['out_va', 'out_w'] },
  { name: 'Batería', keys: ['batt_v', 'batt_pct', 'runtime'] },
  { name: 'UPS', keys: ['temp'] },
];
const LABELS = {
  in_v: 'Voltaje de entrada', in_f: 'Frecuencia de entrada', out_v: 'Voltaje de salida', out_f: 'Frecuencia de salida',
  out_a: 'Corriente de salida', load: 'Carga', out_va: 'Potencia aparente', out_w: 'Potencia activa',
  batt_v: 'Voltaje de batería', batt_pct: 'Carga de batería', runtime: 'Autonomía', temp: 'Temperatura',
};
const UNIT = { in_v: 'V', in_f: 'Hz', out_v: 'V', out_f: 'Hz', out_a: 'A', load: '%', out_va: 'VA', out_w: 'W', batt_v: 'V', batt_pct: '%', runtime: 'min', temp: '°C' };
const DEC = { in_f: 2, out_f: 2, out_a: 2, batt_v: 2, out_va: 0, out_w: 0, load: 0, batt_pct: 0, runtime: 0 };
const COLOR = { in_v: '#00d4ff', in_f: '#00d4ff', out_v: '#10b981', out_f: '#10b981', out_a: '#10b981', load: '#f5a524', out_va: '#00d4ff', out_w: '#10b981', batt_v: '#a78bfa', batt_pct: '#a78bfa', runtime: '#a78bfa', temp: '#f5a524' };
const DEFAULT = ['in_v', 'out_v', 'out_a', 'load', 'out_w', 'batt_pct'];
const RES = { 0: 'cada lectura', 5000: '5 s', 15000: '15 s', 30000: '30 s', 60000: '1 min', 300000: '5 min', 900000: '15 min', 1800000: '30 min', 3600000: '1 h', 21600000: '6 h', 86400000: '1 día' };

// ---------- controles ----------
const saved = JSON.parse(localStorage.getItem('iit-rep-vars') || 'null') || DEFAULT;
$('#vars').innerHTML = GROUPS.map((g) => `<fieldset><legend>${g.name}</legend>${g.keys.map((k) =>
  `<label class="check"><input type="checkbox" value="${k}" ${saved.includes(k) ? 'checked' : ''}> ${LABELS[k]}</label>`).join('')}</fieldset>`).join('');

const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => new Date(v).getTime();
function setRange(from, to, preset) {
  $('#from').value = toLocalInput(from); $('#to').value = toLocalInput(to);
  $$('#presets button').forEach((b) => b.setAttribute('aria-selected', b.dataset.p === preset));
}
function preset(p) {
  const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const m = { '24h': [now - 864e5, now], today: [d0.getTime(), now], yesterday: [d0.getTime() - 864e5, d0.getTime()], '7d': [now - 7 * 864e5, now], '30d': [now - 30 * 864e5, now] };
  setRange(...m[p], p);
}
$('#presets').onclick = (e) => { const b = e.target.closest('button'); if (b) { preset(b.dataset.p); run(); } };
['#from', '#to'].forEach((s) => $(s).addEventListener('change', () => $$('#presets button').forEach((b) => b.setAttribute('aria-selected', false))));

function query() {
  const metrics = $$('#vars input:checked').map((i) => i.value);
  if (!metrics.length) throw new Error('Selecciona al menos una variable');
  localStorage.setItem('iit-rep-vars', JSON.stringify(metrics));
  const from = fromLocalInput($('#from').value), to = fromLocalInput($('#to').value);
  if (!(from < to)) throw new Error('Revisa el rango de fechas');
  return new URLSearchParams({ from, to, bucket: $('#bucket').value, metrics: metrics.join(',') });
}

// ---------- render ----------
const charts = new Map();
const dur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
const fmtDT = (ts) => new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function render(r) {
  const crit = r.events.find((e) => e.severity === 'crit')?.n || 0;
  $('#kpis').innerHTML = [
    ['Lecturas', fmt(r.stats.samples, 0)],
    ['Resolución de gráficas', RES[r.bucketMs] || `${r.bucketMs / 1000} s`],
    ['Energía entregada', `${fmt(r.energyKWh, 2)} kWh`],
    ['Cortes de energía', fmt(r.outages.count, 0), r.outages.count > 0],
    ['Tiempo en baterías', dur(r.outages.totalSec), r.outages.totalSec > 0],
    ['Corte más largo', dur(r.outages.longestSec)],
    ['Alarmas críticas', fmt(crit, 0), crit > 0],
  ].map(([k, v, alert]) => `<div class="kpi ${alert ? 'alert' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');

  if (!r.stats.samples) {
    $('#charts').innerHTML = '<div class="panel muted">No hay lecturas en este periodo. Recuerda que la Raspberry conserva el histórico según <code>retentionDays</code> (30 días por defecto).</div>';
  } else {
    const conv = (k, v) => (v == null ? null : k === 'runtime' ? Math.round(v / 60) : v);
    $('#charts').innerHTML = r.metrics.map((k) => {
      const s = r.stats.metrics[k], d = DEC[k] ?? 1;
      return `<article class="chart-card"><header><h3>${LABELS[k]} <span class="muted">(${UNIT[k]})</span></h3>
        <div class="mm"><span>mín <b>${fmt(conv(k, s.min), d)}</b></span><span>prom <b>${fmt(conv(k, s.avg), d)}</b></span><span>máx <b>${fmt(conv(k, s.max), d)}</b></span></div></header>
        <div class="cw"><canvas id="c-${k}" aria-label="Gráfica de ${LABELS[k]}"></canvas></div></article>`;
    }).join('');
    charts.clear();
    for (const k of r.metrics) {
      const ch = new LineChart($(`#c-${k}`));
      const band = r.bucketMs > 0 ? r.rows.map((x) => [x.t, conv(k, x[`${k}_min`]), conv(k, x[`${k}_max`])]) : null;
      ch.set({ unit: UNIT[k], range: [r.from, r.to], series: [{ label: 'promedio', color: COLOR[k], gapMs: r.bucketMs * 3, data: r.rows.map((x) => [x.t, conv(k, x[`${k}_avg`])]), band }] });
      charts.set(k, ch);
    }
  }
  $('#outages').innerHTML = r.outages.list.length ? r.outages.list.map((o) =>
    `<tr><td class="mono">${fmtDT(o.start)}</td><td class="mono">${o.end ? fmtDT(o.end) : 'en curso'}</td><td class="mono">${dur(o.sec)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">Sin cortes de energía en el periodo.</td></tr>';
}

async function run() {
  let q; try { q = query(); } catch (e) { return toast(e.message, true); }
  $('#run').disabled = true; $('#hint').textContent = 'Consultando la base de datos…';
  try {
    render(await api(`/api/report?${q}`));
    $('#csv').href = `/api/export.csv?from=${q.get('from')}&to=${q.get('to')}`;
    $('#hint').textContent = 'Banda sombreada: mínimo y máximo de cada intervalo. Línea: promedio.';
  } catch (e) { toast(e.message, true); $('#hint').textContent = ''; }
  finally { $('#run').disabled = false; }
}

// Descarga del Excel: fetch para mostrar errores (ej. demasiadas filas) en vez de un archivo roto
$('#xlsx').onclick = async () => {
  let q; try { q = query(); } catch (e) { return toast(e.message, true); }
  const b = $('#xlsx'); b.disabled = true; const txt = b.textContent; b.textContent = 'Generando Excel…';
  try {
    const res = await fetch(`/api/report.xlsx?${q}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'reporte_ups.xlsx';
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Descargado ${name}`);
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = txt; }
};
$('#run').onclick = run;

// Arranque: rango desde la URL (enlace desde la página UPS) o últimas 24 h
startClock();
const u = new URLSearchParams(location.search);
if (u.get('from') && u.get('to')) setRange(Number(u.get('from')), Number(u.get('to')), null); else preset('24h');
run();

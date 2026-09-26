import { sparkline, LineChart } from './chart.js';

const $ = (s) => document.querySelector(s);
const C = { grid: '#00d4ff', batt: '#a78bfa', ok: '#10b981', warn: '#f5a524', crit: '#ff4d6d', text: '#dbe4f0' };

// Definición de tarjetas: clave plana, etiqueta, unidad, decimales, color de la chispa
const TILES = [
  ['in_v', 'Voltaje de entrada', 'V', 1, C.grid],
  ['in_f', 'Frecuencia de entrada', 'Hz', 2, C.grid],
  ['out_v', 'Voltaje de salida', 'V', 1, C.ok],
  ['out_f', 'Frecuencia de salida', 'Hz', 2, C.ok],
  ['out_a', 'Corriente de salida', 'A', 2, C.ok],
  ['load', 'Carga', '%', 0, C.ok],
  ['out_va', 'Potencia aparente', 'VA', 0, C.ok],
  ['out_w', 'Potencia activa', 'W', 0, C.ok],
  ['batt_v', 'Voltaje de batería', 'V', 2, C.batt],
  ['batt_pct', 'Carga de batería', '%', 0, C.batt],
  ['runtime', 'Autonomía', 'min', 0, C.batt],
  ['temp', 'Temperatura', '°C', 1, C.warn],
];
const EST = { 'output.apparentPowerVA': 'out_va', 'output.realPowerW': 'out_w', 'output.current': 'out_a', 'battery.chargePct': 'batt_pct', 'output.frequency': 'out_f' };

const GROUPS = [
  { name: 'Voltajes', unit: 'V', keys: [['in_v', 'Entrada', C.grid], ['out_v', 'Salida', C.ok]] },
  { name: 'Frecuencia', unit: 'Hz', keys: [['in_f', 'Entrada', C.grid], ['out_f', 'Salida', C.ok]] },
  { name: 'Potencia', unit: 'W/VA', keys: [['out_va', 'Aparente (VA)', C.grid], ['out_w', 'Activa (W)', C.ok]] },
  { name: 'Carga y batería', unit: '%', keys: [['load', 'Carga', C.warn], ['batt_pct', 'Batería', C.batt]] },
  { name: 'Corriente', unit: 'A', keys: [['out_a', 'Salida', C.ok]] },
  { name: 'Voltaje de batería', unit: 'V', keys: [['batt_v', 'Batería', C.batt]] },
  { name: 'Temperatura', unit: '°C', keys: [['temp', 'UPS', C.warn]] },
];

const state = { device: null, spark: {}, range: 3600_000, group: 0, rawPrev: {}, lastReading: null };
const chart = new LineChart($('#trend-chart'));

const flat = (r) => ({
  in_v: r.input.voltage, in_f: r.input.frequency, out_v: r.output.voltage, out_f: r.output.frequency,
  out_a: r.output.current, load: r.output.loadPct, out_va: r.output.apparentPowerVA, out_w: r.output.realPowerW,
  batt_v: r.battery.voltage, batt_pct: r.battery.chargePct,
  runtime: r.battery.runtimeSec != null ? r.battery.runtimeSec / 60 : null, temp: r.ups.temperatureC ?? r.battery.temperatureC,
});
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtTime = (ts) => new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (p, o) => fetch(p, o).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error || r.status)))));

// ---------- Tarjetas ----------
function buildTiles() {
  $('#tiles').innerHTML = TILES.map(([k, label, unit]) =>
    `<div class="tile" id="tile-${k}"><span>${label}</span><b>—<small>${unit}</small></b><canvas aria-hidden="true"></canvas></div>`).join('');
  TILES.forEach(([k]) => (state.spark[k] = []));
}

function levelFor(k, v, s) {
  const t = state.device?.thresholds; if (!t || v == null) return '';
  if (k === 'in_v' && !s.onBattery) return v < t.inputVoltage.min || v > t.inputVoltage.max ? 'warn' : '';
  if (k === 'in_f' && !s.onBattery) return v < t.inputFrequency.min || v > t.inputFrequency.max ? 'warn' : '';
  if (k === 'load') return v >= t.loadPct.crit ? 'crit' : v >= t.loadPct.warn ? 'warn' : '';
  if (k === 'batt_pct') return v <= t.batteryPct.crit ? 'crit' : v <= t.batteryPct.warn ? 'warn' : '';
  if (k === 'temp') return v >= t.temperatureC.crit ? 'crit' : v >= t.temperatureC.warn ? 'warn' : '';
  return '';
}

function updateTiles(r) {
  const f = flat(r);
  const est = new Set(r.estimated.map((e) => EST[e]).filter(Boolean));
  for (const [k, , unit, d, color] of TILES) {
    const el = $(`#tile-${k}`);
    el.querySelector('b').innerHTML = `${fmt(f[k], d)}<small>${unit}</small>`;
    el.className = `tile ${levelFor(k, f[k], r.status)}`;
    el.dataset.est = est.has(k) ? '1' : '0';
    el.title = est.has(k) ? 'Valor calculado (no reportado por la UPS)' : '';
    const arr = state.spark[k]; arr.push(f[k]); if (arr.length > 150) arr.shift();
    sparkline(el.querySelector('canvas'), arr, color);
  }
}

// ---------- Diagrama ----------
function updateFlow(r) {
  const s = r.status, f = flat(r);
  const mode = s.onBattery ? 'battery' : s.bypass ? 'bypass' : 'grid';
  document.body.dataset.mode = mode;
  document.body.dataset.bypass = s.bypass ? '1' : '0';
  const titles = {
    grid: 'En línea, alimentada por la red',
    battery: s.testing ? 'Prueba de batería en curso' : 'Operando con baterías',
    bypass: 'En bypass, la carga va directa a la red',
  };
  $('#mode').textContent = titles[mode];
  const rt = f.runtime != null ? `, autonomía estimada ${fmt(f.runtime, 0)} min` : '';
  $('#mode-detail').textContent = mode === 'battery' ? `Batería al ${fmt(f.batt_pct, 0)}%${rt}` : s.charging ? 'Cargando baterías' : 'Baterías en flotación';

  const batOn = s.onBattery || !!s.charging;
  $('#f-in').setAttribute('class', `flow f-grid${!s.onBattery && !s.bypass ? ' on' : ''}`);
  $('#f-out').setAttribute('class', `flow ${s.onBattery ? 'f-batt' : 'f-grid'} on`);
  $('#f-byp').setAttribute('class', `flow f-byp${s.bypass && !s.onBattery ? ' on' : ''}`);
  // descarga: batería -> UPS; carga: sentido inverso
  $('#f-bat').setAttribute('class', `flow ${s.onBattery ? 'f-batt' : 'f-grid'}${batOn ? ' on' : ''}${s.onBattery ? '' : ' rev'}`);

  $('#t-in-v').textContent = `${fmt(f.in_v)} V`;
  $('#t-in-f').textContent = `${fmt(f.in_f, 2)} Hz`;
  $('#t-out-v').textContent = `${fmt(f.out_v)} V`;
  $('#t-out-p').textContent = f.out_w != null ? `${r.estimated.includes('output.realPowerW') ? '≈' : ''}${fmt(f.out_w, 0)} W` : `${fmt(f.out_a, 2)} A`;
  $('#t-ups-mode').textContent = s.codes.join(' ') || '—';
  $('#t-temp').textContent = `${fmt(f.temp)} °C`;
  $('#t-bat-pct').textContent = f.batt_pct != null ? `${fmt(f.batt_pct, 0)}%` : '—';
  $('#t-bat-v').textContent = `${fmt(f.batt_v, 2)} V`;
  $('#t-bat-rt').textContent = f.runtime != null ? `autonomía ${fmt(f.runtime, 0)} min` : 'autonomía no reportada';
  $('#bat-fill').setAttribute('width', (82 * Math.max(0, Math.min(100, f.batt_pct ?? 0))) / 100);

  const load = f.load ?? 0, t = state.device?.thresholds?.loadPct || { warn: 80, crit: 95 };
  const lb = $('#lb-fg');
  lb.setAttribute('width', (220 * Math.min(load, 100)) / 100);
  lb.setAttribute('class', `lb-fg ${load >= t.crit ? 'crit' : load >= t.warn ? 'warn' : ''}`);
  $('#t-load').textContent = `Carga ${fmt(load, 0)}%`;
}

function setComm(ok, error) {
  const l = $('#link');
  l.dataset.state = ok ? 'ok' : 'bad';
  l.querySelector('span').textContent = ok ? 'Leyendo la UPS' : 'Sin comunicación';
  if (!ok) {
    document.body.dataset.mode = 'nocomm';
    $('#mode').textContent = 'Sin comunicación con la UPS';
    $('#mode-detail').textContent = error ? `${error}. Revisa el cable y el puerto configurado.` : '';
  }
}

// ---------- Alarmas y eventos ----------
function renderAlarms(list) {
  $('#active-alarms').innerHTML = list.map((a) => `<li class="${a.severity}">${esc(a.message)}</li>`).join('');
}
function eventItem(e) {
  return `<li class="${e.severity} ${e.state}"><span>${esc(e.message)}${e.value != null ? ` <span class="muted">(${fmt(e.value)})</span>` : ''}</span><time>${fmtTime(e.ts)}</time></li>`;
}
async function loadEvents() {
  const ev = await api('/api/events?limit=100');
  $('#events').innerHTML = ev.length ? ev.map(eventItem).join('') : '<li class="empty">Sin eventos registrados. Aquí aparecerán cortes de energía, sobrecargas y alarmas.</li>';
}

// ---------- Datos crudos del puerto ----------
let rawTimer = 0;
function renderRaw(raw) {
  const now = Date.now(); if (now - rawTimer < 2000) return; rawTimer = now;
  const q = $('#raw-filter').value.trim().toLowerCase();
  const rows = Object.entries(raw).filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q));
  $('#raw').innerHTML = rows.length ? rows.map(([k, v]) =>
    `<tr class="${state.rawPrev[k] !== undefined && state.rawPrev[k] !== v ? 'chg' : ''}"><td>${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`).join('')
    : '<tr><td colspan="2">Sin variables que coincidan</td></tr>';
  state.rawPrev = { ...raw };
}
$('#raw-filter').addEventListener('input', () => { rawTimer = 0; if (state.lastReading) renderRaw(state.lastReading.raw); });

// ---------- Tendencias ----------
function buildGroups() {
  $('#groups').innerHTML = GROUPS.map((g, i) => `<button data-g="${i}" aria-selected="${i === state.group}">${g.name}</button>`).join('');
  $('#groups').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.group = +b.dataset.g; buildGroups(); loadTrend(); };
}
$('#ranges').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('#ranges').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', x === b));
  state.range = +b.dataset.r; loadTrend();
};

async function loadTrend() {
  const to = Date.now(), from = to - state.range;
  const [h, st] = await Promise.all([api(`/api/history?from=${from}&to=${to}&points=400`), api(`/api/stats?from=${from}&to=${to}`)]);
  const g = GROUPS[state.group];
  chart.set({
    unit: g.unit, range: [from, to],
    series: g.keys.map(([k, label, color]) => ({ label, color, gapMs: h.bucket * 3, data: h.rows.map((r) => [r.t, k === 'runtime' && r[k] != null ? r[k] / 60 : r[k]]) })),
  });
  $('#summary').innerHTML = `
    <div class="big"><span>Energía entregada a la carga</span><b>${fmt(st.energyKWh, 2)} kWh</b></div>
    <div><span>Voltaje entrada mín.</span><b>${fmt(st.in_v_min)} V</b></div>
    <div><span>Voltaje entrada máx.</span><b>${fmt(st.in_v_max)} V</b></div>
    <div><span>Voltaje entrada prom.</span><b>${fmt(st.in_v_avg)} V</b></div>
    <div><span>Carga máxima</span><b>${fmt(st.load_max, 0)} %</b></div>
    <div><span>Carga promedio</span><b>${fmt(st.load_avg)} %</b></div>
    <div><span>Potencia promedio</span><b>${fmt(st.out_w_avg, 0)} W</b></div>
    <div><span>Batería mínima</span><b>${fmt(st.batt_pct_min, 0)} %</b></div>
    <div><span>Temperatura máx.</span><b>${fmt(st.temp_max)} °C</b></div>
    <div><span>Muestras</span><b>${fmt(st.samples, 0)}</b></div>`;
  $('#csv').href = `/api/export.csv?from=${from}&to=${to}`;
}

// ---------- Equipo y comandos ----------
async function loadDevice() {
  const d = await api('/api/device');
  state.device = d;
  const i = d.info || {};
  $('#dev-name').textContent = d.name;
  $('#dev-sub').textContent = `${d.site} | ${[i.manufacturer, i.model].filter(Boolean).join(' ') || 'Modelo no reportado'}`;
  const rt = i.ratings || {};
  const rows = [
    ['Identificador', d.id], ['Fabricante', i.manufacturer], ['Modelo', i.model], ['Firmware', i.firmware],
    ['Serial', i.serial], ['Protocolo', i.protocol], ['Puerto', i.port], ['Driver NUT', i.driver],
    ['Potencia nominal', rt.ratedVA && `${rt.ratedVA} VA`], ['Voltaje nominal', rt.ratedVoltage && `${rt.ratedVoltage} V`],
    ['Corriente nominal', rt.ratedCurrent && `${rt.ratedCurrent} A`], ['Batería nominal', rt.ratedBatteryVoltage && `${rt.ratedBatteryVoltage} V`],
    ['Frecuencia nominal', rt.ratedFrequency && `${rt.ratedFrequency} Hz`],
  ].filter(([, v]) => v);
  $('#dev-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');

  const labels = { test: 'Iniciar prueba de batería', testCancel: 'Cancelar prueba', beeperToggle: 'Silenciar o activar alarma sonora', beeperMute: 'Silenciar alarma sonora' };
  if (d.commands.length) {
    $('#cmd-box').hidden = false;
    $('#cmd-key').value = localStorage.getItem('iit-ups-key') || '';
    $('#cmd-buttons').innerHTML = d.commands.map((c) => `<button class="btn danger" data-c="${c}">${labels[c] || c}</button>`).join('');
    $('#cmd-buttons').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (!confirm(`¿Enviar "${b.textContent}" a la UPS?`)) return;
      const key = $('#cmd-key').value; localStorage.setItem('iit-ups-key', key);
      try {
        await api('/api/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ command: b.dataset.c }) });
        $('#cmd-msg').textContent = `Comando enviado: ${b.textContent}`;
      } catch (err) { $('#cmd-msg').textContent = `No se envió: ${err.message}`; }
    };
  }
}

// ---------- WebSocket ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (m) => {
    const { type, data } = JSON.parse(m.data);
    if (type === 'reading') {
      state.lastReading = data;
      setComm(true); updateFlow(data); updateTiles(data); renderRaw(data.raw);
    } else if (type === 'alarms') renderAlarms(data);
    else if (type === 'event') {
      const list = $('#events'); list.querySelector('.empty')?.remove();
      list.insertAdjacentHTML('afterbegin', eventItem(data));
    } else if (type === 'comm') setComm(false, data.error);
  };
  ws.onclose = () => {
    const l = $('#link'); l.dataset.state = 'bad'; l.querySelector('span').textContent = 'Reconectando con la Raspberry';
    setTimeout(connect, 3000);
  };
}

async function preloadSparks() {
  const to = Date.now();
  const h = await api(`/api/history?from=${to - 600_000}&to=${to}&points=150`);
  for (const [k] of TILES) state.spark[k] = h.rows.map((r) => (k === 'runtime' && r[k] != null ? r[k] / 60 : r[k]));
}

setInterval(() => ($('#clock').textContent = new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'medium' })), 1000);
setInterval(() => loadTrend().catch(() => {}), 30_000);

buildTiles(); buildGroups();
await loadDevice().catch((e) => ($('#dev-sub').textContent = `No se pudo leer el equipo: ${e.message}`));
await preloadSparks().catch(() => {});
await Promise.all([loadTrend(), loadEvents()]).catch(() => {});
connect();

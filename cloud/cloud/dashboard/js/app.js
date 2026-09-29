import { LineChart } from './chart.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, OFFLINE_AFTER_MS } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GROUPS = [
  { name: 'Voltajes', unit: 'V', keys: [['in_v', 'Entrada', '#00d4ff'], ['out_v', 'Salida', '#10b981']] },
  { name: 'Carga y batería', unit: '%', keys: [['load', 'Carga', '#f5a524'], ['batt_pct', 'Batería', '#a78bfa']] },
  { name: 'Potencia', unit: 'W/VA', keys: [['out_va', 'Aparente', '#00d4ff'], ['out_w', 'Activa', '#10b981']] },
  { name: 'Frecuencia', unit: 'Hz', keys: [['in_f', 'Entrada', '#00d4ff'], ['out_f', 'Salida', '#10b981']] },
  { name: 'Temperatura', unit: '°C', keys: [['temp', 'UPS', '#f5a524']] },
];
const st = { devices: new Map(), selected: null, range: 86400_000, group: 0 };
const chart = new LineChart($('#chart'));

function modeOf(d) {
  if (!d.last_seen || Date.now() - new Date(d.last_seen) > OFFLINE_AFTER_MS) return ['offline', 'Sin conexión'];
  const s = d.latest?.status || {};
  return s.onBattery ? ['battery', 'En batería'] : s.bypass ? ['battery', 'Bypass'] : ['grid', 'En línea'];
}

function renderFleet() {
  const list = [...st.devices.values()].sort((a, b) => a.name?.localeCompare(b.name));
  $('#fleet-sub').textContent = `${list.length} equipo${list.length === 1 ? '' : 's'} reportando`;
  $('#fleet').innerHTML = list.map((d) => {
    const [cls, label] = modeOf(d), r = d.latest || {};
    return `<button class="unit" data-id="${esc(d.device_id)}" aria-pressed="${st.selected === d.device_id}">
      <header><div><h3>${esc(d.name || d.device_id)}</h3><span class="muted">${esc(d.site || '')} ${esc(d.model || '')}</span></div>
      <span class="pill ${cls}">${label}</span></header>
      <div class="grid3">
        <div><span>Entrada</span><b>${fmt(r.input?.voltage)} V</b></div>
        <div><span>Salida</span><b>${fmt(r.output?.voltage)} V</b></div>
        <div><span>Carga</span><b>${fmt(r.output?.loadPct, 0)} %</b></div>
        <div><span>Batería</span><b>${fmt(r.battery?.chargePct, 0)} %</b></div>
        <div><span>Potencia</span><b>${fmt(r.output?.realPowerW, 0)} W</b></div>
        <div><span>Temp.</span><b>${fmt(r.ups?.temperatureC)} °C</b></div>
      </div>
      <span class="muted" style="font-size:.78rem">Último dato ${d.last_seen ? new Date(d.last_seen).toLocaleString('es-CO') : '—'}</span>
    </button>`;
  }).join('') || '<p class="muted">Aún no hay equipos. Activa CLOUD_ENABLED en la Raspberry para que aparezcan aquí.</p>';
}

$('#fleet').onclick = (e) => { const b = e.target.closest('.unit'); if (b) select(b.dataset.id); };
$('#ranges').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('#ranges').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', x === b));
  st.range = +b.dataset.r; loadDetail();
};
function buildGroups() {
  $('#groups').innerHTML = GROUPS.map((g, i) => `<button data-g="${i}" aria-selected="${i === st.group}">${g.name}</button>`).join('');
}
$('#groups').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.group = +b.dataset.g; buildGroups(); loadDetail(); };

async function select(id) { st.selected = id; renderFleet(); $('#detail').hidden = false; await loadDetail(); }

async function loadDetail() {
  const d = st.devices.get(st.selected); if (!d) return;
  $('#d-title').textContent = d.name || d.device_id;
  const to = Date.now(), from = to - st.range, g = GROUPS[st.group];
  const cols = ['ts', ...g.keys.map((k) => k[0])].join(',');
  let rows = [];
  for (let off = 0; off < 20000; off += 1000) {   // paginación PostgREST
    const { data, error } = await sb.from('ups_readings').select(cols).eq('device_id', d.device_id)
      .gte('ts', new Date(from).toISOString()).order('ts').range(off, off + 999);
    if (error) break; rows = rows.concat(data); if (data.length < 1000) break;
  }
  chart.set({ unit: g.unit, range: [from, to], series: g.keys.map(([k, label, color]) => ({ label, color, gapMs: 300_000, data: rows.map((r) => [new Date(r.ts).getTime(), r[k]]) })) });
  const { data: ev } = await sb.from('ups_events').select('*').eq('device_id', d.device_id).order('ts', { ascending: false }).limit(100);
  $('#events').innerHTML = (ev || []).map((e) => `<li class="${e.severity} ${e.state}"><span>${esc(e.message)}</span><time>${new Date(e.ts).toLocaleString('es-CO')}</time></li>`).join('')
    || '<li class="empty">Sin eventos en la nube para este equipo.</li>';
}

async function start() {
  $('#login').hidden = true; $('#app').hidden = false; buildGroups();
  const { data } = await sb.from('ups_devices').select('*');
  (data || []).forEach((d) => st.devices.set(d.device_id, d));
  renderFleet();
  sb.channel('ups').on('postgres_changes', { event: '*', schema: 'public', table: 'ups_devices' }, (p) => {
    if (p.new?.device_id) st.devices.set(p.new.device_id, p.new); renderFleet();
  }).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ups_events' }, (p) => {
    if (p.new.device_id === st.selected) loadDetail();
  }).subscribe();
  setInterval(renderFleet, 30_000); // refresca el estado "sin conexión"
}

$('#login').onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value, password: $('#pass').value });
  if (error) $('#login-msg').textContent = 'Correo o contraseña incorrectos.'; else start();
};
$('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

const { data: { session } } = await sb.auth.getSession();
session ? start() : ($('#login').hidden = false);

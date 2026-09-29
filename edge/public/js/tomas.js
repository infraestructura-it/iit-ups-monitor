import { ready, can } from './auth.js';
import { $, api, connectWS, startClock, toast, esc, fmt, eventItem } from './lib.js';
const me = await ready;

const PRIO = { critica: 'Crítica', normal: 'Normal', no_critica: 'No crítica' };
let st = null, selected = null, gpioFree = [];

// ---------- Caras de los tomacorrientes (SVG) ----------
const face515 = () => `<svg viewBox="0 0 60 80" class="face" aria-hidden="true">
  <rect class="plate" x="4" y="4" width="52" height="72" rx="12"/>
  <rect class="slot" x="15" y="18" width="6" height="22" rx="1.5"/>
  <rect class="slot" x="39" y="21" width="6" height="16" rx="1.5"/>
  <path class="slot" d="M25 62 v-6 a5 5 0 0 1 10 0 v6 z"/></svg>`;

function arc(a0, a1, r = 21) {
  const p = (a) => [40 + r * Math.sin((a * Math.PI) / 180), 40 - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
const faceL530 = () => `<svg viewBox="0 0 80 80" class="face" aria-hidden="true">
  <circle class="plate" cx="40" cy="40" r="35"/><circle class="ring" cx="40" cy="40" r="29"/>
  <path class="arc" d="${arc(-28, 28)}"/><path class="arc" d="${arc(92, 148)}"/><path class="arc" d="${arc(212, 268)}"/>
  <path class="arc" d="M49.9 21.5 l-4 5"/></svg>`;

function card(o) {
  const cls = [o.on ? 'on' : 'off', o.shed ? 'shed' : '', o.cycling ? 'cyc' : '', o.currentA > o.continuousA ? 'alarm' : '', selected === o.id ? 'sel' : ''].join(' ');
  const state = o.cycling ? 'reiniciando' : o.shed ? 'desconectada' : o.on ? `${fmt(o.powerW, 0)} W, ${fmt(o.currentA, 2)} A` : 'apagada';
  return `<button class="outlet ${cls}" data-id="${o.id}" aria-pressed="${selected === o.id}" title="${esc(o.typeLabel)} ${o.virtual ? '(virtual)' : `GPIO${o.gpio}`}">
    <span class="o-top"><b>${o.id}</b><i class="prio ${o.priority}" title="${PRIO[o.priority]}"></i></span>
    ${o.type === '5-15R' ? face515() : faceL530()}
    <span class="o-name">${esc(o.name)}</span>
    <span class="o-state">${state}</span>
  </button>`;
}

function renderKpis() {
  const t = st.totals, u = st.ups;
  const shedTxt = st.restoreTimer != null ? `restaura en ${st.restoreTimer} s`
    : t.shed > 0 ? `${t.shed} desconectada${t.shed === 1 ? '' : 's'}`
    : st.shedTimer != null ? `apaga no críticas en ${st.shedTimer} s`
    : st.policy.shedEnabled ? 'lista' : 'deshabilitada';
  $('#kpis').innerHTML = [
    ['Tomas encendidas', `${t.on} / ${t.count}`],
    ['Potencia total', `${fmt(t.powerW, 0)} W`],
    ['Corriente total', `${fmt(t.currentA, 2)} A`],
    ['Carga de la UPS', u?.loadPct != null ? `${fmt(u.loadPct, 0)} %` : '—', u?.loadPct >= 80],
    ['Alimentación', u ? (u.onBattery ? `Baterías ${fmt(u.batteryPct, 0)}%` : 'Red') : '—', u?.onBattery],
    ['Desconexión en batería', shedTxt, t.shed > 0 || st.shedTimer != null],
  ].map(([k, v, alert]) => `<div class="kpi ${alert ? 'alert' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}

function renderGrid() {
  $('#grid515').innerHTML = st.outlets.filter((o) => o.type === '5-15R').map(card).join('');
  $('#gridL530').innerHTML = st.outlets.filter((o) => o.type === 'L5-30R').map(card).join('');
}

function renderDetail() {
  const o = st.outlets.find((x) => x.id === selected);
  const box = $('#detail');
  if (!o) { box.innerHTML = '<p class="muted">Toca una toma para encenderla, apagarla o reiniciar el equipo conectado.</p>'; return; }
  if (box.contains(document.activeElement) && document.activeElement.matches('input, select')) return; // no pisar lo que se edita
  const op = can(me, 'operator'), admin = can(me, 'admin');
  const gpioOpts = ['<option value="">Virtual (sin relé)</option>', ...[...new Set([...gpioFree, ...(o.gpio != null ? [o.gpio] : [])])].sort((a, b) => a - b)
    .map((g) => `<option value="${g}" ${g === o.gpio ? 'selected' : ''}>GPIO${g}</option>`)].join('');
  box.innerHTML = `
    <div class="row" style="justify-content:space-between"><h3>${o.id} <span class="muted" style="font-size:.9rem">${esc(o.typeLabel)}, ${o.ratingA} A</span></h3>
      <span class="badge">${o.virtual ? 'Virtual' : `Relé en GPIO${o.gpio}`}</span></div>
    <div class="io-state">
      <button class="switch" id="sw" role="switch" aria-checked="${o.on}" aria-label="Encender toma" ${op && !o.cycling ? '' : 'disabled'}></button>
      <div><b>${o.cycling ? 'Reiniciando' : o.on ? 'Encendida' : 'Apagada'}</b>
        <div class="muted" style="font-size:.8rem">${o.shed ? 'Desconectada automáticamente por batería' : `${fmt(o.powerW, 0)} W, ${fmt(o.currentA, 2)} A (${o.loadPct}% de ${o.ratingA} A)`}</div></div>
      <button class="btn ghost op-only" id="cycle" style="margin:0 0 0 auto" ${o.cycling || !o.on ? 'disabled' : ''}>Reiniciar (${st.policy.cycleSec} s)</button>
    </div>
    ${o.gpioError ? `<div class="lock-box">No se pudo usar el GPIO asignado: ${esc(o.gpioError)}</div>` : ''}
    <div class="grid2">
      <label class="field">Equipo conectado<input id="f-name" value="${esc(o.name)}" ${admin ? '' : 'disabled'}></label>
      <label class="field">Prioridad<select id="f-prio" ${admin ? '' : 'disabled'}>${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === o.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Relé (GPIO)<select id="f-gpio" ${admin ? '' : 'disabled'}>${gpioOpts}</select></label>
      <label class="field">Carga simulada (W)<input id="f-w" type="number" min="0" value="${o.simW}" ${admin ? '' : 'disabled'}></label>
    </div>
    <p class="muted" style="font-size:.8rem">Relé activo = toma apagada: si la Raspberry falla, todas las tomas quedan energizadas. Continuo máximo recomendado: ${o.continuousA} A (80%).</p>
    <div class="row admin-only"><button class="btn primary" id="save">Guardar toma</button></div>`;

  $('#sw').onclick = () => {
    if (o.on && o.priority === 'critica' && !confirm(`${o.id} alimenta "${o.name}", marcada como crítica. ¿Apagarla?`)) return;
    act(`/api/outlets/${o.id}`, { action: o.on ? 'off' : 'on' });
  };
  $('#cycle')?.addEventListener('click', () => {
    if (!confirm(`¿Reiniciar "${o.name}"? La toma ${o.id} se apagará ${st.policy.cycleSec} s.`)) return;
    act(`/api/outlets/${o.id}`, { action: 'cycle' }, `Reiniciando ${o.id}`);
  });
  $('#save')?.addEventListener('click', async () => {
    try {
      await api(`/api/outlets/${o.id}`, { method: 'PUT', body: { name: $('#f-name').value, priority: $('#f-prio').value, gpio: $('#f-gpio').value, simW: $('#f-w').value } });
      toast(`Toma ${o.id} guardada`); await loadGpio(); await load();
    } catch (e) { toast(e.message, true); }
  });
}

function renderPolicy() {
  const p = st.policy, admin = can(me, 'admin');
  if ($('#pol').contains(document.activeElement)) return;
  $('#p-en').checked = p.shedEnabled; $('#p-nc').value = p.shedNonCriticalAfterSec; $('#p-pct').value = p.shedNormalBelowPct;
  $('#p-rest').value = p.restoreAfterSec; $('#p-cyc').value = p.cycleSec; $('#p-seq').value = p.sequenceMs;
  $('#pol').querySelectorAll('input').forEach((i) => (i.disabled = !admin));
}

function render(s) { st = s; renderKpis(); renderGrid(); renderDetail(); renderPolicy(); }

async function act(url, body, okMsg) {
  try { await api(url, { method: 'POST', body }); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
}

async function load() { render(await api('/api/outlets')); }
async function loadGpio() {
  const g = await api('/api/gpio');
  gpioFree = g.pins.filter((p) => p.mode === 'free').map((p) => p.gpio);
}
async function loadEvents() {
  const ev = await api('/api/events?prefix=OUTLET&limit=100');
  $('#events').innerHTML = ev.length ? ev.map(eventItem).join('') : '<li class="empty">Sin eventos de las tomas todavía.</li>';
}

document.querySelector('.pdu').addEventListener('click', (e) => {
  const b = e.target.closest('.outlet'); if (!b) return;
  selected = b.dataset.id; renderGrid(); renderDetail();
});
$('#all-on').onclick = () => act('/api/outlets/bulk', { action: 'allOn' }, 'Encendido escalonado en curso');
$('#off-nc').onclick = () => confirm('¿Apagar todas las tomas no críticas?') && act('/api/outlets/bulk', { action: 'offNonCritical' }, 'Tomas no críticas apagadas');
$('#pol').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/outlets/policy', { method: 'PUT', body: { shedEnabled: $('#p-en').checked, shedNonCriticalAfterSec: $('#p-nc').value,
      shedNormalBelowPct: $('#p-pct').value, restoreAfterSec: $('#p-rest').value, cycleSec: $('#p-cyc').value, sequenceMs: $('#p-seq').value } });
    document.activeElement.blur(); toast('Política guardada'); await load();
  } catch (err) { toast(err.message, true); }
};

startClock();
await Promise.all([loadGpio(), load(), loadEvents()]);
connectWS({
  outlets: render,
  event: (e) => { if (e.code.startsWith('OUTLET')) { $('#events .empty')?.remove(); $('#events').insertAdjacentHTML('afterbegin', eventItem(e)); } },
});

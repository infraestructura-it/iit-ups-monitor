import { $, $$, api, connectWS, startClock, toast, eventItem, fmt, fmtTime } from './lib.js';
import { ready, can } from './auth.js';
const me = await ready;


let st = null, gpioInfo = null;
const TITLES = {
  ups: 'Carga alimentada por la UPS',
  bypass: 'Carga en bypass, directo de la red',
  transfiriendo_a_bypass: 'Transfiriendo a bypass',
  transfiriendo_a_ups: 'Regresando la carga a la UPS',
  bloqueado: 'Bypass bloqueado',
  deshabilitado: 'Bypass deshabilitado',
};
const yes = (v, a, b) => (v === true ? a : v === false ? b : 'desconocido');

function render(s) {
  st = s;
  document.body.dataset.bp = s.state;
  $('#bp-title').textContent = TITLES[s.state] || s.state;
  const i = s.inputs || {};
  let detail = s.mode === 'auto' ? 'Modo automático' : 'Modo manual: no transfiere solo';
  if (s.countdown?.toBypassMs != null) detail = `Salida de la UPS ausente: transfiere en ${fmt(s.countdown.toBypassMs / 1000, 1)} s`;
  if (s.countdown?.toUpsSec != null) detail = `Salida de la UPS restablecida: regresa en ${s.countdown.toUpsSec} s`;
  if (s.state === 'bypass' && i.upsOut === false) detail = 'Esperando que la UPS vuelva a entregar energía';
  if (s.state === 'bypass' && i.upsOut === true && !s.config.autoReturn) detail = 'La UPS ya entrega energía: el regreso es manual (modo manual > Volver a la UPS)';
  $('#bp-detail').textContent = s.enabled ? detail : '';

  // Diagrama
  const k1Closed = i.fbUps ?? (i.k1Open === false);
  const k2Closed = i.fbBypass ?? (i.k2Closed === true);
  $('#k1').classList.toggle('open', !k1Closed);
  $('#k2').classList.toggle('open', !k2Closed);
  $('#k1-st').textContent = k1Closed ? 'cerrado' : 'abierto';
  $('#k2-st').textContent = k2Closed ? 'cerrado' : 'abierto';
  const gridLive = i.grid !== false, upsLive = i.upsOut !== false;
  $('#w-feed').setAttribute('class', `bp-wire${gridLive ? ' live-grid' : ''}`);
  $('#w-byp-a').setAttribute('class', `bp-wire${gridLive ? ' live-grid' : ''}`);
  $('#w-byp-b').setAttribute('class', `bp-wire${gridLive && k2Closed ? ' live-grid' : ''}`);
  $('#w-ups-a').setAttribute('class', `bp-wire${upsLive ? ' live-ups' : ''}`);
  $('#w-ups-b').setAttribute('class', `bp-wire${upsLive && k1Closed ? ' live-ups' : ''}`);
  const loadLive = (gridLive && k2Closed) ? 'live-grid' : (upsLive && k1Closed) ? 'live-ups' : '';
  $('#w-load').setAttribute('class', `bp-wire ${loadLive}`);
  const sense = (el, v, label, src) => {
    el.setAttribute('class', `sense start ${v === true ? 'on' : v === false ? 'off' : 'unk'}`);
    el.textContent = `${label} ${yes(v, 'presente', 'ausente')}${src ? ` (${src})` : ''}`;
  };
  sense($('#s-grid'), i.grid, 'red', i.sensorGrid != null ? 'sensor' : i.dataGrid != null ? 'datos UPS' : '');
  sense($('#s-ups'), i.upsOut, 'salida', i.sensorUps != null ? 'sensor' : i.dataUps != null ? 'datos UPS' : '');

  // Controles
  $('#disabled').hidden = s.enabled;
  $('#lock').hidden = s.state !== 'bloqueado';
  $('#lock').textContent = s.lockReason ? `Motivo: ${s.lockReason}. Revisa la instalación antes de restablecer.` : '';
  $('#reset').hidden = s.state !== 'bloqueado';
  $$('#mode button').forEach((b) => { b.setAttribute('aria-selected', b.dataset.m === s.mode); b.setAttribute('aria-checked', b.dataset.m === s.mode); b.disabled = !s.enabled; });
  const manual = s.enabled && s.mode === 'manual' && s.state !== 'bloqueado';
  $('#to-bypass').disabled = !manual || s.state === 'bypass';
  $('#to-ups').disabled = !manual || s.state === 'ups';

  const c = s.config, p = c.pins, pin = (g) => (g == null ? 'no usado' : `GPIO${g}`);
  $('#cfg').innerHTML = [
    ['K1 abrir salida UPS', pin(p.relayUps)], ['K2 cerrar bypass', pin(p.relayBypass)],
    ['Sensor salida UPS', pin(p.senseUpsOut)], ['Sensor red', pin(p.senseGrid)],
    ['Auxiliar K1', pin(p.feedbackUps)], ['Auxiliar K2', pin(p.feedbackBypass)],
    ['Confirmación de falla', `${c.confirmMs} ms`], ['Tiempo muerto', `${c.deadTimeMs} ms`],
    ['Retorno a UPS', c.autoReturn ? `automático tras ${c.returnDelaySec} s estable` : 'manual (lo decide el operador)'], ['Límite', `${c.maxTransfers} transferencias / ${c.windowMin} min`],
    ['Transferencias recientes', s.transfersInWindow], ['Usar datos de la UPS', c.useUpsData ? `sí (salida < ${c.outputMinV} V = falla)` : 'no'],
    ['Última transferencia', s.lastTransferTs ? fmtTime(s.lastTransferTs) : '—'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

async function command(body, okMsg) {
  try { render(await api('/api/bypass', { method: 'POST', body })); toast(okMsg); }
  catch (e) { toast(e.message, true); }
}

$('#mode').onclick = (e) => { const b = e.target.closest('button'); if (b && b.dataset.m !== st?.mode) command({ action: 'mode', mode: b.dataset.m }, `Modo ${b.textContent.toLowerCase()}`); };
$('#to-bypass').onclick = () => confirm('¿Transferir la carga a la red (bypass)? La carga quedará sin protección de la UPS.') && command({ action: 'transfer', to: 'bypass' }, 'Carga transferida a bypass');
$('#to-ups').onclick = () => command({ action: 'transfer', to: 'ups' }, 'Carga de regreso en la UPS');
$('#reset').onclick = () => confirm('¿Ya revisaste la causa del bloqueo?') && command({ action: 'reset' }, 'Bloqueo restablecido');

$('#sim').onclick = async (e) => {
  const b = e.target.closest('[data-sim]'); if (!b || !st) return;
  const [what, v] = b.dataset.sim.split(':');
  const gpio = what === 'ups' ? st.config.pins.senseUpsOut : st.config.pins.senseGrid;
  if (gpio == null) return toast('Ese sensor no está configurado', true);
  try { await api(`/api/gpio/${gpio}/simulate`, { method: 'POST', body: { active: v === '1' } }); }
  catch (err) { toast(err.message, true); }
};

async function loadEvents() {
  const ev = await api('/api/events?prefix=BYPASS&limit=100');
  $('#events').innerHTML = ev.length ? ev.map(eventItem).join('') : '<li class="empty">Aún no hay transferencias registradas.</li>';
}

startClock();
render(await api('/api/bypass'));
gpioInfo = await api('/api/gpio');
$('#sim').hidden = !(gpioInfo.simulated && st.enabled);
await loadEvents();
connectWS({
  bypass: render,
  event: (e) => { if (e.code.startsWith('BYPASS')) { $('#events .empty')?.remove(); $('#events').insertAdjacentHTML('afterbegin', eventItem(e)); } },
});

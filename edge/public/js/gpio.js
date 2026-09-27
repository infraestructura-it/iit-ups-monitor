import { $, $$, api, connectWS, startClock, toast, esc } from './lib.js';

let data = null, selected = null;
const POWER_CLASS = { '5V': 'pwr5', '3V3': 'pwr3', GND: 'gnd', ID_SD: 'id', ID_SC: 'id' };
const MODE_TXT = { output: 'Salida', input: 'Entrada', free: 'Libre', reserved: 'Reservado' };

function pinClass(p) {
  if (p.owner === 'bypass') return `bypass${p.active ? ' on' : ''}`;
  if (p.mode === 'output' || p.mode === 'input') return `${p.mode}${p.active ? ' on' : ''}`;
  return p.mode;
}

function renderHeader() {
  const byPin = new Map(data.pins.map((p) => [p.pin, p]));
  let html = '';
  for (let row = 0; row < 20; row++) {
    const L = row * 2 + 1, R = L + 1;
    const cell = (n, side) => {
      const p = byPin.get(n);
      if (!p) {
        const k = data.power[n];
        return { label: `<span class="plabel ${side}">${k}</span>`, btn: `<button class="pinbtn ${POWER_CLASS[k] || 'gnd'}" disabled title="Pin ${n}: ${k}">${n}</button>` };
      }
      const name = p.name ? esc(p.name) : `GPIO${p.gpio}`;
      return {
        label: `<span class="plabel ${side} ${p.name ? 'named' : ''}" title="${esc(p.alt)}">${side === 'l' ? `${name} <span class="muted">${p.gpio}</span>` : `<span class="muted">${p.gpio}</span> ${name}`}</span>`,
        btn: `<button class="pinbtn ${pinClass(p)}" data-g="${p.gpio}" aria-pressed="${selected === p.gpio}" title="Pin ${n} GPIO${p.gpio} ${MODE_TXT[p.mode]}">${n}</button>`,
      };
    };
    const a = cell(L, 'l'), b = cell(R, 'r');
    html += a.label + a.btn + b.btn + b.label;
  }
  $('#header40').innerHTML = html;
}

function renderSummary() {
  const s = data.summary;
  $('#summary').textContent = `${s.total} GPIO: ${s.outputs} salidas, ${s.inputs} entradas, ${s.free} libres${s.reserved ? `, ${s.reserved} reservados` : ''}`;
  const b = $('#backend');
  b.textContent = data.simulated ? 'Simulación: sin hardware' : `Hardware real (${data.backend})`;
  b.className = `badge${data.simulated ? ' sim' : ''}`;
}

function renderUsed() {
  const used = data.pins.filter((p) => p.mode === 'output' || p.mode === 'input');
  $('#used').innerHTML = used.length ? used.map((p) => `<tr data-g="${p.gpio}">
    <td class="mono">GPIO${p.gpio}</td><td class="mono">${p.pin}</td><td>${esc(p.name)}</td><td>${MODE_TXT[p.mode]}</td>
    <td>${p.active ? '<span style="color:var(--ok)">Activo</span>' : '<span class="muted">Inactivo</span>'}</td>
    <td>${p.owner === 'bypass' ? 'Bypass' : 'Usuario'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Ningún pin configurado. Elige uno en el conector.</td></tr>';
}

function renderEditor() {
  const p = data.pins.find((x) => x.gpio === selected);
  const ed = $('#editor');
  if (!p) { ed.innerHTML = '<p class="muted">Toca un pin del conector para configurarlo como salida o entrada.</p>'; return; }
  const head = `<div class="row" style="justify-content:space-between"><h3>GPIO${p.gpio} <span class="muted" style="font-size:.9rem">pin físico ${p.pin}</span></h3>
    ${p.alt ? `<span class="badge">${esc(p.alt)}</span>` : ''}</div>`;
  if (p.owner === 'bypass' || p.mode === 'reserved') {
    ed.innerHTML = head + `<p>${p.owner === 'bypass' ? `Controlado por el bypass como <b>${esc(p.name)}</b>. Se configura en <code>config/local.json</code> para evitar cambios accidentales.` : 'Reservado por el sistema.'}</p>
      ${p.mode === 'input' || p.mode === 'output' ? `<div class="io-state"><b>${p.active ? 'Activo' : 'Inactivo'}</b><span class="muted">nivel físico ${p.level}</span></div>` : ''}`;
    return;
  }
  const isOut = p.mode === 'output', isIn = p.mode === 'input';
  ed.innerHTML = head + `
    ${isOut ? `<div class="io-state"><button class="switch" id="sw" role="switch" aria-checked="${!!p.active}" aria-label="Activar salida"></button>
      <div><b>${p.active ? 'Activa' : 'Inactiva'}</b><div class="muted" style="font-size:.8rem">nivel físico ${p.level} (${p.activeLow ? 'activo en bajo' : 'activo en alto'})</div></div></div>` : ''}
    ${isIn ? `<div class="io-state"><b style="color:${p.active ? 'var(--ok)' : 'var(--muted)'}">${p.active ? 'Activa' : 'Inactiva'}</b><span class="muted">nivel físico ${p.level}</span>
      ${data.simulated ? '<button class="btn ghost" id="simin" style="margin:0 0 0 auto">Simular cambio</button>' : ''}</div>` : ''}
    <div class="grid2">
      <label class="field">Nombre<input id="f-name" value="${esc(p.name || '')}" placeholder="Ej.: Ventilador rack"></label>
      <label class="field">Modo<select id="f-mode">
        <option value="free" ${p.mode === 'free' ? 'selected' : ''}>Libre</option>
        <option value="output" ${isOut ? 'selected' : ''}>Salida</option>
        <option value="input" ${isIn ? 'selected' : ''}>Entrada</option></select></label>
      <label class="field">Resistencia (entradas)<select id="f-pull">
        ${['none', 'up', 'down'].map((v) => `<option value="${v}" ${p.pull === v ? 'selected' : ''}>${{ none: 'Sin pull', up: 'Pull-up', down: 'Pull-down' }[v]}</option>`).join('')}</select></label>
      <div style="display:grid;gap:8px;align-content:end">
        <label class="check"><input type="checkbox" id="f-al" ${p.activeLow ? 'checked' : ''}> Activo en bajo</label>
        <label class="check"><input type="checkbox" id="f-persist" ${p.persist ? 'checked' : ''}> Recordar estado al reiniciar</label>
      </div>
    </div>
    <p class="muted" style="font-size:.82rem">La mayoría de módulos de relé chinos se activan en bajo. Las entradas de optoacoplador con pull-up también.</p>
    <div class="row"><button class="btn primary" id="save">Guardar pin</button></div>`;

  $('#save').onclick = async () => {
    try {
      await api(`/api/gpio/${p.gpio}`, { method: 'PUT', body: {
        mode: $('#f-mode').value, name: $('#f-name').value.trim() || `GPIO${p.gpio}`,
        pull: $('#f-pull').value, activeLow: $('#f-al').checked, persist: $('#f-persist').checked } });
      toast(`GPIO${p.gpio} guardado`); await load();
    } catch (e) { toast(e.message, true); }
  };
  $('#sw')?.addEventListener('click', async () => {
    try { await api(`/api/gpio/${p.gpio}/set`, { method: 'POST', body: { active: !p.active } }); }
    catch (e) { toast(e.message, true); }
  });
  $('#simin')?.addEventListener('click', async () => {
    try { await api(`/api/gpio/${p.gpio}/simulate`, { method: 'POST', body: { active: !p.active } }); }
    catch (e) { toast(e.message, true); }
  });
}

function renderAll() { renderSummary(); renderHeader(); renderUsed(); renderEditor(); }

async function load() { data = await api('/api/gpio'); renderAll(); }

$('#header40').onclick = (e) => { const b = e.target.closest('[data-g]'); if (!b) return; selected = +b.dataset.g; renderHeader(); renderEditor(); };
$('#used').onclick = (e) => { const r = e.target.closest('[data-g]'); if (!r) return; selected = +r.dataset.g; renderHeader(); renderEditor(); };

startClock();
await load();
connectWS({
  gpio: (p) => {
    const i = data.pins.findIndex((x) => x.gpio === p.gpio);
    if (i >= 0) data.pins[i] = p;
    const count = (m) => data.pins.filter((x) => x.mode === m).length;
    Object.assign(data.summary, { free: count('free'), outputs: count('output'), inputs: count('input') });
    renderSummary(); renderHeader(); renderUsed();
    if (p.gpio === selected && !document.activeElement?.closest('#editor input, #editor select')) renderEditor();
  },
});

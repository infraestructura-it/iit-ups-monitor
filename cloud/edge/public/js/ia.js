import { $, api, connectWS, startClock, toast, esc } from './lib.js';
import { ready } from './auth.js';
await ready;


const STORE = 'iit-ups-chat';
let history = JSON.parse(sessionStorage.getItem(STORE) || '[]');
let busy = false, available = false;

const SUGGESTIONS = [
  'Haz un diagnóstico de la UPS en las últimas 24 horas',
  '¿Cuántos cortes de energía hubo esta semana y cuánto duraron?',
  '¿Cómo está la batería y cuánta autonomía tengo con la carga actual?',
  '¿El voltaje de entrada ha estado dentro de rango?',
  '¿Qué mantenimiento recomiendas según los datos?',
  '¿Cuál es el estado del bypass y de los GPIO?',
];

// Markdown mínimo y seguro: negrita, código, listas y párrafos
function md(text) {
  const blocks = esc(text).split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');

function render() {
  const log = $('#log');
  if (!history.length) {
    log.innerHTML = `<div class="empty-chat"><p>Pregunta lo que necesites saber de la instalación. El asistente consulta los datos reales de la UPS, el historial, los eventos, el bypass y los GPIO antes de responder.</p>
      <div class="chips">${SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('')}</div></div>`;
    return;
  }
  log.innerHTML = history.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
    const actions = (m.actions || []).map((a) => `<div class="action-card" data-id="${a.id}">
      <div>La IA propone <b>${a.activar ? 'activar' : 'desactivar'} ${esc(a.name)}</b> (GPIO${a.gpio}). ${esc(a.motivo)}</div>
      ${a.done ? `<span class="muted">${a.done}</span>` : `<div class="row"><button class="btn primary" data-ok="1">Confirmar</button><button class="btn ghost" data-ok="0" style="margin:0">Descartar</button></div>`}
    </div>`).join('');
    const meta = m.tools?.length ? `<div class="meta">consultó: ${m.tools.map(esc).join(', ')}</div>` : '';
    return `<div class="msg bot ${m.error ? 'err' : ''}">${md(m.content)}${meta}</div>${actions}`;
  }).join('') + (busy ? '<div class="thinking">Consultando datos de la instalación</div>' : '');
  log.scrollTop = log.scrollHeight;
}

const save = () => sessionStorage.setItem(STORE, JSON.stringify(history));

async function ask(text) {
  if (busy || !text.trim()) return;
  if (!available) return toast('Configura ANTHROPIC_API_KEY en la Raspberry para usar el asistente', true);
  history.push({ role: 'user', content: text.trim() });
  busy = true; render(); $('#send').disabled = true;
  try {
    const r = await api('/api/ai/chat', { method: 'POST', body: { messages: history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })) } });
    history.push({ role: 'assistant', content: r.reply || '(sin respuesta)', tools: [...new Set(r.tools)], actions: r.actions });
  } catch (e) {
    history.push({ role: 'assistant', content: `No se pudo consultar: ${e.message}`, error: true });
  } finally { busy = false; $('#send').disabled = !available; save(); render(); }
}

$('#form').onsubmit = (e) => { e.preventDefault(); const q = $('#q'); ask(q.value); q.value = ''; q.style.height = ''; };
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#q').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; });
$('#clear').onclick = () => { history = []; save(); render(); };
$('#log').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chips button'); if (chip) return ask(chip.textContent);
  const b = e.target.closest('[data-ok]'); if (!b) return;
  const card = b.closest('.action-card'), id = card.dataset.id, approve = b.dataset.ok === '1';
  try {
    await api('/api/ai/confirm', { method: 'POST', body: { id, approve } });
    for (const m of history) for (const a of m.actions || []) if (a.id === id) a.done = approve ? 'Confirmada y ejecutada' : 'Descartada';
    save(); render(); toast(approve ? 'Acción ejecutada' : 'Acción descartada');
  } catch (err) { toast(err.message, true); }
});

startClock();
const info = await api('/api/ai');
$('#ai-status').innerHTML = info.available
  ? `Modelo <b class="mono">${esc(info.model)}</b>. Puede leer todos los datos; las acciones sobre GPIO requieren tu confirmación y el bypass es solo lectura.`
  : 'Falta configurar <code>ANTHROPIC_API_KEY</code> en el <code>.env</code> de la Raspberry. Obtén la clave en console.anthropic.com.';
available = info.available;
$('#send').disabled = !available;
render();
connectWS({});

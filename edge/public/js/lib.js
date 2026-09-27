// Utilidades compartidas por las páginas de módulos
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtTime = (ts) => new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const KEY = 'iit-ups-key';
export const getKey = () => localStorage.getItem(KEY) || '';

// fetch JSON; si la acción exige clave y falla, la pide una vez y reintenta
export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') headers['x-api-key'] = getKey();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && retry) {
    const k = prompt('Clave de comandos (API_COMMAND_KEY)');
    if (k) { localStorage.setItem(KEY, k); return api(path, { method, body, retry: false }); }
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function connectWS(handlers) {
  const link = $('#link');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { if (link) { link.dataset.state = 'ok'; link.querySelector('span').textContent = 'En línea'; } };
  ws.onmessage = (m) => { const { type, data } = JSON.parse(m.data); handlers[type]?.(data); };
  ws.onclose = () => {
    if (link) { link.dataset.state = 'bad'; link.querySelector('span').textContent = 'Reconectando con la Raspberry'; }
    setTimeout(() => connectWS(handlers), 3000);
  };
}

export function startClock() {
  const c = $('#clock');
  if (c) setInterval(() => (c.textContent = new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'medium' })), 1000);
}

export function toast(msg, bad = false) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.className = bad ? 'show bad' : 'show';
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = ''), 3500);
}

export function eventItem(e) {
  return `<li class="${e.severity} ${e.state}"><span>${esc(e.message)}</span><time>${fmtTime(e.ts)}</time></li>`;
}

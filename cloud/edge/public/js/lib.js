// Utilidades compartidas por las páginas de módulos
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtTime = (ts) => new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// fetch JSON con la sesión del navegador (cookie). 401 = iniciar sesión; 403 con mustChange = cambiar contraseña
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    location.replace(`login.html?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);
    return new Promise(() => {});
  }
  if (res.status === 403 && data.mustChange) { location.replace('seguridad.html#cuenta'); return new Promise(() => {}); }
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

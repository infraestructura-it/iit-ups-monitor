import { ready } from './auth.js';
import { $, api, startClock, toast, esc } from './lib.js';
const me0 = await ready;

const ACTIONS = {
  'login.ok': 'Inicio de sesión', 'login.fail': 'Intento fallido', 'login.locked': 'Bloqueo por intentos', logout: 'Cierre de sesión',
  'user.create': 'Usuario creado', 'user.update': 'Usuario modificado', 'user.delete': 'Usuario eliminado', 'user.password': 'Cambio de contraseña',
  'settings.update': 'Políticas modificadas', 'token.create': 'Token creado', 'token.revoke': 'Token revocado', 'setup.fail': 'Instalación: código incorrecto',
  'report.export': 'Reporte Excel', 'ai.chat': 'Consulta IA', 'ai_action': 'Acción IA confirmada', command: 'Comando UPS',
  gpio_set: 'GPIO accionado', gpio_config: 'GPIO configurado',
  'bypass.mode': 'Bypass: cambio de modo', 'bypass.transfer': 'Bypass: transferencia manual', 'bypass.reset': 'Bypass: bloqueo restablecido',
};
const when = (ts) => (ts ? new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
let data = null;

function roleOptions(sel, current) {
  sel.innerHTML = Object.entries(data.roles).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${v}</option>`).join('');
}

function render() {
  const m = data.me || {};
  $('#me').innerHTML = `<dt>Usuario</dt><dd>${esc(m.username)}</dd><dt>Nombre</dt><dd>${esc(m.name)}</dd><dt>Rol</dt><dd>${esc(data.roles[m.role] || m.role)}</dd><dt>Tu IP</dt><dd>${esc(data.ip)}</dd><dt>Conexión</dt><dd>${data.secure ? 'HTTPS' : 'HTTP sin cifrar'}</dd>`;
  $('#pw-user').value = m.username || '';
  $('#must').hidden = !me0?.mustChange;
  if (!data.admin) return;

  // Revisión
  const checks = data.review, okN = checks.filter((c) => c.ok && c.level !== 'info').length, total = checks.filter((c) => c.level !== 'info').length;
  const pct = okN / total, color = pct >= 0.85 ? 'var(--ok)' : pct >= 0.6 ? 'var(--warn)' : 'var(--crit)';
  const C = 2 * Math.PI * 52;
  $('#score').innerHTML = `<svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="var(--line)" stroke-width="10"/>
    <circle cx="60" cy="60" r="52" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C * pct} ${C}"/></svg><b>${okN}/${total}</b>`;
  $('#checks').innerHTML = checks.map((c) => `<li class="${c.ok ? (c.level === 'info' ? 'info' : '') : c.level || 'warn'}"><span>${esc(c.text)}${!c.ok && c.fix ? `<small>${esc(c.fix)}</small>` : ''}</span></li>`).join('');

  // Políticas
  const s = data.settings;
  $('#p-login').checked = s.requireLoginForRead; $('#p-hours').value = s.sessionHours; $('#p-att').value = s.maxLoginAttempts;
  $('#p-lock').value = s.lockMinutes; $('#p-nets').value = s.allowedNetworks.join('\n'); $('#p-scope').value = s.networkScope;
  $('#p-ai').checked = s.aiEnabled; roleOptions($('#p-airole'), s.aiMinRole); $('#p-aimax').value = s.aiMaxRequestsPerHour;
  $('#p-ip').textContent = `Tu IP actual es ${data.ip}. El sistema no te deja guardar una lista de redes que te bloquee.`;

  // Usuarios
  $('#users').innerHTML = data.users.map((u) => `<tr data-id="${u.id}">
    <td class="mono">${esc(u.username)}${u.must_change ? ' <span class="badge sim">temporal</span>' : ''}</td><td>${esc(u.name)}</td>
    <td><select data-act="role">${Object.entries(data.roles).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-act="active" ${u.active ? 'checked' : ''} aria-label="Activo"></td>
    <td class="mono">${when(u.last_login)}</td>
    <td class="row" style="gap:6px"><button class="mini" data-act="reset">Restablecer clave</button><button class="mini bad" data-act="del">Eliminar</button></td></tr>`).join('');
  roleOptions($('#nu-role'), 'viewer');

  // Tokens
  $('#tokens').innerHTML = data.tokens.length ? data.tokens.map((t) => `<tr data-id="${t.id}"><td>${esc(t.name)}</td><td>${data.roles[t.role]}</td>
    <td class="mono">${when(t.created)}</td><td class="mono">${when(t.last_used)}</td><td>${t.revoked ? '<span class="muted">Revocado</span>' : 'Activo'}</td>
    <td>${t.revoked ? '' : '<button class="mini bad" data-act="revoke">Revocar</button>'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Sin tokens.</td></tr>';
  roleOptions($('#nt-role'), 'viewer');
}

async function load() { data = await api('/api/security'); render(); if (data.admin) loadAudit(); }

async function loadAudit() {
  const rows = await api(`/api/security/audit?limit=300&action=${$('#aud-f').value}`);
  $('#audit').innerHTML = rows.length ? rows.map((a) => `<tr><td class="mono">${when(a.ts)}</td><td>${esc(a.actor)}</td><td class="mono">${esc(a.ip)}</td>
    <td>${esc(ACTIONS[a.action] || a.action)}</td><td class="muted">${esc(a.detail)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin registros.</td></tr>';
}
$('#aud-f').onchange = loadAudit;

const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message, true); await load().catch(() => {}); } };

$('#pw').onsubmit = (e) => {
  e.preventDefault();
  if ($('#pw-new').value !== $('#pw-new2').value) return toast('Las contraseñas nuevas no coinciden', true);
  act(async () => {
    await api('/api/auth/password', { method: 'POST', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
    toast('Contraseña cambiada. Inicia sesión de nuevo.');
    setTimeout(() => location.replace('login.html'), 1200);
  });
};

$('#pol').onsubmit = (e) => {
  e.preventDefault();
  act(() => api('/api/security/settings', { method: 'PUT', body: {
    requireLoginForRead: $('#p-login').checked, sessionHours: $('#p-hours').value, maxLoginAttempts: $('#p-att').value,
    lockMinutes: $('#p-lock').value, allowedNetworks: $('#p-nets').value, networkScope: $('#p-scope').value,
    aiEnabled: $('#p-ai').checked, aiMinRole: $('#p-airole').value, aiMaxRequestsPerHour: $('#p-aimax').value,
  } }), 'Políticas guardadas');
};

$('#users').addEventListener('change', (e) => {
  const id = e.target.closest('tr').dataset.id, a = e.target.dataset.act;
  if (a === 'role') act(() => api(`/api/security/users/${id}`, { method: 'PUT', body: { role: e.target.value } }), 'Rol actualizado');
  if (a === 'active') act(() => api(`/api/security/users/${id}`, { method: 'PUT', body: { active: e.target.checked } }), e.target.checked ? 'Usuario activado' : 'Usuario desactivado: se cerraron sus sesiones');
});
$('#users').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const tr = b.closest('tr'), id = tr.dataset.id, user = tr.querySelector('td').textContent.trim().split(' ')[0];
  if (b.dataset.act === 'del' && confirm(`¿Eliminar el usuario ${user}?`)) act(() => api(`/api/security/users/${id}`, { method: 'DELETE' }), 'Usuario eliminado');
  if (b.dataset.act === 'reset') {
    const p = prompt(`Contraseña temporal para ${user} (mín. 10 caracteres, letras y números). Deberá cambiarla al entrar:`);
    if (p) act(() => api(`/api/security/users/${id}`, { method: 'PUT', body: { password: p } }), 'Contraseña restablecida');
  }
});
$('#nu').onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    await api('/api/security/users', { method: 'POST', body: { username: $('#nu-user').value, name: $('#nu-name').value, role: $('#nu-role').value, password: $('#nu-pass').value } });
    $('#nu').reset();
  }, 'Usuario creado');
};

$('#nt').onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    const t = await api('/api/security/tokens', { method: 'POST', body: { name: $('#nt-name').value, role: $('#nt-role').value } });
    const box = $('#tok-new');
    box.hidden = false;
    box.innerHTML = `<b>Token "${esc(t.name)}" creado.</b> Cópialo ahora; no se volverá a mostrar.<code>${esc(t.token)}</code><div><button type="button" class="mini" id="copy">Copiar</button></div>`;
    $('#copy').onclick = () => navigator.clipboard.writeText(t.token).then(() => toast('Token copiado'));
    $('#nt').reset();
  });
};
$('#tokens').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="revoke"]'); if (!b) return;
  if (confirm('¿Revocar este token? Las integraciones que lo usan dejarán de funcionar.')) act(() => api(`/api/security/tokens/${b.closest('tr').dataset.id}`, { method: 'DELETE' }), 'Token revocado');
});

startClock();
await load();
if (location.hash === '#cuenta') $('#pw-cur').focus();

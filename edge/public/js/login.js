const $ = (s) => document.querySelector(s);
const next = new URLSearchParams(location.search).get('next') || 'index.html';
const safeNext = /^[a-z]+\.html(\?.*)?$/.test(next) ? next : 'index.html';

const st = await fetch('/api/auth/status').then((r) => r.json());
$('#device').textContent = `${st.device.name}, ${st.device.site}`;
if (st.user && !st.setupRequired) location.replace(safeNext);

const setup = st.setupRequired;
if (setup) {
  $('#title').textContent = 'Configuración inicial';
  $('#setup-info').hidden = false;
  document.querySelectorAll('.setup').forEach((e) => (e.hidden = false));
  $('#pass').autocomplete = 'new-password';
  $('#go').textContent = 'Crear administrador';
  $('#token').focus();
} else $('#user').focus();

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  $('#err').textContent = '';
  $('#go').disabled = true;
  const username = $('#user').value.trim(), password = $('#pass').value;
  try {
    if (setup) {
      if (password !== $('#pass2').value) throw new Error('Las contraseñas no coinciden');
      await post('/api/auth/setup', { token: $('#token').value.trim(), username, name: $('#name').value.trim() || username, password });
    }
    await post('/api/auth/login', { username, password });
    location.replace(safeNext);
  } catch (err) {
    $('#err').textContent = err.message;
    $('#go').disabled = false;
  }
};

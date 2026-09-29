// Control de acceso del lado del navegador: se importa primero en cada página.
// El servidor es quien realmente protege los datos; esto solo guía al usuario.
const page = location.pathname.split('/').pop() || 'index.html';

async function check() {
  const st = await fetch('/api/auth/status').then((r) => r.json());
  if (st.setupRequired || (!st.user && st.requireLoginForRead)) {
    location.replace(`login.html?next=${encodeURIComponent(page + location.search)}`);
    return new Promise(() => {}); // detiene la página mientras redirige
  }
  if (st.user?.mustChange && page !== 'seguridad.html') { location.replace('seguridad.html#cuenta'); return new Promise(() => {}); }
  document.body.dataset.role = st.user?.role || 'anon';
  const right = document.querySelector('.top-right');
  if (right) {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.innerHTML = st.user
      ? `<span title="${st.user.roleText}">${st.user.name.replace(/[<>&"]/g, '')}</span><button type="button" id="logout">Salir</button>`
      : '<a href="login.html">Iniciar sesión</a>';
    right.prepend(chip);
    chip.querySelector('#logout')?.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      location.replace('login.html');
    });
  }
  return st.user;
}

export const ready = check();
export const can = (user, min) => ({ anon: 0, viewer: 1, operator: 2, admin: 3 }[user?.role || 'anon'] >= { viewer: 1, operator: 2, admin: 3 }[min]);

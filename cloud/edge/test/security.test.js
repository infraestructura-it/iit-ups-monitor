import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Security } from '../src/security/security.js';
import { hashPassword, verifyPassword } from '../src/security/crypto.js';
import { ipAllowed } from '../src/security/cidr.js';

const mk = () => new Security(new DatabaseSync(':memory:'));

test('hash de contraseñas scrypt', () => {
  const h = hashPassword('Clave12345');
  assert.ok(verifyPassword('Clave12345', h));
  assert.ok(!verifyPassword('otra123456', h));
});

test('configuración inicial solo con el código y una sola vez', () => {
  const s = mk();
  assert.throws(() => s.setup({ token: 'malo', username: 'admin', password: 'Clave12345' }), /incorrecto/);
  s.setup({ token: s.setupToken, username: 'admin', password: 'Clave12345' });
  assert.equal(s.users()[0].role, 'admin');
  assert.throws(() => s.setup({ token: 'x', username: 'otro', password: 'Clave12345' }), /ya se completó/);
});

test('login, sesión por cookie y permisos por rol', () => {
  const s = mk();
  s.setup({ token: s.setupToken, username: 'admin', password: 'Clave12345' });
  s.createUser({ username: 'ana', role: 'viewer', password: 'Lectura123', mustChange: false }, 'admin');
  const { token } = s.login('ana', 'Lectura123', '192.168.1.10');
  const u = s.identify({ cookieHeader: `otra=1; iit_sid=${token}` });
  assert.equal(u.username, 'ana');
  assert.ok(Security.can(u, 'read'));
  assert.ok(Security.can(u, 'report.export'));
  assert.ok(!Security.can(u, 'gpio.set'));
  assert.ok(!Security.can(u, 'security.admin'));
  s.logout(token);
  assert.equal(s.identify({ cookieHeader: `iit_sid=${token}` }), null);
});

test('bloqueo tras intentos fallidos', () => {
  const s = mk();
  s.setup({ token: s.setupToken, username: 'admin', password: 'Clave12345' });
  for (let i = 0; i < 5; i++) assert.throws(() => s.login('admin', 'mala', '10.0.0.5'), /incorrectos/);
  assert.throws(() => s.login('admin', 'Clave12345', '10.0.0.5'), /Demasiados intentos/);
  assert.ok(s.login('admin', 'Clave12345', '10.0.0.6').token); // otra IP no queda bloqueada
  assert.ok(s.auditList().some((a) => a.action === 'login.locked'));
});

test('siempre queda un administrador', () => {
  const s = mk();
  s.setup({ token: s.setupToken, username: 'admin', password: 'Clave12345' });
  const id = s.users()[0].id;
  assert.throws(() => s.updateUser(id, { role: 'viewer' }, 'x'), /al menos un administrador/);
  assert.throws(() => s.deleteUser(id, 'x'), /último administrador/);
});

test('tokens de API: se muestran una vez, se revocan', () => {
  const s = mk();
  const { token } = s.createToken({ name: 'Home Assistant', role: 'operator' }, 'admin');
  assert.equal(s.identify({ apiKey: token }).role, 'operator');
  s.revokeToken(s.tokens()[0].id, 'admin');
  assert.equal(s.identify({ apiKey: token }), null);
});

test('redes permitidas (CIDR) y protección contra auto-bloqueo', () => {
  assert.ok(ipAllowed('192.168.1.77', ['192.168.1.0/24']));
  assert.ok(ipAllowed('::ffff:10.147.19.4', ['10.147.19.0/24']));
  assert.ok(!ipAllowed('192.168.2.1', ['192.168.1.0/24']));
  assert.ok(ipAllowed('127.0.0.1', ['192.168.1.0/24']));
  const s = mk();
  assert.throws(() => s.saveSettings({ allowedNetworks: '192.168.5.0/24' }, 'admin', '192.168.1.20'), /quedaría bloqueada/);
  assert.deepEqual(s.saveSettings({ allowedNetworks: '192.168.1.0/24 10.147.19.0/24' }, 'admin', '192.168.1.20').allowedNetworks, ['192.168.1.0/24', '10.147.19.0/24']);
  assert.throws(() => s.saveSettings({ allowedNetworks: '300.1.1.1/24' }, 'admin', '192.168.1.20'), /inválida/);
});

test('contraseñas débiles rechazadas', () => {
  const s = mk();
  assert.throws(() => s.createUser({ username: 'luis', role: 'viewer', password: 'corta1' }, 'a'), /10 caracteres/);
  assert.throws(() => s.createUser({ username: 'luis', role: 'viewer', password: 'soloLetrasLargas' }, 'a'), /letras y números/);
});

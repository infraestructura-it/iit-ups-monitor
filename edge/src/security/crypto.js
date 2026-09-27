// Contraseñas con scrypt (node:crypto, sin dependencias nativas) y tokens aleatorios
import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1, LEN = 64;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [alg, n, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: R, p: P });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'La contraseña debe combinar letras y números';
  return null;
}

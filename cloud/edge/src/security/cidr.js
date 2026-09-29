// Verificación de IPv4 contra listas CIDR (ej.: 192.168.1.0/24, 10.147.19.0/24)
export function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

const toInt = (ip) => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};

export function parseCidr(c) {
  const [ip, bitsTxt] = String(c).trim().split('/');
  const base = toInt(ip);
  const bits = bitsTxt === undefined ? 32 : Number(bitsTxt);
  if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, text: `${ip}/${bits}` };
}

export function ipAllowed(ip, cidrs) {
  if (!cidrs?.length) return true;
  const n = toInt(normalizeIp(ip));
  if (n == null) return false; // IPv6 real: no permitido si hay lista
  if (normalizeIp(ip) === '127.0.0.1') return true; // la propia Pi y Cloudflare Tunnel local
  return cidrs.some((c) => { const p = parseCidr(c); return p && ((n & p.mask) >>> 0) === p.base; });
}

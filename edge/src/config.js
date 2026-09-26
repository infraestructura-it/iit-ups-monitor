// Carga de configuración: default.json <- local.json <- .env <- variables de entorno
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] || {}, v) : v;
  }
  return out;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const bool = (v) => (v === undefined || v === '' ? undefined : /^(1|true|yes|si)$/i.test(v));

function set(obj, keys, value) {
  if (value === undefined || Number.isNaN(value)) return;
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[keys.at(-1)] = value;
}

export function loadConfig() {
  loadDotEnv(path.join(ROOT, '.env'));
  let cfg = deepMerge(readJson(path.join(ROOT, 'config/default.json')), readJson(path.join(ROOT, 'config/local.json')));
  const e = process.env;
  set(cfg, ['device', 'id'], e.DEVICE_ID || undefined);
  set(cfg, ['device', 'name'], e.DEVICE_NAME || undefined);
  set(cfg, ['device', 'site'], e.DEVICE_SITE || undefined);
  set(cfg, ['driver', 'type'], e.UPS_DRIVER || undefined);
  set(cfg, ['driver', 'pollIntervalMs'], num(e.POLL_MS));
  set(cfg, ['driver', 'megatec', 'path'], e.UPS_PORT || undefined);
  set(cfg, ['driver', 'megatec', 'baudRate'], num(e.UPS_BAUD));
  set(cfg, ['driver', 'nut', 'host'], e.NUT_HOST || undefined);
  set(cfg, ['driver', 'nut', 'ups'], e.NUT_UPS || undefined);
  set(cfg, ['driver', 'nut', 'username'], e.NUT_USER || undefined);
  set(cfg, ['driver', 'nut', 'password'], e.NUT_PASSWORD || undefined);
  set(cfg, ['driver', 'nameplate', 'ratedVA'], num(e.UPS_RATED_VA));
  set(cfg, ['driver', 'nameplate', 'powerFactor'], num(e.UPS_POWER_FACTOR));
  set(cfg, ['driver', 'nameplate', 'batteryCells'], num(e.UPS_BATTERY_CELLS));
  set(cfg, ['api', 'port'], num(e.HTTP_PORT));
  set(cfg, ['api', 'commandKey'], e.API_COMMAND_KEY || undefined);
  set(cfg, ['cloud', 'enabled'], bool(e.CLOUD_ENABLED));
  set(cfg, ['cloud', 'url'], e.SUPABASE_URL || undefined);
  set(cfg, ['cloud', 'serviceKey'], e.SUPABASE_SERVICE_KEY || undefined);
  if (process.argv.includes('--sim')) cfg.driver.type = 'simulator';
  cfg.storage.path = path.resolve(ROOT, cfg.storage.path);
  cfg.root = ROOT;
  return cfg;
}

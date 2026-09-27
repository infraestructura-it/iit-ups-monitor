// Orquestador de la capa local (Raspberry Pi 5)
//   Capa 1 Adquisición  -> drivers/ (Megatec RS232 | NUT USB HID | simulador)
//   Capa 2 Núcleo       -> storage/ + alarms/
//   Capa 3 Servicio web -> api/ + public/ (dashboard local)
//   Capa 4 Nube         -> cloud/ (Supabase)
// Módulos: 1 UPS | 2 Bypass (bypass/) | 3 GPIO (gpio/) | 4 IA (ai/)
import { loadConfig } from './config.js';
import { createDriver } from './drivers/index.js';
import { Store } from './storage/store.js';
import { AlarmEngine } from './alarms/engine.js';
import { createServer } from './api/server.js';
import { CloudSync } from './cloud/supabase-sync.js';
import { GpioService } from './gpio/gpio-service.js';
import { BypassController } from './bypass/bypass-controller.js';
import { Assistant } from './ai/assistant.js';
import path from 'node:path';
import { log } from './util/log.js';

const cfg = loadConfig();
const store = new Store(cfg.storage);
const alarms = new AlarmEngine(cfg.alarms);
const driver = createDriver(cfg.driver);
const state = { latest: null, commOk: false, lastError: null, lastOk: Date.now(), cloud: null };

if (cfg.cloud.enabled) {
  if (!cfg.cloud.url || !cfg.cloud.serviceKey) log.warn('Nube habilitada pero falta SUPABASE_URL o SUPABASE_SERVICE_KEY');
  else state.cloud = new CloudSync(cfg.cloud, cfg.device, store);
}

const gpio = new GpioService(cfg.gpio, path.dirname(cfg.storage.path));
await gpio.init();
const bypass = new BypassController(cfg.bypass, gpio, () => ({ reading: state.latest, commOk: state.commOk }));
const assistant = new Assistant(cfg.ai, { cfg, state, store, alarms, driver, gpio, bypass });
const api = createServer({ cfg, store, driver, alarms, state, gpio, bypass, assistant });

gpio.on('change', (p) => api.broadcast('gpio', p));
bypass.on('state', (s) => api.broadcast('bypass', s));
bypass.on('event', (e) => emit([e]));
try { await bypass.init(); }
catch (e) { log.error('Bypass NO iniciado:', e.message); bypass.state = 'bloqueado'; bypass.lockReason = e.message; }

function emit(events) {
  for (const e of events) {
    store.saveEvent(e);
    api.broadcast('event', e);
    state.cloud?.onEvent(e);
    log[e.severity === 'crit' ? 'warn' : 'info'](`[${e.state}] ${e.code} ${e.message}`);
  }
  if (events.length) api.broadcast('alarms', alarms.list());
}

async function tick() {
  try {
    const r = await driver.read();
    if (!state.commOk) log.info(`Comunicación OK con la UPS (${driver.name})`);
    state.latest = r; state.commOk = true; state.lastError = null; state.lastOk = r.ts;
    store.saveReading(r);
    emit(alarms.evaluate(r));
    api.broadcast('reading', r);
    state.cloud?.onReading(r, driver.info);
  } catch (e) {
    if (state.commOk || !state.lastError) log.warn('Error leyendo la UPS:', e.message);
    state.commOk = false; state.lastError = e.message;
    api.broadcast('comm', { ok: false, error: e.message });
    emit(alarms.commFailure(state.lastOk, e.message));
    await driver.close().catch(() => {}); // fuerza reapertura del puerto en el próximo ciclo
  } finally {
    setTimeout(tick, cfg.driver.pollIntervalMs);
  }
}

await api.listen();
log.info(`IIT UPS Monitor | equipo ${cfg.device.id} | driver ${driver.name} | http://${cfg.api.host}:${cfg.api.port}`);
tick();

async function shutdown() {
  log.info('Deteniendo servicio…');
  bypass.stop();
  state.cloud?.stop();
  await state.cloud?.push().catch(() => {});
  await driver.close().catch(() => {});
  await api.close();
  await gpio.close().catch(() => {});
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

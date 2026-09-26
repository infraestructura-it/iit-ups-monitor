// Orquestador de la capa local (Raspberry Pi 5)
//   Capa 1 Adquisición  -> drivers/ (Megatec RS232 | NUT USB HID | simulador)
//   Capa 2 Núcleo       -> storage/ + alarms/
//   Capa 3 Servicio web -> api/ + public/ (dashboard local)
//   Capa 4 Nube         -> cloud/ (Supabase)
import { loadConfig } from './config.js';
import { createDriver } from './drivers/index.js';
import { Store } from './storage/store.js';
import { AlarmEngine } from './alarms/engine.js';
import { createServer } from './api/server.js';
import { CloudSync } from './cloud/supabase-sync.js';
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

const api = createServer({ cfg, store, driver, alarms, state });

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
  state.cloud?.stop();
  await state.cloud?.push().catch(() => {});
  await driver.close().catch(() => {});
  await api.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

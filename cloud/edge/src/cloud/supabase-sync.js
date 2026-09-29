// Capa nube: replica lecturas submuestreadas y eventos a Supabase (PostgREST).
// Usa una cola persistente (outbox en SQLite): si no hay internet, nada se pierde.
import { flatten } from '../storage/store.js';
import { log } from '../util/log.js';

export class CloudSync {
  constructor(cfg, device, store) {
    this.cfg = cfg;
    this.device = device;
    this.store = store;
    this.lastSample = 0;
    this.lastPushOk = null;
    this.lastError = null;
    this.latest = null;
    this.info = null;
    this.timer = setInterval(() => this.push().catch(() => {}), cfg.pushEverySec * 1000);
  }

  headers(extra = {}) {
    return {
      apikey: this.cfg.serviceKey, Authorization: `Bearer ${this.cfg.serviceKey}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal', ...extra,
    };
  }

  onReading(r, info) {
    this.latest = r; this.info = info;
    if (r.ts - this.lastSample < this.cfg.sampleEverySec * 1000) return;
    this.lastSample = r.ts;
    const { ts, ...m } = flatten(r);
    this.store.enqueue('reading', { device_id: this.device.id, ts: new Date(ts).toISOString(), ...m }, this.cfg.maxOutbox);
  }

  onEvent(e) {
    this.store.enqueue('event', {
      device_id: this.device.id, ts: new Date(e.ts).toISOString(), code: e.code,
      severity: e.severity, state: e.state, message: e.message, value: e.value,
    }, this.cfg.maxOutbox);
    this.push().catch(() => {}); // los eventos salen de inmediato
  }

  async post(table, body, prefer) {
    const res = await fetch(`${this.cfg.url}/rest/v1/${table}${prefer ? '?on_conflict=device_id' : ''}`, {
      method: 'POST', headers: this.headers(prefer ? { Prefer: prefer } : {}), body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
  }

  async push() {
    if (this.busy) return;
    this.busy = true;
    try {
      // 1. Latido del equipo (upsert) con el último estado completo
      await this.post('ups_devices', [{
        device_id: this.device.id, name: this.device.name, site: this.device.site,
        manufacturer: this.info?.manufacturer ?? null, model: this.info?.model ?? null,
        firmware: this.info?.firmware ?? null, driver: this.latest?.source ?? null,
        last_seen: new Date().toISOString(), latest: this.latest ? { ...this.latest, raw: undefined } : null,
      }], 'resolution=merge-duplicates,return=minimal');

      // 2. Vaciar la cola por lotes
      for (let guard = 0; guard < 20; guard++) {
        const batch = this.store.peekOutbox(500);
        if (!batch.length) break;
        const readings = batch.filter((b) => b.kind === 'reading').map((b) => JSON.parse(b.payload));
        const events = batch.filter((b) => b.kind === 'event').map((b) => JSON.parse(b.payload));
        if (readings.length) await this.post('ups_readings', readings);
        if (events.length) await this.post('ups_events', events);
        this.store.ackOutbox(batch.map((b) => b.id));
      }
      if (this.lastError) log.info('Nube: sincronización restablecida');
      this.lastPushOk = Date.now(); this.lastError = null;
    } catch (e) {
      if (!this.lastError) log.warn('Nube: no se pudo sincronizar, se reintentará —', e.message);
      this.lastError = e.message;
    } finally { this.busy = false; }
  }

  status() {
    return { enabled: true, lastPushOk: this.lastPushOk, lastError: this.lastError, pending: this.store.outboxSize() };
  }

  stop() { clearInterval(this.timer); }
}

// Ficha 7: panel de tomas (PDU) alimentado por la UPS.
// 15 tomas NEMA 5-15R (120 V / 15 A) y 2 NEMA L5-30R (120 V / 30 A, con seguro de giro).
//
// Cableado a prueba de fallas (igual filosofía que el bypass):
//   Cada toma se alimenta por el contacto NC de su relé. Relé ACTIVO = toma APAGADA.
//   Si la Raspberry se apaga o el servicio muere, los relés caen y TODAS las tomas quedan energizadas.
//
// Una toma sin GPIO asignado es virtual: se simula por completo (útil para diseñar y probar).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TYPES = {
  '5-15R': { ratingA: 15, label: 'NEMA 5-15R', continuousA: 12 },
  'L5-30R': { ratingA: 30, label: 'NEMA L5-30R', continuousA: 24 },
};
export const PRIORITIES = { critica: 'Crítica', normal: 'Normal', no_critica: 'No crítica' };

// Cargas simuladas por defecto: lo típico de un rack pequeño
const DEFAULT_SIM = [
  ['Servidor 1', 280, 'critica'], ['Servidor 2', 260, 'critica'], ['NAS', 90, 'critica'], ['Switch core', 60, 'critica'],
  ['Router / firewall', 35, 'critica'], ['Switch acceso', 45, 'normal'], ['Access point', 15, 'normal'], ['Monitor KVM', 30, 'no_critica'],
  ['Cámaras NVR', 55, 'normal'], ['Central telefónica', 40, 'normal'], ['Ventiladores rack', 70, 'no_critica'], ['Iluminación rack', 20, 'no_critica'],
  ['Cargador equipos', 60, 'no_critica'], ['Reserva', 0, 'normal'], ['Reserva', 0, 'normal'],
];

function defaults() {
  const outlets = DEFAULT_SIM.map(([name, simW, priority], i) => ({ id: `T${i + 1}`, type: '5-15R', name, simW, priority, gpio: null, on: true }));
  outlets.push({ id: 'L1', type: 'L5-30R', name: 'Enfriamiento en rack', simW: 380, priority: 'no_critica', gpio: null, on: true });
  outlets.push({ id: 'L2', type: 'L5-30R', name: 'Servidor de alta densidad', simW: 340, priority: 'critica', gpio: null, on: true });
  return outlets;
}

export const DEFAULT_POLICY = {
  shedEnabled: true,
  shedNonCriticalAfterSec: 30,  // en batería: apaga las "no críticas" tras este tiempo
  shedNormalBelowPct: 40,       // en batería: apaga las "normales" si la batería baja de este %
  restoreAfterSec: 60,          // red estable este tiempo: restaura lo que se desconectó
  cycleSec: 10,                 // reinicio remoto: tiempo apagada
  sequenceMs: 1500,             // encendido escalonado (evita picos de corriente de arranque)
};

export class OutletBank extends EventEmitter {
  constructor(cfg, gpio, getReading, dataDir) {
    super();
    this.cfg = cfg;                 // { relayActiveLow, tickMs, powerFactor }
    this.gpio = gpio;
    this.getReading = getReading;   // () => { reading, commOk }
    this.file = path.join(dataDir, 'outlets.json');
    this.batterySince = null;
    this.gridSince = null;
    this.busy = new Set();          // tomas en ciclo o secuencia
    this.meter = new Map();         // id -> { w, a }
  }

  async init() {
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.policy = { ...DEFAULT_POLICY, ...(saved.policy || {}) };
    const byId = new Map((saved.outlets || []).map((o) => [o.id, o]));
    this.outlets = defaults().map((d) => ({ ...d, ...(byId.get(d.id) || {}), shed: !!byId.get(d.id)?.shed }));
    for (const o of this.outlets) {
      if (o.gpio != null) {
        try { await this.#claim(o); } catch (e) { o.gpioError = e.message; o.gpio = null; }
      }
    }
    this.#measure();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.cfg.tickMs || 1000);
    this.timer.unref?.();
  }

  #save() {
    const outlets = this.outlets.map(({ id, name, simW, priority, gpio, on, shed }) => ({ id, name, simW, priority, gpio, on, shed }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ policy: this.policy, outlets }, null, 2));
  }

  async #claim(o) {
    await this.gpio.claim(o.gpio, { mode: 'output', activeLow: this.cfg.relayActiveLow, initial: !o.on, name: `Toma ${o.id}` }, 'tomas');
  }

  get(id) {
    const o = this.outlets.find((x) => x.id === id);
    if (!o) throw new Error(`La toma ${id} no existe`);
    return o;
  }

  // ---------- Conmutación ----------
  async #switch(o, on) {
    if (o.gpio != null) await this.gpio.set(o.gpio, !on, 'tomas'); // relé activo = toma apagada
    o.on = on;
    o.lastChange = Date.now();
    this.#measure();
  }

  async setOutlet(id, on, origin = 'operador') {
    const o = this.get(id);
    if (this.busy.has(id)) throw new Error(`La toma ${id} está en un reinicio en curso`);
    if (o.on === on) return this.#out(o);
    await this.#switch(o, on);
    o.shed = false; // una orden manual anula la desconexión automática
    this.#event(on ? 'OUTLET_ON' : 'OUTLET_OFF', 'info', `Toma ${o.id} (${o.name}) ${on ? 'encendida' : 'apagada'} [${origin}]`);
    this.#save(); this.#emit();
    return this.#out(o);
  }

  async cycle(id, origin = 'operador') {
    const o = this.get(id);
    if (this.busy.has(id)) throw new Error(`La toma ${id} ya se está reiniciando`);
    this.busy.add(id);
    this.#emit();
    try {
      this.#event('OUTLET_CYCLE', 'info', `Reinicio de la toma ${o.id} (${o.name}): ${this.policy.cycleSec} s apagada [${origin}]`);
      await this.#switch(o, false); this.#emit();
      await sleep(this.policy.cycleSec * 1000);
      await this.#switch(o, true);
      o.shed = false;
      this.#save();
    } finally { this.busy.delete(id); this.#emit(); }
    return this.#out(o);
  }

  async bulk(action, origin = 'operador') {
    if (action === 'allOn') {
      // Encendido escalonado: evita el pico de arranque de todas las fuentes a la vez
      for (const o of this.outlets.filter((x) => !x.on && !this.busy.has(x.id))) {
        await this.#switch(o, true); o.shed = false; this.#emit();
        await sleep(this.policy.sequenceMs);
      }
      this.#event('OUTLET_BULK', 'info', `Encendido escalonado de todas las tomas [${origin}]`);
    } else if (action === 'offNonCritical') {
      for (const o of this.outlets.filter((x) => x.on && x.priority === 'no_critica' && !this.busy.has(x.id))) await this.#switch(o, false);
      this.#event('OUTLET_BULK', 'info', `Tomas no críticas apagadas [${origin}]`);
    } else throw new Error('Acción inválida');
    this.#save(); this.#emit();
    return this.status();
  }

  // ---------- Configuración ----------
  async configure(id, patch) {
    const o = this.get(id);
    if ('name' in patch) o.name = String(patch.name).trim().slice(0, 40) || o.id;
    if ('priority' in patch) { if (!PRIORITIES[patch.priority]) throw new Error('Prioridad inválida'); o.priority = patch.priority; }
    if ('simW' in patch) {
      const w = Number(patch.simW);
      if (!Number.isFinite(w) || w < 0 || w > TYPES[o.type].ratingA * 120 * 1.2) throw new Error(`Carga simulada fuera de rango para ${TYPES[o.type].label}`);
      o.simW = Math.round(w);
    }
    if ('gpio' in patch) {
      const g = patch.gpio === null || patch.gpio === '' ? null : Number(patch.gpio);
      if (g !== o.gpio) {
        if (g != null) {
          const d = this.gpio.describe(g);
          if (d.mode !== 'free' && d.owner !== 'tomas') throw new Error(`GPIO${g} no está libre (${d.owner === 'bypass' ? 'lo usa el bypass' : d.mode})`);
          if (this.outlets.some((x) => x !== o && x.gpio === g)) throw new Error(`GPIO${g} ya está asignado a otra toma`);
        }
        if (o.gpio != null) await this.gpio.release(o.gpio, 'tomas');
        o.gpio = g; delete o.gpioError;
        if (g != null) await this.#claim(o);
      }
    }
    this.#save(); this.#emit();
    return this.#out(o);
  }

  setPolicy(patch) {
    const num = (k, lo, hi) => {
      if (!(k in patch)) return;
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} fuera de rango (${lo} a ${hi})`);
      this.policy[k] = v;
    };
    if ('shedEnabled' in patch) this.policy.shedEnabled = !!patch.shedEnabled;
    num('shedNonCriticalAfterSec', 0, 3600); num('shedNormalBelowPct', 0, 100);
    num('restoreAfterSec', 5, 3600); num('cycleSec', 2, 300); num('sequenceMs', 0, 30000);
    this.#save(); this.#emit();
    return this.policy;
  }

  // ---------- Desconexión automática de carga ----------
  async tick() {
    this.#measure();
    const { reading, commOk } = this.getReading() || {};
    const now = Date.now();
    if (reading && commOk) {
      if (reading.status.onBattery) {
        this.batterySince ??= now; this.gridSince = null;
        if (this.policy.shedEnabled) {
          if (now - this.batterySince >= this.policy.shedNonCriticalAfterSec * 1000) await this.#shed('no_critica', 'batería');
          const pct = reading.battery.chargePct;
          if (pct != null && pct <= this.policy.shedNormalBelowPct) await this.#shed('normal', `batería al ${pct}%`);
        }
      } else {
        this.batterySince = null; this.gridSince ??= now;
        if (now - this.gridSince >= this.policy.restoreAfterSec * 1000) await this.#restore();
      }
    }
    this.#checkCurrents();
    this.#emit();
  }

  async #shed(priority, why) {
    const list = this.outlets.filter((o) => o.on && o.priority === priority && !this.busy.has(o.id));
    if (!list.length) return;
    for (const o of list) { await this.#switch(o, false); o.shed = true; }
    this.#event('OUTLET_SHED', 'warn', `Desconexión de carga (${why}): ${list.map((o) => o.id).join(', ')} apagadas para alargar la autonomía`);
    this.#save();
  }

  async #restore() {
    const list = this.outlets.filter((o) => o.shed && !o.on);
    if (!list.length || this.restoring) return;
    this.restoring = true;
    try {
      for (const o of list) {
        if (!o.shed) continue; // un operador pudo intervenir durante la secuencia
        await this.#switch(o, true); o.shed = false; this.#emit();
        await sleep(this.policy.sequenceMs);
      }
      this.#event('OUTLET_RESTORE', 'info', `Red estable: se restauraron las tomas ${list.map((o) => o.id).join(', ')}`);
      this.#save();
    } finally { this.restoring = false; }
  }

  // ---------- Medición (simulada) ----------
  #measure() {
    const v = this.getReading()?.reading?.output?.voltage || 120;
    const pf = this.cfg.powerFactor || 0.9;
    for (const o of this.outlets) {
      const w = o.on ? Math.max(0, o.simW * (1 + (Math.random() - 0.5) * 0.08)) : 0;
      this.meter.set(o.id, { w: Math.round(w), a: Math.round((w / (pf * v)) * 100) / 100 });
    }
  }

  totalW() { return [...this.meter.values()].reduce((a, m) => a + m.w, 0); }

  #checkCurrents() {
    this.alarmed ??= new Set();
    for (const o of this.outlets) {
      const a = this.meter.get(o.id)?.a || 0, t = TYPES[o.type];
      const over = a > t.continuousA;
      if (over && !this.alarmed.has(o.id)) {
        this.alarmed.add(o.id);
        this.#event('OUTLET_OVERCURRENT', a > t.ratingA ? 'crit' : 'warn', `Toma ${o.id} (${o.name}) con ${a} A: supera el 80% continuo de ${t.label} (${t.continuousA} A)`, a);
      } else if (!over && this.alarmed.has(o.id)) this.alarmed.delete(o.id);
    }
  }

  // ---------- Salida ----------
  #out(o) {
    const m = this.meter.get(o.id) || { w: 0, a: 0 }, t = TYPES[o.type];
    return {
      id: o.id, type: o.type, typeLabel: t.label, ratingA: t.ratingA, continuousA: t.continuousA,
      name: o.name, priority: o.priority, gpio: o.gpio, gpioError: o.gpioError || null, virtual: o.gpio == null,
      on: o.on, shed: !!o.shed, cycling: this.busy.has(o.id), simW: o.simW, powerW: m.w, currentA: m.a,
      loadPct: Math.round((m.a / t.ratingA) * 100), lastChange: o.lastChange || null,
    };
  }

  status() {
    const list = this.outlets.map((o) => this.#out(o));
    const { reading } = this.getReading() || {};
    return {
      outlets: list, policy: this.policy, metering: 'simulada',
      totals: {
        on: list.filter((o) => o.on).length, count: list.length, shed: list.filter((o) => o.shed).length,
        powerW: list.reduce((a, o) => a + o.powerW, 0), currentA: Math.round(list.reduce((a, o) => a + o.currentA, 0) * 100) / 100,
      },
      ups: reading ? { onBattery: reading.status.onBattery, batteryPct: reading.battery.chargePct, loadPct: reading.output.loadPct } : null,
      shedTimer: this.batterySince && this.policy.shedEnabled
        ? Math.max(0, Math.ceil(this.policy.shedNonCriticalAfterSec - (Date.now() - this.batterySince) / 1000)) : null,
      restoreTimer: this.gridSince && this.outlets.some((o) => o.shed)
        ? Math.max(0, Math.ceil(this.policy.restoreAfterSec - (Date.now() - this.gridSince) / 1000)) : null,
    };
  }

  #event(code, severity, message, value = null) { this.emit('event', { ts: Date.now(), code, severity, state: 'raised', message, value }); }
  #emit() {
    const now = Date.now();
    if (now - (this.lastEmit || 0) < 250) { clearTimeout(this.emitT); this.emitT = setTimeout(() => this.#emit(), 260); return; }
    this.lastEmit = now; this.emit('state', this.status());
  }

  stop() { clearInterval(this.timer); clearTimeout(this.emitT); }
}

// Servicio GPIO: configuración persistente, dueños de pines (usuario / bypass / reservado),
// lógica activo-bajo y eventos en vivo. Nivel lógico 1 = "activo" (relé energizado, señal presente).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HEADER, POWER_PINS, byGpio } from './pins.js';
import { MockBackend } from './backends/mock.js';
import { LgpioBackend } from './backends/lgpio.js';
import { log } from '../util/log.js';

function pickBackend(cfg) {
  if (cfg.backend === 'mock') return new MockBackend();
  if (cfg.backend === 'lgpio') return new LgpioBackend(cfg.pollMs);
  const ok = process.platform === 'linux' && fs.existsSync('/dev/gpiochip0')
    && spawnSync('python3', ['-c', 'import lgpio'], { timeout: 5000 }).status === 0;
  return ok ? new LgpioBackend(cfg.pollMs) : new MockBackend();
}

export class GpioService extends EventEmitter {
  constructor(cfg, dataDir) {
    super();
    this.cfg = cfg;
    this.file = path.join(dataDir, 'gpio.json');
    this.backend = pickBackend(cfg);
    this.pins = new Map(); // gpio -> {mode, name, activeLow, pull, owner, level(físico)}
    this.reserved = new Set(cfg.reserved || []);
  }

  get simulated() { return this.backend instanceof MockBackend; }

  async init() {
    await this.backend.open();
    this.backend.on('input', (gpio, level) => {
      const p = this.pins.get(gpio); if (!p) return;
      p.level = level;
      this.emit('change', this.describe(gpio));
    });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    for (const [g, spec] of Object.entries(saved.pins || {})) {
      const gpio = Number(g);
      if (!byGpio.has(gpio) || this.reserved.has(gpio)) continue;
      try { await this.#apply(gpio, { ...spec, owner: 'user' }); }
      catch (e) { log.warn(`GPIO${gpio}: no se pudo restaurar (${e.message})`); }
    }
    log.info(`GPIO: backend ${this.backend.name}${this.simulated ? ' (sin hardware)' : ''}`);
  }

  #save() {
    const pins = {};
    for (const [g, p] of this.pins) {
      if (p.owner !== 'user') continue;
      pins[g] = { mode: p.mode, name: p.name, activeLow: p.activeLow, pull: p.pull,
        initial: p.mode === 'output' ? (p.persist ? this.#logical(p) : !!p.initial) : undefined, persist: p.persist };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ pins }, null, 2));
  }

  #logical(p) { return p.level == null ? null : (p.activeLow ? !p.level : !!p.level); }
  #physical(p, on) { return (p.activeLow ? !on : !!on) ? 1 : 0; }

  async #apply(gpio, spec) {
    const p = { mode: spec.mode, name: spec.name || `GPIO${gpio}`, activeLow: !!spec.activeLow,
      pull: spec.pull || 'none', owner: spec.owner, initial: !!spec.initial, persist: spec.persist !== false };
    if (p.mode === 'output') {
      p.level = this.#physical(p, spec.initial);
      await this.backend.claimOutput(gpio, p.level);
    } else if (p.mode === 'input') {
      p.level = (await this.backend.claimInput(gpio, p.pull)) ?? await this.backend.read(gpio);
    } else throw new Error(`Modo inválido: ${p.mode}`);
    this.pins.set(gpio, p);
    this.emit('change', this.describe(gpio));
  }

  describe(gpio) {
    const h = byGpio.get(gpio), p = this.pins.get(gpio);
    return {
      gpio, pin: h.pin, alt: h.alt,
      mode: this.reserved.has(gpio) ? 'reserved' : p?.mode || 'free',
      owner: this.reserved.has(gpio) ? 'system' : p?.owner || null,
      name: p?.name || null, activeLow: p?.activeLow ?? false, pull: p?.pull || 'none',
      level: p?.level ?? null, active: p ? this.#logical(p) : null, persist: p?.persist ?? true,
    };
  }

  list() {
    const pins = HEADER.map((h) => this.describe(h.gpio));
    const count = (m) => pins.filter((p) => p.mode === m).length;
    return {
      backend: this.backend.name, simulated: this.simulated, power: POWER_PINS, pins,
      summary: { total: pins.length, free: count('free'), outputs: count('output'), inputs: count('input'), reserved: count('reserved') },
    };
  }

  #check(gpio, owner) {
    if (!byGpio.has(gpio)) throw new Error(`GPIO${gpio} no existe en el conector de 40 pines`);
    if (this.reserved.has(gpio)) throw new Error(`GPIO${gpio} está reservado por el sistema`);
    const p = this.pins.get(gpio);
    if (p && p.owner !== owner) throw new Error(`GPIO${gpio} está en uso por ${p.owner === 'bypass' ? 'el bypass' : p.owner}`);
  }

  // --- API para el usuario (web / IA) ---
  async configure(gpio, spec) {
    this.#check(gpio, 'user');
    if (spec.mode === 'free') {
      if (this.pins.has(gpio)) { await this.backend.free(gpio); this.pins.delete(gpio); }
      this.emit('change', this.describe(gpio));
    } else await this.#apply(gpio, { ...this.pins.get(gpio), ...spec, owner: 'user' });
    this.#save();
    return this.describe(gpio);
  }

  async set(gpio, on, owner = 'user') {
    this.#check(gpio, owner);
    const p = this.pins.get(gpio);
    if (!p || p.mode !== 'output') throw new Error(`GPIO${gpio} no es una salida`);
    p.level = this.#physical(p, on);
    await this.backend.write(gpio, p.level);
    this.emit('change', this.describe(gpio));
    if (owner === 'user' && p.persist) this.#save();
    return this.describe(gpio);
  }

  isActive(gpio) { const p = this.pins.get(gpio); return p ? this.#logical(p) : null; }

  // --- API para módulos internos (bypass) ---
  async claim(gpio, spec, owner) {
    if (!byGpio.has(gpio)) throw new Error(`GPIO${gpio} no existe`);
    if (this.reserved.has(gpio)) throw new Error(`GPIO${gpio} está reservado`);
    const cur = this.pins.get(gpio);
    if (cur && cur.owner === 'user') {
      log.warn(`GPIO${gpio} estaba configurado por el usuario; ahora lo controla ${owner}`);
    }
    await this.#apply(gpio, { ...spec, owner, persist: false });
    this.#save();
  }

  simulateInput(gpio, active) {
    if (!this.simulated) throw new Error('Solo disponible con el backend simulado');
    const p = this.pins.get(gpio);
    if (!p || p.mode !== 'input') throw new Error(`GPIO${gpio} no es una entrada`);
    this.backend.simulateInput(gpio, this.#physical(p, active));
  }

  async close() { await this.backend.close(); }
}

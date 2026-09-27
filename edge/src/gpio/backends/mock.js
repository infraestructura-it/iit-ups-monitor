// Backend simulado: para desarrollo en Windows/PC. Las entradas se pueden forzar desde la web.
import { EventEmitter } from 'node:events';

export class MockBackend extends EventEmitter {
  constructor() { super(); this.name = 'simulado'; this.lines = new Map(); }
  async open() {}
  async claimOutput(gpio, level) { this.lines.set(gpio, { mode: 'output', level }); }
  async claimInput(gpio, pull) {
    const prev = this.lines.get(gpio);
    // Sin nada conectado, la entrada queda en el nivel de su pull (up = 1, down/none = 0)
    this.lines.set(gpio, { mode: 'input', level: prev?.mode === 'input' ? prev.level : pull === 'up' ? 1 : 0 });
  }
  async write(gpio, level) {
    const l = this.lines.get(gpio);
    if (!l || l.mode !== 'output') throw new Error(`GPIO${gpio} no está configurado como salida`);
    l.level = level;
  }
  async read(gpio) { return this.lines.get(gpio)?.level ?? 0; }
  async free(gpio) { this.lines.delete(gpio); }
  // Solo en simulación: fuerza el nivel físico de una entrada
  simulateInput(gpio, level) {
    const l = this.lines.get(gpio);
    if (!l || l.mode !== 'input') throw new Error(`GPIO${gpio} no es una entrada`);
    if (l.level !== level) { l.level = level; this.emit('input', gpio, level); }
  }
  async close() {}
}

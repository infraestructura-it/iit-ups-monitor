// Backend real: proceso Python con lgpio. Si el proceso muere, se reinicia y reclama las líneas.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from '../../util/log.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lgpio_bridge.py');

export class LgpioBackend extends EventEmitter {
  constructor(pollMs = 50) {
    super();
    this.name = 'lgpio';
    this.pollMs = pollMs;
    this.seq = 0;
    this.pending = new Map();
    this.claims = new Map(); // gpio -> {op, level|pull} para reclamar tras reinicio
  }

  open() {
    return new Promise((resolve, reject) => {
      // cwd en /tmp: lgpio crea archivos .lgd-nfy* en el directorio de trabajo
      this.proc = spawn('python3', ['-u', BRIDGE, String(this.pollMs / 1000)], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
      let buf = '', ready = false;
      this.proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.event === 'ready') { ready = true; log.info(`GPIO: lgpio en gpiochip${m.chip} (${m.label})`); resolve(); }
          else if (m.event === 'input') this.emit('input', m.gpio, m.level);
          else if (this.pending.has(m.id)) {
            const p = this.pending.get(m.id); this.pending.delete(m.id);
            m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
          }
        }
      });
      this.proc.stderr.on('data', (d) => log.warn('GPIO bridge:', String(d).trim()));
      this.proc.on('exit', (code) => {
        for (const p of this.pending.values()) p.reject(new Error('Puente GPIO detenido'));
        this.pending.clear();
        if (!ready) return reject(new Error(`El puente GPIO terminó (código ${code}). ¿Está instalado python3-lgpio?`));
        if (this.closing) return;
        log.warn('GPIO: el puente se detuvo, reiniciando en 1 s');
        setTimeout(() => this.#restart(), 1000);
      });
    });
  }

  async #restart() {
    try {
      await this.open();
      for (const [gpio, c] of this.claims) await this.#req(c.op, { gpio, ...c.args });
      this.emit('restarted');
    } catch (e) { log.error('GPIO: no se pudo reiniciar el puente:', e.message); setTimeout(() => this.#restart(), 5000); }
  }

  #req(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout GPIO ${op}`)); }, 2000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  async claimOutput(gpio, level) { this.claims.set(gpio, { op: 'output', args: { level } }); await this.#req('output', { gpio, level }); }
  async claimInput(gpio, pull) { this.claims.set(gpio, { op: 'input', args: { pull } }); return this.#req('input', { gpio, pull }); }
  async write(gpio, level) { const c = this.claims.get(gpio); if (c) c.args.level = level; await this.#req('write', { gpio, level }); }
  read(gpio) { return this.#req('read', { gpio }); }
  async free(gpio) { this.claims.delete(gpio); await this.#req('free', { gpio }); }
  async close() { this.closing = true; this.proc?.kill(); }
}

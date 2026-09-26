// Driver Megatec por puerto serie: RS232 (adaptador USB-RS232 o MAX3232 en UART del Pi)
// o puertos USB de UPS que en realidad son USB-serial (CH340, PL2303, FTDI).
import { SerialPort } from 'serialport';
import { emptyReading, fillEstimates } from './model.js';
import { parseQ1, parseF, parseI, estimateBattery } from './megatec-parser.js';

export class MegatecDriver {
  constructor(cfg, nameplate) {
    this.cfg = cfg;
    this.nameplate = nameplate;
    this.name = 'megatec';
    this.port = null;
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.info = { manufacturer: null, model: null, firmware: null, ratings: {}, protocol: 'Megatec Q1', port: cfg.path };
    this.capabilities = { commands: ['test', 'testCancel', 'beeperToggle'] };
  }

  async open() {
    this.port = new SerialPort({
      path: this.cfg.path, baudRate: this.cfg.baudRate || 2400,
      dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false,
    });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    // Algunas interfaces requieren DTR=1 y RTS=0 para alimentar el lado RS232
    await new Promise((res) => this.port.set({ dtr: true, rts: false }, () => res()));
    this.port.on('data', (d) => this.#onData(d));
    this.port.on('close', () => { this.port = null; });
    await this.#loadStatic();
  }

  #onData(chunk) {
    this.buffer += chunk.toString('latin1');
    let idx;
    while ((idx = this.buffer.indexOf('\r')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (this.pending && line.trim()) { this.pending.resolve(line); this.pending = null; }
    }
  }

  // Las consultas se serializan: el protocolo es estrictamente pregunta/respuesta
  query(cmd, timeoutMs = this.cfg.timeoutMs || 1500) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.port?.isOpen) return reject(new Error('Puerto serie cerrado'));
      this.buffer = '';
      const t = setTimeout(() => { this.pending = null; reject(new Error(`Timeout esperando respuesta a "${cmd}"`)); }, timeoutMs);
      this.pending = { resolve: (l) => { clearTimeout(t); resolve(l); } };
      this.port.write(cmd + '\r');
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #loadStatic() {
    try { Object.assign(this.info, parseI(await this.query('I'))); } catch { /* modelo sin comando I */ }
    try { this.info.ratings = parseF(await this.query('F')); } catch { /* modelo sin comando F */ }
  }

  async read() {
    if (!this.port?.isOpen) await this.open();
    const line = await this.query('Q1');
    const q = parseQ1(line);
    const r = emptyReading(this.name);
    const batt = estimateBattery(q.batteryVoltage, this.info.ratings, this.nameplate);

    r.input.voltage = q.inputVoltage;
    r.input.faultVoltage = q.inputFaultVoltage;
    r.input.frequency = q.inputFrequency;
    r.output.voltage = q.outputVoltage;
    r.output.loadPct = q.loadPct;
    r.battery.voltage = batt.totalV;
    r.battery.chargePct = batt.pct;
    if (batt.pct != null) r.estimated.push('battery.chargePct');
    r.ups.temperatureC = q.temperatureC;

    const b = q.bits;
    Object.assign(r.status, {
      onBattery: b.utilityFail, online: !b.utilityFail, lowBattery: b.batteryLow,
      bypass: b.bypassBoost, fault: b.upsFailed, standby: b.standby,
      testing: b.testInProgress, shutdownActive: b.shutdownActive, beeperOn: b.beeperOn,
      charging: !b.utilityFail && batt.pct != null && batt.pct < 98,
      overload: q.loadPct != null && q.loadPct >= 100,
    });
    r.status.codes = codesFrom(r.status);

    r.raw = {
      'q1.response': line.trim(),
      'q1.input_voltage': q.inputVoltage,
      'q1.input_fault_voltage': q.inputFaultVoltage,
      'q1.output_voltage': q.outputVoltage,
      'q1.load_pct': q.loadPct,
      'q1.input_frequency': q.inputFrequency,
      'q1.battery_voltage': q.batteryVoltage,
      'q1.temperature': q.temperatureC,
      'q1.status_bits': q.statusBits,
      ...Object.fromEntries(Object.entries(b).map(([k, v]) => [`q1.bit.${k}`, v ? 1 : 0])),
      'i.manufacturer': this.info.manufacturer,
      'i.model': this.info.model,
      'i.firmware': this.info.firmware,
      ...Object.fromEntries(Object.entries(this.info.ratings || {}).map(([k, v]) => [`f.${k}`, v])),
    };
    return fillEstimates(r, this.info, this.nameplate);
  }

  async command(name) {
    const map = { test: 'T', testCancel: 'CT', beeperToggle: 'Q' };
    if (!map[name]) throw new Error(`Comando no soportado: ${name}`);
    // Estos comandos no devuelven respuesta en la mayoría de UPS
    await new Promise((res, rej) => this.port.write(map[name] + '\r', (e) => (e ? rej(e) : res())));
    return { sent: map[name] };
  }

  async close() { if (this.port?.isOpen) await new Promise((r) => this.port.close(() => r())); }
}

export function codesFrom(s) {
  const c = [];
  if (s.online) c.push('OL');
  if (s.onBattery) c.push('OB');
  if (s.lowBattery) c.push('LB');
  if (s.charging) c.push('CHRG');
  if (s.bypass) c.push('BYPASS');
  if (s.testing) c.push('TEST');
  if (s.fault) c.push('FAULT');
  if (s.overload) c.push('OVER');
  if (s.shutdownActive) c.push('FSD');
  return c;
}

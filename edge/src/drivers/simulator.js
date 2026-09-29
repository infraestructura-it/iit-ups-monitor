// Simulador: permite desarrollar y probar el dashboard sin UPS conectada.
// Recorre escenarios: normal -> corte de energía (descarga) -> retorno -> sobrecarga -> normal
import { emptyReading, fillEstimates, round } from './model.js';
import { codesFrom } from './megatec.js';

export class SimulatorDriver {
  constructor(_cfg, nameplate) {
    this.name = 'simulator';
    this.nameplate = { ratedVA: 3000, powerFactor: 0.9, ...Object.fromEntries(Object.entries(nameplate || {}).filter(([, v]) => v != null)) };
    this.t0 = Date.now();
    this.batt = 100;
    this.beeper = true;
    this.testUntil = 0;
    this.info = {
      manufacturer: 'IIT-SIM', model: 'Online 3kVA', firmware: 'v1.0-sim', serial: 'SIM0001',
      protocol: 'Simulador', port: 'virtual',
      ratings: { ratedVA: 3000, ratedVoltage: 120, ratedCurrent: 25, ratedBatteryVoltage: 72, ratedFrequency: 60 },
    };
    this.capabilities = { commands: ['test', 'testCancel', 'beeperToggle'] };
  }
  async open() {}

  read() {
    const cycle = ((Date.now() - this.t0) / 1000) % 240;       // ciclo de 4 min
    const blackout = cycle > 90 && cycle < 140;
    const overload = cycle > 190 && cycle < 205;
    const testing = Date.now() < this.testUntil;
    const noise = (a) => (Math.random() - 0.5) * a;
    const slow = Math.sin(Date.now() / 60000);

    // Si el panel de tomas (ficha 7) está activo, la carga real es la suma de sus tomas
    const ext = this.loadProvider?.();
    const base = ext != null ? (ext / this.nameplate.powerFactor / this.nameplate.ratedVA) * 100 : 38 + 6 * slow + noise(3);
    const load = overload ? base + 65 + noise(4) : base;
    const onBatt = blackout || testing;
    this.batt = onBatt ? Math.max(5, this.batt - 0.9) : Math.min(100, this.batt + 0.35);

    const r = emptyReading(this.name);
    r.input.voltage = blackout ? 0 : round(121 + 3 * slow + noise(1.5));
    r.input.faultVoltage = blackout ? 0 : r.input.voltage;
    r.input.frequency = blackout ? 0 : round(60 + noise(0.1), 2);
    r.output.voltage = round(120 + noise(0.6));
    r.output.frequency = round(60 + noise(0.02), 2);
    r.output.loadPct = round(load, 0);
    r.battery.chargePct = round(this.batt, 0);
    r.battery.voltage = round(66 + (this.batt / 100) * 15 - (onBatt ? 2.5 : 0) + noise(0.2), 2);
    r.battery.runtimeSec = Math.round((this.batt / 100) * 1500 * (40 / Math.max(load, 5)));
    r.ups.temperatureC = round(31 + load / 12 + noise(0.4));
    Object.assign(r.status, {
      online: !onBatt, onBattery: onBatt, lowBattery: this.batt < 20, bypass: overload,
      fault: false, testing, shutdownActive: false, beeperOn: this.beeper,
      charging: !onBatt && this.batt < 99, overload: load >= 100,
    });
    r.status.codes = codesFrom(r.status);
    r.raw = {
      'sim.cycle_s': round(cycle, 0), 'sim.scenario': blackout ? 'corte' : overload ? 'sobrecarga' : testing ? 'prueba' : 'normal',
      'input.voltage': r.input.voltage, 'input.frequency': r.input.frequency, 'output.voltage': r.output.voltage,
      'ups.load': r.output.loadPct, 'battery.charge': r.battery.chargePct, 'battery.voltage': r.battery.voltage,
      'battery.runtime': r.battery.runtimeSec, 'ups.temperature': r.ups.temperatureC, 'ups.status': r.status.codes.join(' '),
      'ups.mfr': this.info.manufacturer, 'ups.model': this.info.model, 'ups.power.nominal': 3000,
    };
    return Promise.resolve(fillEstimates(r, this.info, this.nameplate));
  }

  async command(name) {
    if (name === 'test') this.testUntil = Date.now() + 10000;
    else if (name === 'testCancel') this.testUntil = 0;
    else if (name === 'beeperToggle') this.beeper = !this.beeper;
    else throw new Error(`Comando no soportado: ${name}`);
    return { sent: name };
  }
  async close() {}
}

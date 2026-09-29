import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GpioService } from '../src/gpio/gpio-service.js';
import { OutletBank } from '../src/outlets/outlets.js';
import { SimulatorDriver } from '../src/drivers/simulator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iit-out-'));
  const gpio = new GpioService({ backend: 'mock', reserved: [] }, dir);
  await gpio.init();
  const ups = { reading: { output: { voltage: 120 }, status: { onBattery: false }, battery: { chargePct: 100 } }, commOk: true };
  const bank = new OutletBank({ relayActiveLow: true, tickMs: 60_000, powerFactor: 0.9 }, gpio, () => ups, dir);
  await bank.init();
  bank.setPolicy({ shedNonCriticalAfterSec: 0.1, restoreAfterSec: 5, cycleSec: 2, sequenceMs: 0 });
  const events = [];
  bank.on('event', (e) => events.push(e.code));
  return { dir, gpio, ups, bank, events };
}

test('17 tomas: 15 NEMA 5-15R y 2 NEMA L5-30R, todas encendidas y virtuales', async () => {
  const { bank } = await setup();
  const s = bank.status();
  assert.equal(s.outlets.filter((o) => o.type === '5-15R').length, 15);
  assert.equal(s.outlets.filter((o) => o.type === 'L5-30R').length, 2);
  assert.equal(s.outlets.find((o) => o.id === 'L1').ratingA, 30);
  assert.ok(s.outlets.every((o) => o.on && o.virtual));
  assert.ok(s.totals.powerW > 0);
  bank.stop();
});

test('a prueba de fallas: relé activo = toma apagada', async () => {
  const { gpio, bank } = await setup();
  await bank.configure('T1', { gpio: 17 });
  assert.equal(gpio.isActive(17), false);          // toma encendida -> relé en reposo
  await bank.setOutlet('T1', false);
  assert.equal(gpio.isActive(17), true);           // apagar = energizar relé
  assert.equal(gpio.describe(17).owner, 'tomas');
  await assert.rejects(gpio.set(17, false, 'user'), /tomas/); // el usuario no la toca desde GPIO
  await bank.configure('T1', { gpio: null });
  assert.equal(gpio.describe(17).mode, 'free');    // al desasignar se libera
  bank.stop();
});

test('no permite asignar un GPIO del bypass ni repetir uno', async () => {
  const { gpio, bank } = await setup();
  await gpio.claim(5, { mode: 'output', name: 'K1' }, 'bypass');
  await assert.rejects(bank.configure('T2', { gpio: 5 }), /bypass/);
  await bank.configure('T2', { gpio: 22 });
  await assert.rejects(bank.configure('T3', { gpio: 22 }), /otra toma/);
  bank.stop();
});

test('reinicio remoto: apaga, espera y enciende', async () => {
  const { bank, events } = await setup();
  const p = bank.cycle('T4');
  await sleep(50);
  assert.equal(bank.status().outlets.find((o) => o.id === 'T4').on, false);
  assert.equal(bank.status().outlets.find((o) => o.id === 'T4').cycling, true);
  await assert.rejects(bank.setOutlet('T4', true), /reinicio en curso/);
  await p;
  assert.equal(bank.status().outlets.find((o) => o.id === 'T4').on, true);
  assert.ok(events.includes('OUTLET_CYCLE'));
  bank.stop();
});

test('en batería: apaga no críticas, luego normales por % y nunca las críticas; restaura al volver la red', async () => {
  const { ups, bank, events } = await setup();
  ups.reading.status.onBattery = true;
  await bank.tick(); await sleep(150); await bank.tick();
  let s = bank.status().outlets;
  assert.ok(s.filter((o) => o.priority === 'no_critica').every((o) => !o.on && o.shed));
  assert.ok(s.filter((o) => o.priority === 'normal').every((o) => o.on));
  ups.reading.battery.chargePct = 35;
  await bank.tick();
  s = bank.status().outlets;
  assert.ok(s.filter((o) => o.priority === 'normal').every((o) => !o.on));
  assert.ok(s.filter((o) => o.priority === 'critica').every((o) => o.on));
  assert.ok(events.includes('OUTLET_SHED'));
  // Vuelve la red: restaura después de restoreAfterSec
  ups.reading.status.onBattery = false; ups.reading.battery.chargePct = 100;
  bank.setPolicy({ restoreAfterSec: 5 });
  await bank.tick();
  assert.ok(bank.status().outlets.some((o) => o.shed));   // aún no
  bank.gridSince -= 6000;                                   // simula el paso del tiempo
  await bank.tick();
  assert.ok(bank.status().outlets.every((o) => o.on && !o.shed));
  assert.ok(events.includes('OUTLET_RESTORE'));
  bank.stop();
});

test('una toma apagada a mano no se enciende sola al restaurar', async () => {
  const { ups, bank } = await setup();
  await bank.setOutlet('T8', false);                        // T8 es no crítica, apagada por el operador
  ups.reading.status.onBattery = true;
  await bank.tick(); await sleep(150); await bank.tick();
  ups.reading.status.onBattery = false;
  await bank.tick(); bank.gridSince -= 6000; await bank.tick();
  assert.equal(bank.status().outlets.find((o) => o.id === 'T8').on, false);
  bank.stop();
});

test('alarma de sobrecorriente al superar el 80% continuo', async () => {
  const { bank, events } = await setup();
  await bank.configure('T14', { simW: 1500 });              // ~13,9 A en una 5-15R (continuo 12 A)
  await bank.tick();
  assert.ok(events.includes('OUTLET_OVERCURRENT'));
  await assert.rejects(bank.configure('T14', { simW: 5000 }), /fuera de rango/);
  bank.stop();
});

test('el estado persiste entre reinicios del servicio', async () => {
  const { dir, gpio, ups, bank } = await setup();
  await bank.configure('T5', { name: 'Router ISP', priority: 'critica' });
  await bank.setOutlet('T6', false);
  bank.stop();
  const b2 = new OutletBank({ relayActiveLow: true, tickMs: 60_000 }, gpio, () => ups, dir);
  await b2.init();
  const s = b2.status().outlets;
  assert.equal(s.find((o) => o.id === 'T5').name, 'Router ISP');
  assert.equal(s.find((o) => o.id === 'T6').on, false);
  b2.stop();
});

test('la UPS simulada toma su carga del panel de tomas', async () => {
  const { bank } = await setup();
  const sim = new SimulatorDriver({}, { ratedVA: 3000, powerFactor: 0.9 });
  sim.loadProvider = () => bank.totalW();
  const before = (await sim.read()).output.loadPct;
  await bank.bulk('offNonCritical');
  const after = (await sim.read()).output.loadPct;
  assert.ok(after < before - 5, `carga ${before}% -> ${after}%`);
  bank.stop();
});

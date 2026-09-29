import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GpioService } from '../src/gpio/gpio-service.js';
import { BypassController, STATES } from '../src/bypass/bypass-controller.js';
import base from '../config/default.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iit-'));
  const gpio = new GpioService({ backend: 'mock', reserved: [] }, dir);
  await gpio.init();
  const cfg = { ...base.bypass, enabled: true, tickMs: 10, confirmMs: 50, deadTimeMs: 30, returnDelaySec: 0.2, useUpsData: false, ...over };
  const bp = new BypassController(cfg, gpio, () => ({}));
  const events = [];
  bp.on('event', (e) => events.push(e.code));
  // Registro de la secuencia física de relés
  const seq = [];
  gpio.on('change', (p) => { if ([cfg.pins.relayUps, cfg.pins.relayBypass].includes(p.gpio)) seq.push(`${p.gpio}:${p.active ? 1 : 0}`); });
  await bp.init();
  seq.length = 0;
  return { gpio, bp, cfg, events, seq, stop: () => bp.stop() };
}

test('arranca en UPS con ambos relés inactivos (estado seguro)', async () => {
  const { gpio, bp, cfg, stop } = await setup();
  assert.equal(bp.state, STATES.UPS);
  assert.equal(gpio.isActive(cfg.pins.relayUps), false);
  assert.equal(gpio.isActive(cfg.pins.relayBypass), false);
  // relés activo-bajo: inactivo = nivel físico alto
  assert.equal(gpio.describe(cfg.pins.relayUps).level, 1);
  stop();
});

test('pérdida de salida UPS con red presente => bypass con break-before-make', async () => {
  const { gpio, bp, cfg, events, seq, stop } = await setup();
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(200);
  assert.equal(bp.state, STATES.BYPASS);
  assert.deepEqual(seq, [`${cfg.pins.relayUps}:1`, `${cfg.pins.relayBypass}:1`]); // primero abre UPS, luego cierra red
  assert.ok(events.includes('BYPASS_ON'));
  stop();
});

test('no transfiere si tampoco hay red', async () => {
  const { gpio, bp, cfg, events, stop } = await setup();
  gpio.simulateInput(cfg.pins.senseGrid, false);
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(200);
  assert.equal(bp.state, STATES.UPS);
  assert.equal(events.filter((e) => e === 'BYPASS_NO_GRID').length, 1); // sin repetir el evento
  stop();
});

test('una caída más corta que confirmMs no transfiere', async () => {
  const { gpio, bp, cfg, stop } = await setup({ confirmMs: 300 });
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(80);
  gpio.simulateInput(cfg.pins.senseUpsOut, true);
  await sleep(350);
  assert.equal(bp.state, STATES.UPS);
  stop();
});

test('regresa a UPS tras returnDelay, abriendo la red antes de cerrar la UPS', async () => {
  const { gpio, bp, cfg, events, seq, stop } = await setup();
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(200);
  seq.length = 0;
  gpio.simulateInput(cfg.pins.senseUpsOut, true);
  await sleep(450);
  assert.equal(bp.state, STATES.UPS);
  assert.deepEqual(seq, [`${cfg.pins.relayBypass}:0`, `${cfg.pins.relayUps}:0`]);
  assert.ok(events.includes('BYPASS_OFF'));
  stop();
});

test('bloqueo por exceso de transferencias', async () => {
  const { gpio, bp, cfg, events, stop } = await setup({ maxTransfers: 2, returnDelaySec: 0.05 });
  for (let i = 0; i < 3; i++) {
    gpio.simulateInput(cfg.pins.senseUpsOut, false); await sleep(180);
    gpio.simulateInput(cfg.pins.senseUpsOut, true); await sleep(250);
  }
  gpio.simulateInput(cfg.pins.senseUpsOut, false); await sleep(180);
  assert.equal(bp.state, STATES.LOCKOUT);
  assert.ok(events.includes('BYPASS_LOCKOUT'));
  stop();
});

test('contacto auxiliar de K1 no abre => no cierra el bypass y bloquea', async () => {
  const { gpio, bp, cfg, stop } = await setup({ pins: { ...base.bypass.pins, feedbackUps: 21 } });
  gpio.simulateInput(21, true);   // K1 "soldado": sigue reportando cerrado
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(200);
  assert.equal(bp.state, STATES.LOCKOUT);
  assert.equal(gpio.isActive(cfg.pins.relayBypass), false);
  assert.equal(gpio.isActive(cfg.pins.relayUps), false); // devolvió la carga a la UPS
  stop();
});

test('interlock: si ambos caminos aparecen cerrados se abre el bypass', async () => {
  const { gpio, bp, cfg, stop } = await setup();
  bp.mode = 'manual';
  await gpio.set(cfg.pins.relayBypass, true, 'bypass'); // falla forzada: K2 cerrado con UPS cerrada
  await sleep(60);
  assert.equal(bp.state, STATES.LOCKOUT);
  assert.equal(gpio.isActive(cfg.pins.relayBypass), false);
  stop();
});

test('modo manual: transferencias por comando y validaciones', async () => {
  const { gpio, bp, cfg, stop } = await setup({ mode: 'manual' });
  await bp.command({ action: 'transfer', to: 'bypass' });
  assert.equal(bp.state, STATES.BYPASS);
  gpio.simulateInput(cfg.pins.senseUpsOut, false);
  await sleep(30);
  await assert.rejects(bp.command({ action: 'transfer', to: 'ups' }), /no está entregando/);
  gpio.simulateInput(cfg.pins.senseUpsOut, true);
  await sleep(30);
  await bp.command({ action: 'transfer', to: 'ups' });
  assert.equal(bp.state, STATES.UPS);
  stop();
});

test('el usuario no puede tocar pines del bypass', async () => {
  const { gpio, cfg, stop } = await setup();
  await assert.rejects(gpio.set(cfg.pins.relayBypass, true, 'user'), /en uso por el bypass/);
  await assert.rejects(gpio.configure(cfg.pins.relayUps, { mode: 'input' }), /en uso por el bypass/);
  stop();
});

test('autoReturn=false: se queda en bypass aunque la UPS vuelva', async () => {
  const { gpio, bp, cfg, stop } = await setup({ autoReturn: false });
  gpio.simulateInput(cfg.pins.senseUpsOut, false); await sleep(200);
  gpio.simulateInput(cfg.pins.senseUpsOut, true); await sleep(450);
  assert.equal(bp.state, STATES.BYPASS);
  stop();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GpioService } from '../src/gpio/gpio-service.js';
import { Assistant } from '../src/ai/assistant.js';

async function ctx() {
  const gpio = new GpioService({ backend: 'mock', reserved: [] }, fs.mkdtempSync(path.join(os.tmpdir(), 'iit-')));
  await gpio.init();
  await gpio.configure(17, { mode: 'output', name: 'Ventilador rack' });
  const bypass = { status: () => ({ state: 'ups' }) };
  return { gpio, a: new Assistant({ apiKey: 'x', model: 'm', maxTokens: 100, maxToolRounds: 4, maxRequestsPerHour: 5 },
    { cfg: { device: { name: 'n', site: 's', id: 'i' }, alarms: {} }, state: {}, store: {}, alarms: { list: () => [] }, driver: { name: 'sim', info: {} }, gpio, bypass }) };
}

test('la IA propone pero no ejecuta; el operador confirma', async () => {
  const { gpio, a } = await ctx();
  const r = await a.runTool('proponer_salida_gpio', { gpio: 17, activar: true, motivo: 'prueba' });
  assert.equal(r.pendiente, true);
  assert.equal(gpio.isActive(17), false);           // nada se movió
  await a.confirm(r.id, true);
  assert.equal(gpio.isActive(17), true);
  await assert.rejects(a.confirm(r.id, true), /no existe/); // no se reutiliza
});

test('la IA no puede proponer pines que no son salidas de usuario', async () => {
  const { a } = await ctx();
  const r = await a.runTool('proponer_salida_gpio', { gpio: 22, activar: true, motivo: 'x' });
  assert.match(r.error, /no es una salida de usuario/);
});

test('ciclo de herramientas con la API simulada', async () => {
  const { a } = await ctx();
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    n++;
    if (n === 1) {
      assert.ok(body.tools.find((t) => t.name === 'estado_bypass'));
      return { ok: true, json: async () => ({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'estado_bypass', input: {} }] }) };
    }
    const last = body.messages.at(-1);
    assert.equal(last.content[0].type, 'tool_result');
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Bypass en UPS.' }] }) };
  };
  const r = await a.chat([{ role: 'user', content: '¿Cómo está el bypass?' }]);
  globalThis.fetch = orig;
  assert.equal(r.reply, 'Bypass en UPS.');
  assert.deepEqual(r.tools, ['estado_bypass']);
});

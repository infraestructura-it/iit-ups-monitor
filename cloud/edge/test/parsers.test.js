import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQ1, parseF, parseI, estimateBattery } from '../src/drivers/megatec-parser.js';
import { parseListVar } from '../src/drivers/nut.js';
import { AlarmEngine } from '../src/alarms/engine.js';
import { emptyReading } from '../src/drivers/model.js';
import cfg from '../config/default.json' with { type: 'json' };

test('Q1 en línea normal', () => {
  const q = parseQ1('(121.4 121.4 120.1 034 60.0 27.2 32.0 00001001');
  assert.equal(q.inputVoltage, 121.4);
  assert.equal(q.loadPct, 34);
  assert.equal(q.batteryVoltage, 27.2);
  assert.equal(q.bits.utilityFail, false);
  assert.equal(q.bits.standby, true);
  assert.equal(q.bits.beeperOn, true);
});

test('Q1 en batería con batería baja', () => {
  const q = parseQ1('(000.0 000.0 119.8 045 00.0 22.8 33.5 11000000');
  assert.equal(q.bits.utilityFail, true);
  assert.equal(q.bits.batteryLow, true);
});

test('Q1 inválido lanza error', () => assert.throws(() => parseQ1('Q1')));

test('F e I', () => {
  const f = parseF('#120.0 025 24.00 60.0');
  assert.equal(f.ratedVA, 3000);
  assert.equal(f.ratedBatteryVoltage, 24);
  const i = parseI('#MEGATEC         OnLine3K   V1.2      ');
  assert.equal(i.manufacturer, 'MEGATEC');
  assert.equal(i.model, 'OnLine3K');
});

test('estimación de batería total y por celda', () => {
  const ratings = { ratedBatteryVoltage: 24 }; // 12 celdas
  assert.equal(estimateBattery(27.0, ratings).pct, 100);
  assert.equal(estimateBattery(21.0, ratings).pct, 0);
  const perCell = estimateBattery(2.0, ratings);
  assert.equal(perCell.totalV, 24);
  assert.equal(perCell.pct, 50);
});

test('NUT LIST VAR', () => {
  const v = parseListVar('BEGIN LIST VAR ups\nVAR ups battery.charge "100"\nVAR ups ups.status "OL CHRG"\nEND LIST VAR ups\n');
  assert.equal(v['battery.charge'], '100');
  assert.equal(v['ups.status'], 'OL CHRG');
});

test('alarma ON_BATTERY inmediata y despeje con antirrebote', () => {
  const eng = new AlarmEngine(cfg.alarms);
  const r = emptyReading('t');
  r.status.onBattery = true;
  const ev = eng.evaluate(r);
  assert.ok(ev.find((e) => e.code === 'ON_BATTERY' && e.state === 'raised'));
  r.status.onBattery = false;
  assert.equal(eng.evaluate(r).length, 0);           // 1ª lectura normal: aún no despeja
  assert.ok(eng.evaluate(r).find((e) => e.code === 'ON_BATTERY' && e.state === 'cleared'));
});

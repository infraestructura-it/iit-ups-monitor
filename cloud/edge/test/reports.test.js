import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { Store } from '../src/storage/store.js';
import { buildReport, outages } from '../src/reports/report.js';
import { writeExcel } from '../src/reports/excel.js';

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iit-rep-'));
  const store = new Store({ path: path.join(dir, 'ups.db'), retentionDays: 3650 });
  const t0 = Date.now() - 3600_000;
  for (let i = 0; i < 1800; i++) {            // 1 hora, cada 2 s
    const ts = t0 + i * 2000, onBatt = i >= 600 && i < 750; // corte de 5 min
    store.saveReading({ ts, input: { voltage: onBatt ? 0 : 120 + (i % 10) / 10, frequency: 60 }, output: { voltage: 120, frequency: 60, current: 10, loadPct: 40, apparentPowerVA: 1200, realPowerW: 1000 },
      battery: { voltage: 27, chargePct: 100, runtimeSec: 1200 }, ups: { temperatureC: 30 }, status: { codes: [onBatt ? 'OB' : 'OL'] } });
  }
  store.saveEvent({ ts: t0 + 600 * 2000, code: 'ON_BATTERY', severity: 'crit', state: 'raised', message: 'Falla de red', value: 0 });
  store.saveEvent({ ts: t0 + 750 * 2000, code: 'ON_BATTERY', severity: 'crit', state: 'cleared', message: 'Normalizado', value: null });
  return { store, t0 };
}

test('reporte agregado con prom/mín/máx, energía y cortes', () => {
  const { store, t0 } = seed();
  const r = buildReport(store, { from: t0, to: t0 + 3600_000, bucket: '60000', metrics: 'in_v,out_v,out_a' });
  assert.equal(r.bucketMs, 60000);
  assert.ok(r.rows.length >= 59 && r.rows.length <= 61);
  assert.ok('in_v_min' in r.rows[0] && 'in_v_max' in r.rows[0]);
  assert.equal(r.stats.metrics.in_v.min, 0);
  assert.equal(r.outages.count, 1);
  assert.equal(r.outages.totalSec, 300);
  assert.ok(Math.abs(r.energyKWh - 1.0) < 0.01); // 1000 W durante 1 h
});

test('corte que empezó antes del rango se cuenta desde el inicio', () => {
  const { store, t0 } = seed();
  const o = outages(store.db, t0 + 1300_000, t0 + 3600_000);
  assert.equal(o.count, 1);
  assert.equal(o.totalSec, 200);
});

test('Excel con hojas Resumen, Datos y Eventos', async () => {
  const { store, t0 } = seed();
  const chunks = [], out = new PassThrough();
  out.on('data', (c) => chunks.push(c));
  const cfg = { device: { id: 'ups-01', name: 'UPS prueba', site: 'Bogotá' } };
  const r = await writeExcel(out, { store, cfg, driver: { info: {} }, user: 'Tester', q: { from: t0, to: t0 + 3600_000, bucket: '0', metrics: 'in_v,out_v,out_a' } });
  assert.equal(r.rows, 1800);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Resumen', 'Datos', 'Eventos']);
  const datos = wb.getWorksheet('Datos');
  assert.equal(datos.rowCount, 1801);
  assert.match(String(datos.getRow(1).getCell(2).value), /Voltaje entrada/);
  assert.ok(datos.getRow(2).getCell(1).value instanceof Date);
  assert.equal(typeof datos.getRow(2).getCell(2).value, 'number');
});

test('rechaza exportar crudo si supera el límite de filas de Excel', async () => {
  const { store, t0 } = seed();
  const { validateExport } = await import('../src/reports/excel.js');
  store.db.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1050000)
    INSERT INTO readings (ts, in_v) SELECT ${t0 - 10_000_000_000} + x, 120 FROM c`);
  assert.throws(() => validateExport(store, { from: t0 - 10_000_000_000, to: t0 + 3600_000, bucket: '0' }), /Excel admite/);
});

test('el historial de la página UPS agrega de verdad (regresión)', () => {
  const { store, t0 } = seed();
  const h = store.history(t0, t0 + 3600_000, 60);
  assert.ok(h.rows.length <= 61, `devolvió ${h.rows.length} filas`);
});

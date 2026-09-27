// Exportación a Excel (.xlsx) en streaming. Estilo corporativo azul/blanco (documento para clientes).
import ExcelJS from 'exceljs';
import { METRICS } from '../storage/store.js';
import { UNITS, parseQuery, autoBucket, aggregate, rawIterator, countRows, metricStats, outages, eventsInRange } from './report.js';

const BLUE = 'FF1F4E79', LIGHT = 'FFDCE6F1', WHITE = 'FFFFFFFF';
const EXCEL_MAX_ROWS = 1_048_000;
const SEVERITY = { crit: 'Crítico', warn: 'Advertencia', info: 'Información' };
const RES_TXT = { 0: 'Cada lectura', 60000: '1 minuto', 300000: '5 minutos', 900000: '15 minutos', 3600000: '1 hora', 86400000: '1 día' };

const headerStyle = (row) => {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: BLUE } } };
  });
  row.height = 30;
};

const numFmt = (m) => (['in_f', 'out_f', 'out_a', 'batt_v'].includes(m) ? '0.00' : ['out_va', 'out_w', 'runtime', 'load', 'batt_pct'].includes(m) ? '0' : '0.0');
const dur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? `${h} h ` : ''}${m} min ${x} s`; };

export function validateExport(store, q) {
  const p = parseQuery(q);
  if (p.bucket === 0 || p.bucket === 'raw') {
    const n = countRows(store.db, p.from, p.to);
    if (n > EXCEL_MAX_ROWS) throw new Error(`El rango tiene ${n.toLocaleString('es-CO')} lecturas y Excel admite ~1.048.000 filas. Elige una resolución de 1 minuto o mayor.`);
  }
  return p;
}

// cfg: config global; user: quién genera. tzOffsetMin: minutos a sumar al UTC para hora local (Bogotá = -300)
export async function writeExcel(outStream, { store, cfg, driver, user, q, tzOffsetMin = -300 }) {
  const { from, to, metrics, bucket } = validateExport(store, q);
  const bucketMs = bucket === 'auto' ? autoBucket(from, to, 5000) : bucket;
  const db = store.db;
  const local = (ts) => new Date(ts + tzOffsetMin * 60_000); // Excel no maneja zonas: se escribe la hora local
  const fmtLocal = (ts) => local(ts).toISOString().replace('T', ' ').slice(0, 19);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outStream, useStyles: true, useSharedStrings: false });
  wb.creator = 'Infraestructura-IT, Monitor UPS';
  wb.created = new Date();

  // ---------- Hoja 1: Resumen ----------
  const st = metricStats(db, { from, to, metrics });
  const out = outages(db, from, to);
  const ws1 = wb.addWorksheet('Resumen', { properties: { tabColor: { argb: BLUE } } });
  ws1.columns = [{ width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  const title = ws1.addRow(['Reporte de monitoreo de UPS']);
  title.font = { bold: true, size: 16, color: { argb: BLUE } };
  ws1.mergeCells(`A${title.number}:E${title.number}`);
  ws1.addRow(['Infraestructura-IT']).font = { italic: true, color: { argb: 'FF595959' } };
  ws1.addRow([]);
  const info = [
    ['Equipo', `${cfg.device.name} (${cfg.device.id})`], ['Sitio', cfg.device.site],
    ['UPS', [driver.info?.manufacturer, driver.info?.model].filter(Boolean).join(' ') || 'No reportado'],
    ['Desde', fmtLocal(from)], ['Hasta', fmtLocal(to)],
    ['Resolución de datos', RES_TXT[bucketMs] ?? `${Math.round(bucketMs / 1000)} s`],
    ['Lecturas en el periodo', st.samples], ['Energía entregada a la carga (kWh)', store.energyKWh(from, to)],
    ['Cortes de energía', out.count], ['Tiempo total en baterías', dur(out.totalSec)], ['Corte más largo', dur(out.longestSec)],
    ['Generado por', user || '—'], ['Generado el', fmtLocal(Date.now())],
  ];
  for (const [k, v] of info) {
    const r = ws1.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    r.getCell(2).alignment = { horizontal: 'left' };
    ws1.mergeCells(`B${r.number}:E${r.number}`);
  }
  ws1.addRow([]);
  headerStyle(ws1.addRow(['Variable', 'Unidad', 'Mínimo', 'Promedio', 'Máximo']));
  for (const m of metrics) {
    const s = st.metrics[m];
    const r = ws1.addRow([METRICS[m].replace(/ \(.+\)$/, ''), UNITS[m], s.min, s.avg, s.max]);
    [3, 4, 5].forEach((i) => (r.getCell(i).numFmt = numFmt(m)));
  }
  ws1.addRow([]);
  ws1.addRow(['Valores de potencia y corriente pueden ser estimados si la UPS solo reporta % de carga (protocolo Megatec).']).font = { italic: true, size: 9, color: { argb: 'FF7F7F7F' } };
  await ws1.commit();

  // ---------- Hoja 2: Datos ----------
  const ws2 = wb.addWorksheet('Datos', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  const raw = bucketMs === 0;
  const cols = [{ header: 'Fecha y hora', key: 't', width: 20, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } }];
  for (const m of metrics) {
    const label = `${METRICS[m].replace(/ \(.+\)$/, '')} (${UNITS[m]})`;
    if (raw) cols.push({ header: label, key: m, width: 16, style: { numFmt: numFmt(m) } });
    else for (const [suf, txt] of [['avg', 'prom.'], ['min', 'mín.'], ['max', 'máx.']]) {
      cols.push({ header: `${label} ${txt}`, key: `${m}_${suf}`, width: 14, style: { numFmt: numFmt(m) } });
    }
  }
  if (raw) cols.push({ header: 'Estado', key: 'status', width: 14 });
  else cols.push({ header: 'Lecturas', key: 'n', width: 10 });
  ws2.columns = cols;
  headerStyle(ws2.getRow(1));
  ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  let n = 0;
  const rows = raw ? rawIterator(db, { from, to, metrics }) : aggregate(db, { from, to, metrics, bucketMs });
  for (const r of rows) {
    ws2.addRow({ ...r, t: local(raw ? r.ts : r.t) }).commit();
    if (++n % 5000 === 0) await new Promise((res) => setImmediate(res)); // no bloquear el servicio
  }
  await ws2.commit();

  // ---------- Hoja 3: Eventos ----------
  const ws3 = wb.addWorksheet('Eventos', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws3.columns = [
    { header: 'Fecha y hora', key: 't', width: 20, style: { numFmt: 'dd/mm/yyyy hh:mm:ss' } },
    { header: 'Código', key: 'code', width: 18 }, { header: 'Severidad', key: 'sev', width: 13 },
    { header: 'Estado', key: 'state', width: 12 }, { header: 'Mensaje', key: 'message', width: 70 },
    { header: 'Valor', key: 'value', width: 10 },
  ];
  headerStyle(ws3.getRow(1));
  ws3.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
  for (const e of eventsInRange(db, from, to)) {
    const r = ws3.addRow({ t: local(e.ts), code: e.code, sev: SEVERITY[e.severity] || e.severity, state: e.state === 'raised' ? 'Activado' : 'Normalizado', message: e.message, value: e.value });
    if (e.severity === 'crit' && e.state === 'raised') r.getCell('sev').font = { bold: true, color: { argb: 'FFC00000' } };
    r.commit();
  }
  if (out.list.length) {
    ws3.addRow({}).commit();
    const h = ws3.addRow({ t: 'Cortes de energía', code: 'Fin', sev: 'Duración' }); h.font = { bold: true }; h.commit();
    for (const o of out.list) ws3.addRow({ t: local(o.start), code: o.end ? fmtLocal(o.end) : 'en curso', sev: dur(o.sec) }).commit();
  }
  await ws3.commit();
  await wb.commit();
  return { rows: n };
}

export const excelFilename = (cfg, q) => {
  const { from, to } = parseQuery(q);
  const d = (ts) => new Date(ts - 5 * 3600_000).toISOString().slice(0, 10);
  return `reporte_${cfg.device.id}_${d(from)}_a_${d(to)}.xlsx`;
};

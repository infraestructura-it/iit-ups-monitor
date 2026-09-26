// Parser del protocolo Megatec / "Q1" (2400 8N1).
// Lo hablan la mayoría de UPS genéricas: Powest, Forza, CDP, Tripp Lite línea económica,
// Mustek, Voltronic, Centurion, Interactive/online chinas, etc.
import { toNum, round } from './model.js';

// Q1 -> "(MMM.M NNN.N PPP.P QQQ RR.R S.SS TT.T b7b6b5b4b3b2b1b0"
export function parseQ1(line) {
  const s = line.trim();
  if (!s.startsWith('(')) throw new Error(`Respuesta Q1 inválida: "${s}"`);
  const f = s.slice(1).trim().split(/\s+/);
  if (f.length < 8 || !/^[01]{8}$/.test(f[7])) throw new Error(`Q1 incompleto: "${s}"`);
  const b = f[7];
  return {
    inputVoltage: toNum(f[0]),
    inputFaultVoltage: toNum(f[1]),
    outputVoltage: toNum(f[2]),
    loadPct: toNum(f[3]),
    inputFrequency: toNum(f[4]),
    batteryVoltage: toNum(f[5]),
    temperatureC: toNum(f[6]),
    bits: {
      utilityFail:    b[0] === '1', // b7
      batteryLow:     b[1] === '1', // b6
      bypassBoost:    b[2] === '1', // b5 (AVR boost/buck o bypass según modelo)
      upsFailed:      b[3] === '1', // b4
      standby:        b[4] === '1', // b3 1=standby/offline 0=online
      testInProgress: b[5] === '1', // b2
      shutdownActive: b[6] === '1', // b1
      beeperOn:       b[7] === '1', // b0
    },
    statusBits: b,
  };
}

// F -> "#MMM.M QQQ SS.SS RR.R"  (voltaje nominal, corriente nominal, voltaje batería nominal, frecuencia)
export function parseF(line) {
  const s = line.trim();
  if (!s.startsWith('#')) throw new Error(`Respuesta F inválida: "${s}"`);
  const f = s.slice(1).trim().split(/\s+/);
  const ratedVoltage = toNum(f[0]);
  const ratedCurrent = toNum(f[1]);
  return {
    ratedVoltage,
    ratedCurrent,
    ratedBatteryVoltage: toNum(f[2]),
    ratedFrequency: toNum(f[3]),
    ratedVA: ratedVoltage && ratedCurrent ? round(ratedVoltage * ratedCurrent, 0) : null,
  };
}

// I -> "#Compañía(15) Modelo(10) Versión(10)"
export function parseI(line) {
  const s = line.replace(/\r/g, '');
  if (!s.startsWith('#')) throw new Error(`Respuesta I inválida: "${s}"`);
  const body = s.slice(1);
  if (body.length >= 35) {
    return {
      manufacturer: body.slice(0, 15).trim(),
      model: body.slice(16, 26).trim(),
      firmware: body.slice(27).trim(),
    };
  }
  const parts = body.trim().split(/\s+/);
  return { manufacturer: parts[0] || '', model: parts[1] || '', firmware: parts.slice(2).join(' ') };
}

// Estimación de % de batería a partir del voltaje (curva lineal por celda de plomo-ácido)
export function estimateBattery(batteryV, ratings, nameplate = {}) {
  if (batteryV == null) return { totalV: null, pct: null };
  let cells = nameplate.batteryCells || null;
  if (!cells && ratings?.ratedBatteryVoltage > 3) cells = Math.round(ratings.ratedBatteryVoltage / 2);
  if (!cells) return { totalV: batteryV, pct: null };
  // Algunas UPS reportan voltaje por celda (ej. 2.27) en lugar del total (ej. 27.2)
  const perCell = batteryV < 3 ? batteryV : batteryV / cells;
  const totalV = batteryV < 3 ? perCell * cells : batteryV;
  const empty = nameplate.cellEmptyV ?? 1.75;
  const full = nameplate.cellFullV ?? 2.25;
  const pct = Math.max(0, Math.min(100, ((perCell - empty) / (full - empty)) * 100));
  return { totalV: round(totalV, 2), pct: round(pct, 0) };
}

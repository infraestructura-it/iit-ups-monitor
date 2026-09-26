// Modelo unificado de lectura. Todos los drivers entregan este formato,
// así las capas superiores (almacenamiento, alarmas, web, nube) no dependen del protocolo.

export function emptyReading(source) {
  return {
    ts: Date.now(),
    source,
    input:   { voltage: null, frequency: null, faultVoltage: null, current: null },
    output:  { voltage: null, frequency: null, current: null, loadPct: null, apparentPowerVA: null, realPowerW: null },
    battery: { voltage: null, chargePct: null, runtimeSec: null, temperatureC: null },
    ups:     { temperatureC: null },
    status: {
      online: false, onBattery: false, lowBattery: false, bypass: false, fault: false,
      testing: false, shutdownActive: false, beeperOn: null, charging: null, overload: false,
      standby: false, codes: [],
    },
    estimated: [],   // campos calculados (no reportados directamente por la UPS)
    raw: {},         // TODO lo que entregó el puerto, sin procesar
  };
}

// Estimaciones cuando el protocolo no entrega el dato (típico en Megatec Q1)
export function fillEstimates(r, info, nameplate = {}) {
  const ratedVA = nameplate.ratedVA || info?.ratings?.ratedVA || null;
  const pf = nameplate.powerFactor ?? 0.8;
  const o = r.output;

  if (o.apparentPowerVA == null && o.loadPct != null && ratedVA) {
    o.apparentPowerVA = round((o.loadPct / 100) * ratedVA, 0);
    r.estimated.push('output.apparentPowerVA');
  }
  if (o.realPowerW == null && o.apparentPowerVA != null) {
    o.realPowerW = round(o.apparentPowerVA * pf, 0);
    r.estimated.push('output.realPowerW');
  }
  if (o.current == null && o.apparentPowerVA != null && o.voltage > 20) {
    o.current = round(o.apparentPowerVA / o.voltage, 2);
    r.estimated.push('output.current');
  }
  if (o.frequency == null && r.input.frequency != null && !r.status.onBattery) {
    o.frequency = r.input.frequency;
    r.estimated.push('output.frequency');
  }
  return r;
}

export const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

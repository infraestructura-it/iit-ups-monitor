// Motor de alarmas con antirrebote: una condición debe mantenerse N lecturas para activarse o despejarse.
export class AlarmEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.active = new Map();   // code -> evento activo
    this.counters = new Map(); // code -> contador de lecturas consecutivas en cambio
  }

  rules(r) {
    const c = this.cfg, s = r.status;
    const inV = r.input.voltage, inF = r.input.frequency, load = r.output.loadPct;
    const bp = r.battery.chargePct, temp = r.ups.temperatureC ?? r.battery.temperatureC;
    const onMains = !s.onBattery;
    return [
      { code: 'ON_BATTERY', severity: 'crit', on: s.onBattery && !s.testing, msg: 'Falla de red: la UPS está alimentando la carga desde baterías', value: inV },
      { code: 'LOW_BATTERY', severity: 'crit', on: s.lowBattery || (bp != null && bp <= c.batteryPct.crit), msg: 'Batería baja: riesgo de apagado de la carga', value: bp },
      { code: 'BATTERY_WARN', severity: 'warn', on: bp != null && bp <= c.batteryPct.warn && bp > c.batteryPct.crit, msg: `Carga de batería por debajo de ${c.batteryPct.warn}%`, value: bp },
      { code: 'INPUT_V_LOW', severity: 'warn', on: onMains && inV != null && inV > 0 && inV < c.inputVoltage.min, msg: `Voltaje de entrada bajo (< ${c.inputVoltage.min} V)`, value: inV },
      { code: 'INPUT_V_HIGH', severity: 'warn', on: onMains && inV != null && inV > c.inputVoltage.max, msg: `Voltaje de entrada alto (> ${c.inputVoltage.max} V)`, value: inV },
      { code: 'INPUT_F_OUT', severity: 'warn', on: onMains && inF > 0 && (inF < c.inputFrequency.min || inF > c.inputFrequency.max), msg: 'Frecuencia de entrada fuera de rango', value: inF },
      { code: 'OVERLOAD', severity: 'crit', on: s.overload || (load != null && load >= c.loadPct.crit), msg: `Sobrecarga: carga ≥ ${c.loadPct.crit}%`, value: load },
      { code: 'LOAD_HIGH', severity: 'warn', on: load != null && load >= c.loadPct.warn && load < c.loadPct.crit && !s.overload, msg: `Carga alta (≥ ${c.loadPct.warn}%)`, value: load },
      { code: 'TEMP_CRIT', severity: 'crit', on: temp != null && temp >= c.temperatureC.crit, msg: `Temperatura crítica (≥ ${c.temperatureC.crit} °C)`, value: temp },
      { code: 'TEMP_HIGH', severity: 'warn', on: temp != null && temp >= c.temperatureC.warn && temp < c.temperatureC.crit, msg: `Temperatura alta (≥ ${c.temperatureC.warn} °C)`, value: temp },
      { code: 'BYPASS', severity: 'warn', on: s.bypass, msg: 'UPS en bypass / AVR activo', value: null },
      { code: 'UPS_FAULT', severity: 'crit', on: s.fault, msg: 'La UPS reporta falla interna', value: null },
      { code: 'SELF_TEST', severity: 'info', on: s.testing, msg: 'Prueba de batería en curso', value: bp },
      { code: 'SHUTDOWN', severity: 'crit', on: s.shutdownActive, msg: 'Apagado programado activo en la UPS', value: null },
    ];
  }

  evaluate(r) {
    const out = [];
    const restored = this.#clearComm(r.ts);
    if (restored) out.push(restored);
    for (const rule of this.rules(r)) {
      const ev = this.#step(rule, r.ts);
      if (ev) out.push(ev);
    }
    return out;
  }

  // Llamado cuando falla la lectura del puerto
  commFailure(lastOkTs, error) {
    const now = Date.now();
    if (now - lastOkTs < this.cfg.commLostAfterMs || this.active.has('COMM_LOST')) return [];
    const ev = { ts: now, code: 'COMM_LOST', severity: 'crit', state: 'raised', message: `Sin comunicación con la UPS: ${error}`, value: null };
    this.active.set('COMM_LOST', ev);
    return [ev];
  }

  #clearComm(ts) {
    if (!this.active.has('COMM_LOST')) return null;
    this.active.delete('COMM_LOST');
    return { ts, code: 'COMM_LOST', severity: 'crit', state: 'cleared', message: 'Comunicación con la UPS restablecida', value: null };
  }

  #step(rule, ts) {
    const isActive = this.active.has(rule.code);
    if (rule.on === isActive) { this.counters.delete(rule.code); return null; }
    const n = (this.counters.get(rule.code) || 0) + 1;
    if (n < (rule.severity === 'crit' && !isActive ? 1 : this.cfg.debounce)) { this.counters.set(rule.code, n); return null; }
    this.counters.delete(rule.code);
    const ev = { ts, code: rule.code, severity: rule.severity, state: rule.on ? 'raised' : 'cleared', message: rule.on ? rule.msg : `Normalizado: ${rule.msg}`, value: rule.value ?? null };
    if (rule.on) this.active.set(rule.code, ev); else this.active.delete(rule.code);
    return ev;
  }

  list() { return [...this.active.values()]; }
}

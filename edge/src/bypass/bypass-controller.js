// Bypass automático: transfiere la carga a la red cuando la UPS deja de entregar energía.
//
// Cableado a prueba de fallas (ver docs/BYPASS.md):
//   K1 (relayUps)    activo = ABRE el camino UPS -> carga      (bobina en contacto NC)
//   K2 (relayBypass) activo = CIERRA el camino red -> carga    (contacto NO)
//   Sin energía en la Pi, o si el servicio muere: ambos inactivos => la carga queda en la UPS.
//
// Secuencia break-before-make: nunca se cierran ambos caminos a la vez.
//   A bypass:  K1 activo (abre UPS) -> tiempo muerto -> verificar -> K2 activo (cierra red)
//   A UPS:     K2 inactivo (abre red) -> tiempo muerto -> verificar -> K1 inactivo (cierra UPS)
import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STATES = {
  DISABLED: 'deshabilitado', UPS: 'ups', TO_BYPASS: 'transfiriendo_a_bypass',
  BYPASS: 'bypass', TO_UPS: 'transfiriendo_a_ups', LOCKOUT: 'bloqueado',
};

export class BypassController extends EventEmitter {
  constructor(cfg, gpio, getReading) {
    super();
    this.cfg = cfg;
    this.gpio = gpio;
    this.getReading = getReading;     // () => { reading, commOk } de la capa UPS
    this.state = cfg.enabled ? STATES.UPS : STATES.DISABLED;
    this.mode = cfg.mode === 'manual' ? 'manual' : 'auto';
    this.lockReason = null;
    this.upsLostSince = null;
    this.upsOkSince = null;
    this.transfers = [];              // timestamps de transferencias a bypass
    this.busy = false;
    this.lastTransferTs = null;
    this.inputs = {};
  }

  async init() {
    if (!this.cfg.enabled) return;
    const p = this.cfg.pins;
    const out = { mode: 'output', activeLow: this.cfg.relayActiveLow, initial: false };
    const inp = { mode: 'input', activeLow: this.cfg.senseActiveLow, pull: this.cfg.sensePull };
    await this.gpio.claim(p.relayUps, { ...out, name: 'K1 Abrir salida UPS' }, 'bypass');
    await this.gpio.claim(p.relayBypass, { ...out, name: 'K2 Cerrar bypass red' }, 'bypass');
    if (p.senseUpsOut != null) await this.gpio.claim(p.senseUpsOut, { ...inp, name: 'Sensor salida UPS' }, 'bypass');
    if (p.senseGrid != null) await this.gpio.claim(p.senseGrid, { ...inp, name: 'Sensor red' }, 'bypass');
    if (p.feedbackUps != null) await this.gpio.claim(p.feedbackUps, { ...inp, name: 'Aux K1 (UPS cerrado)' }, 'bypass');
    if (p.feedbackBypass != null) await this.gpio.claim(p.feedbackBypass, { ...inp, name: 'Aux K2 (bypass cerrado)' }, 'bypass');
    if (this.gpio.simulated) {
      // En simulación se arranca como una instalación sana: red y salida UPS presentes, K1 cerrado
      for (const g of [p.senseUpsOut, p.senseGrid, p.feedbackUps]) if (g != null) this.gpio.simulateInput(g, true);
      if (p.feedbackBypass != null) this.gpio.simulateInput(p.feedbackBypass, false);
    }
    this.timer = setInterval(() => this.tick().catch((e) => this.#lock(`Error interno: ${e.message}`)), this.cfg.tickMs);
    this.timer.unref?.();
  }

  // ---------- Lectura de condiciones ----------
  sense() {
    const p = this.cfg.pins, now = Date.now();
    const { reading, commOk } = this.getReading() || {};
    const read = (g) => (g == null ? null : this.gpio.isActive(g));

    // Salida UPS: sensor físico manda; los datos de la UPS son respaldo opcional
    const sensorUps = read(p.senseUpsOut);
    let dataUps = null;
    if (this.cfg.useUpsData && reading && commOk && now - reading.ts < 10_000) {
      const v = reading.output.voltage;
      dataUps = !(reading.status.fault || reading.status.shutdownActive || (v != null && v < this.cfg.outputMinV));
    }
    const upsOut = sensorUps ?? dataUps;

    const sensorGrid = read(p.senseGrid);
    let dataGrid = null;
    if (reading && commOk && reading.input.voltage != null) dataGrid = reading.input.voltage >= this.cfg.gridMinV;
    const grid = sensorGrid ?? dataGrid;   // null = desconocido

    this.inputs = {
      upsOut, grid, sensorUps, sensorGrid, dataUps, dataGrid,
      k1Open: read(p.relayUps), k2Closed: read(p.relayBypass),
      fbUps: read(p.feedbackUps), fbBypass: read(p.feedbackBypass),
    };
    return this.inputs;
  }

  // ---------- Ciclo de control ----------
  async tick() {
    if (this.state === STATES.DISABLED || this.busy) return;
    const s = this.sense(), now = Date.now();
    this.#checkInvariant(s);

    if (s.upsOut === false) { this.upsLostSince ??= now; this.upsOkSince = null; }
    else if (s.upsOut === true) { this.upsOkSince ??= now; this.upsLostSince = null; }
    else { this.upsLostSince = null; this.upsOkSince = null; }

    if (this.mode !== 'auto' || this.state === STATES.LOCKOUT) return this.#emitState();

    if (this.state === STATES.UPS && this.upsLostSince && now - this.upsLostSince >= this.cfg.confirmMs) {
      if (s.grid === false) {
        if (!this.noGridNoted) this.#note('BYPASS_NO_GRID', 'warn', 'La UPS no entrega energía y tampoco hay red: no se transfiere');
        this.noGridNoted = true;
      } else {
        this.noGridNoted = false;
        this.transfers = this.transfers.filter((t) => now - t < this.cfg.windowMin * 60_000);
        if (this.transfers.length >= this.cfg.maxTransfers) {
          this.#lock(`Más de ${this.cfg.maxTransfers} transferencias en ${this.cfg.windowMin} min`);
        } else await this.toBypass('auto');
      }
    } else if (this.state === STATES.BYPASS && this.cfg.autoReturn !== false && this.upsOkSince && now - this.upsOkSince >= this.cfg.returnDelaySec * 1000) {
      await this.toUps('auto');
    }
    this.#emitState();
  }

  #checkInvariant(s) {
    // Ambos caminos cerrados = UPS en paralelo con la red. Nunca debe ocurrir.
    const upsClosed = s.fbUps ?? !s.k1Open;
    const bypassClosed = s.fbBypass ?? s.k2Closed;
    if (upsClosed && bypassClosed && !this.busy) {
      this.gpio.set(this.cfg.pins.relayBypass, false, 'bypass').catch(() => {});
      this.#lock('Interlock: ambos caminos aparecieron cerrados; se abrió el bypass');
    }
  }

  // ---------- Transferencias ----------
  async toBypass(origin) {
    if (this.busy) throw new Error('Transferencia en curso');
    if (this.state === STATES.BYPASS) return;
    this.busy = true;
    const p = this.cfg.pins;
    try {
      this.#set(STATES.TO_BYPASS);
      await this.gpio.set(p.relayUps, true, 'bypass');          // 1. abrir UPS
      await sleep(this.cfg.deadTimeMs);                          // 2. tiempo muerto
      if (p.feedbackUps != null && this.gpio.isActive(p.feedbackUps)) {   // 3. verificar
        await this.gpio.set(p.relayUps, false, 'bypass');
        this.state = STATES.UPS;
        return this.#lock('K1 no abrió (contacto auxiliar sigue cerrado). No se cerró el bypass');
      }
      await this.gpio.set(p.relayBypass, true, 'bypass');       // 4. cerrar red
      this.transfers.push(Date.now());
      this.lastTransferTs = Date.now();
      this.#set(STATES.BYPASS);
      this.#note('BYPASS_ON', 'crit', `Carga transferida a bypass (red) [${origin}]`);
    } finally { this.busy = false; }
  }

  async toUps(origin) {
    if (this.busy) throw new Error('Transferencia en curso');
    if (this.state === STATES.UPS) return;
    this.busy = true;
    const p = this.cfg.pins;
    try {
      this.#set(STATES.TO_UPS);
      await this.gpio.set(p.relayBypass, false, 'bypass');      // 1. abrir red
      await sleep(this.cfg.deadTimeMs);
      if (p.feedbackBypass != null && this.gpio.isActive(p.feedbackBypass)) {
        this.state = STATES.BYPASS;
        return this.#lock('K2 no abrió (contacto auxiliar sigue cerrado). No se reconectó la UPS');
      }
      await this.gpio.set(p.relayUps, false, 'bypass');         // 2. cerrar UPS
      this.lastTransferTs = Date.now();
      this.#set(STATES.UPS);
      this.#note('BYPASS_OFF', 'info', `Carga de regreso en la UPS [${origin}]`);
    } finally { this.busy = false; }
  }

  // ---------- Órdenes del operador ----------
  async command({ action, mode, to }) {
    if (this.state === STATES.DISABLED) throw new Error('El bypass está deshabilitado en la configuración');
    if (action === 'mode') {
      if (!['auto', 'manual'].includes(mode)) throw new Error('Modo inválido');
      this.mode = mode;
      this.#note('BYPASS_MODE', 'info', `Bypass en modo ${mode === 'auto' ? 'automático' : 'manual'}`);
    } else if (action === 'transfer') {
      if (this.mode !== 'manual') throw new Error('Cambia a modo manual para transferir a mano');
      if (this.state === STATES.LOCKOUT) throw new Error('Bypass bloqueado: restablécelo primero');
      const s = this.sense();
      if (to === 'bypass') {
        if (s.grid === false) throw new Error('No hay red disponible para el bypass');
        await this.toBypass('manual');
      } else if (to === 'ups') {
        if (s.upsOut === false) throw new Error('La UPS no está entregando energía');
        await this.toUps('manual');
      } else throw new Error('Destino inválido');
    } else if (action === 'reset') {
      if (this.state !== STATES.LOCKOUT) return this.status();
      this.lockReason = null;
      this.transfers = [];
      this.state = this.inputs.k2Closed ? STATES.BYPASS : STATES.UPS;
      this.#note('BYPASS_RESET', 'info', 'Bloqueo del bypass restablecido por el operador');
    } else throw new Error('Acción inválida');
    this.#emitState();
    return this.status();
  }

  #lock(reason) {
    if (this.state === STATES.LOCKOUT && this.lockReason === reason) return;
    this.state = STATES.LOCKOUT;
    this.lockReason = reason;
    this.#note('BYPASS_LOCKOUT', 'crit', `Bypass bloqueado: ${reason}`);
    this.#emitState();
  }

  #set(state) { this.state = state; this.#emitState(); }
  #note(code, severity, message) {
    this.emit('event', { ts: Date.now(), code, severity, state: 'raised', message, value: null });
  }
  // Emite de inmediato si cambia estado/modo/entradas; las cuentas regresivas, máximo 1 vez por segundo
  #emitState() {
    const st = this.status();
    const key = JSON.stringify([st.state, st.mode, st.lockReason, st.inputs, st.transfersInWindow]);
    const now = Date.now();
    if (key !== this.lastKey || now - (this.lastEmitTs || 0) >= 1000) {
      this.lastKey = key; this.lastEmitTs = now;
      this.emit('state', st);
    }
  }

  status() {
    const now = Date.now();
    return {
      enabled: this.cfg.enabled, state: this.state, mode: this.mode, lockReason: this.lockReason,
      inputs: this.inputs,
      countdown: {
        toBypassMs: this.state === STATES.UPS && this.upsLostSince ? Math.max(0, this.cfg.confirmMs - (now - this.upsLostSince)) : null,
        toUpsSec: this.state === STATES.BYPASS && this.cfg.autoReturn !== false && this.upsOkSince ? Math.max(0, Math.ceil(this.cfg.returnDelaySec - (now - this.upsOkSince) / 1000)) : null,
      },
      transfersInWindow: this.transfers.filter((t) => now - t < this.cfg.windowMin * 60_000).length,
      lastTransferTs: this.lastTransferTs,
      config: {
        pins: this.cfg.pins, deadTimeMs: this.cfg.deadTimeMs, confirmMs: this.cfg.confirmMs,
        returnDelaySec: this.cfg.returnDelaySec, autoReturn: this.cfg.autoReturn !== false, maxTransfers: this.cfg.maxTransfers, windowMin: this.cfg.windowMin,
        useUpsData: this.cfg.useUpsData, outputMinV: this.cfg.outputMinV,
      },
    };
  }

  stop() { clearInterval(this.timer); }
}

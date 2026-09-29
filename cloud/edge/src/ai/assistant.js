// Asistente IA (Claude, Messages API con uso de herramientas).
// La IA LEE todo (UPS, histórico, eventos, bypass, GPIO). Para ACCIONAR salidas GPIO solo PROPONE:
// la acción queda pendiente hasta que el operador la confirma en la web con su clave.
// El bypass nunca es controlable desde la IA.
import crypto from 'node:crypto';
import { METRICS } from '../storage/store.js';

const API = 'https://api.anthropic.com/v1/messages';

const TOOLS = [
  {
    name: 'estado_ups',
    description: 'Lectura más reciente de la UPS: voltajes, frecuencias, corriente, carga, potencias, batería, temperatura, estado, alarmas activas y datos del equipo. Úsala para cualquier pregunta sobre el estado actual.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'estadisticas',
    description: 'Mínimos, máximos, promedios y energía entregada (kWh) en las últimas N horas.',
    input_schema: { type: 'object', properties: { horas: { type: 'number', description: 'Ventana en horas (1 a 720)' } }, required: ['horas'] },
  },
  {
    name: 'historial',
    description: `Serie de tiempo resumida de una métrica. Métricas: ${Object.entries(METRICS).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        metrica: { type: 'string', enum: Object.keys(METRICS) },
        horas: { type: 'number', description: 'Ventana en horas (1 a 720)' },
      },
      required: ['metrica', 'horas'],
    },
  },
  {
    name: 'eventos',
    description: 'Eventos y alarmas registrados (cortes de red, batería baja, sobrecarga, transferencias de bypass, comandos) en las últimas N horas, más recientes primero.',
    input_schema: { type: 'object', properties: { horas: { type: 'number' }, limite: { type: 'number' } }, required: ['horas'] },
  },
  {
    name: 'estado_bypass',
    description: 'Estado del bypass automático: estado actual, modo, sensores, bloqueos y configuración. Solo lectura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'estado_gpio',
    description: 'Lista de los 26 GPIO del conector: modo (salida, entrada, libre, reservado), nombre, dueño y si está activo.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'estado_tomas',
    description: 'Panel de tomas de la UPS (15 NEMA 5-15R y 2 NEMA L5-30R): estado, prioridad, potencia y corriente por toma (medición simulada), totales y política de desconexión de carga en batería. Solo lectura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'proponer_salida_gpio',
    description: 'Propone encender o apagar una salida GPIO configurada por el usuario (no las del bypass). NO la ejecuta: el operador debe confirmarla en pantalla. Úsala solo cuando el usuario pida accionar algo.',
    input_schema: {
      type: 'object',
      properties: {
        gpio: { type: 'integer' },
        activar: { type: 'boolean', description: 'true = activar/encender, false = desactivar/apagar' },
        motivo: { type: 'string', description: 'Explicación breve para el operador' },
      },
      required: ['gpio', 'activar', 'motivo'],
    },
  },
];

export class Assistant {
  constructor(cfg, ctx) {
    this.cfg = cfg;
    this.ctx = ctx;            // { cfg, state, store, alarms, driver, gpio, bypass }
    this.pending = new Map();  // id -> acción propuesta
    this.calls = [];
  }

  get available() { return !!this.cfg.apiKey; }

  info() {
    return { available: this.available, model: this.cfg.model, pending: [...this.pending.values()] };
  }

  system() {
    const { cfg, driver } = this.ctx;
    const now = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' });
    return `Eres el asistente técnico del monitor de UPS de Infraestructura-IT, corriendo en una Raspberry Pi 5.
Equipo: ${cfg.device.name} (${cfg.device.site}), id ${cfg.device.id}. Driver: ${driver.name}. Fecha y hora local: ${now}.
Red eléctrica de Colombia: 120 V fase-neutro, 60 Hz. Umbrales configurados: ${JSON.stringify(cfg.alarms)}.

Reglas:
- Responde en español, claro y breve. Usa números concretos obtenidos con las herramientas; nunca inventes datos.
- Si un valor viene marcado como estimado (lista "estimated"), acláralo.
- Para diagnósticos, consulta primero las herramientas necesarias (estado, estadísticas, eventos, historial).
- El bypass y las tomas son de solo lectura para ti; se operan desde sus fichas.
- La potencia y corriente por toma son simuladas (no hay medidor por toma); dilo si las usas.
- El bypass es de solo lectura para ti. Si piden transferir, explica que se hace desde el menú Bypass.
- Para accionar una salida GPIO usa proponer_salida_gpio; queda pendiente hasta que el operador confirme. No digas que ya se ejecutó.
- En temas de trabajo eléctrico, recuerda las medidas de seguridad (desenergizar, bloqueo y etiquetado, personal calificado).`;
  }

  async #tool(name, input) {
    const { state, store, alarms, driver, gpio, bypass } = this.ctx;
    const hours = (h) => Math.min(Math.max(Number(h) || 24, 1), 720) * 3600_000;
    const now = Date.now();
    switch (name) {
      case 'estado_ups': {
        const r = state.latest;
        return r ? { lectura: { ...r, raw: undefined }, comunicacion_ok: state.commOk, alarmas_activas: alarms.list(), equipo: driver.info }
          : { error: 'Aún no hay lecturas', ultimo_error: state.lastError };
      }
      case 'estadisticas':
        return { ...store.stats(now - hours(input.horas), now), energia_kwh: store.energyKWh(now - hours(input.horas), now) };
      case 'historial': {
        const h = store.history(now - hours(input.horas), now, 48);
        return { metrica: input.metrica, unidad: METRICS[input.metrica], intervalo_s: h.bucket / 1000,
          puntos: h.rows.map((r) => [new Date(r.t).toISOString(), r[input.metrica]]) };
      }
      case 'eventos':
        return store.events({ from: now - hours(input.horas), to: now, limit: Math.min(input.limite || 50, 200) })
          .map((e) => ({ fecha: new Date(e.ts).toLocaleString('es-CO', { timeZone: 'America/Bogota' }), codigo: e.code, severidad: e.severity, estado: e.state, mensaje: e.message, valor: e.value }));
      case 'estado_bypass': return bypass.status();
      case 'estado_tomas': return this.ctx.outlets ? this.ctx.outlets.status() : { error: 'Panel de tomas no disponible' };
      case 'estado_gpio': {
        const l = gpio.list();
        return { resumen: l.summary, simulado: l.simulated, pines: l.pins.filter((p) => p.mode !== 'free') };
      }
      case 'proponer_salida_gpio': {
        const d = gpio.describe(input.gpio);
        if (d.mode !== 'output' || d.owner !== 'user') return { error: `GPIO${input.gpio} no es una salida de usuario (modo ${d.mode}, dueño ${d.owner || 'ninguno'})` };
        const id = crypto.randomUUID();
        const action = { id, gpio: input.gpio, name: d.name, activar: !!input.activar, motivo: input.motivo, ts: now };
        this.pending.set(id, action);
        this.#newActions.push(action);
        return { pendiente: true, id, mensaje: 'Acción propuesta; espera confirmación del operador' };
      }
      default: return { error: `Herramienta desconocida: ${name}` };
    }
  }

  #newActions = [];

  #rateLimit() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    if (this.calls.length >= this.cfg.maxRequestsPerHour) throw new Error('Límite de consultas por hora alcanzado');
    this.calls.push(now);
  }

  async #call(messages) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.cfg.model, max_tokens: this.cfg.maxTokens, system: this.system(), tools: TOOLS, messages }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `API de Claude respondió HTTP ${res.status}`);
    return body;
  }

  // history: [{role:'user'|'assistant', content:'texto'}]
  async chat(history) {
    if (!this.available) throw new Error('Configura ANTHROPIC_API_KEY en el .env de la Raspberry');
    this.#rateLimit();
    this.#expire();
    this.#newActions = [];
    const messages = history.slice(-20).filter((m) => m.content?.trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 8000) }));
    if (messages[0]?.role !== 'user') messages.shift();
    const used = [];
    let usage = { input_tokens: 0, output_tokens: 0 };

    for (let i = 0; i < this.cfg.maxToolRounds; i++) {
      const r = await this.#call(messages);
      usage.input_tokens += r.usage?.input_tokens || 0;
      usage.output_tokens += r.usage?.output_tokens || 0;
      messages.push({ role: 'assistant', content: r.content });
      if (r.stop_reason !== 'tool_use') {
        const reply = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return { reply, tools: used, actions: this.#newActions, usage };
      }
      const results = [];
      for (const b of r.content.filter((x) => x.type === 'tool_use')) {
        used.push(b.name);
        try { results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await this.#tool(b.name, b.input || {})) }); }
        catch (e) { results.push({ type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true }); }
      }
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'La consulta requirió demasiados pasos. Intenta una pregunta más concreta.', tools: used, actions: this.#newActions, usage };
  }

  #expire() {
    const now = Date.now();
    for (const [id, a] of this.pending) if (now - a.ts > 10 * 60_000) this.pending.delete(id);
  }

  async confirm(id, approve) {
    this.#expire();
    const a = this.pending.get(id);
    if (!a) throw new Error('La acción no existe o expiró (10 min)');
    this.pending.delete(id);
    if (!approve) return { ok: true, discarded: true };
    const pin = await this.ctx.gpio.set(a.gpio, a.activar, 'user');
    return { ok: true, pin, action: a };
  }

  // Exportado para pruebas
  runTool(name, input) { return this.#tool(name, input); }
}

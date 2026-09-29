# Bypass automático (módulo 2)

Transfiere la carga a la red cuando la UPS deja de entregar energía en su salida, y la regresa
cuando la UPS se recupera.

> **Advertencia.** Este módulo conmuta tensión de red. La instalación debe hacerla personal
> calificado, cumpliendo RETIE. El software es la **tercera** capa de protección; las dos primeras
> son el enclavamiento mecánico y el eléctrico entre contactores. Nunca instales el bypass
> confiando solo en el software.

## Por qué nunca pueden cerrarse ambos caminos

La salida de una UPS online no está necesariamente en fase con la red. Cerrar K1 y K2 a la vez
pone en paralelo dos fuentes desfasadas: cortocircuito, daño del inversor de la UPS y disparo de
protecciones. Por eso la secuencia es siempre **abrir, esperar, verificar y luego cerrar** (break-before-make).

## Tres capas de protección

1. **Enclavamiento mecánico.** Usa un par de contactores con enclavamiento mecánico (kit de inversión o
   interlock del fabricante). Físicamente no pueden cerrar juntos.
2. **Enclavamiento eléctrico.** El contacto auxiliar NC de K1 va en serie con la bobina de K2, y el NC
   de K2 en serie con la bobina de K1.
3. **Software.** Break-before-make con tiempo muerto, verificación por contactos auxiliares (opcional),
   interlock que abre el bypass si detecta ambos caminos cerrados, antirrebote de la falla, límite de
   transferencias y bloqueo.

## Diseño a prueba de fallas

Si la Raspberry se apaga, se cuelga o el servicio se detiene, los relés se desenergizan y **la carga
queda en la UPS**, que es el estado normal.

| Salida GPIO | Relé activo significa | Contacto del módulo de relé usado |
|---|---|---|
| K1 `relayUps` | **Abrir** el camino UPS a carga | NC: relé inactivo = bobina K1 energizada = UPS conectada |
| K2 `relayBypass` | **Cerrar** el camino red a carga | NO: relé inactivo = bobina K2 sin energía = bypass abierto |

## Conexiones por defecto

| Función | GPIO | Pin físico |
|---|---|---|
| Relé K1, abrir salida UPS | GPIO5 | 29 |
| Relé K2, cerrar bypass | GPIO6 | 31 |
| Sensor de voltaje en salida UPS | GPIO16 | 36 |
| Sensor de voltaje de red | GPIO20 | 38 |
| Auxiliar NO de K1 (opcional) | GPIO21 sugerido | 40 |
| Auxiliar NO de K2 (opcional) | GPIO26 sugerido | 37 |

Para cambiarlas crea `edge/config/local.json`:

```json
{ "bypass": { "pins": { "relayUps": 5, "relayBypass": 6, "senseUpsOut": 16, "senseGrid": 20, "feedbackUps": 21, "feedbackBypass": 26 } } }
```

## Cableado de fuerza

```
RED ──┬──────────────────────── [K2 NO] ──────────┐
      │                                           ├── CARGA
      └── UPS (entrada)   UPS (salida) ─ [K1] ────┘
                               │
                         sensor salida UPS  (ANTES de K1)
```

- **Bobina de K1** alimentada desde la **salida de la UPS**, a través del contacto NC del relé de GPIO5
  y del auxiliar NC de K2.
- **Bobina de K2** alimentada desde la **red**, a través del contacto NO del relé de GPIO6 y del auxiliar NC de K1.
- **Sensor de salida UPS** en los bornes de salida de la UPS, **antes** de K1. Debe poder ver cuándo
  la UPS se recupera mientras K1 está abierto.
- **Sensor de red** en la alimentación del camino de bypass, antes de K2.
- Contactores dimensionados para la corriente de la carga. Los módulos de relé de la Pi **solo**
  manejan bobinas, nunca la carga.

## Sensores

- Módulos detectores de voltaje AC con optoacoplador, verificados para 120 V. La salida baja cuando
  hay voltaje, así que la configuración por defecto es `senseActiveLow: true` con `sensePull: "up"`.
- Auxiliares de contactor: un lado a GND y el otro al GPIO con pull-up. Activo = contacto cerrado.
- Si no hay sensor de salida y `useUpsData` es true, se usan los datos del puerto de la UPS
  (salida < `outputMinV`, falla o apagado). Es menos confiable: si la UPS muere, también puede morir su puerto.

## Parámetros (`config/default.json` > `bypass`)

| Parámetro | Defecto | Uso |
|---|---|---|
| `confirmMs` | 500 | La falla debe durar esto antes de transferir (evita transferencias por ruido) |
| `deadTimeMs` | 300 | Espera entre abrir un contactor y cerrar el otro. Debe superar el tiempo de apertura del contactor |
| `autoReturn` | true | Regresa solo a la UPS cuando su salida esté estable |
| `returnDelaySec` | 60 | Tiempo de salida UPS estable antes de regresar |
| `maxTransfers` / `windowMin` | 3 / 10 | Más transferencias que esto en la ventana = bloqueo |

### Retorno automático o manual

Toda transferencia interrumpe la carga durante el tiempo muerto más el tiempo de maniobra de los
contactores (unos 100 a 400 ms). Las fuentes de equipos de TI soportan típicamente 10 a 20 ms, así que
**en el regreso a la UPS los equipos se reinician**.

- `autoReturn: true`: la carga no queda indefinidamente en red sin protección, pero hay un reinicio al regresar.
- `autoReturn: false`: la carga se queda en red hasta que el operador decida el regreso, en una ventana de mantenimiento.

Si la carga no tolera cortes, lo que se necesita es un **STS (static transfer switch)** o equipos con
doble fuente alimentados desde ambos caminos. Un bypass con contactores no puede ofrecer transferencia sin corte.

## Bloqueos

El bypass se bloquea (deja de actuar solo y conserva el estado actual) cuando:

- El auxiliar de K1 no confirma apertura. En ese caso no se cierra K2 y la carga vuelve a la UPS.
- El auxiliar de K2 no confirma apertura al regresar.
- Ambos caminos aparecen cerrados. En ese caso se abre K2 de inmediato.
- Se supera el límite de transferencias.

Se restablece desde el menú Bypass, con la clave de comandos, después de revisar la instalación.

## Puesta en marcha

1. Prueba todo primero en simulación en tu PC (`npm run sim` con `BYPASS_ENABLED=true`). El menú Bypass
   trae botones para simular fallas.
2. En la Pi, conecta **solo los módulos de relé y los sensores, sin fuerza**, y verifica cada GPIO desde el menú GPIO.
3. Verifica el enclavamiento mecánico y eléctrico con la instalación desenergizada.
4. Activa `BYPASS_ENABLED=true` en modo **manual** y prueba ambas transferencias con una carga de prueba no crítica.
5. Pasa a modo automático.

# Arquitectura

## Principio

Cada capa solo conoce a la de abajo mediante un contrato fijo. Cambiar de UPS o de protocolo
solo toca la capa 1; cambiar de nube solo toca la capa 4.

## Capa 1: Adquisición (`edge/src/drivers`)

Todos los drivers implementan:

```js
open()           // abre el puerto y lee datos estáticos (modelo, placa)
read()           // devuelve una lectura del modelo unificado
command(nombre)  // test | testCancel | beeperToggle | beeperMute
close()
info             // fabricante, modelo, firmware, datos nominales, protocolo, puerto
capabilities     // comandos soportados
```

Modelo unificado (`drivers/model.js`): `input`, `output`, `battery`, `ups`, `status`, `estimated`, `raw`.

- `raw` conserva **todo** lo que entregó el puerto (respuesta Q1 completa, bits de estado, variables NUT).
- `estimated` lista los campos calculados (p. ej. potencia desde % de carga × VA de placa) para que la web los marque con ≈.

### Protocolo Megatec (2400 8N1, terminador `\r`)

| Comando | Respuesta | Contenido |
|---|---|---|
| `Q1` | `(MMM.M NNN.N PPP.P QQQ RR.R S.SS TT.T b7..b0` | V entrada, V falla, V salida, % carga, Hz, V batería, °C, estado |
| `F` | `#MMM.M QQQ SS.SS RR.R` | V nominal, A nominal, V batería nominal, Hz nominal |
| `I` | `#Fabricante Modelo Versión` | Identificación |
| `T` / `CT` / `Q` | sin respuesta | Prueba 10 s / cancelar / beeper |

Bits de estado: b7 falla de red, b6 batería baja, b5 bypass/AVR, b4 falla UPS, b3 standby,
b2 prueba en curso, b1 apagado activo, b0 beeper.

### NUT

Lee `LIST VAR` por TCP 3493. NUT ya resuelve cientos de modelos USB HID; este proyecto
solo mapea sus variables al modelo unificado y conserva todas en `raw`.

## Capa 2: Núcleo

- **SQLite WAL** en `edge/data/ups.db`: tabla `readings` (una fila por lectura, retención 30 días), `events`, `outbox`.
- **Alarmas**: las críticas se activan en la primera lectura; el resto y todos los despejes requieren `debounce` lecturas seguidas.
- **Energía**: integración trapezoidal de la potencia activa, ignora huecos mayores a 3 min.

## Capa 3: Servicio web

Express sirve la API y `edge/public`. WebSocket empuja cada lectura (cada 2 s por defecto).
El dashboard es HTML/CSS/JS sin frameworks ni CDNs obligatorios: funciona en una LAN aislada.

Acceso remoto sin abrir puertos: ZeroTier o Cloudflare Tunnel apuntando a `localhost:8080`.

## Capa 4: Nube

- Submuestreo configurable (`sampleEverySec`, 30 s por defecto) para no saturar Supabase.
- `outbox` persistente: cortes de internet no pierden datos (tope `maxOutbox`).
- `ups_devices.latest` guarda el último estado completo para la vista de flota en tiempo real.
- RLS: la Pi escribe con `service_role`; los usuarios autenticados solo leen.

## Módulos 2 a 4

- **GPIO** (`src/gpio`): cada pin tiene un dueño (`user`, `bypass` o reservado). Un pin del bypass no se puede
  tocar desde la web ni desde la IA. En la Pi se usa un proceso Python con `lgpio` (preinstalado en Raspberry Pi OS,
  sin compilar nada); si ese proceso muere, las líneas se liberan, los relés caen y el bypass queda en su estado seguro.
  En PC se usa un backend simulado.
- **Bypass** (`src/bypass`): máquina de estados `ups`, `transfiriendo_a_bypass`, `bypass`, `transfiriendo_a_ups`,
  `bloqueado`, `deshabilitado`, evaluada cada 100 ms. Ver `docs/BYPASS.md`.
- **IA** (`src/ai`): Messages API de Claude con uso de herramientas. El historial de la conversación vive en el
  navegador; la Pi solo guarda las acciones pendientes (10 min de vigencia).

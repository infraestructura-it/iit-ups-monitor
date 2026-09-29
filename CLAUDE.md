# CLAUDE.md

Guía para Claude Code en el repositorio `infraestructura-it/iit-ups-monitor`.

## Proyecto

Monitoreo y control web de UPS con una **Raspberry Pi 5**. Infraestructura-IT, Bogotá. Todo web, por capas, en siete fichas (menú superior):

| Módulo | Página | Código |
|---|---|---|
| 1 UPS | `edge/public/index.html` | `edge/src/drivers`, `storage`, `alarms` |
| 2 Bypass | `edge/public/bypass.html` | `edge/src/bypass/bypass-controller.js` |
| 3 GPIO | `edge/public/gpio.html` | `edge/src/gpio` |
| 4 IA | `edge/public/ia.html` | `edge/src/ai/assistant.js` |
| 5 Reportes | `edge/public/reportes.html` | `edge/src/reports` (`report.js`, `excel.js`) |
| 6 Seguridad | `edge/public/seguridad.html`, `login.html` | `edge/src/security` |
| 7 Tomas | `edge/public/tomas.html` | `edge/src/outlets/outlets.js` |

Capas: adquisición (drivers) → núcleo (SQLite, alarmas) → servicio web (Express + WebSocket + dashboard) → nube (Supabase, opcional).
Detalle en `docs/ARQUITECTURA.md`; hardware en `docs/HARDWARE.md`; bypass en `docs/BYPASS.md`.

## Comandos

Todo se ejecuta desde `edge/`:

```bash
npm install          # sin compilación nativa (SQLite es node:sqlite)
npm test             # node --test; debe quedar en verde antes de cada commit
npm run sim          # simulador de UPS + GPIO simulado en http://localhost:8080
npm run dev          # igual, con recarga al guardar
```

Al arrancar sin usuarios, la consola muestra un **código de instalación** para crear el primer administrador en `/login.html`.
Para probar el bypass en PC, en `edge/.env`: `BYPASS_ENABLED=true`. La página Bypass trae botones para simular fallas.
Para datos históricos de prueba en Reportes, insertar lecturas sintéticas en `edge/data/ups.db` (tabla `readings`).

En la Raspberry: `sudo ./deploy/install.sh` (o `--with-nut` para UPS USB HID). Servicio: `journalctl -u iit-ups-monitor -f`.

## Stack y convenciones

- **Node.js ≥ 22.13**, ES modules (`"type": "module"`), sin TypeScript ni frameworks de backend más allá de Express y `ws`.
- **Frontend en HTML/CSS/JS vanilla**, sin frameworks, sin build y sin CDNs obligatorios: el dashboard local debe funcionar en una LAN sin internet. Gráficas propias en canvas (`public/js/chart.js`).
- Estética IIT oscura: fondo `#080b10`, cian `#00D4FF` = energía de red, verde `#10B981` = normal/UPS, púrpura `#7C3AED` = batería/bypass, ámbar y rojo solo para alertas. Tipografías Syne y DM Mono. Variables en `public/css/style.css`.
- **Interfaz, mensajes, logs y comentarios en español** (Colombia). Red eléctrica por defecto: 120 V / 60 Hz.
- Evitar dependencias nativas nuevas: deben instalar sin Visual Studio en Windows y sin compilar en la Pi.
- `cloud/dashboard/css/style.css` y `js/chart.js` son copias de `edge/public`; si cambian allá, copiarlas.
- **SQLite y números:** `node:sqlite` enlaza los números de JS como REAL. Para agrupar por intervalo usar `CAST(ts / @b AS INTEGER) * @b`, nunca `(ts / @b) * @b`.
- **Reportes para clientes (Excel):** estilo corporativo azul `#1F4E79` y blanco, no la estética oscura del panel. Horas en hora local de Colombia (UTC-5).
- Configuración: `config/default.json` (versionado) ← `config/local.json` (no versionado) ← `.env` ← variables de entorno. Ver `src/config.js`.

## Modelo de datos

Todo driver devuelve el modelo unificado de `src/drivers/model.js` (`input`, `output`, `battery`, `ups`, `status`, `estimated`, `raw`).
- `raw` guarda **todo** lo que entregó el puerto, sin procesar.
- Todo valor calculado (no reportado por la UPS) se agrega a `estimated`; la web lo marca con ≈. No presentar estimaciones como mediciones.

## Reglas de seguridad (no negociables)

El módulo de bypass conmuta tensión de red. Cualquier cambio en `src/bypass` o `src/gpio` debe respetar:

1. **Nunca ambos caminos cerrados.** La salida de la UPS y la red jamás en paralelo. Secuencia siempre break-before-make: abrir, tiempo muerto, verificar, cerrar.
2. **Estado a prueba de fallas = relés inactivos.** En el bypass: carga en la UPS. En las tomas: relé activo = toma APAGADA (contacto NC), así que con la Pi caída todas quedan energizadas. No invertir esta lógica.
3. **Dueños de pines.** Un GPIO con dueño `bypass` o `tomas` no se puede modificar desde la ficha GPIO ni desde la IA; cada módulo gestiona los suyos (`claim` / `release`).
4. **La IA es de solo lectura sobre la UPS, el bypass y las tomas.** Sobre GPIO solo propone; la ejecución requiere confirmación humana con `API_COMMAND_KEY`. No agregar herramientas que actúen directamente.
5. **Toda ruta nueva de la API lleva `need('<permiso>')`** (ver `PERMS` en `src/security/security.js`). Lectura para ver, Operador para accionar, Administrador para configurar. Nada queda abierto por omisión.
6. Todo cambio en el bypass va acompañado de pruebas en `test/bypass.test.js` que verifiquen la **secuencia física** de relés, no solo el estado final.
7. Sesiones: cookie HttpOnly + SameSite=Strict, verificación de origen en métodos que modifican. Contraseñas con scrypt. Tokens de API guardados solo como hash SHA-256; se muestran una vez.
8. Toda acción de seguridad o física queda en la tabla `audit`.

## Pruebas

- `test/parsers.test.js`: protocolos Megatec y NUT, alarmas.
- `test/bypass.test.js`: secuencias, interlock, bloqueos, retorno, dueños de pines (backend GPIO simulado).
- `test/ai.test.js`: herramientas y ciclo de uso de herramientas con `fetch` simulado. **No llamar a la API real en pruebas.**
- `test/security.test.js`: contraseñas, instalación, roles, bloqueo por intentos, tokens, CIDR, auto-bloqueo.
- `test/reports.test.js`: agregación, cortes de energía, Excel (se abre y verifica con exceljs), límite de filas.
- `test/outlets.test.js`: conmutación a prueba de fallas, reinicio, desconexión y restauración en batería, persistencia, acoplamiento con la UPS simulada.
- `test/fake-ups.js`: UPS Megatec falsa por puerto serie virtual (`socat`) para probar el driver real.

## Git

- Rama `main`, repo en la organización `infraestructura-it`.
- Mensajes de commit en español, en imperativo y descriptivos (ej.: "Agrega modo changeover al bypass").
- No versionar: `node_modules`, `edge/data`, `.env`, `config/local.json`.
- Los `.sh`, `.service` y `.rules` deben conservar finales de línea LF (`.gitattributes`); se ejecutan en Linux.

## Pendientes conocidos

- Bypass: definir si el hardware será dos contactores (K1/K2, diseño actual) o un solo relé/contactor de conmutación (modo `changeover`, pendiente de implementar).
- GPIO: expansores MCP23017 por I2C para superar las 26 líneas nativas (las 17 tomas + bypass ya usan 21).
- Tomas: medición real por toma (transformadores de corriente + ADC I2C); hoy es simulada.
- IA: análisis automático al ocurrir eventos críticos.
- Seguridad: HTTPS directo en la Pi (hoy se recomienda Cloudflare Tunnel o ZeroTier para acceso remoto); segundo factor (TOTP) para administradores.

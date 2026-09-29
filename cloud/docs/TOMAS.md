# Panel de tomas (ficha 7)

Panel de distribución (PDU) alimentado por la salida de la UPS:

| Tomas | Tipo | Capacidad | Continuo recomendado (80%) |
|---|---|---|---|
| T1 a T15 | NEMA 5-15R | 120 V, 15 A | 12 A |
| L1, L2 | NEMA L5-30R (con seguro de giro) | 120 V, 30 A | 24 A |

## Funciones

- **Encender y apagar** cada toma (rol Operador). Apagar una toma marcada como crítica pide confirmación.
- **Reinicio remoto**: apaga la toma `cycleSec` segundos (10 por defecto) y la vuelve a encender. Sirve para reiniciar un equipo colgado sin ir al sitio.
- **Encendido escalonado**: "Encender todas" las enciende una por una cada `sequenceMs` para no sumar las corrientes de arranque de todas las fuentes.
- **Desconexión de carga en batería** (load shedding):
  1. En baterías, tras `shedNonCriticalAfterSec` se apagan las tomas **no críticas**.
  2. Si la batería baja a `shedNormalBelowPct` se apagan las **normales**.
  3. Las **críticas** nunca se apagan solas.
  4. Con la red estable `restoreAfterSec`, se restauran en forma escalonada **solo** las que apagó el sistema. Lo que un operador apagó a mano sigue apagado.
- **Alarma de sobrecorriente** al superar el 80% continuo de la toma.
- La IA puede consultar el panel (solo lectura).

## Medición

No hay medidor por toma: la potencia y la corriente por toma son **simuladas** con la carga configurada en cada una (`Carga simulada (W)`).
En simulación, la carga de la UPS de la ficha 1 es la suma de las tomas, así que apagar tomas baja la carga y sube la autonomía.
Para medición real por toma se necesitan sensores de corriente (por ejemplo transformadores de corriente con un ADC por I2C); queda como mejora futura.

## Cableado a prueba de fallas

> Trabajo en tensión de red: personal calificado y cumplimiento de RETIE.

Cada toma se alimenta por el **contacto NC** de su relé o contactor. **Relé activo = toma apagada.**
Si la Raspberry se apaga, se reinicia o el servicio falla, los relés caen y **todas las tomas quedan energizadas**.

- Los relés deben soportar la corriente de la toma: 15 A para las 5-15R y **contactor de 30 A** para las L5-30R.
  Los módulos de relé de 10 A comunes **no** sirven para cargas de 15 A.
- La bobina del contactor se maneja con el módulo de relé del GPIO, nunca directamente desde la Pi.
- Cada toma conserva su protección (breaker) aguas arriba.

## Asignación de GPIO

Una toma sin GPIO es **virtual**: funciona completa en simulación. Para conectarla a un relé, un administrador le asigna un GPIO libre desde la ficha.
El pin queda con dueño `tomas`: no se puede tocar desde la ficha GPIO ni reutilizar para otra toma o para el bypass.

Las 17 tomas más los 4 pines del bypass son 21 GPIO de los 26 del conector. Si además necesitas I2C (GPIO2/3) o el UART (GPIO14/15), se justifica pasar las tomas a expansores **MCP23017** (pendiente).

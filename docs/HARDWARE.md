# Conexión física

## Opción A: adaptador USB-RS232 (recomendada)

UPS DB9 → cable → adaptador USB-RS232 (FTDI o PL2303 originales) → USB de la Pi 5.
La regla udev crea `/dev/ups-serial` para que el puerto no cambie de nombre.

## Opción B: UART del GPIO con MAX3232

**Nunca conectes RS232 directo al GPIO**: RS232 maneja ±12 V y el GPIO del Pi es 3,3 V; lo destruye.

| MAX3232 | Pi 5 |
|---|---|
| VCC | 3,3 V (pin 1) |
| GND | GND (pin 6) |
| TXD | GPIO14 TXD (pin 8) |
| RXD | GPIO15 RXD (pin 10) |

En `/boot/firmware/config.txt` agrega `dtparam=uart0=on`, reinicia y usa `UPS_PORT=/dev/ttyAMA0`
(o descomenta la línea de `ttyAMA0` en `deploy/udev/99-iit-ups.rules`).

## Opción C: USB directo de la UPS

```bash
lsusb
```

| Aparece como | Driver |
|---|---|
| `/dev/ttyUSB0` (CH340, PL2303, CP210x) | `megatec` con ese puerto |
| `0665:5161` Cypress "USB to Serial" | `nut` con `nutdrv_qx` (ver `deploy/nut/ups.conf`) |
| APC `051d`, Eaton `0463`, CyberPower `0764`, Tripp Lite `09ae` | `nut` con `usbhid-ups` |

## Cable RS232: verifica antes de conectar

- La mayoría de UPS Megatec usan cable directo pines 2-3-5; algunas usan cruzado. Si no hay respuesta, prueba intercambiar 2 y 3.
- **APC Smart-UPS por DB9**: requiere el cable propietario 940-0024C. Un cable serie estándar puede **apagar la UPS y la carga** al conectarlo. Con APC prefiere USB + NUT.
- Algunos DB9 de UPS económicas son solo **contacto seco** (relés de alarma), no datos. Ahí no hay protocolo que leer.

## Diagnóstico rápido

```bash
sudo apt install -y minicom
minicom -D /dev/ups-serial -b 2400
# escribe Q1 y Enter: debe responder algo como "(121.0 121.0 120.0 034 60.0 27.2 32.0 00001001"
```

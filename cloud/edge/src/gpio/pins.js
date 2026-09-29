// Conector de 40 pines de la Raspberry Pi 5 (numeración BCM -> pin físico)
// GPIO 2..27 = 26 líneas utilizables. GPIO 0/1 (ID EEPROM) no se exponen.
export const HEADER = [
  { gpio: 2,  pin: 3,  alt: 'I2C1 SDA (pull-up fijo 1,8 kΩ)' },
  { gpio: 3,  pin: 5,  alt: 'I2C1 SCL (pull-up fijo 1,8 kΩ)' },
  { gpio: 4,  pin: 7,  alt: 'GPCLK0' },
  { gpio: 5,  pin: 29, alt: '' },
  { gpio: 6,  pin: 31, alt: '' },
  { gpio: 7,  pin: 26, alt: 'SPI0 CE1' },
  { gpio: 8,  pin: 24, alt: 'SPI0 CE0' },
  { gpio: 9,  pin: 21, alt: 'SPI0 MISO' },
  { gpio: 10, pin: 19, alt: 'SPI0 MOSI' },
  { gpio: 11, pin: 23, alt: 'SPI0 SCLK' },
  { gpio: 12, pin: 32, alt: 'PWM0' },
  { gpio: 13, pin: 33, alt: 'PWM1' },
  { gpio: 14, pin: 8,  alt: 'UART0 TX' },
  { gpio: 15, pin: 10, alt: 'UART0 RX' },
  { gpio: 16, pin: 36, alt: '' },
  { gpio: 17, pin: 11, alt: '' },
  { gpio: 18, pin: 12, alt: 'PCM CLK / PWM0' },
  { gpio: 19, pin: 35, alt: 'PCM FS / PWM1' },
  { gpio: 20, pin: 38, alt: 'PCM DIN' },
  { gpio: 21, pin: 40, alt: 'PCM DOUT' },
  { gpio: 22, pin: 15, alt: '' },
  { gpio: 23, pin: 16, alt: '' },
  { gpio: 24, pin: 18, alt: '' },
  { gpio: 25, pin: 22, alt: '' },
  { gpio: 26, pin: 37, alt: '' },
  { gpio: 27, pin: 13, alt: '' },
];

// Pines físicos que no son GPIO (para dibujar el conector completo)
export const POWER_PINS = {
  1: '3V3', 2: '5V', 4: '5V', 6: 'GND', 9: 'GND', 14: 'GND', 17: '3V3', 20: 'GND',
  25: 'GND', 27: 'ID_SD', 28: 'ID_SC', 30: 'GND', 34: 'GND', 39: 'GND',
};

export const byGpio = new Map(HEADER.map((h) => [h.gpio, h]));

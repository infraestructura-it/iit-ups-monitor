// UPS Megatec falsa para pruebas: node test/fake-ups.js /dev/pts/X
import { SerialPort } from 'serialport';
const port = new SerialPort({ path: process.argv[2], baudRate: 2400 });
let buf = '', beeper = 1, onBatt = false;
setInterval(() => (onBatt = !onBatt), 8000);
port.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\r')) >= 0) {
    const cmd = buf.slice(0, i); buf = buf.slice(i + 1);
    if (cmd === 'Q1') port.write(onBatt
      ? `(000.0 000.0 119.9 052 00.0 23.10 34.0 1000100${beeper}\r`
      : `(122.3 122.3 120.0 051 60.0 27.20 33.0 0000100${beeper}\r`);
    else if (cmd === 'F') port.write('#120.0 025 24.00 60.0\r');
    else if (cmd === 'I') port.write('#MEGATEC         OnLine3K   V1.2      \r');
    else if (cmd === 'Q') beeper ^= 1;
  }
});

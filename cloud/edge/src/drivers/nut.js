// Driver NUT (Network UPS Tools). Cubre UPS USB HID (APC, Eaton, CyberPower, Tripp Lite, Riello,
// Megatec USB 0665:5161 vía nutdrv_qx...) y también serie con drivers blazer_ser/nutdrv_qx/apcsmart.
// NUT expone todas las variables del puerto; aquí se leen con "LIST VAR" por TCP (puerto 3493).
import net from 'node:net';
import { emptyReading, fillEstimates, toNum } from './model.js';

function nutSession(cfg, lines, endMatcher) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: cfg.host, port: cfg.port });
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('Timeout NUT')); }, cfg.timeoutMs || 3000);
    sock.on('connect', () => sock.write(lines.join('\n') + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      if (/^ERR /m.test(buf)) { clearTimeout(t); sock.end(); return reject(new Error(buf.match(/^ERR .*/m)[0])); }
      if (endMatcher(buf)) { clearTimeout(t); sock.end('LOGOUT\n'); resolve(buf); }
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export function parseListVar(text) {
  const vars = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^VAR \S+ (\S+) "(.*)"$/);
    if (m) vars[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return vars;
}

export class NutDriver {
  constructor(cfg, nameplate) {
    this.cfg = cfg;
    this.nameplate = nameplate;
    this.name = 'nut';
    this.info = { manufacturer: null, model: null, firmware: null, serial: null, ratings: {}, protocol: 'NUT', port: `${cfg.host}:${cfg.port}/${cfg.ups}` };
    this.capabilities = { commands: ['test', 'testCancel', 'beeperToggle', 'beeperMute'] };
  }

  async open() { await this.read(); }

  async read() {
    const text = await nutSession(this.cfg, [`LIST VAR ${this.cfg.ups}`], (b) => b.includes(`END LIST VAR ${this.cfg.ups}`));
    const v = parseListVar(text);
    const n = (k) => toNum(v[k]);
    const r = emptyReading(this.name);

    r.input.voltage = n('input.voltage');
    r.input.faultVoltage = n('input.voltage.fault');
    r.input.frequency = n('input.frequency');
    r.input.current = n('input.current');
    r.output.voltage = n('output.voltage');
    r.output.frequency = n('output.frequency');
    r.output.current = n('output.current');
    r.output.loadPct = n('ups.load');
    r.output.apparentPowerVA = n('ups.power');
    r.output.realPowerW = n('ups.realpower');
    r.battery.voltage = n('battery.voltage');
    r.battery.chargePct = n('battery.charge');
    r.battery.runtimeSec = n('battery.runtime');
    r.battery.temperatureC = n('battery.temperature');
    r.ups.temperatureC = n('ups.temperature') ?? n('battery.temperature');

    const st = (v['ups.status'] || '').split(/\s+/).filter(Boolean);
    const has = (c) => st.includes(c);
    Object.assign(r.status, {
      online: has('OL'), onBattery: has('OB'), lowBattery: has('LB'), bypass: has('BYPASS'),
      fault: has('ALARM') || has('OFF'), testing: has('TEST') || has('CAL'), shutdownActive: has('FSD'),
      charging: has('CHRG') ? true : has('DISCHRG') ? false : null, overload: has('OVER'),
      beeperOn: v['ups.beeper.status'] ? v['ups.beeper.status'] === 'enabled' : null,
      codes: st,
    });

    this.info.manufacturer = v['ups.mfr'] || v['device.mfr'] || null;
    this.info.model = v['ups.model'] || v['device.model'] || null;
    this.info.firmware = v['ups.firmware'] || null;
    this.info.serial = v['ups.serial'] || v['device.serial'] || null;
    this.info.driver = v['driver.name'] || null;
    this.info.ratings = {
      ratedVA: n('ups.power.nominal'),
      ratedW: n('ups.realpower.nominal'),
      ratedVoltage: n('input.voltage.nominal') ?? n('output.voltage.nominal'),
      ratedFrequency: n('input.frequency.nominal') ?? n('output.frequency.nominal'),
      ratedBatteryVoltage: n('battery.voltage.nominal'),
    };

    r.raw = v; // todas las variables publicadas por NUT
    return fillEstimates(r, this.info, this.nameplate);
  }

  async command(name) {
    const map = {
      test: 'test.battery.start.quick', testCancel: 'test.battery.stop',
      beeperToggle: 'beeper.toggle', beeperMute: 'beeper.mute',
    };
    if (!map[name]) throw new Error(`Comando no soportado: ${name}`);
    const { username, password, ups } = this.cfg;
    if (!password) throw new Error('Define NUT_PASSWORD (usuario con instcmds en upsd.users)');
    const out = await nutSession(this.cfg,
      [`USERNAME ${username}`, `PASSWORD ${password}`, `INSTCMD ${ups} ${map[name]}`],
      (b) => (b.match(/^OK/gm) || []).length >= 3);
    return { sent: map[name], reply: out.trim() };
  }

  async close() {}
}

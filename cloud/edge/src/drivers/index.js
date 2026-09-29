import { MegatecDriver } from './megatec.js';
import { NutDriver } from './nut.js';
import { SimulatorDriver } from './simulator.js';

export function createDriver(cfg) {
  switch (cfg.type) {
    case 'megatec': return new MegatecDriver(cfg.megatec, cfg.nameplate);
    case 'nut': return new NutDriver(cfg.nut, cfg.nameplate);
    case 'simulator': return new SimulatorDriver({}, cfg.nameplate);
    default: throw new Error(`Driver desconocido: ${cfg.type} (usa megatec | nut | simulator)`);
  }
}

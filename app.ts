'use strict';

import Homey from 'homey';
import { CentralSystem } from './lib/ocpp/CentralSystem';
import { ChargePoint } from './lib/ocpp/ChargePoint';

const DEFAULT_PORT = 9000;

/**
 * ChargeIQ — embeds the OCPP 1.6J Central System and orchestrates charging.
 * The Central System lives here on the App instance so it is available whenever
 * the app runs, independent of device pairing. Charger devices reach it via
 * `this.homey.app` (typed as ChargeIQApp).
 */
module.exports = class ChargeIQApp extends Homey.App {

  private centralSystem!: CentralSystem;

  async onInit() {
    const port = (this.homey.settings.get('ocppPort') as number) || DEFAULT_PORT;

    this.centralSystem = new CentralSystem({
      port,
      authorize: (idTag) => this.authorize(idTag),
      allocateTransactionId: () => this.allocateTransactionId(),
      logger: (msg, ...args) => this.log(msg, ...args),
    });

    try {
      await this.centralSystem.start();
    } catch (err) {
      this.error('Failed to start OCPP Central System:', err);
      throw err;
    }

    this.log(`ChargeIQ initialised; OCPP CS on port ${port}`);
  }

  async onUninit() {
    await this.centralSystem?.stop();
  }

  /** Expose the Central System to drivers/devices. */
  getCentralSystem(): CentralSystem {
    return this.centralSystem;
  }

  getChargePoint(identity: string): ChargePoint | undefined {
    return this.centralSystem.getChargePoint(identity);
  }

  /** Authorize policy: accept-all, or an idTag whitelist from settings. */
  private authorize(idTag: string): boolean {
    const mode = this.homey.settings.get('authorizeMode') as string | undefined;
    if (mode === 'whitelist') {
      const list = (this.homey.settings.get('idTagWhitelist') as string[]) || [];
      return list.includes(idTag);
    }
    return true; // accept-all (default)
  }

  /** Monotonic, persisted transaction id source. */
  private allocateTransactionId(): number {
    const next = ((this.homey.settings.get('txCounter') as number) || 0) + 1;
    this.homey.settings.set('txCounter', next);
    return next;
  }

};

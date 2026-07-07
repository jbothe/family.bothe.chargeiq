'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';
import { ChargePoint } from '../../lib/ocpp/ChargePoint';
import { ChargeController, ChargeMode, ControllerHost } from '../../lib/control/ChargeController';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
  getChargePoint(identity: string): ChargePoint | undefined;
}

const CAPABILITIES = [
  'charge_mode', 'evcharger_charging', 'evcharger_charging_state', 'charger_status',
  'measure_power', 'measure_current', 'measure_voltage', 'meter_power', 'charge_current_limit',
];

module.exports = class ChargerDevice extends Homey.Device {

  private controller!: ChargeController;

  async onInit() {
    await this.ensureCapabilities();

    const app = this.homey.app as ChargeIQApp;
    this.controller = new ChargeController(this.buildHost(), app.getCentralSystem());
    this.controller.init();

    this.registerCapabilityListener('evcharger_charging', async (value: boolean) => {
      if (value) {
        const amps = this.getCapabilityValue('charge_current_limit') as number | null;
        await this.controller.startManual(amps ?? undefined);
      } else {
        await this.controller.stop();
      }
    });

    this.registerCapabilityListener('charge_current_limit', async (value: number) => {
      await this.controller.setCurrentLimit(value);
    });

    this.registerCapabilityListener('charge_mode', async (value: ChargeMode) => {
      await this.controller.setMode(value);
    });

    this.log(`ChargerDevice ${this.getData().id} initialised`);
  }

  async onSettings() {
    this.controller?.refreshConfig();
  }

  private async ensureCapabilities() {
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    if (this.getCapabilityValue('charge_current_limit') === null) {
      await this.setCapabilityValue('charge_current_limit', 6).catch(this.error);
    }
  }

  /** Adapter implementing the controller's minimal host surface. */
  private buildHost(): ControllerHost {
    return {
      identity: this.getData().id as string,
      setCapability: (cap, value) => {
        if (this.hasCapability(cap)) this.setCapabilityValue(cap, value as any).catch(this.error);
      },
      getSetting: <T>(key: string) => this.getSetting(key) as T,
      getStore: <T>(key: string) => this.getStoreValue(key) as T,
      setStore: (key, value) => this.setStoreValue(key, value),
      setAvailable: () => { this.setAvailable().catch(this.error); },
      setUnavailable: (msg) => { this.setUnavailable(msg).catch(this.error); },
      setWarning: (msg) => {
        (msg ? this.setWarning(msg) : this.unsetWarning()).catch(this.error);
      },
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    };
  }

};

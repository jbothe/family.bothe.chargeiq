'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';
import { ChargePoint } from '../../lib/ocpp/ChargePoint';
import { ChargeController, ChargeMode, ControllerHost } from '../../lib/control/ChargeController';
import { ScheduleWindow } from '../../lib/control/Scheduler';
import { SolarFeed, SolarSample } from '../../lib/solar/SolarFeed';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
  getChargePoint(identity: string): ChargePoint | undefined;
  getSolarFeed(): SolarFeed;
}

const CAPABILITIES = [
  'charge_mode', 'evcharger_charging', 'evcharger_charging_state', 'charger_status',
  'measure_power', 'measure_current', 'measure_voltage', 'meter_power', 'charge_current_limit',
  'measure_solar_surplus',
];

module.exports = class ChargerDevice extends Homey.Device {

  private controller!: ChargeController;

  private startedTrigger!: Homey.FlowCardTriggerDevice;

  private stoppedTrigger!: Homey.FlowCardTriggerDevice;

  private modeTrigger!: Homey.FlowCardTriggerDevice;

  private onSolarSample?: (s: SolarSample) => void;

  private lastSolarSample: SolarSample | null = null;

  /**
   * Homey's onSettings hook fires *before* the new values are actually
   * persisted - this.getSetting() during that call still returns the OLD
   * settings, so refreshConfig() would silently read one generation stale.
   * newSettings (the full, fresh settings object) is cached here for the
   * duration of that one refresh so buildHost().getSetting sees the values
   * that were just saved, not the ones about to be replaced.
   */
  private pendingSettings: Record<string, boolean | string | number | undefined | null> | null = null;

  async onInit() {
    await this.ensureCapabilities();

    this.startedTrigger = this.homey.flow.getDeviceTriggerCard('charging_started');
    this.stoppedTrigger = this.homey.flow.getDeviceTriggerCard('charging_stopped');
    this.modeTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');

    const app = this.homey.app as ChargeIQApp;
    this.controller = new ChargeController(this.buildHost(), app.getCentralSystem());
    this.controller.init();

    // Feed grid power into the solar loop; keep the latest sample for the widget.
    const feed = app.getSolarFeed();
    this.onSolarSample = (s: SolarSample) => {
      this.lastSolarSample = s;
      this.controller.onSolarSample(s);
    };
    feed?.on('sample', this.onSolarSample);
    this.lastSolarSample = feed?.getSample() ?? null;

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
    // charge_mode is now a read-only derived metric — no listener.

    this.log(`ChargerDevice ${this.getData().id} initialised`);
  }

  async onSettings({ newSettings }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }) {
    this.pendingSettings = newSettings;
    try {
      this.controller?.refreshConfig();
    } finally {
      this.pendingSettings = null;
    }
  }

  async onDeleted() {
    this.controller?.destroy();
    if (this.onSolarSample) {
      (this.homey.app as ChargeIQApp).getSolarFeed()?.removeListener('sample', this.onSolarSample);
    }
  }

  /** Latest merged solar sample (for the widget). */
  getSolarSample(): SolarSample | null {
    return this.lastSolarSample;
  }

  /** Excess-solar / loop diagnostics (for the widget + metrics). */
  getDiagnostics() {
    return this.controller.getDiagnostics();
  }

  /** Derived mode + short status detail (for the widget). */
  getModeInfo() {
    return this.controller.getModeInfo();
  }

  // --- Flow card entry points -------------------------------------------------

  flowStart(current?: number) {
    return this.controller.startManual(current);
  }

  flowStop() {
    return this.controller.stop();
  }

  flowSetCurrent(current: number) {
    return this.controller.setCurrentLimit(current);
  }

  flowIsCharging() {
    return this.controller.isCharging();
  }

  flowModeIs(mode: ChargeMode) {
    return this.controller.getMode() === mode;
  }

  flowWithinSchedule() {
    return this.controller.isWithinSchedule();
  }

  /** Used by the settings/widget editor to persist weekly windows. */
  setSchedule(windows: ScheduleWindow[]) {
    return this.controller.setSchedule(windows);
  }

  getSchedule() {
    return this.controller.getSchedule();
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
        if (this.hasCapability(cap)) this.setCapabilityValue(cap, value).catch(this.error);
      },
      getSetting: <T>(key: string) => (
        this.pendingSettings && key in this.pendingSettings ? this.pendingSettings[key] : this.getSetting(key)
      ) as T,
      getStore: <T>(key: string) => this.getStoreValue(key) as T,
      setStore: (key, value) => this.setStoreValue(key, value),
      setAvailable: () => {
        this.setAvailable().catch(this.error);
      },
      setUnavailable: (msg) => {
        this.setUnavailable(msg).catch(this.error);
      },
      setWarning: (msg) => {
        (msg ? this.setWarning(msg) : this.unsetWarning()).catch(this.error);
      },
      // Route controller diagnostics through the app logger for a short prefix
      // ([ChargeIQApp] …) instead of Homey's long [ManagerDrivers][Driver][Device:uuid].
      log: (...args) => this.homey.app.log(...args),
      error: (...args) => this.homey.app.error(...args),
      onChargingChanged: (charging) => {
        const card = charging ? this.startedTrigger : this.stoppedTrigger;
        card.trigger(this, {}, {}).catch(this.error);
      },
      onModeChanged: (mode) => {
        this.modeTrigger.trigger(this, { mode }, {}).catch(this.error);
      },
      // Homey's underlying OS clock runs in UTC regardless of the timezone
      // configured in the Homey app, so schedule windows need this explicitly.
      getTimezone: () => this.homey.clock.getTimezone(),
    };
  }

};

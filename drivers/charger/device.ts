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
  'evcharger_charging', 'charge_current_limit', 'charge_mode', 'evcharger_charging_state',
  'session_duration', 'meter_power.session', 'measure_solar_surplus', 'measure_power',
  'measure_current', 'measure_voltage', 'meter_power', 'alarm_generic',
];

// Capabilities from earlier versions to strip from already-paired devices.
const REMOVED_CAPABILITIES = ['charger_status'];

/**
 * Lower bound declared by the charge_current_limit capability itself
 * (.homeycompose/capabilities/charge_current_limit.json). The minAmps *setting*
 * allows values below this, so a seed value taken from it has to be floored
 * here or Homey rejects the write outright.
 */
const CHARGE_CURRENT_LIMIT_MIN_A = 6;

module.exports = class ChargerDevice extends Homey.Device {

  private controller!: ChargeController;

  private startedTrigger!: Homey.FlowCardTriggerDevice;

  private pausedTrigger!: Homey.FlowCardTriggerDevice;

  private stoppedTrigger!: Homey.FlowCardTriggerDevice;

  private modeTrigger!: Homey.FlowCardTriggerDevice;

  private faultTrigger!: Homey.FlowCardTriggerDevice;

  private vehicleConnectedTrigger!: Homey.FlowCardTriggerDevice;

  private vehicleDisconnectedTrigger!: Homey.FlowCardTriggerDevice;

  private offlineTrigger!: Homey.FlowCardTriggerDevice;

  private onlineTrigger!: Homey.FlowCardTriggerDevice;

  private onSolarSample?: (s: SolarSample) => void;

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
    this.pausedTrigger = this.homey.flow.getDeviceTriggerCard('charging_paused');
    this.stoppedTrigger = this.homey.flow.getDeviceTriggerCard('charging_stopped');
    this.modeTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
    this.faultTrigger = this.homey.flow.getDeviceTriggerCard('charger_fault');
    this.vehicleConnectedTrigger = this.homey.flow.getDeviceTriggerCard('vehicle_connected');
    this.vehicleDisconnectedTrigger = this.homey.flow.getDeviceTriggerCard('vehicle_disconnected');
    this.offlineTrigger = this.homey.flow.getDeviceTriggerCard('charger_offline');
    this.onlineTrigger = this.homey.flow.getDeviceTriggerCard('charger_online');

    const app = this.homey.app as ChargeIQApp;
    this.controller = new ChargeController(this.buildHost(), app.getCentralSystem());
    this.controller.init();

    // Feed grid power into the solar loop. The widget reads solar straight off
    // the app's SolarFeed, so nothing is cached here.
    const feed = app.getSolarFeed();
    this.onSolarSample = (s: SolarSample) => this.controller.onSolarSample(s);
    feed?.on('sample', this.onSolarSample);

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

  /**
   * Homey re-initialises a device without deleting it (app reload, device
   * repair), so onDeleted() alone is not enough: the controller subscribes to
   * the app-lifetime CentralSystem/ChargePoint, and the solar feed holds a
   * listener into this instance. Both have to go whenever this instance stops
   * being the live one, not only when the device is removed for good.
   */
  async onUninit() {
    this.teardown();
  }

  async onDeleted() {
    this.teardown();
  }

  private teardown() {
    this.controller?.destroy();
    if (this.onSolarSample) {
      (this.homey.app as ChargeIQApp).getSolarFeed()?.removeListener('sample', this.onSolarSample);
      this.onSolarSample = undefined;
    }
  }

  /** Excess-solar / loop diagnostics (for the widget + metrics). */
  getDiagnostics() {
    return this.controller?.getDiagnostics();
  }

  /** Derived mode + the raw facts behind it (for the widget's shorthand status). */
  getModeInfo() {
    return this.controller?.getModeInfo();
  }

  /** OCPP link state (for the widget's offline reporting). */
  getConnectionInfo() {
    return this.controller?.getConnectionInfo();
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

  flowIsOnline() {
    return this.controller.isOnline();
  }

  flowResumeAuto() {
    return this.controller.resumeAutomatic();
  }

  /** Used by the settings/widget editor to persist weekly windows. */
  setSchedule(windows: ScheduleWindow[]) {
    return this.controller.setSchedule(windows);
  }

  getSchedule() {
    return this.controller.getSchedule();
  }

  private async ensureCapabilities() {
    for (const cap of REMOVED_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    // Seed the slider from the configured minimum rather than a hardcoded 6, so
    // a freshly paired device doesn't briefly advertise a limit its own settings
    // rule out. Only ever the initial value - every later write comes from the
    // controller.
    if (this.getCapabilityValue('charge_current_limit') === null) {
      const minAmps = this.getSetting('minAmps') as number | undefined;
      const seed = Math.max(CHARGE_CURRENT_LIMIT_MIN_A, minAmps ?? CHARGE_CURRENT_LIMIT_MIN_A);
      await this.setCapabilityValue('charge_current_limit', seed).catch(this.error);
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
      onChargingEvent: (event, tokens) => {
        const card = {
          started: this.startedTrigger,
          paused: this.pausedTrigger,
          stopped: this.stoppedTrigger,
        }[event];
        card.trigger(this, {
          current: tokens.current,
          mode: tokens.mode,
          surplus: tokens.surplus,
          session_energy: tokens.sessionEnergy,
        }, {}).catch(this.error);
      },
      onModeChanged: (mode) => {
        this.modeTrigger.trigger(this, { mode }, {}).catch(this.error);
      },
      onFault: (errorCode) => {
        this.faultTrigger.trigger(this, { error_code: errorCode }, {}).catch(this.error);
      },
      onVehicleConnected: () => {
        this.vehicleConnectedTrigger.trigger(this, {}, {}).catch(this.error);
      },
      onVehicleDisconnected: () => {
        this.vehicleDisconnectedTrigger.trigger(this, {}, {}).catch(this.error);
      },
      onConnectivityChanged: (online, offlineForMs) => {
        if (online) {
          this.onlineTrigger.trigger(this, {
            offline_minutes: offlineForMs != null ? Math.round(offlineForMs / 60000) : 0,
          }, {}).catch(this.error);
        } else {
          // A local-time string, not an ISO stamp: this token lands straight in
          // a user's notification text. Homey's OS clock is UTC regardless of
          // the configured timezone, so it has to be passed explicitly.
          const seen = offlineForMs != null
            ? new Date(Date.now() - offlineForMs).toLocaleString('en-GB', { timeZone: this.homey.clock.getTimezone() })
            : 'never';
          this.offlineTrigger.trigger(this, { last_seen: seen }, {}).catch(this.error);
        }
      },
      // Homey's underlying OS clock runs in UTC regardless of the timezone
      // configured in the Homey app, so schedule windows need this explicitly.
      getTimezone: () => this.homey.clock.getTimezone(),
    };
  }

};

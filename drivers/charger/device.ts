'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';
import { ChargePoint } from '../../lib/ocpp/ChargePoint';
import { ChargeController, ControllerHost } from '../../lib/control/ChargeController';
import { ScheduleWindow } from '../../lib/control/Scheduler';
import { SolarFeed, SolarSample } from '../../lib/solar/SolarFeed';
import { resolveEnergyControl, TargetPowerOptions, targetPowerOptionsUpdate } from '../../lib/capabilities';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
  getChargePoint(identity: string): ChargePoint | undefined;
  getSolarFeed(): SolarFeed;
}

const CAPABILITIES = [
  'evcharger_charging', 'target_power', 'target_power_mode', 'evcharger_charging_state', 'measure_power',
  'charge_current_applied', 'charge_current_offered', 'measure_current', 'measure_voltage',
  'meter_power.session', 'session_duration', 'meter_power', 'measure_solar_surplus', 'alarm_generic',
];

// Fallbacks matching the defaults in driver.settings.compose.json, for the
// window before a device has settings of its own.
const DEFAULT_MIN_AMPS = 6;
const DEFAULT_MAX_AMPS = 32;
const DEFAULT_VOLTAGE = 230;
const DEFAULT_PHASES = 1;

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
    await this.syncTargetPowerOptions();
    await this.seedTargetPower();

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

    // One listener for all three: Homey's Set target power card sets them in
    // quick succession, and this debounces that into a single manual decision
    // instead of three. See resolveEnergyControl().
    this.registerMultipleCapabilityListener(
      ['target_power', 'target_power_mode', 'evcharger_charging'],
      async (values: Record<string, unknown>) => {
        const control = resolveEnergyControl({
          watts: values.target_power as number | undefined,
          mode: values.target_power_mode as string | undefined,
          charging: values.evcharger_charging as boolean | undefined,
        }, {
          watts: this.getCapabilityValue('target_power') as number | null,
          charging: this.controller.isChargeRequested(),
        }, this.wattsPerAmp());
        if (control.action === 'resume') {
          this.controller.resumeAutomatic(`target power mode -> ${values.target_power_mode}`);
          // Homey stores the picked value once this listener returns, which
          // would leave e.g. "Idle" showing while ChargeIQ resolves Solar.
          this.homey.setTimeout(() => this.controller?.republishMode(), 1000);
        } else if (control.action === 'charge') {
          await this.controller.startManual(control.amps);
        } else if (control.action === 'off') {
          await this.controller.stop();
        } else {
          this.homey.app.log(`[mode] target power ${values.target_power}W kept for the next start (not charging)`);
        }
      },
      500,
    );

    this.log(`ChargerDevice ${this.getData().id} initialised`);
  }

  async onSettings({ newSettings }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }) {
    this.pendingSettings = newSettings;
    try {
      // Inside the pendingSettings window on purpose: this reads the amp limits,
      // voltage and phases, and would otherwise see the previous generation,
      // exactly as refreshConfig() would. And before refreshConfig(), which
      // re-publishes target_power at the new conversion - a range not yet
      // widened to admit it would reject that write.
      await this.syncTargetPowerOptions();
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

  flowSetCurrent(current: number) {
    return this.controller.setCurrentLimit(current);
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

  /**
   * Adds any capability this version introduced to an already-paired device.
   * Nothing is removed: Homey can only remove a custom capability while its
   * definition is still in the app, and a stale one it can't resolve then fails
   * every addCapability() as well. A dropped capability means re-pairing.
   */
  private async ensureCapabilities() {
    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
  }

  /**
   * Reads a setting, preferring the not-yet-persisted values from onSettings.
   * Homey's onSettings hook fires *before* the new values are stored, so a plain
   * getSetting() during that call returns the generation about to be replaced -
   * see pendingSettings.
   */
  private setting<T>(key: string): T | undefined {
    if (this.pendingSettings && key in this.pendingSettings) {
      return this.pendingSettings[key] as T;
    }
    return this.getSetting(key) as T;
  }

  /** Watts per amp from this device's voltage/phases settings, as the controller converts. */
  private wattsPerAmp(): number {
    return (this.setting<number>('voltage') ?? DEFAULT_VOLTAGE) * (this.setting<number>('phases') ?? DEFAULT_PHASES);
  }

  /**
   * Point target_power's range, step and dead zone at this device's own
   * configured amp limits, voltage and phases - Homey's Energy reads them to know
   * what it can ask for. The manifest can only declare one set for every
   * install - see targetPowerOptions(). Only written when it actually changes,
   * since Homey documents setCapabilityOptions as expensive and this runs on
   * every save.
   */
  private async syncTargetPowerOptions() {
    if (!this.hasCapability('target_power')) return;
    const minAmps = this.setting<number>('minAmps') ?? DEFAULT_MIN_AMPS;
    const maxAmps = this.setting<number>('maxAmps') ?? DEFAULT_MAX_AMPS;
    const current = this.getCapabilityOptions('target_power') as Partial<TargetPowerOptions> | null | undefined;
    const update = targetPowerOptionsUpdate(current, minAmps, maxAmps, this.wattsPerAmp());
    if (!update) return;
    this.log(`[capability] target_power range -> ${update.excludeMax}-${update.max}W in ${update.step}W steps`);
    await this.setCapabilityOptions('target_power', { ...(current ?? {}), ...update }).catch(this.error);
  }

  /**
   * Initial target_power for a freshly paired device, from the configured
   * minimum. Runs after syncTargetPowerOptions() so the range already admits it.
   * Only ever the initial value - every later write comes from the controller.
   */
  private async seedTargetPower() {
    if (!this.hasCapability('target_power')) return;
    if (this.getCapabilityValue('target_power') !== null) return;
    await this.setCapabilityValue(
      'target_power', (this.setting<number>('minAmps') ?? DEFAULT_MIN_AMPS) * this.wattsPerAmp(),
    ).catch(this.error);
  }

  /** Adapter implementing the controller's minimal host surface. */
  private buildHost(): ControllerHost {
    return {
      identity: this.getData().id as string,
      setCapability: (cap, value) => {
        if (this.hasCapability(cap)) this.setCapabilityValue(cap, value).catch(this.error);
      },
      getSetting: <T>(key: string) => this.setting<T>(key) as T,
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

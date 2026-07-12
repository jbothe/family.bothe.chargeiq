'use strict';

import Homey from 'homey';
import { CentralSystem } from './lib/ocpp/CentralSystem';
import { ChargePoint } from './lib/ocpp/ChargePoint';
import { SolarFeed } from './lib/solar/SolarFeed';

const DEFAULT_PORT = 9000;

/** Minimal surface this file needs from the paired charger device, if any. */
interface ChargerDeviceLike {
  hasCapability(id: string): boolean;
  getCapabilityValue(id: string): unknown;
  getDiagnostics?(): { availableW: number; solarState: string; targetA: number | null; mode: string };
  getModeInfo?(): {
    mode: string | null;
    scheduleEndAt: string | null;
    nextScheduleStartAt: string | null;
    boostActive: boolean;
    solarEnough: boolean | null;
  };
  getSchedule?(): unknown[];
  setSchedule?(windows: unknown[]): Promise<void>;
}

/**
 * ChargeIQ — embeds the OCPP 1.6J Central System and orchestrates charging.
 * The Central System lives here on the App instance so it is available whenever
 * the app runs, independent of device pairing. Charger devices reach it via
 * `this.homey.app` (typed as ChargeIQApp).
 */
module.exports = class ChargeIQApp extends Homey.App {

  private centralSystem!: CentralSystem;

  private solarFeed!: SolarFeed;

  private widgetBroadcast?: ReturnType<typeof setInterval>;

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

    // Solar feed is best-effort: the charger still works (manual/scheduled) if
    // the SolarEdge app is absent or the HomeyAPI is unavailable.
    this.solarFeed = new SolarFeed(this.homey, (msg, ...args) => this.log(msg, ...args));
    this.solarFeed.start().catch((err) => this.error('SolarFeed failed to start:', err));

    this.startWidgetBroadcast();

    this.log(`ChargeIQ initialised; OCPP CS on port ${port}`);
  }

  async onUninit() {
    if (this.widgetBroadcast) clearInterval(this.widgetBroadcast);
    await this.centralSystem?.stop();
    await this.solarFeed?.stop();
  }

  /**
   * Push merged state to the power-flow widget via realtime events every 10s.
   * This is the primary widget data channel (Homey.on in the widget), avoiding
   * any dependence on widget/app API routing.
   */
  private startWidgetBroadcast() {
    let firstLogged = false;
    const tick = () => {
      try {
        this.homey.api.realtime('powerflow', this.getWidgetState());
        if (!firstLogged) {
          this.log('[widget] broadcasting state via realtime'); firstLogged = true;
        }
      } catch (err) {
        this.error('[widget] realtime broadcast failed:', err);
      }
    };
    tick();
    // eslint-disable-next-line homey-app/global-timers -- cleared in onUninit()
    this.widgetBroadcast = setInterval(tick, 10000);
  }

  /** Expose the Central System to drivers/devices. */
  getCentralSystem(): CentralSystem {
    return this.centralSystem;
  }

  getChargePoint(identity: string): ChargePoint | undefined {
    return this.centralSystem.getChargePoint(identity);
  }

  getSolarFeed(): SolarFeed {
    return this.solarFeed;
  }

  /** The (single) charger device, if paired. */
  private getChargerDevice(): ChargerDeviceLike | null {
    try {
      const devices = this.homey.drivers.getDriver('charger').getDevices();
      return devices[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Merged state for the power-flow widget. App owns all four data points. */
  getWidgetState() {
    const solar = this.solarFeed?.getSample()
      ?? {
        pvW: 0, gridSignedW: 0, batteryW: 0, houseW: 0, batterySoc: null,
      };
    const dev = this.getChargerDevice();
    const cap = (id: string) => (dev && dev.hasCapability(id) ? dev.getCapabilityValue(id) : null);
    const diag = dev?.getDiagnostics?.();
    const modeInfo = dev?.getModeInfo?.() ?? {
      mode: null, scheduleEndAt: null, nextScheduleStartAt: null, boostActive: false, solarEnough: null,
    };
    // Excess solar available to the car: from the loop when present, else grid export.
    const surplusW = diag ? diag.availableW : Math.max(0, -solar.gridSignedW);
    return {
      solarW: solar.pvW,
      houseW: solar.houseW,
      gridW: solar.gridSignedW, // import + / export -
      batteryW: solar.batteryW,
      batterySoc: solar.batterySoc,
      surplusW,
      mode: modeInfo.mode,
      scheduleEndAt: modeInfo.scheduleEndAt,
      nextScheduleStartAt: modeInfo.nextScheduleStartAt,
      boostActive: modeInfo.boostActive,
      solarEnough: modeInfo.solarEnough,
      charger: {
        available: !!dev,
        powerW: (cap('measure_power') as number) ?? 0,
        currentA: (cap('measure_current') as number) ?? 0,
        limitA: (cap('charge_current_limit') as number) ?? null,
        mode: modeInfo.mode,
        status: cap('charger_status'),
        chargingState: cap('evcharger_charging_state'),
        charging: !!cap('evcharger_charging'),
      },
    };
  }

  /** Weekly schedule get/set, proxied to the charger device (used by settings UI). */
  getSchedule(): unknown[] {
    const dev = this.getChargerDevice();
    return dev?.getSchedule?.() ?? [];
  }

  async setSchedule(windows: unknown[]): Promise<void> {
    const dev = this.getChargerDevice();
    if (dev?.setSchedule) await dev.setSchedule(windows);
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

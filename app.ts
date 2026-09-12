'use strict';

import Homey from 'homey';
import { CentralSystem, DEFAULT_OCPP_PORT } from './lib/ocpp/CentralSystem';
import { ChargePoint } from './lib/ocpp/ChargePoint';
import { SolarFeed } from './lib/solar/SolarFeed';

/** Minimal surface this file needs from the paired charger device, if any. */
interface ChargerDeviceLike {
  hasCapability(id: string): boolean;
  getCapabilityValue(id: string): unknown;
  getDiagnostics?(): {
    availableW: number; solarState: string; targetA: number | null; mode: string;
    chargerPowerW: number | null;
    solarFeed: { stale: boolean; ageMs: number | null };
    limits: {
      chargerMaxW: number; gridMaxW: number;
      batteryChargePeakW: number; batteryDischargePeakW: number; solarPeakW: number;
    };
  };
  getModeInfo?(): {
    mode: string | null;
    scheduleEndAt: string | null;
    nextScheduleStartAt: string | null;
    boostActive: boolean;
    solarEnough: boolean | null;
  };
  getConnectionInfo?(): {
    online: boolean | null; lastSeenAt: string | null; offlineSince: string | null;
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
    const port = DEFAULT_OCPP_PORT;

    this.centralSystem = new CentralSystem({
      port,
      // Accept every idTag. There used to be an `authorizeMode: 'whitelist'`
      // branch reading an `idTagWhitelist` out of app settings, but the app has
      // no settings page to set either one, so the whitelist could never be
      // turned on and the code was unreachable. Removed rather than left as a
      // control that looks configurable and isn't. This is a single-charger LAN
      // Central System reachable only from the local network, so accept-all is
      // the honest policy; the seam (CentralSystemOptions.authorize) is still
      // here if a real one is ever wanted.
      authorize: () => true,
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
    // OCPP link state. `online: null` = not yet resolved (startup grace) - the
    // widget must not claim an outage on that, only on an explicit false.
    // Without this the widget has no way to tell a live reading from the last
    // one before the charger vanished, and renders 12-hour-old state as current.
    const conn = dev?.getConnectionInfo?.() ?? { online: null, lastSeenAt: null, offlineSince: null };
    // Excess solar available to the car: from the loop when present, else grid export.
    const surplusW = diag ? diag.availableW : Math.max(0, -solar.gridSignedW);
    // solar.houseW is derived purely from the SolarEdge feed (pv + grid - battery), so it
    // has no notion of the EV charger and includes its draw as if it were household load.
    // Net the charger's own draw back out when it's known, so house/ev/solar/grid/battery
    // stay zero-sum instead of double-counting the EV. Left unmodified when unknown
    // (diag.chargerPowerW === null, e.g. briefly after a reconnect) rather than guessing.
    const chargerPowerW = diag?.chargerPowerW ?? null;
    const houseW = chargerPowerW != null ? Math.max(0, solar.houseW - chargerPowerW) : solar.houseW;
    // SolarFeed returns its last sample forever; the controller knows how old it is.
    const solarFeed = diag?.solarFeed ?? { stale: false, ageMs: null };
    return {
      solarW: solar.pvW,
      houseW,
      gridW: solar.gridSignedW, // import + / export -
      batteryW: solar.batteryW,
      batterySoc: solar.batterySoc,
      solarStale: solarFeed.stale,
      solarAgeMs: solarFeed.ageMs,
      surplusW,
      mode: modeInfo.mode,
      scheduleEndAt: modeInfo.scheduleEndAt,
      nextScheduleStartAt: modeInfo.nextScheduleStartAt,
      boostActive: modeInfo.boostActive,
      solarEnough: modeInfo.solarEnough,
      limits: diag?.limits ?? {
        chargerMaxW: 0, gridMaxW: 0, batteryChargePeakW: 0, batteryDischargePeakW: 0, solarPeakW: 0,
      },
      charger: {
        available: !!dev,
        online: conn.online,
        lastSeenAt: conn.lastSeenAt,
        offlineSince: conn.offlineSince,
        powerW: (cap('measure_power') as number) ?? 0,
        currentA: (cap('measure_current') as number) ?? 0,
        limitA: (cap('charge_current_limit') as number) ?? null,
        // What the charger accepted; limitA is only what the controller decided.
        appliedA: (cap('charge_current_applied') as number) ?? null,
        mode: modeInfo.mode,
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

  /**
   * The schedule lives in the charger device's own store, so there is nowhere
   * to put it until one is paired. Throw rather than no-op: the settings page
   * treats a resolved call as saved and shows the windows as persisted, so
   * silently dropping them looked exactly like success right up until the page
   * was reloaded and they were gone.
   */
  async setSchedule(windows: unknown[]): Promise<void> {
    const dev = this.getChargerDevice();
    if (!dev?.setSchedule) {
      throw new Error('No charger is paired yet - add your charger first, then set a schedule.');
    }
    await dev.setSchedule(windows);
  }

  /** Monotonic, persisted transaction id source. */
  private allocateTransactionId(): number {
    const next = ((this.homey.settings.get('txCounter') as number) || 0) + 1;
    this.homey.settings.set('txCounter', next);
    return next;
  }

};

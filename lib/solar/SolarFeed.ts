'use strict';

import { EventEmitter } from 'events';
// homey-api is a CommonJS module without bundled TS types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');

const SOLAREDGE_APP = 'bothe.family.solaredge';

/**
 * Inverter/meter/battery power (and battery SoC) each subscribe to their own
 * capability instance, so a single underlying SolarEdge reading cycle can
 * fire several independent listener callbacks within the same real-world
 * moment - confirmed via a real log with 3 near-duplicate emits ~150ms apart,
 * each driving its own downstream ChargeController.tick(). Debounced (reset
 * on every update, not a fixed delay from the first) so a burst of any size
 * collapses into one emit of the latest merged sample. Generous on purpose -
 * per-role updates in practice are sparse (well under SolarEdge's ~10s report
 * cadence, ChargeController's TICK_MS backstop, and solarStaleMs), so this
 * only adds latency to reaching a quiet point, not to the freshness of the
 * value once emitted, and plays nice with ChargeController's own tick
 * backstop (scheduleNextTick() re-arms from whenever tick() actually runs,
 * not a fixed wall-clock schedule).
 *
 * A tick() triggered independently of solar (the backstop timer, a status
 * change, a manual/schedule action) while a sample is mid-debounce will
 * resolve against the previous sample's cached values - at most this many ms
 * stale, bounded by the debounce window itself, and strictly smaller than the
 * staleness any tick() already tolerates between two solar reports ~10s apart.
 * It self-corrects the moment the debounced sample lands and drives its own
 * tick(): tick()'s capTightened comparison is tick-over-tick against whatever
 * the *previous* tick last saw (stale or not), so a hard cap that actually
 * tightened is still detected and written urgently, just up to
 * SAMPLE_DEBOUNCE_MS later than an undebounced feed would have caught it.
 */
const SAMPLE_DEBOUNCE_MS = 1000;

/**
 * How often the feed checks whether it is still actually receiving anything.
 * discover() used to run exactly once, from start(), which left two ways for
 * the feed to be dead for the app's whole lifetime: the SolarEdge app's devices
 * not being there yet at boot (nothing ever re-looked), and a failed first
 * discovery (start() rejected, the app logged it, and that was that). The
 * charger keeps working either way - the controller fails safe and pauses solar
 * - but solar mode stays silently broken until ChargeIQ itself is restarted.
 */
const RESCAN_INTERVAL_MS = 5 * 60000;

/**
 * Silence tolerated before the subscriptions are presumed dead and rebuilt.
 * Deliberately generous: Homey only fires a capability listener on an actual
 * change, so a genuinely healthy feed can be quiet for a while (overnight, with
 * PV at a flat zero). The grid meter moves with household load and so is the
 * one that realistically keeps this fresh. A false positive only costs a
 * getDevices() call and a resubscribe to the same devices, so erring long is
 * cheap in the direction that matters.
 */
const FEED_SILENT_MS = 30 * 60000;

/** Roles we read from the SolarEdge app, keyed by its driver id. */
type Role = 'inverter' | 'meter' | 'battery';

/** Handle returned by makeCapabilityInstance(), used only to unsubscribe. */
export interface CapabilityInstance {
  destroy?(): Promise<void> | void;
}

/** Minimal shape of a homey-api device this file reads from. */
export interface HomeyApiDevice {
  driverId?: string;
  capabilities?: string[];
  capabilitiesObj?: {
    'measure_power'?: { value?: number };
    'measure_battery'?: { value?: number };
  };
  makeCapabilityInstance(capabilityId: string, listener: (value: number) => void): CapabilityInstance;
}

/** Options homey-api's generated manager methods accept alongside their own args. */
export interface GetDevicesOptions {
  /** false = always fetch, never answer from ManagerDevices' cache. */
  $cache?: boolean;
  /** false = don't populate that cache with the result either. */
  $updateCache?: boolean;
}

/** Minimal shape of the homey-api client (HomeyAPI.createAppAPI()'s return value) we rely on. */
export interface HomeyApiClient {
  devices: { getDevices(opts?: GetDevicesOptions): Promise<Record<string, HomeyApiDevice>> };
}

export interface SolarSample {
  /** PV production (W, >=0). */
  pvW: number;
  /** Grid power, import positive / export negative (W). */
  gridSignedW: number;
  /** Battery power, charge positive / discharge negative (W). */
  batteryW: number;
  /** Derived house consumption (W): pv + gridSigned - batterySigned. */
  houseW: number;
  /** Battery state of charge (%), or null when no battery is present. */
  batterySoc: number | null;
}

/**
 * Merge raw device values into a sample. House load is derived because the
 * SolarEdge app does not expose it: house = pv + gridSigned - batterySigned.
 * SoC is only reported when a battery device is present. Pure/testable.
 */
export function mergeSample(
  values: { inverter: number; meter: number; battery: number },
  batteryPresent: boolean,
  batterySoc: number | null,
): SolarSample {
  const pvW = values.inverter;
  const gridSignedW = values.meter;
  const batteryW = values.battery;
  return {
    pvW,
    gridSignedW,
    batteryW,
    houseW: pvW + gridSignedW - batteryW,
    batterySoc: batteryPresent ? batterySoc : null,
  };
}

/**
 * Reads live power from the user's forked SolarEdge app over the HomeyAPI and
 * emits a merged {@link SolarSample} whenever any input changes. House load is
 * derived because the SolarEdge app does not expose it directly.
 *
 * Emits: 'sample' (SolarSample). Failures are logged rather than emitted - an
 * 'error' event with no listener would take the app down, and this feed is
 * best-effort by design (the charger still runs manual/scheduled without it).
 *
 * Discovery is not one-shot: see RESCAN_INTERVAL_MS / checkAndRecover().
 */
export class SolarFeed extends EventEmitter {

  /** Only ever passed through opaquely to HomeyAPI.createAppAPI() - never read here. */
  private homey: unknown;

  private api: HomeyApiClient | null = null;

  private instances: CapabilityInstance[] = [];

  private values: Record<Role, number> = { inverter: 0, meter: 0, battery: 0 };

  private present: Record<Role, boolean> = { inverter: false, meter: false, battery: false };

  /** Battery state of charge (%) from the battery device's measure_battery. */
  private batterySoc: number | null = null;

  /** Debounces emitSample() - see SAMPLE_DEBOUNCE_MS. */
  private pendingEmit: ReturnType<typeof setTimeout> | null = null;

  /** Periodic health check - see RESCAN_INTERVAL_MS. */
  private rescanTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Epoch ms of the last sign of life: a capability update, or a successful
   * discovery (which reads current values, so it counts as one). 0 = never.
   */
  private lastUpdateAt = 0;

  /** Guards against a rescan starting while one is already in flight. */
  private rediscovering = false;

  private log: (...a: unknown[]) => void;

  /**
   * @param apiOverride Skips the real HomeyAPI.createAppAPI() call in start()
   * - lets tests exercise discover()'s actual matching/subscription logic
   * against a fake client without needing the Homey runtime.
   */
  constructor(homey: unknown, logger?: (...a: unknown[]) => void, apiOverride?: HomeyApiClient) {
    super();
    this.homey = homey;
    this.log = logger ?? (() => { /* noop */ });
    this.api = apiOverride ?? null;
  }

  /**
   * The rescan is armed *before* the first discovery, so a discovery that fails
   * outright (no HomeyAPI yet, SolarEdge app still starting) is retried rather
   * than being the one and only attempt. start() still rejects on that first
   * failure - the caller logs it - it just is no longer terminal.
   */
  async start(): Promise<void> {
    this.armRescan();
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.api) this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    await this.discover();
  }

  private armRescan(): void {
    if (this.rescanTimer) return;
    // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in stop()
    this.rescanTimer = setInterval(() => {
      this.checkAndRecover().catch((err) => this.log('SolarFeed: rescan failed:', (err as Error).message));
    }, RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();
  }

  /**
   * Rebuild the subscriptions if the feed looks dead - nothing useful was ever
   * discovered, or nothing has come in for FEED_SILENT_MS. Run by the internal
   * rescan timer; public and taking an explicit `now` so tests can drive it
   * without waiting on real time. Returns whether it actually rediscovered.
   */
  async checkAndRecover(now: number = Date.now()): Promise<boolean> {
    if (this.rediscovering) return false;
    const silentFor = this.lastUpdateAt === 0 ? Infinity : now - this.lastUpdateAt;
    if (this.present.meter && silentFor <= FEED_SILENT_MS) return false;
    this.rediscovering = true;
    try {
      this.log(`SolarFeed: ${this.present.meter
        ? `no updates for ${Math.round(silentFor / 60000)}m`
        : 'nothing discovered yet'} - rediscovering`);
      await this.releaseInstances();
      await this.connect();
      return true;
    } finally {
      this.rediscovering = false;
    }
  }

  /**
   * Find SolarEdge devices and subscribe to their measure_power capability.
   * Safe to run again: `present` is rebuilt from what is actually found this
   * time (so a device that has gone away stops being claimed as present), but
   * only after getDevices() has succeeded, so a failed fetch leaves the last
   * known state alone rather than blanking it.
   */
  private async discover(): Promise<void> {
    // Uncached on purpose, on both counts. $updateCache: homey-api's
    // ManagerDevices caches a getAll by pinning a full Device object for every
    // device on the Homey and marking the cache complete, retained for the
    // app's lifetime - for the sake of the three SolarEdge devices actually
    // wanted here. (It happens not to fire today: caching is gated on the
    // *manager* namespace being connected to socket.io, and makeCapabilityInstance
    // only ever connects each Device's own namespace - so this pins the current
    // behaviour rather than fixing a live leak.) $cache: a rescan that got
    // served that cached map wouldn't re-look at all, which is the entire point
    // of checkAndRecover().
    const devices = await this.api!.devices.getDevices({ $cache: false, $updateCache: false });
    this.present = { inverter: false, meter: false, battery: false };
    for (const device of Object.values(devices)) {
      const role = this.roleOf(device);
      if (!role) continue;
      if (!(device.capabilities || []).includes('measure_power')) continue;

      this.present[role] = true;
      const current = device.capabilitiesObj?.measure_power?.value;
      if (typeof current === 'number') this.values[role] = current;

      try {
        const inst = device.makeCapabilityInstance('measure_power', (value: number) => {
          if (typeof value === 'number') {
            this.lastUpdateAt = Date.now();
            this.values[role] = value;
            this.emitSample();
          }
        });
        this.instances.push(inst);
      } catch (err) {
        this.log('SolarFeed: could not subscribe to', role, (err as Error).message);
      }

      // Battery state of charge (SoC %) from the same battery device.
      if (role === 'battery' && (device.capabilities || []).includes('measure_battery')) {
        const soc = device.capabilitiesObj?.measure_battery?.value;
        if (typeof soc === 'number') this.batterySoc = soc;
        try {
          const inst = device.makeCapabilityInstance('measure_battery', (value: number) => {
            if (typeof value === 'number') {
              this.lastUpdateAt = Date.now();
              this.batterySoc = value;
              this.emitSample();
            }
          });
          this.instances.push(inst);
        } catch (err) {
          this.log('SolarFeed: could not subscribe to battery SoC', (err as Error).message);
        }
      }
    }
    this.log(`SolarFeed discovered: ${Object.entries(this.present).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
    // A successful discovery read each device's current value, so it counts as a
    // sign of life in its own right - otherwise the silence check would fire on
    // the very next rescan, before any capability listener has had cause to run.
    if (this.present.meter) {
      this.lastUpdateAt = Date.now();
      this.emitSample();
    }
  }

  private roleOf(device: HomeyApiDevice): Role | null {
    // driverId is the canonical URI, e.g. "homey:app:bothe.family.solaredge:meter".
    const driverId: string = device.driverId ?? '';
    if (!driverId.includes(SOLAREDGE_APP)) return null;
    const key = driverId.includes(':') ? driverId.split(':').pop() : driverId;
    if (key === 'inverter' || key === 'meter' || key === 'battery') return key;
    return null;
  }

  private sample(): SolarSample {
    return mergeSample(this.values, this.present.battery, this.batterySoc);
  }

  private emitSample(): void {
    if (this.pendingEmit) clearTimeout(this.pendingEmit);
    // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in stop()
    this.pendingEmit = setTimeout(() => {
      this.pendingEmit = null;
      this.emit('sample', this.sample());
    }, SAMPLE_DEBOUNCE_MS);
    this.pendingEmit.unref?.();
  }

  /** Latest merged sample (for the widget / initial state). */
  getSample(): SolarSample {
    return this.sample();
  }

  hasGrid(): boolean {
    return this.present.meter;
  }

  /** Drop every capability subscription, leaving the feed ready to resubscribe. */
  private async releaseInstances(): Promise<void> {
    for (const inst of this.instances) {
      try {
        await inst.destroy?.();
      } catch { /* ignore */ }
    }
    this.instances = [];
  }

  async stop(): Promise<void> {
    if (this.pendingEmit) {
      clearTimeout(this.pendingEmit);
      this.pendingEmit = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    await this.releaseInstances();
  }

}

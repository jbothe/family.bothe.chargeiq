'use strict';

import { EventEmitter } from 'events';
import { CentralSystem } from '../ocpp/CentralSystem';
import { ChargePoint } from '../ocpp/ChargePoint';
import {
  BootNotificationReq,
  MeterValuesReq,
  OcppStatus,
  Readings,
  StartTransactionReq,
  StatusNotificationReq,
  StopTransactionReq,
} from '../ocpp/types';
import { Scheduler, ScheduleWindow, findScheduleConflicts } from './Scheduler';
import { SolarLoop, SolarLoopConfig } from './SolarLoop';

/** Derived charging mode (not user-selected). */
export type ChargeMode = 'manual' | 'scheduled' | 'solar' | 'idle';

/** Unified charging-state event, driven off OCPP status rather than transaction bookkeeping. */
export type ChargingEvent = 'started' | 'paused' | 'stopped';

export interface ChargingTokens {
  /** Target current (A) - what the controller is asking for, not a live measurement. */
  current: number;
  mode: ChargeMode;
  /** Solar surplus (W) at the moment of the event. */
  surplus: number;
  /** Energy delivered this session (kWh), 0 if unknown. */
  sessionEnergy: number;
}

/** Live power inputs from the solar feed (all in W; grid import + / export -). */
export interface SolarSampleInput {
  gridSignedW: number;
  pvW?: number;
  batteryW?: number;
  houseW?: number;
}

/**
 * A sticky manual intent set by any hands-on action (charge on/off, slider).
 * Cleared only when a schedule window starts or the charger is replugged.
 */
interface ManualLatch {
  intent: 'charge' | 'off';
  amps?: number;
}

/**
 * Minimal surface the controller needs from its host (the Homey device).
 * Kept small so the controller stays unit-testable without the Homey runtime.
 */
export interface ControllerHost {
  identity: string;
  setCapability(cap: string, value: unknown): void;
  getSetting<T>(key: string): T | undefined;
  getStore<T>(key: string): T | undefined;
  setStore(key: string, value: unknown): Promise<void>;
  setAvailable(): void;
  setUnavailable(msg: string): void;
  setWarning(msg: string | null): void;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Fired on a started/paused/stopped transition so the device can trigger Flow cards. */
  onChargingEvent?(event: ChargingEvent, tokens: ChargingTokens): void;
  onModeChanged?(mode: ChargeMode): void;
  /** Fired when the charger reports a Faulted status. */
  onFault?(errorCode: string): void;
  /** Fired on a genuine unplugged -> plugged-in edge. */
  onVehicleConnected?(): void;
  /** Fired on a genuine plugged-in -> unplugged edge. */
  onVehicleDisconnected?(): void;
  /**
   * Fired when the OCPP link to the charger is confirmed down or back up.
   * `offlineForMs` is how long it had been out of contact: at the moment of
   * going offline that is the age of the last inbound message; on recovery it
   * is the length of the outage. null when there is no last-seen time to
   * measure from (the charger has never been in contact this install).
   */
  onConnectivityChanged?(online: boolean, offlineForMs: number | null): void;
  /**
   * IANA timezone Homey is configured for (e.g. "Europe/Amsterdam"), via
   * `this.homey.clock.getTimezone()`. The underlying OS clock runs in UTC
   * regardless of this setting, so schedule windows must be evaluated against
   * it explicitly rather than trusting `Date`'s own local getters.
   */
  getTimezone?(): string | undefined;
}

interface ControllerConfig {
  minAmps: number;
  maxAmps: number;
  phases: number;
  voltage: number;
  idTag: string;
  meterSampleIntervalSec: number;
  writeThrottleMs: number;
  // Solar loop tunables
  deadbandA: number;
  rampA: number;
  minOnMs: number;
  minOffMs: number;
  marginW: number;
  solarStaleMs: number;
  // Raw user settings for the household cap: the main supply's per-phase amp
  // rating and its own phase count (independent of the charger's own `phases`
  // above - a single-phase charger on a 3-phase household connection is
  // common). `maxHouseholdW` below is derived from these in refreshConfig()
  // and is what householdCapAmps()/getDiagnostics() actually compare against,
  // since the live base-load reading is fundamentally in Watts.
  maxHouseholdA: number;
  householdPhases: number;
  maxHouseholdW: number;
  sharedCircuitA: number;
  sharedCircuitBufferA: number;
  // Which live readings feed the shared-circuit formula below - a shared
  // circuit doesn't necessarily involve solar or a battery at all (e.g. a
  // charger sharing a breaker with a dryer), so each is opt-in independently
  // rather than assumed. See sharedCircuitCapAmps().
  sharedCircuitIncludeSolar: boolean;
  sharedCircuitIncludeBattery: boolean;
  // Master switch for solar-surplus tracking as a charging mode. Does NOT stop
  // solar samples being consumed (surplus meter, household/circuit caps stay
  // live) - only gates whether resolveDetailed() falls into the solar branch.
  solarEnabled: boolean;
  // Dashboard capacity-meter peaks (0 = meter hidden); no bearing on control decisions.
  peakSolarW: number;
  peakBatteryChargeW: number;
  peakBatteryDischargeW: number;
}

const DEFAULTS: ControllerConfig = {
  minAmps: 6,
  maxAmps: 32,
  phases: 1,
  voltage: 230,
  idTag: 'CHARGEIQ',
  meterSampleIntervalSec: 10,
  writeThrottleMs: 15000,
  deadbandA: 0,
  rampA: 3,
  minOnMs: 3 * 60000,
  minOffMs: 3 * 60000,
  marginW: 0,
  solarStaleMs: 60000,
  maxHouseholdA: 63,
  householdPhases: 1,
  maxHouseholdW: 63 * 230 * 1,
  sharedCircuitA: 0,
  sharedCircuitBufferA: 0,
  sharedCircuitIncludeSolar: false,
  sharedCircuitIncludeBattery: false,
  solarEnabled: true,
  peakSolarW: 0,
  peakBatteryChargeW: 0,
  peakBatteryDischargeW: 0,
};

const PROFILE_ID = 1;
const STACK_LEVEL = 1;
const CONNECTOR_ID = 1;
// 15s rather than 10s: SolarEdge reports roughly every 10s, so this avoids the
// backstop timer and solar-driven ticks routinely landing at nearly the same
// moment under normal conditions.
const TICK_MS = 15000;
// Some charge points (seen on a Wallbox Pulsar Max) report a transient
// Available as part of their own OCPP reconnect handshake, even while a
// vehicle is still plugged in and actively charging - flipping back to the
// real status within well under a second. Idle-reconciliation (clearing a
// still-live transaction/manual-latch) is debounced by this long so that
// blip can't be mistaken for a genuine idle charger.
const IDLE_RECONCILE_DELAY_MS = 5000;
// How long after init() to wait for the charger to (re)connect before calling
// it offline. A charge point reconnects within seconds of the app starting, so
// without this every app restart/update would report a spurious offline->online
// round trip - and fire the Flow trigger for it. Connectivity stays `null`
// (unknown, reported as neither) until either a bind or this timer resolves it.
const STARTUP_GRACE_MS = 120000;
// How often the last-seen timestamp is written through to the device store
// while the link is healthy. It only needs to be roughly right (it exists to
// measure outages in hours, not seconds), and a store write on every tick for
// the lifetime of the app would be pure churn.
const LAST_SEEN_PERSIST_MS = 5 * 60000;

/** Compact human duration for logs/diagnostics: "45s", "12m", "3h", "2d". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** OCPP statuses that mean a vehicle is connected. */
const PLUGGED = ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

/** amps: 0 = pause (hold 0A, keep any live session alive), >0 = charge at that current. */
interface Decision {
  mode: ChargeMode;
  amps: number;
}

/** Map raw OCPP status to Homey's standard evcharger_charging_state enum. */
export function toChargingState(status: OcppStatus): string {
  switch (status) {
    case 'Charging':
      return 'plugged_in_charging';
    case 'Preparing':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Finishing':
    case 'Reserved':
    case 'Faulted':
      return 'plugged_in';
    case 'Available':
    case 'Unavailable':
    default:
      return 'plugged_out';
  }
}

/**
 * Owns charging behaviour for one charge point. Binds to its {@link ChargePoint},
 * reflects OCPP state onto capabilities, and each tick resolves a derived mode:
 *   Manual (a manual latch is set) > Scheduled (inside a window) > Solar (default).
 * The household grid cap is applied on top in every mode. The manual latch is set
 * by hands-on actions and cleared only by a schedule window starting or a replug.
 */
export class ChargeController {

  private host: ControllerHost;

  private cs: CentralSystem;

  private cp: ChargePoint | null = null;

  private cfg: ControllerConfig;

  private scheduler = new Scheduler();

  /** IANA timezone Homey is configured for (see ControllerHost.getTimezone). */
  private timezone?: string;

  /** Sticky manual intent, or null when running automatically. */
  private manualLatch: ManualLatch | null = null;

  /** Derived mode last applied (for change detection / triggers). */
  private currentMode: ChargeMode | null = null;

  /** Tracks schedule active-state to detect the rising edge (window start). */
  private wasInSchedule = false;

  /** Tracks plug state to detect a fresh plug-in (unplugged -> plugged) edge. */
  private prevPlugged: boolean | null = null;

  /** Solar target (A): null = stop, 0 = pause, >=minAmps = charge. */
  private solarTargetAmps: number | null = null;

  private solarLoop: SolarLoop | null = null;

  private lastSolarSampleAt = 0;

  private solarStaleWarned = false;

  /**
   * null until the first MeterValues since the charger was last confirmed
   * delivering power - see nettedChargerW(). Also reset to null (not 0) by
   * onStatus() on a confirmed stop, so a subsequent Charging status with no
   * fresh MeterValues yet is read as unknown rather than a stale reading.
   */
  private lastPowerW: number | null = null;

  /** null until the first energy reading this connection - see chargingTokens(). */
  private lastEnergyKwh: number | null = null;

  /** Last emitted started/paused/stopped event, for change detection - see onChargingEvent. */
  private lastChargingEvent: ChargingEvent | null = null;

  private lastAvailableW = 0;

  private lastGridSignedW = 0;

  /** PV production (W) from the last solar sample, used by sharedCircuitCapAmps. */
  private lastPvW = 0;

  /** Battery power (W) from the last solar sample, charge positive / discharge negative. */
  private lastBatteryW = 0;

  private prevStatus: string | null = null;

  /** Raw last-seen OCPP status, used to gate a new RemoteStartTransaction. */
  private lastStatusValue: OcppStatus | null = null;

  /** Last power figure written to the log, so [charger] power= only reports real movement. */
  private loggedPowerW = 0;

  /** Fingerprint of the last [solar] line logged - see onSolarSample(). */
  private loggedSolar = '';

  private transactionId: number | null = null;

  private desiredAmps: number | null = null;

  private awaitingStart = false;

  /** Whether the last ensureCharging() call was eligible to write a profile - see there. */
  private wasWriteEligible = false;

  private lastWriteAt = 0;

  private pendingWrite: NodeJS.Timeout | null = null;

  /** Previous tick's hard-cap ceilings, used only to detect a cap tightening further - see tick(). */
  private lastHouseholdCapAmps: number | null = null;

  private lastSharedCircuitCapAmps: number | null = null;

  private tickTimer: NodeJS.Timeout | null = null;

  /** Debounces idle-reconciliation on an Available report - see IDLE_RECONCILE_DELAY_MS. */
  private pendingIdleReconcile: NodeJS.Timeout | null = null;

  /**
   * OCPP link state: true/false once known, null while still unresolved during
   * the startup grace window (see STARTUP_GRACE_MS). Deliberately tri-state -
   * "we haven't heard yet" is not the same claim as "it's offline", and only
   * the latter should be reported to the user.
   */
  private online: boolean | null = null;

  /**
   * Epoch ms of the last inbound OCPP message, persisted so an outage that
   * spans an app restart is still measurable. Without it a restart resets the
   * clock and a charger that has been dark for 12 hours reads as freshly gone.
   */
  private lastSeenAt: number | null = null;

  /** Value of lastSeenAt at the last store write - see noteLastSeen(). */
  private lastSeenPersistedAt = 0;

  private startupGrace: NodeJS.Timeout | null = null;

  /** Last Faulted error code, or null - one of the two inputs to refreshWarning(). */
  private lastFaultCode: string | null = null;

  /** The charger is parked in Finishing with a live target - see writeBlockedBecause(). */
  private needsReplug = false;

  /** Last value handed to host.setWarning(), so it is only called on a change. */
  private lastWarning: string | null | undefined;

  /**
   * How to unregister the listeners this controller put on the CentralSystem,
   * which outlives it (it lives on the App). Torn down in destroy().
   */
  private csTeardowns: Array<() => void> = [];

  /**
   * Same, for the currently bound ChargePoint - also app-lifetime, and also
   * re-bindable, so this list is emptied on every fresh bind() as well as in
   * destroy().
   */
  private cpTeardowns: Array<() => void> = [];

  constructor(host: ControllerHost, cs: CentralSystem) {
    this.host = host;
    this.cs = cs;
    this.cfg = { ...DEFAULTS };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  init(): void {
    this.refreshConfig();
    this.solarLoop = new SolarLoop(this.solarLoopConfig());
    this.transactionId = this.host.getStore<number>('transactionId') ?? null;
    this.manualLatch = this.host.getStore<ManualLatch>('manualLatch') ?? null;
    this.scheduler.setWindows(this.host.getStore<ScheduleWindow[]>('schedule') ?? []);
    this.wasInSchedule = this.scheduler.isActive(new Date());

    this.lastSeenAt = this.host.getStore<number>('ocppLastSeenAt') ?? null;

    const existing = this.cs.getChargePoint(this.host.identity);
    if (existing) this.bind(existing);

    this.listenTo(this.cs, this.csTeardowns, 'connect', (cp: ChargePoint) => {
      if (cp.identity === this.host.identity) this.bind(cp);
    });
    this.listenTo(this.cs, this.csTeardowns, 'disconnect', (cp: ChargePoint) => {
      if (cp.identity !== this.host.identity) return;
      this.cp = null;
      this.noteLastSeen(cp.getConnectionInfo().lastSeenAt, true);
      this.setOnline(false);
    });

    // Nothing connected yet: give the charge point its reconnect window before
    // concluding it's offline (see STARTUP_GRACE_MS).
    if (this.online === null) this.armStartupGrace();

    this.tick(new Date(), 'init'); // establish initial mode capability; also arms the backstop timer
  }

  /**
   * Register an event listener and remember how to remove it again. Every
   * emitter this controller listens to (CentralSystem, ChargePoint) lives on
   * the App and therefore outlives the controller, so a listener left behind is
   * not merely a leak: see destroy() for what it actually causes.
   */
  private listenTo(
    emitter: EventEmitter,
    into: Array<() => void>,
    event: string,
    listener: (...args: never[]) => void,
  ): void {
    const fn = listener as (...args: unknown[]) => void;
    emitter.on(event, fn);
    into.push(() => emitter.removeListener(event, fn));
  }

  /** Unregister everything in a teardown list and empty it. */
  private static runTeardowns(list: Array<() => void>): void {
    while (list.length > 0) list.pop()!();
  }

  /**
   * Release every timer *and* every listener. Unregistering matters as much as
   * the timers do: the CentralSystem and ChargePoint both live on the App, so a
   * controller that goes away still subscribed stays reachable through them.
   * The next charger reconnect would then call the dead controller's bind(),
   * which re-arms its own backstop tick and leaves it writing
   * SetChargingProfile - at the same stable profile id/stack level as the live
   * controller, so the two silently overwrite each other's target - and calling
   * setCapability() on a device that no longer exists. Reachable today by
   * deleting and re-pairing the charger, which is the only re-pair path there
   * is (pairing is capped at one device).
   */
  destroy(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    if (this.pendingIdleReconcile) clearTimeout(this.pendingIdleReconcile);
    if (this.startupGrace) clearTimeout(this.startupGrace);
    this.tickTimer = null;
    this.pendingWrite = null;
    this.pendingIdleReconcile = null;
    this.startupGrace = null;
    ChargeController.runTeardowns(this.cpTeardowns);
    ChargeController.runTeardowns(this.csTeardowns);
    this.cp = null;
  }

  refreshConfig(): void {
    const g = <T>(k: string, d: T): T => (this.host.getSetting<T>(k) ?? d);
    const voltage = g('voltage', DEFAULTS.voltage);
    const maxHouseholdA = g('maxHouseholdA', DEFAULTS.maxHouseholdA);
    const householdPhases = g('householdPhases', DEFAULTS.householdPhases);
    this.cfg = {
      minAmps: g('minAmps', DEFAULTS.minAmps),
      maxAmps: g('maxAmps', DEFAULTS.maxAmps),
      phases: g('phases', DEFAULTS.phases),
      voltage,
      idTag: g('idTag', DEFAULTS.idTag),
      meterSampleIntervalSec: g('meterSampleIntervalSec', DEFAULTS.meterSampleIntervalSec),
      writeThrottleMs: g('writeThrottleMs', DEFAULTS.writeThrottleMs),
      deadbandA: g('deadbandA', DEFAULTS.deadbandA),
      rampA: g('rampA', DEFAULTS.rampA),
      minOnMs: g('minOnSec', DEFAULTS.minOnMs / 1000) * 1000,
      minOffMs: g('minOffSec', DEFAULTS.minOffMs / 1000) * 1000,
      marginW: g('marginW', DEFAULTS.marginW),
      solarStaleMs: g('solarStaleSec', DEFAULTS.solarStaleMs / 1000) * 1000,
      maxHouseholdA,
      householdPhases,
      maxHouseholdW: maxHouseholdA * voltage * householdPhases,
      sharedCircuitA: g('sharedCircuitA', DEFAULTS.sharedCircuitA),
      sharedCircuitBufferA: g('sharedCircuitBufferA', DEFAULTS.sharedCircuitBufferA),
      sharedCircuitIncludeSolar: g('sharedCircuitIncludeSolar', DEFAULTS.sharedCircuitIncludeSolar),
      sharedCircuitIncludeBattery: g('sharedCircuitIncludeBattery', DEFAULTS.sharedCircuitIncludeBattery),
      solarEnabled: g('solarEnabled', DEFAULTS.solarEnabled),
      peakSolarW: g('peakSolarW', DEFAULTS.peakSolarW),
      peakBatteryChargeW: g('peakBatteryChargeW', DEFAULTS.peakBatteryChargeW),
      peakBatteryDischargeW: g('peakBatteryDischargeW', DEFAULTS.peakBatteryDischargeW),
    };
    this.solarLoop?.setConfig(this.solarLoopConfig());
    this.timezone = this.host.getTimezone?.();
    this.scheduler.setTimezone(this.timezone);
    // Logs the full resolved config on every refresh (boot + every settings
    // save) so a settings change can be confirmed as actually applied,
    // rather than assumed - see the onSettings/getSetting timing gotcha in
    // CLAUDE.md that this would otherwise mask.
    this.host.log('[config] refreshed:', JSON.stringify(this.cfg));
  }

  private solarLoopConfig(): SolarLoopConfig {
    const c = this.cfg;
    return {
      voltage: c.voltage,
      phases: c.phases,
      minAmps: c.minAmps,
      maxAmps: c.maxAmps,
      deadbandA: c.deadbandA,
      rampA: c.rampA,
      minOnMs: c.minOnMs,
      minOffMs: c.minOffMs,
      marginW: c.marginW,
    };
  }

  // ---------------------------------------------------------------------------
  // Connectivity
  // ---------------------------------------------------------------------------

  /**
   * Current OCPP link state for the widget / settings UI. `lastSeenAt` prefers
   * the live ChargePoint's own figure and falls back to the persisted one, so
   * it survives an app restart (see the field's comment). `offlineSince` is
   * only set while genuinely offline - during the startup grace window it stays
   * null rather than asserting an outage that may not exist.
   */
  getConnectionInfo(): { online: boolean | null; lastSeenAt: string | null; offlineSince: string | null } {
    const seen = this.cp?.getConnectionInfo().lastSeenAt ?? this.lastSeenAt;
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    return {
      online: this.online,
      lastSeenAt: iso(seen),
      offlineSince: this.online === false ? iso(seen) : null,
    };
  }

  /** True only when the link is confirmed up - used by the Flow condition card. */
  isOnline(): boolean {
    return this.online === true;
  }

  /**
   * Why a positive target cannot currently reach the charger, or null if it
   * can. This mirrors ensureCharging()'s own eligibility test so the per-tick
   * decision line can say so out loud. It exists because the alternative is
   * what real hardware produced: three minutes of confident `-> 23A` decision
   * lines while ensureCharging() was silently doing nothing at all, because a
   * PowerLoss stop had left the charger in Finishing with no transaction.
   *
   * Offline is excluded - the decision line already carries its own OFFLINE
   * note, and repeating it here would just be noise.
   */
  private writeBlockedBecause(target: number): string | null {
    if (target <= 0 || this.online === false || this.transactionId != null) return null;
    if (this.lastStatusValue == null) return 'no charger status yet';
    // Checked before the PLUGGED test below, which includes Finishing.
    if (this.lastStatusValue === 'Finishing') {
      return 'charger is Finishing - the session ended and it will not start another until the cable is unplugged and replugged';
    }
    if (PLUGGED.includes(this.lastStatusValue)) return null;
    return `charger reports ${this.lastStatusValue} - nothing plugged in`;
  }

  /**
   * One owner for the device's warning banner. Both a fault and the
   * needs-a-replug state want it, and they used to be written from different
   * places - onStatus() cleared the banner on every non-Faulted status, which
   * would wipe anything else set between reports.
   */
  private refreshWarning(): void {
    let next: string | null = null;
    if (this.lastFaultCode) next = `Charger fault: ${this.lastFaultCode}`;
    else if (this.needsReplug) next = 'Charging session ended - unplug and replug the cable to resume';
    if (next === this.lastWarning) return;
    this.lastWarning = next;
    this.host.setWarning(next);
  }

  private armStartupGrace(): void {
    if (this.startupGrace) clearTimeout(this.startupGrace);
    // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in destroy()
    this.startupGrace = setTimeout(() => {
      this.startupGrace = null;
      if (this.online === null) this.setOnline(false);
    }, STARTUP_GRACE_MS);
    this.startupGrace.unref?.();
  }

  /**
   * Record the most recent contact, never moving it backwards. The write
   * through to the store is throttled (see LAST_SEEN_PERSIST_MS) except when
   * `persist` forces it - the disconnect edge is the one moment the exact value
   * matters, since it is what any later outage is measured from.
   */
  private noteLastSeen(at: number | null | undefined, persist = false): void {
    if (at == null || (this.lastSeenAt != null && at <= this.lastSeenAt)) return;
    this.lastSeenAt = at;
    if (!persist && at - this.lastSeenPersistedAt < LAST_SEEN_PERSIST_MS) return;
    this.lastSeenPersistedAt = at;
    this.host.setStore('ocppLastSeenAt', at).catch((e) => this.host.error('persist ocppLastSeenAt', e));
  }

  /**
   * Apply an OCPP link transition. Only genuine transitions are reported: a
   * first-ever resolve to online (null -> true) is the normal app-start path
   * and fires no Flow trigger, whereas resolving to offline is always worth
   * reporting - null -> false means the grace window expired with no charger.
   */
  private setOnline(next: boolean): void {
    if (this.online === next) return;
    const wasKnown = this.online !== null;
    this.online = next;
    if (this.startupGrace) {
      clearTimeout(this.startupGrace);
      this.startupGrace = null;
    }
    const offlineForMs = this.lastSeenAt != null ? Date.now() - this.lastSeenAt : null;
    if (next) {
      this.host.log(`[ocpp] online${wasKnown && offlineForMs != null ? ` after ${fmtDuration(offlineForMs)} offline` : ''}`);
      this.host.setAvailable();
      if (wasKnown) this.host.onConnectivityChanged?.(true, offlineForMs);
    } else {
      const since = offlineForMs != null ? `last seen ${fmtDuration(offlineForMs)} ago` : 'never seen';
      this.host.log(`[ocpp] offline (${since})`);
      this.host.setUnavailable('Charger offline - no OCPP connection');
      this.host.onConnectivityChanged?.(false, offlineForMs);
    }
  }

  /**
   * Take the charge point's own record of the live transaction id, which beats
   * ours whenever the two disagree: it comes from this connection, whereas
   * `transactionId` may have been restored from the store (a previous process)
   * or missed entirely if the id was granted before this device finished
   * initialising - the StartTransaction handler allocates and answers whether
   * or not a controller is listening. Confirmed on real hardware: the app held
   * 48 while the charger's live session was 49, so every TxProfile write went
   * to a transaction that did not exist and came back rejected.
   *
   * A null on the charge point's side is *not* adopted: that only means no
   * StartTransaction has arrived this connection, which is exactly the
   * restart-onto-an-already-charging-session case the stored id exists for.
   */
  private adoptTransactionId(cp: ChargePoint): void {
    const known = cp.getLastTransactionId();
    if (known == null || known === this.transactionId) return;
    this.host.log(`[charger] adopting transaction ${known} from the charge point `
      + `(had ${this.transactionId ?? 'none'})`);
    this.transactionId = known;
    this.host.setStore('transactionId', known).catch(this.host.error);
  }

  private bind(cp: ChargePoint): void {
    // Order matters: setOnline() measures the outage against the *previous*
    // last-contact time, so the new connection's own timestamp must not be
    // folded in until after - otherwise every recovery reports ~0s downtime.
    this.setOnline(true);
    this.noteLastSeen(cp.getConnectionInfo().lastSeenAt);
    this.adoptTransactionId(cp);
    if (this.cp === cp) {
      // Same ChargePoint reconnected (its client was swapped) - not a fresh
      // bind, but still worth a fresh status to reconcile any staleness.
      this.host.log(`[charger] reconnected (${cp.identity})`);
      this.requestFreshState();
      return;
    }
    // A different ChargePoint instance taking over: drop the previous one's
    // handlers before adding this one's, so they don't both stay live.
    ChargeController.runTeardowns(this.cpTeardowns);
    this.cp = cp;
    const onCp = (event: string, listener: (...args: never[]) => void) => (
      this.listenTo(cp, this.cpTeardowns, event, listener)
    );

    onCp('boot', (info: BootNotificationReq) => {
      this.host.log(`[charger] boot ${info.chargePointVendor} ${info.chargePointModel}${
        info.firmwareVersion ? ` fw=${info.firmwareVersion}` : ''
      }${info.chargePointSerialNumber ? ` sn=${info.chargePointSerialNumber}` : ''}`);
      this.configureCharger().catch((e) => this.host.error('configureCharger', e));
    });
    onCp('status', (i: StatusNotificationReq) => this.onStatus(i));
    onCp('meterValues', (r: Readings, _raw: MeterValuesReq) => this.onMeterValues(r));
    onCp('startTransaction', (id: number, req: StartTransactionReq) => this.onStartTransaction(id, req));
    onCp('stopTransaction', (req: StopTransactionReq) => this.onStopTransaction(req));
    onCp('heartbeat', () => this.host.log('[charger] heartbeat'));
    onCp('authorize', (idTag: string, accepted: boolean) => {
      this.host.log(`[charger] authorize ${idTag} -> ${accepted ? 'accepted' : 'invalid'}`);
    });
    onCp('dataTransfer', (payload: { vendorId?: string; messageId?: string; data?: string }) => {
      this.host.log(`[charger] dataTransfer vendor=${payload.vendorId ?? '?'}${
        payload.messageId ? ` msg=${payload.messageId}` : ''
      }${payload.data ? ` data=${payload.data}` : ''}`);
    });
    onCp('firmwareStatus', (status: string) => this.host.log(`[charger] firmware status ${status}`));
    onCp('diagnosticsStatus', (status: string) => this.host.log(`[charger] diagnostics status ${status}`));

    const cachedStatus = cp.getLastStatus();
    if (cachedStatus) this.onStatus(cachedStatus);
    const cachedReadings = cp.getLastReadings();
    if (cachedReadings) this.onMeterValues(cachedReadings);

    this.requestFreshState();

    this.host.log(`Controller bound to ${cp.identity}`);
    this.tick(new Date(), 'bind');
  }

  private requestFreshState(): void {
    if (!this.cp?.connected) return;
    this.cp.triggerMessage('StatusNotification', CONNECTOR_ID)
      .then((ok) => {
        if (!ok) this.host.log('[charger] TriggerMessage(StatusNotification) not accepted');
      })
      .catch((e) => this.host.log(`[charger] TriggerMessage(StatusNotification) failed: ${(e as Error).message}`));
    this.cp.triggerMessage('MeterValues', CONNECTOR_ID)
      .then((ok) => {
        if (!ok) this.host.log('[charger] TriggerMessage(MeterValues) not accepted');
      })
      .catch((e) => this.host.log(`[charger] TriggerMessage(MeterValues) failed: ${(e as Error).message}`));
  }

  private async configureCharger(): Promise<void> {
    if (!this.cp) return;
    try {
      await this.cp.changeConfiguration('MeterValueSampleInterval', String(this.cfg.meterSampleIntervalSec));
      await this.cp.changeConfiguration(
        'MeterValuesSampledData',
        'Power.Active.Import,Current.Import,Voltage,Energy.Active.Import.Register',
      );
    } catch (err) {
      this.host.log('Charger rejected MeterValues config (continuing):', (err as Error).message);
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound OCPP -> capabilities
  // ---------------------------------------------------------------------------

  /** Maps a raw OCPP status to the unified started/paused/stopped Flow event, if any. */
  private statusToChargingEvent(status: OcppStatus): ChargingEvent | null {
    switch (status) {
      case 'Charging':
        return 'started';
      case 'SuspendedEV':
      case 'SuspendedEVSE':
        return 'paused';
      case 'Finishing':
        return 'stopped';
      default:
        return null;
    }
  }

  /** Fires the device's onChargingEvent callback, deduped against the last emitted event. */
  private emitChargingEvent(event: ChargingEvent): void {
    if (event === this.lastChargingEvent) return;
    this.lastChargingEvent = event;
    this.host.onChargingEvent?.(event, this.chargingTokens());
  }

  /**
   * Energy delivered (kWh) and elapsed time (min) for the live transaction, or
   * null when unknown (no reading / no start recorded yet). Both are
   * transaction-scoped: `meterStartWh` and `sessionStartMs` are set on
   * StartTransaction and read back from the store, so they survive an app
   * restart onto an already-running session.
   */
  private sessionMetrics(now: number): { energyKwh: number | null; durationMin: number | null } {
    const meterStartWh = this.host.getStore<number>('meterStartWh') ?? null;
    const startMs = this.host.getStore<number>('sessionStartMs') ?? null;
    const energyKwh = this.lastEnergyKwh != null && meterStartWh != null
      ? Math.max(0, this.lastEnergyKwh - meterStartWh / 1000)
      : null;
    const durationMin = startMs != null
      ? Math.max(0, Math.floor((now - startMs) / 60000))
      : null;
    return { energyKwh, durationMin };
  }

  /**
   * Push the live session's energy/duration onto their capabilities. Gated on a
   * tracked transaction so the values freeze at the final total between sessions
   * (matching the session_energy Flow token) rather than the duration ticking
   * up forever after the car unplugs.
   */
  private updateSessionCapabilities(now: number = Date.now()): void {
    if (this.transactionId == null) return;
    const { energyKwh, durationMin } = this.sessionMetrics(now);
    if (energyKwh != null) {
      this.host.setCapability('meter_power.session', Math.round(energyKwh * 100) / 100);
    }
    if (durationMin != null) this.host.setCapability('session_duration', durationMin);
  }

  /** Token payload for the started/paused/stopped Flow trigger family. */
  private chargingTokens(): ChargingTokens {
    const { energyKwh } = this.sessionMetrics(Date.now());
    return {
      current: this.desiredAmps ?? 0,
      mode: this.getMode(),
      surplus: Math.round(this.lastAvailableW),
      sessionEnergy: Math.round((energyKwh ?? 0) * 100) / 100,
    };
  }

  private onStatus(info: StatusNotificationReq): void {
    const changed = info.status !== this.prevStatus;
    if (changed) {
      this.host.log(`[charger] status ${this.prevStatus ?? '?'} -> ${info.status}${
        info.errorCode && info.errorCode !== 'NoError' ? ` (${info.errorCode})` : ''}`);
      this.prevStatus = info.status;
      // Captured before any of the branches below clear transactionId/desiredAmps,
      // so a 'stopped' event's tokens reflect the current that was actually in
      // effect, not the just-cleared value.
      const event = this.statusToChargingEvent(info.status);
      if (event) this.emitChargingEvent(event);
      if (info.status === 'Faulted') this.host.onFault?.(info.errorCode ?? 'unknown');
    }
    this.host.setCapability('evcharger_charging_state', toChargingState(info.status));
    this.host.setCapability('evcharger_charging', info.status === 'Charging');
    // Persistent, condition-queryable fault state alongside the edge-only
    // onFault Flow trigger and the setWarning banner - all off the one signal.
    this.host.setCapability('alarm_generic', info.status === 'Faulted');
    this.lastFaultCode = info.status === 'Faulted' ? (info.errorCode ?? 'unknown') : null;
    this.refreshWarning();

    // A fresh plug-in always clears the manual latch, so a newly-connected car
    // resolves to Scheduled (in a window) or Solar (otherwise) - never Manual.
    // `prevPlugged === false` (not null) means we've actually observed the
    // charger idle before, so this doesn't fire on a transactionId restored
    // from the store at boot with no real status seen yet.
    if (info.status === 'Available') {
      if (this.prevPlugged === true) this.host.onVehicleDisconnected?.();
      this.prevPlugged = false;
      // Debounced: see IDLE_RECONCILE_DELAY_MS. Don't trust a single Available
      // report as proof a still-tracked transaction has actually ended - only
      // clear it if not superseded by a plugged status shortly after (a
      // same-session reconnect blip, not a real stop).
      if (this.transactionId != null && !this.pendingIdleReconcile) {
        // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in destroy()
        this.pendingIdleReconcile = setTimeout(() => {
          this.pendingIdleReconcile = null;
          this.applyIdleReconciliation();
        }, IDLE_RECONCILE_DELAY_MS);
        this.pendingIdleReconcile.unref?.();
      }
    } else if (PLUGGED.includes(info.status)) {
      if (this.pendingIdleReconcile) {
        clearTimeout(this.pendingIdleReconcile);
        this.pendingIdleReconcile = null;
      }
      if (this.prevPlugged === false) {
        if (this.manualLatch) this.clearManualLatch('fresh plug-in');
        this.host.onVehicleConnected?.();
      }
      this.prevPlugged = true;
    }

    // Finishing means the EV ended the session; some chargers (Wallbox Pulsar
    // included) hold Finishing without sending StopTransaction until the cable
    // is physically removed and reinserted. Treat it as authoritative here
    // rather than waiting indefinitely for StopTransaction/Available, so the
    // controller doesn't believe a dead transaction is still live.
    if (info.status === 'Finishing' && this.transactionId != null) {
      this.transactionId = null;
      this.desiredAmps = null;
      this.awaitingStart = false;
      this.host.setStore('transactionId', null).catch(this.host.error);
      this.host.setCapability('evcharger_charging', false);
    }
    this.lastStatusValue = info.status;
    // measure_power/measure_current are otherwise only ever written by
    // onMeterValues() - but a charger stops sending MeterValues once a
    // session ends (e.g. on unplug: confirmed on real hardware, Available
    // reports carry no meter payload), so without this the capabilities -
    // and anything reading them, including the power-flow widget and
    // Homey's own device tile/Insights - would keep showing the last
    // charging reading forever, even while evcharger_charging_state (driven
    // purely by this same StatusNotification, see toChargingState() above)
    // has already flipped to plugged_out. Reuse nettedChargerW()'s own
    // "confirmed 0 vs genuinely unknown" logic rather than zeroing on every
    // non-Charging status unconditionally, so the transient reconnect-blip
    // Available (still-live transactionId, see IDLE_RECONCILE_DELAY_MS)
    // correctly does NOT zero a session that's actually still charging.
    // Reset lastPowerW to null (not 0) so a future Charging status with no
    // fresh MeterValues yet is still read as unknown, not wrongly netted as
    // a confirmed 0 - see nettedChargerW()'s own doc comment.
    if (this.nettedChargerW() === 0 && this.lastPowerW !== null) {
      this.lastPowerW = null;
      this.host.setCapability('measure_power', 0);
      this.host.setCapability('measure_current', 0);
    }
    // Only re-resolve on an actual status change - a repeat of the same
    // status (e.g. the real charger echoing back what bind() already
    // replayed from cache, after requestFreshState()'s TriggerMessage) is not
    // new information, so skip the otherwise-duplicate [decision] line.
    if (changed) {
      this.tick(new Date(), `status:${info.status}`);
    }
  }

  /**
   * Applied once an Available report has persisted for IDLE_RECONCILE_DELAY_MS
   * without a plugged status superseding it - i.e. the charger is genuinely
   * idle, not mid-reconnect-blip. Reconciles a transaction id left over from
   * before an app restart, exactly as the pre-debounce code did. (prevPlugged
   * itself is set immediately on Available, not debounced - see onStatus -
   * only the transaction reconciliation needs this caution.)
   */
  private applyIdleReconciliation(): void {
    if (this.transactionId != null) {
      this.transactionId = null;
      this.awaitingStart = false;
      this.host.setStore('transactionId', null).catch(this.host.error);
      this.host.log('[charger] reconciled a stale transaction id (idle confirmed)');
    }
    // Covers a genuine unplug that goes straight Charging -> Available with no
    // Finishing report - the debounce above already confirmed this isn't a
    // reconnect blip. No-op (via emitChargingEvent's dedup) if 'stopped' was
    // already emitted through the Finishing path.
    this.emitChargingEvent('stopped');
  }

  private onMeterValues(r: Readings): void {
    if (r.power !== undefined) {
      this.lastPowerW = r.power; this.host.setCapability('measure_power', r.power);
    }
    if (r.current !== undefined) this.host.setCapability('measure_current', r.current);
    if (r.voltage !== undefined) this.host.setCapability('measure_voltage', r.voltage);
    if (r.energyKwh !== undefined) {
      this.lastEnergyKwh = r.energyKwh;
      this.host.setCapability('meter_power', r.energyKwh);
    }
    this.updateSessionCapabilities();

    // Gated on real movement: MeterValues arrives every meterSampleIntervalSec
    // (10s by default) for as long as the app runs, so logging every report
    // buries everything else in the log for no added information.
    if (r.power !== undefined && Math.abs(r.power - this.loggedPowerW) >= 100) {
      this.loggedPowerW = r.power;
      this.host.log(`[charger] power=${Math.round(r.power)}W `
        + `current=${r.current ?? '?'}A voltage=${r.voltage ?? '?'}V`);
    }
  }

  private onStartTransaction(id: number, req: StartTransactionReq): void {
    this.host.log(`[charger] transaction ${id} started (idTag ${req.idTag}, meterStart ${req.meterStart}Wh)`);
    this.transactionId = id;
    this.awaitingStart = false;
    this.host.setStore('transactionId', id).catch(this.host.error);
    this.host.setStore('meterStartWh', req.meterStart).catch(this.host.error);
    this.host.setStore('sessionStartMs', Date.now()).catch(this.host.error);
    this.host.setCapability('evcharger_charging', true);
    // Fresh session: re-base the session meters now rather than waiting for the
    // next MeterValues/tick to recompute them off the new meterStart.
    this.host.setCapability('meter_power.session', 0);
    this.host.setCapability('session_duration', 0);
    if (this.desiredAmps != null) this.scheduleWrite();
  }

  private onStopTransaction(req: StopTransactionReq): void {
    this.host.log(`[charger] transaction ${req.transactionId} stopped (${req.reason ?? 'n/a'}, meterStop ${req.meterStop}Wh)`);
    // The charger stopping a transaction we were never tracking means our id
    // was stale - every TxProfile write since would have been rejected. See
    // adoptTransactionId(), which is what should now prevent it; this stays as
    // the tell-tale if one ever slips through anyway.
    if (this.transactionId != null && req.transactionId !== this.transactionId) {
      this.host.log(`[charger] transaction id mismatch: charger stopped ${req.transactionId}, `
        + `we were tracking ${this.transactionId} - profile writes were going to a dead session`);
    }
    this.transactionId = null;
    this.host.setStore('transactionId', null).catch(this.host.error);
    this.host.setCapability('evcharger_charging', false);
  }

  // ---------------------------------------------------------------------------
  // Manual control (from capability listeners / flow cards) -> sets the latch
  // ---------------------------------------------------------------------------

  /** Turn charging on (charge at amps / slider) or off — both latch Manual mode. */
  async setManualCharging(on: boolean, amps?: number): Promise<void> {
    if (on) {
      const target = this.clampAmps(amps ?? this.cfg.maxAmps);
      this.manualLatch = { intent: 'charge', amps: target };
      this.host.setCapability('charge_current_limit', target);
    } else {
      this.manualLatch = { intent: 'off' };
    }
    this.host.log(`[mode] manual ${on ? `charge ${this.manualLatch.amps}A` : 'off'} (holds until schedule/replug)`);
    await this.host.setStore('manualLatch', this.manualLatch);
    this.tick(new Date(), 'manual-toggle');
  }

  /** Changing the current is a hands-on action: latch Manual at that current. */
  async setCurrentLimit(amps: number): Promise<void> {
    const target = this.clampAmps(amps);
    this.manualLatch = { intent: 'charge', amps: target };
    this.host.setCapability('charge_current_limit', target);
    await this.host.setStore('manualLatch', this.manualLatch);
    this.tick(new Date(), 'manual-current');
  }

  startManual(amps?: number): Promise<void> {
    return this.setManualCharging(true, amps);
  }

  stop(): Promise<void> {
    return this.setManualCharging(false);
  }

  /** Flow action: clear a manual override so the next tick resolves Scheduled/Solar/Idle. */
  resumeAutomatic(): void {
    this.clearManualLatch('flow: resume automatic');
    this.tick(new Date(), 'manual-toggle');
  }

  private clearManualLatch(reason: string): void {
    if (!this.manualLatch) return;
    this.manualLatch = null;
    this.host.setStore('manualLatch', null).catch(this.host.error);
    this.host.log(`[mode] manual cleared (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // Schedule / solar inputs
  // ---------------------------------------------------------------------------

  isCharging(): boolean {
    return this.transactionId != null;
  }

  /**
   * Is the charger's own reported status telling us current is actually
   * flowing right now? Deliberately independent of `isCharging()`/
   * `transactionId` - a charge point that never hands back a `StartTransaction`
   * for a session it's already running (some Wallbox firmware, apparently)
   * would otherwise leave `lastPowerW` permanently un-netted-out everywhere it
   * matters (solar surplus calc, household cap), even while genuinely
   * delivering power. Status is the more reliable ground truth here.
   */
  private isDeliveringPower(): boolean {
    return this.lastStatusValue === 'Charging';
  }

  /**
   * The charger's own draw (W) to net out of grid-based calcs (solar surplus,
   * household cap) - 0 when confirmed not delivering, the last MeterValues
   * reading when delivering and known, or null when genuinely unknown either
   * way. Two distinct unknown-window cases collapse to the same null result:
   * (a) `lastStatusValue` is still null (no StatusNotification received yet
   * this connection) *and* a `transactionId` is already known (persisted
   * from store at init - a session may already be live, e.g. restart onto
   * an already-charging car, confirmed on real hardware to take several
   * seconds to reconnect) - and (b) status confirms `Charging` but no
   * MeterValues has come back yet (confirmed to lag status by a couple more
   * seconds via the triggered-MeterValues round trip, since a fresh
   * ChargePoint instance has no cached reading to replay). Without a known
   * transactionId, a null status is instead trusted as "no session, nothing
   * to net out" (0) - otherwise a charger that's simply never connected
   * would leave every solar/household calc permanently unavailable, which
   * is what the plain SolarLoop-only tests correctly assume. Case (a)
   * matters even though a write can't reach a disconnected charger: the
   * resulting `desiredAmps` is still recorded, and if it happens to *not*
   * change again once the connection comes up (a real restart log showed
   * exactly this), `ensureCharging()`'s change-triggered write never fires
   * to correct it - so a wrongly-computed pause from this window can end up
   * being what a newly-connected, already-charging session sees applied.
   * Callers must NOT default a null result to 0 - that's the bug this exists
   * to prevent: it would treat the charger's own draw as competing "other"
   * household/grid load, understating available headroom right when a
   * session is already mid-charge, rather than honestly reporting unknown.
   */
  private nettedChargerW(): number | null {
    if (this.lastStatusValue == null) return this.transactionId != null ? null : 0;
    // A lone 'Available' report right after reconnect can be the same
    // transient false report onStatus() already debounces via
    // IDLE_RECONCILE_DELAY_MS before trusting it to end a still-tracked
    // transaction - confirmed on real hardware to flip back to Charging
    // over a second later, having briefly driven a genuine wrong (too-low)
    // household-cap write that then sat throttled for a full
    // writeThrottleMs before self-correcting. Mirror that same caution here:
    // don't trust it as confirmed-0 either while transactionId is still on
    // record (i.e. not yet reconciled away as genuinely idle).
    if (this.lastStatusValue === 'Available' && this.transactionId != null) return null;
    // Link down while the last thing we knew was 'Charging': the charge point
    // keeps running the profile it was last given, so the car may well still be
    // drawing - but lastPowerW is now as old as the outage itself and asserting
    // it as a live reading is exactly the staleness this whole path guards
    // against. A non-Charging last status still nets as a confirmed 0: that's
    // the conservative direction (it never credits the charger with headroom it
    // may not have), and it keeps a never-connected charger from leaving every
    // solar/household calc permanently unavailable, per the note above.
    if (this.online === false && this.isDeliveringPower()) return null;
    if (!this.isDeliveringPower()) return 0;
    return this.lastPowerW;
  }

  /** Human-readable reason nettedChargerW() returned null - see there. Log-only. */
  private chargerPowerUnknownReason(): string {
    if (this.lastStatusValue == null) return 'no status received yet this connection';
    if (this.lastStatusValue === 'Available') return 'Available but a transaction is still on record, not yet reconciled';
    if (this.online === false) return 'OCPP link down - last reading is as old as the outage';
    return 'Charging but no MeterValues yet this connection';
  }

  isWithinSchedule(now: Date = new Date()): boolean {
    return this.scheduler.isActive(now);
  }

  async setSchedule(windows: ScheduleWindow[]): Promise<void> {
    const conflicts = findScheduleConflicts(windows);
    if (conflicts.length > 0) {
      const [{ a, b }] = conflicts;
      throw new Error(`Schedule windows ${a + 1} and ${b + 1} overlap`);
    }
    this.scheduler.setWindows(windows);
    await this.host.setStore('schedule', windows);
    this.tick(new Date(), 'schedule-updated');
  }

  getSchedule(): ScheduleWindow[] {
    return this.scheduler.getWindows();
  }

  /** Directly set the solar target (A): null = stop, 0 = pause, >=min = charge. Test use. */
  setSolarTarget(amps: number | null): void {
    this.solarTargetAmps = amps;
    this.tick(new Date(), 'test-solar-target');
  }

  onSolarSample(sample: SolarSampleInput, now: number = Date.now()): void {
    this.lastSolarSampleAt = now;
    this.solarStaleWarned = false;
    const { gridSignedW } = sample;
    this.lastGridSignedW = gridSignedW;
    this.lastPvW = sample.pvW ?? 0;
    this.lastBatteryW = sample.batteryW ?? 0;
    if (!this.solarLoop) return;
    const chargerPowerW = this.nettedChargerW();
    if (chargerPowerW == null) {
      // Can't net the charger's own draw out of the grid reading, so skip
      // this sample's surplus evaluation rather than crediting/debiting an
      // unknown amount. solarTargetAmps/lastAvailableW are left as they
      // were; the next sample (moments away, given the ~10s cadence)
      // resolves this once nettedChargerW() has a real answer.
      this.host.log(`[solar] charger power unknown (${this.chargerPowerUnknownReason()}) - skipping evaluation`);
      this.tick(new Date(now), 'solar');
      return;
    }
    const res = this.solarLoop.evaluate({
      gridSignedW, chargerPowerW, batteryW: this.lastBatteryW, now,
    });
    this.lastAvailableW = Math.max(0, res.availableW);
    this.solarTargetAmps = res.target;
    this.host.setCapability('measure_solar_surplus', Math.round(this.lastAvailableW));

    // Deduped on a rounded-to-50W fingerprint: the feed reports roughly every
    // 10s indefinitely, and PV/house figures jitter by a few watts constantly,
    // so an unthrottled line here is almost all noise. The resolved target
    // itself is left to the [decision] line that follows (via tick() below) -
    // state is SolarLoop's own hysteresis state, which isn't shown anywhere
    // else and keeps running in the background even when solar isn't the
    // active mode, so it belongs in the fingerprint.
    const r50 = (w?: number) => (w == null ? 'na' : String(Math.round(w / 50) * 50));
    const key = [r50(sample.pvW), r50(sample.batteryW), r50(sample.houseW),
      r50(gridSignedW), r50(chargerPowerW), res.state].join('|');
    if (key !== this.loggedSolar) {
      this.loggedSolar = key;
      const f = (w?: number) => (w == null ? '?' : `${Math.round(w)}W`);
      this.host.log(`[solar] solar=${f(sample.pvW)} battery=${f(sample.batteryW)} house=${f(sample.houseW)} `
        + `grid=${f(gridSignedW)} charger=${f(chargerPowerW)} excess=${Math.round(this.lastAvailableW)}W`
        + ` (state=${res.state})`);
    }

    this.tick(new Date(now), 'solar');
  }

  private householdCapAmps(): number | null {
    if (this.cfg.maxHouseholdW <= 0) return null;
    const stale = this.lastSolarSampleAt === 0
      || (Date.now() - this.lastSolarSampleAt) > this.cfg.solarStaleMs;
    if (stale) return null;
    const chargerW = this.nettedChargerW();
    // Charging but no MeterValues yet this connection: same "don't guess"
    // gap as onSolarSample - trust the configured ceiling rather than netting
    // out 0 and understating headroom by the charger's own (unknown) draw.
    if (chargerW == null) return null;
    const baseLoadW = this.lastGridSignedW - chargerW;
    const maxChargerW = this.cfg.maxHouseholdW - baseLoadW;
    return Math.floor(maxChargerW / (this.cfg.voltage * this.cfg.phases));
  }

  /**
   * Hard ceiling for a physical circuit shared with other equipment (e.g. a
   * home battery inverter), independent of the whole-household cap above.
   * `sharedCircuitA + pv − battery − buffer`: PV production adds headroom,
   * battery charging subtracts it, battery discharging adds it back (it's
   * genuinely not drawing on the shared conductor right now) - this is a
   * Kirchhoff's-law current sum at the shared circuit node, so it's correct
   * to let discharge raise this ceiling even though `scheduledAmps` deliberately
   * refuses to use that same discharge as a reason to boost above a schedule's
   * floor (see there). Stale feed -> no extra restriction, same convention as
   * householdCapAmps: whatever ceiling is already configured for the active
   * mode (manual amps / schedule currentA) is trusted as the safety margin.
   *
   * Not every shared circuit involves solar or a battery at all (e.g. a
   * charger sharing a breaker with a dryer) - `sharedCircuitIncludeSolar`/
   * `sharedCircuitIncludeBattery` opt each term in independently. If neither
   * is enabled, the cap has nothing to do with the solar feed, so it's a
   * plain static number and the staleness gate above doesn't apply either -
   * gating a config that never reads the feed on that same feed being fresh
   * would make the cap permanently unavailable for anyone without solar.
   */
  private sharedCircuitCapAmps(): number | null {
    if (this.cfg.sharedCircuitA <= 0) return null;
    if (!this.cfg.sharedCircuitIncludeSolar && !this.cfg.sharedCircuitIncludeBattery) {
      return Math.floor(this.cfg.sharedCircuitA - this.cfg.sharedCircuitBufferA);
    }
    const stale = this.lastSolarSampleAt === 0
      || (Date.now() - this.lastSolarSampleAt) > this.cfg.solarStaleMs;
    if (stale) return null;
    const div = this.cfg.voltage * this.cfg.phases;
    const pvA = this.cfg.sharedCircuitIncludeSolar ? this.lastPvW / div : 0;
    const batteryA = this.cfg.sharedCircuitIncludeBattery ? this.lastBatteryW / div : 0;
    return Math.floor(this.cfg.sharedCircuitA + pvA - batteryA - this.cfg.sharedCircuitBufferA);
  }

  // ---------------------------------------------------------------------------
  // Mode + status reporting
  // ---------------------------------------------------------------------------

  getMode(): ChargeMode {
    return this.currentMode ?? this.resolve(new Date()).mode;
  }

  /**
   * Mode + the raw semantic facts the widget's shorthand status line needs -
   * deliberately not pre-formatted strings (formatting/timezone belongs to
   * the client, which runs on the user's phone in its own local timezone, not
   * the Homey Pro's UTC OS clock - see the class doc). Only the field(s)
   * relevant to the current mode are populated; the rest are null/false.
   */
  getModeInfo(): {
    mode: ChargeMode;
    scheduleEndAt: string | null;
    nextScheduleStartAt: string | null;
    boostActive: boolean;
    solarEnough: boolean | null;
    } {
    const now = new Date();
    const mode = this.currentMode ?? this.resolve(now).mode;
    let scheduleEndAt: string | null = null;
    let nextScheduleStartAt: string | null = null;
    let boostActive = false;
    let solarEnough: boolean | null = null;
    if (mode === 'scheduled') {
      const end = this.scheduler.currentEnd(now);
      scheduleEndAt = end ? end.toISOString() : null;
      const floor = this.scheduleOrMax(now);
      boostActive = this.scheduledAmpsDetail(now).amps > floor;
    } else {
      const ns = this.scheduler.nextStart(now);
      nextScheduleStartAt = ns ? ns.toISOString() : null;
      if (mode === 'solar') {
        const t = this.solarTargetAmps;
        solarEnough = t != null && t >= this.cfg.minAmps;
      }
    }
    return {
      mode, scheduleEndAt, nextScheduleStartAt, boostActive, solarEnough,
    };
  }

  getDiagnostics(): {
    availableW: number; solarState: string; targetA: number | null; mode: ChargeMode;
    chargerPowerW: number | null;
    limits: {
      chargerMaxW: number; gridMaxW: number;
      batteryChargePeakW: number; batteryDischargePeakW: number; solarPeakW: number;
    };
    } {
    return {
      availableW: this.lastAvailableW,
      solarState: this.solarLoop?.getState() ?? 'off',
      targetA: this.solarTargetAmps,
      mode: this.getMode(),
      // Netted charger draw (see nettedChargerW()): 0 if confirmed not delivering,
      // null if genuinely unknown right now. Exposed so callers (the widget's house
      // load) can subtract the EV's own draw out of a grid-derived total instead of
      // double-counting it as household consumption.
      chargerPowerW: this.nettedChargerW(),
      limits: {
        chargerMaxW: this.cfg.maxAmps * this.cfg.voltage * this.cfg.phases,
        gridMaxW: this.cfg.maxHouseholdW,
        batteryChargePeakW: this.cfg.peakBatteryChargeW,
        batteryDischargePeakW: this.cfg.peakBatteryDischargeW,
        solarPeakW: this.cfg.peakSolarW,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Decision + tick
  // ---------------------------------------------------------------------------

  /**
   * Resolve derived mode + desired charging current. Manual > Schedule > Solar.
   * amps is always 0 (pause, keep any live session alive) or a real target -
   * nothing here ever calls for a hard stop. The Wallbox holds Finishing until
   * a physical unplug/replug once a transaction is actually ended, so ending
   * one is never worth the risk of stranding the charger.
   */
  resolve(now: Date): Decision {
    const { mode, amps } = this.resolveDetailed(now);
    return { mode, amps };
  }

  /**
   * Same resolution as `resolve()`, plus a human-readable `reason` covering
   * every branch below - this is what `tick()` logs every cycle so the log
   * always explains why a given current was requested, before any cap is
   * applied. Kept separate from the public `resolve()` (used directly by
   * tests) so its return shape doesn't grow for callers that don't need it.
   */
  private resolveDetailed(now: Date): Decision & { reason: string } {
    if (this.manualLatch) {
      if (this.manualLatch.intent === 'off') {
        return { mode: 'manual', amps: 0, reason: 'manual: off (paused)' };
      }
      const amps = this.manualLatch.amps ?? this.cfg.maxAmps;
      return { mode: 'manual', amps, reason: `manual: charging at ${amps}A` };
    }
    if (this.scheduler.isActive(now)) {
      return { mode: 'scheduled', ...this.scheduledAmpsDetail(now) };
    }
    if (!this.cfg.solarEnabled) {
      return {
        mode: 'idle',
        amps: 0,
        reason: 'idle: solar tracking disabled (no manual or schedule target active)',
      };
    }
    // Solar is the default outside a schedule. null (SolarLoop's 'off' state:
    // never started, or just reset) and 0 (its 'paused' state: was charging,
    // backed off) both mean "hold at 0A" here, but they restart differently -
    // 'off' can start the instant surplus is enough, while 'paused' must also
    // wait out the min-off dwell from when it actually stopped, so the reason
    // text spells that difference out rather than treating them as the same.
    if (this.solarTargetAmps == null) {
      return {
        mode: 'solar',
        amps: 0,
        reason: `solar: idle (no session started yet - starts once surplus reaches ${this.cfg.minAmps}A)`,
      };
    }
    if (this.solarTargetAmps === 0) {
      const cooldownSec = Math.round(this.cfg.minOffMs / 1000);
      return {
        mode: 'solar',
        amps: 0,
        reason: 'solar: paused (stopped charging - won\'t resume until surplus recovers '
          + `and the ${cooldownSec}s cooldown elapses)`,
      };
    }
    const amps = this.clampAmps(this.solarTargetAmps);
    return { mode: 'solar', amps, reason: `solar: following surplus at ${amps}A` };
  }

  private scheduleOrMax(now: Date): number {
    return this.clampAmps(this.scheduler.activeCurrent(now) ?? this.cfg.maxAmps);
  }

  /**
   * The active schedule window's current, as a floor rather than a fixed
   * target when the window has `boostToCap` set: if there's spare capacity on
   * the shared circuit, raise the target up to it. Deliberately excludes
   * battery discharge as a reason to boost - `lastBatteryW < 0` means the
   * battery is actively servicing some load on the shared circuit right now,
   * and the home battery must never be the thing funding extra EV current
   * beyond the configured floor, even though sharedCircuitCapAmps() (the hard
   * safety ceiling applied afterwards in tick()) correctly treats that same
   * discharge as freeing up real capacity on the conductor. Only applies when
   * the battery is actually part of the shared circuit (`sharedCircuitIncludeBattery`)
   * - otherwise its charge/discharge state has no bearing on this circuit at all.
   */
  private scheduledAmpsDetail(now: Date): { amps: number; reason: string } {
    const floor = this.scheduleOrMax(now);
    if (!this.scheduler.activeBoostToCap(now)) {
      return { amps: floor, reason: `scheduled: floor ${floor}A (boost not enabled for this window)` };
    }
    if (this.cfg.sharedCircuitIncludeBattery && this.lastBatteryW < 0) {
      const dischargeA = Math.abs(Math.round(this.lastBatteryW / (this.cfg.voltage * this.cfg.phases)));
      return {
        amps: floor,
        reason: `scheduled: floor ${floor}A (boost blocked - battery discharging ~${dischargeA}A on shared circuit)`,
      };
    }
    const cap = this.sharedCircuitCapAmps();
    if (cap == null) {
      return { amps: floor, reason: `scheduled: floor ${floor}A (boost enabled, but shared-circuit cap unavailable)` };
    }
    if (cap <= floor) {
      return { amps: floor, reason: `scheduled: floor ${floor}A (boost enabled, circuit cap ${cap}A doesn't exceed floor)` };
    }
    const amps = this.clampAmps(Math.max(floor, cap));
    return {
      amps,
      reason: `scheduled: boosted floor ${floor}A -> ${amps}A (circuit cap ${cap}A, `
        + `pv=${Math.round(this.lastPvW)}W battery=${Math.round(this.lastBatteryW)}W)`,
    };
  }

  tick(now: Date = new Date(), trigger: string = 'timer'): void {
    // Clear the manual latch when a schedule window starts (rising edge).
    const inSchedule = this.scheduler.isActive(now);
    if (inSchedule && !this.wasInSchedule && this.manualLatch) {
      this.clearManualLatch('schedule started');
    }
    this.wasInSchedule = inSchedule;

    // Solar fail-safe: if the feed goes stale while solar is the effective mode.
    if (!this.manualLatch && !inSchedule && this.lastSolarSampleAt > 0
      && now.getTime() - this.lastSolarSampleAt > this.cfg.solarStaleMs) {
      if (!this.solarStaleWarned) {
        this.host.log('Solar feed stale; failing safe (pausing solar charging)');
        this.solarStaleWarned = true;
      }
      this.solarTargetAmps = null;
      this.solarLoop?.reset();
    }

    // Keep the persisted last-seen figure roughly current while the link is
    // healthy, so an outage that starts with an ungraceful app exit (no
    // disconnect event to force a write) is still measured from close to the
    // real last contact rather than from whenever the controller last bound.
    if (this.cp?.connected) this.noteLastSeen(this.cp.getConnectionInfo().lastSeenAt);

    const decision = this.resolveDetailed(now);
    this.updateMode(decision.mode);

    // Two independent hard ceilings apply on top of the decision above, in
    // every mode. Both are logged into the same per-tick decision line below
    // (not just on change) so every tick's outcome - and exactly why - is
    // visible in the log, covering every branch: uncapped, household-capped,
    // circuit-capped, or both.
    let { amps } = decision;
    const capNotes: string[] = [];
    // Set when a hard cap's *own ceiling* has dropped further than it was on
    // the previous tick - regardless of whether it's this block or a mode's
    // own logic (e.g. the schedule boost-to-cap in scheduledAmpsDetail) that
    // ends up applying it. Passed through to ensureCharging() so a resulting
    // decrease can jump the write throttle: the throttle exists to space out
    // routine adjustments (solar tracking, schedule floors), not to leave the
    // charger over a shrinking safety ceiling for up to writeThrottleMs.
    let capTightened = false;

    if (amps > 0) {
      const requested = amps;
      const cap = this.householdCapAmps();
      if (cap != null) {
        if (this.lastHouseholdCapAmps != null && cap < this.lastHouseholdCapAmps) capTightened = true;
        this.lastHouseholdCapAmps = cap;
      }
      if (cap != null && cap < amps) {
        const capped = cap < this.cfg.minAmps ? 0 : cap;
        capNotes.push(`household cap ${this.cfg.maxHouseholdW}W -> ${capped === 0 ? 'pause' : `${capped}A`} `
          + `(requested ${requested}A)`);
        amps = capped;
      } else if (cap != null) {
        // "ceiling" is the max the charger could draw under this cap right
        // now (baseline load already netted out) - not spare capacity above
        // the current request, which is `cap - requested` if that's wanted.
        capNotes.push(`household cap ok (ceiling ${cap}A >= requested ${requested}A)`);
      }
    }

    if (amps > 0) {
      const requested = amps;
      const circuitCap = this.sharedCircuitCapAmps();
      if (circuitCap != null) {
        if (this.lastSharedCircuitCapAmps != null && circuitCap < this.lastSharedCircuitCapAmps) capTightened = true;
        this.lastSharedCircuitCapAmps = circuitCap;
      }
      if (circuitCap != null && circuitCap < amps) {
        const capped = circuitCap < this.cfg.minAmps ? 0 : circuitCap;
        capNotes.push(`shared circuit cap ${this.cfg.sharedCircuitA}A -> ${capped === 0 ? 'pause' : `${capped}A`} `
          + `(requested ${requested}A)`);
        amps = capped;
      } else if (circuitCap != null) {
        capNotes.push(`shared circuit cap ok (ceiling ${circuitCap}A >= requested ${requested}A)`);
      }
    }

    const finalDesc = amps <= 0 ? 'paused' : `${amps}A`;
    // The link state is part of every decision line: a resolved target the
    // charger can't be told about reads identically to one it accepted, which
    // is exactly how a long outage hides behind a plausible-looking log.
    const linkNote = this.online === false
      ? ` | OFFLINE${this.lastSeenAt != null ? ` for ${fmtDuration(Date.now() - this.lastSeenAt)}` : ''} (not sent)`
      : '';
    // Same treatment for a target the charger is connected for but can't be
    // given (see writeBlockedBecause) - a decision that never reaches the
    // charger must never read like one that did.
    const blocked = this.writeBlockedBecause(amps);
    this.host.log(`[decision:${trigger}] ${decision.reason}${
      capNotes.length ? ` | ${capNotes.join('; ')}` : ''} -> ${finalDesc}${linkNote}${
      blocked ? ` | NOT SENT (${blocked})` : ''}`);

    // Only the Finishing case asks something of the user; "nothing plugged in"
    // is an ordinary idle state and must not raise a banner.
    const replug = this.lastStatusValue === 'Finishing' && amps > 0;
    if (replug && !this.needsReplug) {
      this.host.log('[charger] parked in Finishing with a live target - needs a physical unplug/replug to resume');
    }
    this.needsReplug = replug;
    this.refreshWarning();

    this.ensureCharging(amps, capTightened);

    // Advance the session duration/energy capabilities even on ticks with no
    // fresh MeterValues (e.g. a paused-but-live session), so duration doesn't
    // stall between meter reports.
    this.updateSessionCapabilities(now.getTime());

    // Backstop: guarantee a re-resolve at least every TICK_MS even with no
    // reactive trigger (status/solar/manual/schedule) - but every tick, from
    // whichever source, pushes the backstop out another TICK_MS rather than
    // firing independently on its own fixed schedule. So this is a "max once
    // every TICK_MS from the timer" rather than "every TICK_MS regardless".
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in destroy()
    this.tickTimer = setTimeout(() => this.tick(new Date(), 'timer'), TICK_MS);
    this.tickTimer.unref?.();
  }

  private updateMode(mode: ChargeMode): void {
    if (mode === this.currentMode) return;
    const first = this.currentMode === null;
    this.currentMode = mode;
    this.host.setCapability('charge_mode', mode);
    if (!first) {
      this.host.log(`[mode] -> ${mode}`);
      this.host.onModeChanged?.(mode);
    }
  }

  /**
   * amps: 0 = pause (hold 0A, keep the transaction), >0 = charge at that
   * current. capTightened: a hard cap's ceiling dropped further this tick
   * (see tick()) - if that also means less current than we last asked for,
   * the resulting write jumps the throttle rather than leaving the charger
   * over a shrinking safety ceiling for up to writeThrottleMs.
   */
  private ensureCharging(amps: number, capTightened = false): void {
    const target = amps <= 0 ? 0 : this.clampAmps(amps);
    // Genuinely plugged in and mid-session from the charger's own point of
    // view, whether or not *we* hold a transaction id for it.
    const plugged = this.lastStatusValue != null && PLUGGED.includes(this.lastStatusValue)
      && this.lastStatusValue !== 'Finishing';
    // TxProfile once a transaction id is known, or TxDefaultProfile whenever
    // the charger is visibly plugged in even without one - some charge points
    // never hand back a StartTransaction for a session they're already
    // running (observed on real hardware: a redundant RemoteStartTransaction
    // while already Charging gets rejected outright), which would otherwise
    // leave the app permanently unable to adjust the current for that entire
    // session.
    const eligible = this.transactionId != null || plugged;
    const ampsChanged = this.desiredAmps !== target;
    // Newly write-eligible after a spell of not being (a replug out of
    // Finishing, a session finally granting a transaction id): the charger is
    // running on whatever profile predates the gap, and the throttle exists to
    // space out routine adjustments, not to hold back the write that first
    // reconciles it. Treated as urgent for the same reason a tightening cap is.
    const regained = eligible && !this.wasWriteEligible;
    const urgent = regained
      || (capTightened && this.desiredAmps != null && target < this.desiredAmps);
    if (ampsChanged) {
      this.desiredAmps = target;
      if (target > 0) this.host.setCapability('charge_current_limit', target);
    }
    // Also write on becoming newly eligible even if the target didn't change
    // across that transition (e.g. the charger only just reported a plugged
    // status) - otherwise a target that happens not to move at that exact
    // moment would never actually reach the charger.
    if (eligible && (ampsChanged || regained)) this.scheduleWrite(urgent);
    this.wasWriteEligible = eligible;
    // Only attempt a fresh start while the charger is genuinely waiting for
    // one (Preparing: cable connected, no session yet) - not once a session
    // already appears underway (Charging/SuspendedEV/SuspendedEVSE), which
    // has been observed to just get rejected, and which TxDefaultProfile
    // above already covers for adjusting the current anyway.
    if (target > 0 && this.transactionId == null && !this.awaitingStart
      && this.lastStatusValue === 'Preparing' && this.cp?.connected) {
      this.awaitingStart = true;
      this.host.log(`[charger] requesting start (${target}A)`);
      this.cp.remoteStartTransaction(this.cfg.idTag, CONNECTOR_ID)
        .then((accepted) => {
          this.host.log(`[charger] start ${accepted ? 'accepted' : 'rejected'}`);
          if (!accepted) this.awaitingStart = false;
        })
        .catch((e) => {
          this.awaitingStart = false; this.host.error('remoteStart', e);
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Applying the current limit (throttled)
  // ---------------------------------------------------------------------------

  private clampAmps(amps: number): number {
    // Floor (never round up) so a target can't exceed the available surplus/limit.
    return Math.max(this.cfg.minAmps, Math.min(this.cfg.maxAmps, Math.floor(amps)));
  }

  private scheduleWrite(urgent = false): void {
    // Urgent (a hard cap tightened below what we last asked for): jump the
    // queue rather than waiting out - or continuing to wait out - the usual
    // throttle. Cancels any deferred write already pending so this one, with
    // the freshest (lower) desiredAmps, goes out immediately instead.
    if (urgent) {
      if (this.pendingWrite) {
        clearTimeout(this.pendingWrite);
        this.pendingWrite = null;
      }
      this.writeProfile().catch(this.host.error);
      return;
    }
    if (this.pendingWrite) return;
    const wait = Math.max(0, this.cfg.writeThrottleMs - (Date.now() - this.lastWriteAt));
    if (wait === 0) {
      this.writeProfile().catch(this.host.error);
    } else {
      // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared in destroy()
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = null;
        this.writeProfile().catch(this.host.error);
      }, wait);
      this.pendingWrite.unref?.();
    }
  }

  // writeProfile() already catches everything internally (never rejects) -
  // the .catch(host.error) above is a defensive backstop only.
  private async writeProfile(): Promise<void> {
    if (!this.cp?.connected || this.desiredAmps == null) return;
    this.lastWriteAt = Date.now();
    const txId = this.transactionId;
    const kind = txId != null ? `TxProfile tx=${txId}` : 'TxDefaultProfile';
    this.host.log(`[charger] setting profile: ${this.desiredAmps}A (${kind})`);
    try {
      const accepted = await this.cp.setChargingProfile({
        limitAmps: this.desiredAmps,
        connectorId: CONNECTOR_ID,
        transactionId: txId ?? undefined,
        numberPhases: this.cfg.phases,
        chargingProfileId: PROFILE_ID,
        stackLevel: STACK_LEVEL,
      });
      this.host.log(`[charger] profile ${accepted ? 'accepted' : 'rejected'}`);
      // A rejected TxProfile is most often a transaction id the charger does
      // not recognise, and the next write is only triggered by the target
      // changing - which may not happen for minutes. TxDefaultProfile needs no
      // transaction id and is already known to be obeyed on this hardware, so
      // retry once immediately rather than leaving the charger on its previous
      // limit indefinitely. Guarded on the id being unchanged so this can't
      // fight a transaction that started while the call was in flight.
      if (!accepted && txId != null && this.transactionId === txId && this.cp?.connected) {
        this.host.log('[charger] retrying as TxDefaultProfile (no transaction id)');
        const retried = await this.cp.setChargingProfile({
          limitAmps: this.desiredAmps,
          connectorId: CONNECTOR_ID,
          numberPhases: this.cfg.phases,
          chargingProfileId: PROFILE_ID,
          stackLevel: STACK_LEVEL,
        });
        this.host.log(`[charger] profile retry ${retried ? 'accepted' : 'rejected'}`);
      }
    } catch (err) {
      this.host.error('SetChargingProfile failed:', (err as Error).message);
    }
  }

}

'use strict';

import { CentralSystem } from '../ocpp/CentralSystem';
import { ChargePoint } from '../ocpp/ChargePoint';
import {
  MeterValuesReq,
  OcppStatus,
  Readings,
  StartTransactionReq,
  StatusNotificationReq,
  StopTransactionReq,
} from '../ocpp/types';
import { Scheduler, ScheduleWindow } from './Scheduler';
import { BelowMinBehavior, SolarLoop, SolarLoopConfig } from './SolarLoop';

export type ChargeMode = 'off' | 'scheduled' | 'solar' | 'manual';

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
  /** Fired when charging starts/stops so the device can trigger Flow cards. */
  onChargingChanged?(charging: boolean): void;
  onModeChanged?(mode: ChargeMode): void;
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
  belowMin: BelowMinBehavior;
  /** Solar feed stale timeout (ms) after which the loop fails safe. */
  solarStaleMs: number;
}

const DEFAULTS: ControllerConfig = {
  minAmps: 6,
  maxAmps: 31,
  phases: 1,
  voltage: 230,
  idTag: 'CHARGEIQ',
  meterSampleIntervalSec: 10,
  writeThrottleMs: 15000,
  deadbandA: 1,
  rampA: 3,
  minOnMs: 3 * 60000,
  minOffMs: 3 * 60000,
  marginW: 0,
  belowMin: 'pause',
  solarStaleMs: 60000,
};

const PROFILE_ID = 1;
const STACK_LEVEL = 1;
const CONNECTOR_ID = 1;
const TICK_MS = 30000;

interface ManualOverride {
  action: 'start' | 'stop';
  amps?: number;
  /** Epoch ms at which the override expires (Infinity = until cleared). */
  expiresAt: number;
}

interface Decision {
  charge: boolean;
  amps?: number;
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
 * reflects OCPP state onto capabilities, and resolves a desired charging action
 * each tick from mode + schedule + manual override (precedence: manual override
 * -> active schedule window -> solar -> idle). Solar is added in M4.
 */
export class ChargeController {

  private host: ControllerHost;

  private cs: CentralSystem;

  private cp: ChargePoint | null = null;

  private cfg: ControllerConfig;

  private mode: ChargeMode = 'off';

  private scheduler = new Scheduler();

  private override: ManualOverride | null = null;

  /** Solar target (A): null = stop, 0 = pause, >=minAmps = charge. Fed by SolarFeed (M4). */
  private solarTargetAmps: number | null = null;

  private solarLoop: SolarLoop | null = null;

  private lastSolarSampleAt = 0;

  private solarStaleWarned = false;

  /** Latest charger draw from MeterValues (W), used by the solar loop. */
  private lastPowerW = 0;

  /** Latest computed surplus available to the car (W) — the "excess solar". */
  private lastAvailableW = 0;

  // Diagnostics: remember last-logged values to log only on meaningful change.
  private prevStatus: string | null = null;

  private loggedPowerW = 0;

  private loggedSolar = '';

  private transactionId: number | null = null;

  /** Currently-applied/desired current (A); null = not charging. */
  private desiredAmps: number | null = null;

  private awaitingStart = false;

  private lastWriteAt = 0;

  private pendingWrite: NodeJS.Timeout | null = null;

  private tickTimer: NodeJS.Timeout | null = null;

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
    this.mode = this.host.getStore<ChargeMode>('mode') ?? 'off';
    this.transactionId = this.host.getStore<number>('transactionId') ?? null;
    this.scheduler.setWindows(this.host.getStore<ScheduleWindow[]>('schedule') ?? []);
    this.host.setCapability('charge_mode', this.mode);

    const existing = this.cs.getChargePoint(this.host.identity);
    if (existing) this.bind(existing);

    this.cs.on('connect', (cp: ChargePoint) => {
      if (cp.identity === this.host.identity) this.bind(cp);
    });
    this.cs.on('disconnect', (cp: ChargePoint) => {
      if (cp.identity === this.host.identity) {
        this.cp = null;
        this.host.setUnavailable('Charger offline');
      }
    });

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    // Do not keep the process alive solely for the tick (matters for tests/CLI).
    this.tickTimer.unref?.();
  }

  destroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pendingWrite) clearTimeout(this.pendingWrite);
    this.tickTimer = null;
    this.pendingWrite = null;
  }

  refreshConfig(): void {
    const g = <T>(k: string, d: T): T => (this.host.getSetting<T>(k) ?? d);
    this.cfg = {
      minAmps: g('minAmps', DEFAULTS.minAmps),
      maxAmps: g('maxAmps', DEFAULTS.maxAmps),
      phases: g('phases', DEFAULTS.phases),
      voltage: g('voltage', DEFAULTS.voltage),
      idTag: g('idTag', DEFAULTS.idTag),
      meterSampleIntervalSec: g('meterSampleIntervalSec', DEFAULTS.meterSampleIntervalSec),
      writeThrottleMs: g('writeThrottleMs', DEFAULTS.writeThrottleMs),
      deadbandA: g('deadbandA', DEFAULTS.deadbandA),
      rampA: g('rampA', DEFAULTS.rampA),
      minOnMs: g('minOnSec', DEFAULTS.minOnMs / 1000) * 1000,
      minOffMs: g('minOffSec', DEFAULTS.minOffMs / 1000) * 1000,
      marginW: g('marginW', DEFAULTS.marginW),
      belowMin: g('belowMin', DEFAULTS.belowMin),
      solarStaleMs: g('solarStaleSec', DEFAULTS.solarStaleMs / 1000) * 1000,
    };
    this.solarLoop?.setConfig(this.solarLoopConfig());
  }

  private solarLoopConfig(): SolarLoopConfig {
    const c = this.cfg;
    return {
      voltage: c.voltage, phases: c.phases, minAmps: c.minAmps, maxAmps: c.maxAmps,
      deadbandA: c.deadbandA, rampA: c.rampA, minOnMs: c.minOnMs, minOffMs: c.minOffMs,
      marginW: c.marginW, belowMin: c.belowMin,
    };
  }

  private bind(cp: ChargePoint): void {
    this.host.setAvailable();
    if (this.cp === cp) return;
    this.cp = cp;

    cp.on('boot', () => this.configureCharger().catch((e) => this.host.error('configureCharger', e)));
    cp.on('status', (i: StatusNotificationReq) => this.onStatus(i));
    cp.on('meterValues', (r: Readings, _raw: MeterValuesReq) => this.onMeterValues(r));
    cp.on('startTransaction', (id: number, req: StartTransactionReq) => this.onStartTransaction(id, req));
    cp.on('stopTransaction', (req: StopTransactionReq) => this.onStopTransaction(req));

    // Catch up from cached state if the charger connected before we bound.
    const cachedStatus = cp.getLastStatus();
    if (cachedStatus) this.onStatus(cachedStatus);
    const cachedReadings = cp.getLastReadings();
    if (cachedReadings) this.onMeterValues(cachedReadings);

    // And request fresh values so nothing stays blank if the charger was quiet.
    this.requestFreshState();

    this.host.log(`Controller bound to ${cp.identity}`);
    this.tick();
  }

  /** Ask the charger to (re)send its current status and meter values. Best-effort. */
  private requestFreshState(): void {
    if (!this.cp?.connected) return;
    this.cp.triggerMessage('StatusNotification', CONNECTOR_ID).catch(() => { /* optional */ });
    this.cp.triggerMessage('MeterValues', CONNECTOR_ID).catch(() => { /* optional */ });
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

  private onStatus(info: StatusNotificationReq): void {
    if (info.status !== this.prevStatus) {
      this.host.log(`[charger] status ${this.prevStatus ?? '?'} -> ${info.status}`
        + (info.errorCode && info.errorCode !== 'NoError' ? ` (${info.errorCode})` : ''));
      this.prevStatus = info.status;
    }
    this.host.setCapability('charger_status', info.status);
    this.host.setCapability('evcharger_charging_state', toChargingState(info.status));
    this.host.setCapability('evcharger_charging', info.status === 'Charging');
    this.host.setWarning(info.status === 'Faulted' ? `Charger fault: ${info.errorCode}` : null);

    // Reconcile a stale transaction id after a restart/reconnect: if the charger
    // reports it is idle, no session is active regardless of what we persisted.
    if (info.status === 'Available' && this.transactionId != null) {
      this.transactionId = null;
      this.awaitingStart = false;
      this.host.setStore('transactionId', null).catch(this.host.error);
    }
  }

  private onMeterValues(r: Readings): void {
    if (r.power !== undefined) { this.lastPowerW = r.power; this.host.setCapability('measure_power', r.power); }
    if (r.current !== undefined) this.host.setCapability('measure_current', r.current);
    if (r.voltage !== undefined) this.host.setCapability('measure_voltage', r.voltage);
    if (r.energyKwh !== undefined) this.host.setCapability('meter_power', r.energyKwh);

    // Log only on a meaningful power change (>=100W) to avoid flooding.
    if (r.power !== undefined && Math.abs(r.power - this.loggedPowerW) >= 100) {
      this.loggedPowerW = r.power;
      this.host.log(`[charger] power=${Math.round(r.power)}W current=${r.current ?? '?'}A voltage=${r.voltage ?? '?'}V`);
    }
  }

  private onStartTransaction(id: number, req: StartTransactionReq): void {
    this.host.log(`[charger] transaction ${id} started (idTag ${req.idTag}, meterStart ${req.meterStart}Wh)`);
    this.transactionId = id;
    this.awaitingStart = false;
    this.host.setStore('transactionId', id).catch(this.host.error);
    this.host.setStore('meterStartWh', req.meterStart).catch(this.host.error);
    this.host.setCapability('evcharger_charging', true);
    this.host.onChargingChanged?.(true);
    if (this.desiredAmps != null) this.scheduleWrite();
  }

  private onStopTransaction(req: StopTransactionReq): void {
    this.host.log(`[charger] transaction ${req.transactionId} stopped (${req.reason ?? 'n/a'}, meterStop ${req.meterStop}Wh)`);
    this.transactionId = null;
    this.host.setStore('transactionId', null).catch(this.host.error);
    this.host.setCapability('evcharger_charging', false);
    this.host.onChargingChanged?.(false);
  }

  // ---------------------------------------------------------------------------
  // Public API (capability listeners / flow cards)
  // ---------------------------------------------------------------------------

  async setMode(mode: ChargeMode): Promise<void> {
    this.mode = mode;
    this.override = null; // switching mode clears a lingering override
    await this.host.setStore('mode', mode);
    this.host.setCapability('charge_mode', mode);
    this.host.onModeChanged?.(mode);
    this.tick();
  }

  getMode(): ChargeMode {
    return this.mode;
  }

  isCharging(): boolean {
    return this.transactionId != null;
  }

  isWithinSchedule(now: Date = new Date()): boolean {
    return this.scheduler.isActive(now);
  }

  async setSchedule(windows: ScheduleWindow[]): Promise<void> {
    this.scheduler.setWindows(windows);
    await this.host.setStore('schedule', windows);
    this.tick();
  }

  getSchedule(): ScheduleWindow[] {
    return this.scheduler.getWindows();
  }

  /** Directly set the solar target (A): null = stop, 0 = pause, >=min = charge. Test/manual use. */
  setSolarTarget(amps: number | null): void {
    this.solarTargetAmps = amps;
    if (this.mode === 'solar') this.tick();
  }

  /**
   * Feed a fresh grid-power sample (import positive / export negative) from the
   * solar device. Runs the surplus loop against the current charger draw and
   * updates the solar target. Called by SolarFeed on every capability change.
   */
  onSolarSample(gridSignedW: number, now: number = Date.now()): void {
    this.lastSolarSampleAt = now;
    this.solarStaleWarned = false;
    if (!this.solarLoop) return;
    const chargerPowerW = this.isCharging() ? this.lastPowerW : 0;
    const res = this.solarLoop.evaluate({ gridSignedW, chargerPowerW, now });
    this.lastAvailableW = res.availableW;
    this.solarTargetAmps = res.target;

    // Log solar decisions when the outcome changes (avoids per-sample spam).
    const line = `grid=${Math.round(gridSignedW)}W excess=${Math.round(res.availableW)}W -> `
      + `${res.target === null ? 'stop' : res.target === 0 ? 'pause' : res.target + 'A'} (${res.state})`;
    if (line !== this.loggedSolar) {
      this.loggedSolar = line;
      this.host.log(`[solar] ${line}`);
    }

    if (this.mode === 'solar') this.tick(new Date(now));
  }

  /** Diagnostics for the widget / metrics: excess solar (W), solar loop state, target. */
  getDiagnostics(): { availableW: number; solarState: string; targetA: number | null; mode: ChargeMode } {
    return {
      availableW: this.lastAvailableW,
      solarState: this.solarLoop?.getState() ?? 'off',
      targetA: this.solarTargetAmps,
      mode: this.mode,
    };
  }

  /** Manual start: overrides the base mode until the next schedule boundary. */
  async startManual(amps?: number): Promise<void> {
    const target = this.clampAmps(amps ?? this.cfg.maxAmps);
    this.host.setCapability('charge_current_limit', target);
    this.override = { action: 'start', amps: target, expiresAt: this.nextBoundaryMs() };
    this.tick();
  }

  async setCurrentLimit(amps: number): Promise<void> {
    const target = this.clampAmps(amps);
    this.host.setCapability('charge_current_limit', target);
    if (this.override?.action === 'start') this.override.amps = target;
    this.tick();
  }

  /** Manual stop: overrides the base mode until the next schedule boundary. */
  async stop(): Promise<void> {
    this.override = { action: 'stop', expiresAt: this.nextBoundaryMs() };
    this.tick();
  }

  private nextBoundaryMs(): number {
    const b = this.scheduler.nextBoundary(new Date());
    return b ? b.getTime() : Infinity;
  }

  // ---------------------------------------------------------------------------
  // Decision + tick
  // ---------------------------------------------------------------------------

  /** Resolve the desired charging action from override + mode + schedule + solar. */
  resolve(now: Date): Decision {
    if (this.override && now.getTime() < this.override.expiresAt) {
      if (this.override.action === 'stop') return { charge: false };
      return { charge: true, amps: this.override.amps ?? this.scheduleOrMax(now) };
    }

    if (this.mode === 'off') return { charge: false };

    // Schedule beats solar.
    if (this.scheduler.isActive(now)) {
      return { charge: true, amps: this.scheduleOrMax(now) };
    }

    if (this.mode === 'solar') {
      if (this.solarTargetAmps == null) return { charge: false };
      if (this.solarTargetAmps === 0) return { charge: true, amps: 0 }; // pause (hold 0A if a tx exists)
      return { charge: true, amps: this.clampAmps(this.solarTargetAmps) };
    }

    // 'scheduled' outside a window, or 'manual' with no active override -> idle.
    return { charge: false };
  }

  private scheduleOrMax(now: Date): number {
    return this.clampAmps(this.scheduler.activeCurrent(now) ?? this.cfg.maxAmps);
  }

  tick(now: Date = new Date()): void {
    if (this.override && now.getTime() >= this.override.expiresAt) this.override = null;

    // Solar fail-safe: if the feed goes stale, stop increasing/charging on solar.
    if (this.mode === 'solar' && this.lastSolarSampleAt > 0
      && now.getTime() - this.lastSolarSampleAt > this.cfg.solarStaleMs) {
      if (!this.solarStaleWarned) {
        this.host.log('Solar feed stale; failing safe (stopping solar charging)');
        this.solarStaleWarned = true;
      }
      this.solarTargetAmps = null;
      this.solarLoop?.reset();
    }

    const decision = this.resolve(now);
    if (decision.charge) {
      this.ensureCharging(decision.amps ?? this.cfg.maxAmps);
    } else {
      this.ensureStopped();
    }
  }

  /** amps: 0 = pause (hold 0A, keep the transaction), >0 = charge at that current. */
  private ensureCharging(amps: number): void {
    const target = amps <= 0 ? 0 : this.clampAmps(amps);
    if (this.desiredAmps !== target) {
      this.desiredAmps = target;
      if (target > 0) this.host.setCapability('charge_current_limit', target);
      if (this.transactionId != null) this.scheduleWrite();
    }
    // Only start a transaction to actually charge (never just to pause at 0A).
    if (target > 0 && this.transactionId == null && !this.awaitingStart && this.cp?.connected) {
      this.awaitingStart = true;
      this.cp.remoteStartTransaction(this.cfg.idTag, CONNECTOR_ID)
        .catch((e) => { this.awaitingStart = false; this.host.error('remoteStart', e); });
    }
  }

  private ensureStopped(): void {
    if (this.pendingWrite) { clearTimeout(this.pendingWrite); this.pendingWrite = null; }
    this.desiredAmps = null;
    if (this.transactionId != null && this.cp?.connected) {
      this.cp.remoteStopTransaction(this.transactionId).catch((e) => this.host.error('remoteStop', e));
    }
  }

  // ---------------------------------------------------------------------------
  // Applying the current limit (throttled)
  // ---------------------------------------------------------------------------

  private clampAmps(amps: number): number {
    return Math.max(this.cfg.minAmps, Math.min(this.cfg.maxAmps, Math.round(amps)));
  }

  private scheduleWrite(): void {
    if (this.pendingWrite) return;
    const wait = Math.max(0, this.cfg.writeThrottleMs - (Date.now() - this.lastWriteAt));
    if (wait === 0) {
      void this.writeProfile();
    } else {
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = null;
        void this.writeProfile();
      }, wait);
    }
  }

  private async writeProfile(): Promise<void> {
    if (!this.cp?.connected || this.desiredAmps == null) return;
    this.lastWriteAt = Date.now();
    try {
      await this.cp.setChargingProfile({
        limitAmps: this.desiredAmps,
        connectorId: CONNECTOR_ID,
        transactionId: this.transactionId ?? undefined,
        numberPhases: this.cfg.phases,
        chargingProfileId: PROFILE_ID,
        stackLevel: STACK_LEVEL,
      });
    } catch (err) {
      this.host.error('SetChargingProfile failed:', (err as Error).message);
    }
  }

}

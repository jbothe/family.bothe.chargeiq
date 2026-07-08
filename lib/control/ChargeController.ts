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

/** Derived charging mode (not user-selected). */
export type ChargeMode = 'manual' | 'scheduled' | 'solar';

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
  solarStaleMs: number;
  maxHouseholdW: number;
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
  maxHouseholdW: 14000,
};

const PROFILE_ID = 1;
const STACK_LEVEL = 1;
const CONNECTOR_ID = 1;
const TICK_MS = 10000;

/** OCPP statuses that mean a vehicle is connected. */
const PLUGGED = ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'];

interface Decision {
  mode: ChargeMode;
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

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

  /** Sticky manual intent, or null when running automatically. */
  private manualLatch: ManualLatch | null = null;

  /** Derived mode last applied (for change detection / triggers). */
  private currentMode: ChargeMode | null = null;

  /** Tracks schedule active-state to detect the rising edge (window start). */
  private wasInSchedule = false;

  /** Tracks plug state to detect a replug (unplugged -> plugged) edge. */
  private prevPlugged: boolean | null = null;

  /** Solar target (A): null = stop, 0 = pause, >=minAmps = charge. */
  private solarTargetAmps: number | null = null;

  private solarLoop: SolarLoop | null = null;

  private lastSolarSampleAt = 0;

  private solarStaleWarned = false;

  private lastPowerW = 0;

  private lastAvailableW = 0;

  private lastGridSignedW = 0;

  private loggedCapAmps: number | null = null;

  private prevStatus: string | null = null;

  private loggedPowerW = 0;

  private loggedSolar = '';

  private transactionId: number | null = null;

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
    this.transactionId = this.host.getStore<number>('transactionId') ?? null;
    this.manualLatch = this.host.getStore<ManualLatch>('manualLatch') ?? null;
    this.scheduler.setWindows(this.host.getStore<ScheduleWindow[]>('schedule') ?? []);
    this.wasInSchedule = this.scheduler.isActive(new Date());

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
    this.tickTimer.unref?.();
    this.tick(); // establish initial mode capability
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
      maxHouseholdW: g('maxHouseholdW', DEFAULTS.maxHouseholdW),
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

    const cachedStatus = cp.getLastStatus();
    if (cachedStatus) this.onStatus(cachedStatus);
    const cachedReadings = cp.getLastReadings();
    if (cachedReadings) this.onMeterValues(cachedReadings);

    this.requestFreshState();

    this.host.log(`Controller bound to ${cp.identity}`);
    this.tick();
  }

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

    // Detect unplug -> replug: clear the manual latch so charging reverts to
    // automatic (schedule/solar). Ignore the first observation and Faulted/etc.
    if (info.status === 'Available') {
      this.prevPlugged = false;
      // Idle charger: reconcile any stale transaction id from before a restart.
      if (this.transactionId != null) {
        this.transactionId = null;
        this.awaitingStart = false;
        this.host.setStore('transactionId', null).catch(this.host.error);
      }
    } else if (PLUGGED.includes(info.status)) {
      if (this.prevPlugged === false && this.manualLatch) {
        this.clearManualLatch('charger replugged');
      }
      this.prevPlugged = true;
    }
    this.tick();
  }

  private onMeterValues(r: Readings): void {
    if (r.power !== undefined) { this.lastPowerW = r.power; this.host.setCapability('measure_power', r.power); }
    if (r.current !== undefined) this.host.setCapability('measure_current', r.current);
    if (r.voltage !== undefined) this.host.setCapability('measure_voltage', r.voltage);
    if (r.energyKwh !== undefined) this.host.setCapability('meter_power', r.energyKwh);

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
    this.tick();
  }

  /** Changing the current is a hands-on action: latch Manual at that current. */
  async setCurrentLimit(amps: number): Promise<void> {
    const target = this.clampAmps(amps);
    this.manualLatch = { intent: 'charge', amps: target };
    this.host.setCapability('charge_current_limit', target);
    await this.host.setStore('manualLatch', this.manualLatch);
    this.tick();
  }

  startManual(amps?: number): Promise<void> { return this.setManualCharging(true, amps); }

  stop(): Promise<void> { return this.setManualCharging(false); }

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

  /** Directly set the solar target (A): null = stop, 0 = pause, >=min = charge. Test use. */
  setSolarTarget(amps: number | null): void {
    this.solarTargetAmps = amps;
    this.tick();
  }

  onSolarSample(sample: SolarSampleInput, now: number = Date.now()): void {
    this.lastSolarSampleAt = now;
    this.solarStaleWarned = false;
    const gridSignedW = sample.gridSignedW;
    this.lastGridSignedW = gridSignedW;
    if (!this.solarLoop) return;
    const chargerPowerW = this.isCharging() ? this.lastPowerW : 0;
    const res = this.solarLoop.evaluate({ gridSignedW, chargerPowerW, now });
    this.lastAvailableW = Math.max(0, res.availableW);
    this.solarTargetAmps = res.target;
    this.host.setCapability('measure_solar_surplus', Math.round(this.lastAvailableW));

    const tgt = res.target === null ? 'stop' : (res.target === 0 ? 'pause' : res.target + 'A');
    const r50 = (w?: number) => (w == null ? 'na' : String(Math.round(w / 50) * 50));
    const key = [r50(sample.pvW), r50(sample.batteryW), r50(sample.houseW),
      r50(gridSignedW), r50(chargerPowerW), tgt, res.state].join('|');
    if (key !== this.loggedSolar) {
      this.loggedSolar = key;
      const f = (w?: number) => (w == null ? '?' : Math.round(w) + 'W');
      this.host.log(`[solar] solar=${f(sample.pvW)} battery=${f(sample.batteryW)} house=${f(sample.houseW)} `
        + `grid=${f(gridSignedW)} charger=${f(chargerPowerW)} excess=${Math.round(this.lastAvailableW)}W`
        + ` -> ${tgt} (${res.state})`);
    }

    this.tick(new Date(now));
  }

  private householdCapAmps(): number | null {
    if (this.cfg.maxHouseholdW <= 0) return null;
    const stale = this.lastSolarSampleAt === 0
      || (Date.now() - this.lastSolarSampleAt) > this.cfg.solarStaleMs;
    if (stale) return null;
    const chargerW = this.isCharging() ? this.lastPowerW : 0;
    const baseLoadW = this.lastGridSignedW - chargerW;
    const maxChargerW = this.cfg.maxHouseholdW - baseLoadW;
    return Math.floor(maxChargerW / (this.cfg.voltage * this.cfg.phases));
  }

  // ---------------------------------------------------------------------------
  // Mode + status reporting
  // ---------------------------------------------------------------------------

  getMode(): ChargeMode {
    return this.currentMode ?? this.resolve(new Date()).mode;
  }

  /** Mode + a short human status detail for the widget/metrics. */
  getModeInfo(): { mode: ChargeMode; detail: string } {
    const now = new Date();
    const mode = this.currentMode ?? this.resolve(now).mode;
    let detail = '';
    if (mode === 'manual') {
      const base = this.manualLatch?.intent === 'off' ? 'stopped' : 'charging';
      const ns = this.scheduler.nextStart(now);
      detail = base + (ns ? ` · schedule ${fmtTime(ns)}` : '');
    } else if (mode === 'scheduled') {
      const end = this.scheduler.currentEnd(now);
      detail = end ? `until ${fmtTime(end)}` : 'charging';
    } else { // solar
      const t = this.solarTargetAmps;
      detail = (t != null && t >= this.cfg.minAmps) ? `charging ${t}A`
        : (t === 0 ? 'paused (low excess)' : 'idle (low excess)');
    }
    return { mode, detail };
  }

  getDiagnostics(): { availableW: number; solarState: string; targetA: number | null; mode: ChargeMode } {
    return {
      availableW: this.lastAvailableW,
      solarState: this.solarLoop?.getState() ?? 'off',
      targetA: this.solarTargetAmps,
      mode: this.getMode(),
    };
  }

  // ---------------------------------------------------------------------------
  // Decision + tick
  // ---------------------------------------------------------------------------

  /** Resolve derived mode + desired charging action. Manual > Schedule > Solar. */
  resolve(now: Date): Decision {
    if (this.manualLatch) {
      if (this.manualLatch.intent === 'off') return { mode: 'manual', charge: false };
      return { mode: 'manual', charge: true, amps: this.manualLatch.amps ?? this.cfg.maxAmps };
    }
    if (this.scheduler.isActive(now)) {
      return { mode: 'scheduled', charge: true, amps: this.scheduleOrMax(now) };
    }
    // Solar is the default outside a schedule.
    if (this.solarTargetAmps == null) return { mode: 'solar', charge: false };
    if (this.solarTargetAmps === 0) return { mode: 'solar', charge: true, amps: 0 };
    return { mode: 'solar', charge: true, amps: this.clampAmps(this.solarTargetAmps) };
  }

  private scheduleOrMax(now: Date): number {
    return this.clampAmps(this.scheduler.activeCurrent(now) ?? this.cfg.maxAmps);
  }

  tick(now: Date = new Date()): void {
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
        this.host.log('Solar feed stale; failing safe (stopping solar charging)');
        this.solarStaleWarned = true;
      }
      this.solarTargetAmps = null;
      this.solarLoop?.reset();
    }

    const decision = this.resolve(now);
    this.updateMode(decision.mode);

    if (!decision.charge) {
      this.ensureStopped();
      return;
    }

    let amps = decision.amps ?? this.cfg.maxAmps;
    if (amps > 0) {
      const cap = this.householdCapAmps();
      if (cap != null && cap < amps) {
        const capped = cap < this.cfg.minAmps ? 0 : cap;
        if (this.loggedCapAmps !== capped) {
          this.host.log(`[cap] household limit ${this.cfg.maxHouseholdW}W -> charger `
            + `${capped === 0 ? 'paused' : capped + 'A'} (requested ${amps}A)`);
          this.loggedCapAmps = capped;
        }
        amps = capped;
      } else if (cap != null && this.loggedCapAmps !== null) {
        this.host.log('[cap] household limit no longer constraining');
        this.loggedCapAmps = null;
      }
    }

    this.ensureCharging(amps);
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

  /** amps: 0 = pause (hold 0A, keep the transaction), >0 = charge at that current. */
  private ensureCharging(amps: number): void {
    const target = amps <= 0 ? 0 : this.clampAmps(amps);
    if (this.desiredAmps !== target) {
      this.desiredAmps = target;
      if (target > 0) this.host.setCapability('charge_current_limit', target);
      if (this.transactionId != null) this.scheduleWrite();
    }
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
    // Floor (never round up) so a target can't exceed the available surplus/limit.
    return Math.max(this.cfg.minAmps, Math.min(this.cfg.maxAmps, Math.floor(amps)));
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

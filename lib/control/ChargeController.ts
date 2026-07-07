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
}

interface ControllerConfig {
  minAmps: number;
  maxAmps: number;
  phases: number;
  voltage: number;
  idTag: string;
  meterSampleIntervalSec: number;
  /** Minimum ms between SetChargingProfile writes. */
  writeThrottleMs: number;
}

const DEFAULTS: ControllerConfig = {
  minAmps: 6,
  maxAmps: 31,
  phases: 1,
  voltage: 230,
  idTag: 'CHARGEIQ',
  meterSampleIntervalSec: 10,
  writeThrottleMs: 15000,
};

const PROFILE_ID = 1;
const STACK_LEVEL = 1;
const CONNECTOR_ID = 1;

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
 * Owns charging behaviour for one charge point: binds to its {@link ChargePoint},
 * reflects OCPP state onto Homey capabilities, and applies charging decisions.
 *
 * M2 implements manual control (start/stop/set current) and boot-time MeterValues
 * configuration. Scheduled and solar modes extend {@link resolve} in later milestones.
 */
export class ChargeController {

  private host: ControllerHost;

  private cs: CentralSystem;

  private cp: ChargePoint | null = null;

  private cfg: ControllerConfig;

  private mode: ChargeMode = 'off';

  /** Live transaction id, mirrored to the device store for restart recovery. */
  private transactionId: number | null = null;

  /** Desired current to apply once a transaction is running (A); null = don't charge. */
  private desiredAmps: number | null = null;

  private lastWriteAt = 0;

  private pendingWrite: NodeJS.Timeout | null = null;

  private lastStatus: OcppStatus | null = null;

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
    this.mode = (this.host.getStore<ChargeMode>('mode')) ?? (this.host.getSetting<ChargeMode>('defaultMode')) ?? 'off';
    this.transactionId = this.host.getStore<number>('transactionId') ?? null;
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
  }

  /** Re-read tunables from device settings. */
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

    // If a transaction was live before restart, resume applying the target.
    if (this.transactionId != null && this.desiredAmps != null) {
      this.scheduleWrite();
    }
    this.host.log(`Controller bound to ${cp.identity}`);
  }

  /** Push MeterValues sampling config so the loop and widget stay responsive. */
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
    this.lastStatus = info.status;
    this.host.setCapability('charger_status', info.status);
    this.host.setCapability('evcharger_charging_state', toChargingState(info.status));
    this.host.setCapability('evcharger_charging', info.status === 'Charging');
    this.host.setWarning(info.status === 'Faulted' ? `Charger fault: ${info.errorCode}` : null);
  }

  private onMeterValues(r: Readings): void {
    if (r.power !== undefined) this.host.setCapability('measure_power', r.power);
    if (r.current !== undefined) this.host.setCapability('measure_current', r.current);
    if (r.voltage !== undefined) this.host.setCapability('measure_voltage', r.voltage);
    if (r.energyKwh !== undefined) this.host.setCapability('meter_power', r.energyKwh);
  }

  private onStartTransaction(id: number, req: StartTransactionReq): void {
    this.transactionId = id;
    this.host.setStore('transactionId', id).catch(this.host.error);
    this.host.setStore('meterStartWh', req.meterStart).catch(this.host.error);
    this.host.setCapability('evcharger_charging', true);
    // Apply the desired current now that we have a live transaction.
    if (this.desiredAmps != null) this.scheduleWrite();
  }

  private onStopTransaction(_req: StopTransactionReq): void {
    this.transactionId = null;
    this.host.setStore('transactionId', null).catch(this.host.error);
    this.host.setCapability('evcharger_charging', false);
  }

  // ---------------------------------------------------------------------------
  // Manual control API (invoked by capability listeners / flow cards)
  // ---------------------------------------------------------------------------

  async setMode(mode: ChargeMode): Promise<void> {
    this.mode = mode;
    await this.host.setStore('mode', mode);
    this.host.setCapability('charge_mode', mode);
    if (mode === 'off') await this.stop();
  }

  getMode(): ChargeMode {
    return this.mode;
  }

  /** Start charging at the given current (defaults to the slider value / min). */
  async startManual(amps?: number): Promise<void> {
    const target = this.clampAmps(amps ?? this.cfg.maxAmps);
    this.desiredAmps = target;
    this.host.setCapability('charge_current_limit', target);

    if (this.transactionId == null) {
      if (!this.cp?.connected) throw new Error('Charger not connected');
      await this.cp.remoteStartTransaction(this.cfg.idTag, CONNECTOR_ID);
      // SetChargingProfile is applied when StartTransaction arrives.
    } else {
      this.scheduleWrite();
    }
  }

  /** Change the target current (applies immediately if charging). */
  async setCurrentLimit(amps: number): Promise<void> {
    const target = this.clampAmps(amps);
    this.host.setCapability('charge_current_limit', target);
    if (this.desiredAmps == null) return; // not charging; remember for next start
    this.desiredAmps = target;
    this.scheduleWrite();
  }

  async stop(): Promise<void> {
    this.desiredAmps = null;
    if (this.pendingWrite) { clearTimeout(this.pendingWrite); this.pendingWrite = null; }
    if (this.transactionId != null && this.cp?.connected) {
      await this.cp.remoteStopTransaction(this.transactionId).catch((e) => this.host.error('stop', e));
    }
  }

  // ---------------------------------------------------------------------------
  // Applying the current limit (throttled)
  // ---------------------------------------------------------------------------

  private clampAmps(amps: number): number {
    return Math.max(this.cfg.minAmps, Math.min(this.cfg.maxAmps, Math.round(amps)));
  }

  /** Throttle SetChargingProfile writes; coalesce rapid changes into a trailing write. */
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

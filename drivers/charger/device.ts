'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';
import { ChargePoint } from '../../lib/ocpp/ChargePoint';
import {
  MeterValuesReq,
  OcppStatus,
  Readings,
  StartTransactionReq,
  StatusNotificationReq,
  StopTransactionReq,
} from '../../lib/ocpp/types';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
  getChargePoint(identity: string): ChargePoint | undefined;
}

/** Map raw OCPP status to Homey's standard evcharger_charging_state enum. */
function toChargingState(status: OcppStatus): string {
  switch (status) {
    case 'Charging':
      return 'plugged_in_charging';
    case 'Preparing':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Finishing':
    case 'Reserved':
      return 'plugged_in';
    case 'Faulted':
      return 'plugged_in'; // keep plugged; fault surfaced via charger_status + availability
    case 'Available':
    case 'Unavailable':
    default:
      return 'plugged_out';
  }
}

module.exports = class ChargerDevice extends Homey.Device {

  private identity!: string;

  /** The ChargePoint instance we have bound listeners to (stable per app run). */
  private cp: ChargePoint | null = null;

  async onInit() {
    this.identity = this.getData().id as string;

    await this.ensureCapabilities();

    const app = this.homey.app as ChargeIQApp;
    const cs = app.getCentralSystem();

    // Bind now if already connected, and on every (re)connect.
    const existing = cs.getChargePoint(this.identity);
    if (existing) this.bindChargePoint(existing);

    cs.on('connect', (cp: ChargePoint) => {
      if (cp.identity === this.identity) this.bindChargePoint(cp);
    });
    cs.on('disconnect', (cp: ChargePoint) => {
      if (cp.identity === this.identity) {
        this.setUnavailable(this.homey.__('charger.offline') || 'Charger offline').catch(this.error);
      }
    });

    this.log(`ChargerDevice ${this.identity} initialised (connected=${!!existing})`);
  }

  private async ensureCapabilities() {
    const required = [
      'charge_mode', 'evcharger_charging', 'evcharger_charging_state', 'charger_status',
      'measure_power', 'measure_current', 'measure_voltage', 'meter_power', 'charge_current_limit',
    ];
    for (const cap of required) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }
    if (this.getCapabilityValue('charge_mode') === null) {
      await this.setCapabilityValue('charge_mode', 'off').catch(this.error);
    }
  }

  /** Attach listeners to the ChargePoint once; safe against repeat connect events. */
  private bindChargePoint(cp: ChargePoint) {
    this.setAvailable().catch(this.error);
    if (this.cp === cp) return; // already bound to this instance
    this.cp = cp;

    cp.on('status', (info: StatusNotificationReq) => this.onStatus(info));
    cp.on('meterValues', (readings: Readings, _raw: MeterValuesReq) => this.onMeterValues(readings));
    cp.on('startTransaction', (transactionId: number, req: StartTransactionReq) => {
      this.setStoreValue('transactionId', transactionId).catch(this.error);
      this.setStoreValue('meterStartWh', req.meterStart).catch(this.error);
      this.setCapabilityValue('evcharger_charging', true).catch(this.error);
    });
    cp.on('stopTransaction', (_req: StopTransactionReq) => {
      this.setStoreValue('transactionId', null).catch(this.error);
      this.setCapabilityValue('evcharger_charging', false).catch(this.error);
    });
    cp.on('disconnect', () => {
      this.setUnavailable('Charger offline').catch(this.error);
    });

    this.log(`Bound to ChargePoint ${cp.identity}`);
  }

  private onStatus(info: StatusNotificationReq) {
    this.setCapabilityValue('charger_status', info.status).catch(this.error);
    this.setCapabilityValue('evcharger_charging_state', toChargingState(info.status)).catch(this.error);
    this.setCapabilityValue('evcharger_charging', info.status === 'Charging').catch(this.error);

    if (info.status === 'Faulted') {
      this.setWarning(`Charger fault: ${info.errorCode}`).catch(this.error);
    } else {
      this.unsetWarning().catch(this.error);
    }
  }

  private onMeterValues(r: Readings) {
    if (r.power !== undefined) this.setCapabilityValue('measure_power', r.power).catch(this.error);
    if (r.current !== undefined) this.setCapabilityValue('measure_current', r.current).catch(this.error);
    if (r.voltage !== undefined) this.setCapabilityValue('measure_voltage', r.voltage).catch(this.error);
    if (r.energyKwh !== undefined) this.setCapabilityValue('meter_power', r.energyKwh).catch(this.error);
  }

};

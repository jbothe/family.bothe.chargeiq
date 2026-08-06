'use strict';

/**
 * Shared OCPP 1.6J types and small parsing helpers used by the Central System.
 * Only the subset of the spec this app actually exchanges is modelled here.
 */

/** OCPP 1.6 connector/charge-point status (StatusNotification.status). */
export type OcppStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEVSE'
  | 'SuspendedEV'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

/** Registration status returned in BootNotification.conf. */
export type BootStatus = 'Accepted' | 'Pending' | 'Rejected';

/** idTagInfo status returned to Authorize / Start / StopTransaction. */
export type AuthorizationStatus =
  | 'Accepted'
  | 'Blocked'
  | 'Expired'
  | 'Invalid'
  | 'ConcurrentTx';

export interface IdTagInfo {
  status: AuthorizationStatus;
  expiryDate?: string;
  parentIdTag?: string;
}

export interface BootNotificationReq {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  chargeBoxSerialNumber?: string;
  firmwareVersion?: string;
  iccid?: string;
  imsi?: string;
  meterType?: string;
  meterSerialNumber?: string;
}

export interface StatusNotificationReq {
  connectorId: number;
  errorCode: string;
  status: OcppStatus;
  info?: string;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
}

export interface StartTransactionReq {
  connectorId: number;
  idTag: string;
  meterStart: number; // Wh
  reservationId?: number;
  timestamp: string;
}

export interface SampledValue {
  value: string;
  context?: string;
  format?: string;
  measurand?: string;
  phase?: string;
  location?: string;
  unit?: string;
}

export interface MeterValue {
  timestamp: string;
  sampledValue: SampledValue[];
}

export interface StopTransactionReq {
  transactionId: number;
  idTag?: string;
  meterStop: number; // Wh
  timestamp: string;
  reason?: string;
  transactionData?: MeterValue[];
}

export interface MeterValuesReq {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValue[];
}

/** Normalised electrical readings extracted from a MeterValues / transactionData batch. */
export interface Readings {
  /** Active import power in W. */
  power?: number;
  /** Import current in A (max across phases). */
  current?: number;
  /** Voltage in V (max across phases). */
  voltage?: number;
  /** Energy.Active.Import.Register in kWh. */
  energyKwh?: number;
  /** Timestamp of the batch. */
  timestamp?: string;
  /**
   * Measurands present in the batch that this app maps onto no reading, as
   * `measurand` -> the last raw `value unit @phase` seen for it. Diagnostic
   * only - nothing acts on it; ChargeController logs each name once so what a
   * charge point actually sends (SoC? Current.Offered? a vendor measurand?) is
   * discoverable from the log instead of being silently dropped here.
   */
  unhandled?: Record<string, string>;
}

/** Options for building a SetChargingProfile payload. */
export interface ChargingProfileOptions {
  /** Target current limit in amps. Use 0 to pause. */
  limitAmps: number;
  /** Connector to apply to (0 = charge point as a whole). */
  connectorId: number;
  /** Live transaction id — when set a TxProfile is built, otherwise TxDefaultProfile. */
  transactionId?: number;
  /** Number of phases the limit applies to. */
  numberPhases: number;
  /** Stable profile id so each update replaces the previous one. */
  chargingProfileId: number;
  /** Stable stack level. */
  stackLevel: number;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** The measurands parseMeterValues maps onto Readings; anything else is recorded as unhandled. */
const HANDLED_MEASURANDS = new Set([
  'Power.Active.Import',
  'Current.Import',
  'Voltage',
  'Energy.Active.Import.Register',
]);

function toNumber(v: string): number | undefined {
  return NUMERIC.test(v) ? Number(v) : undefined;
}

/**
 * Parse a batch of OCPP MeterValues into normalised electrical readings.
 * Takes the last (most recent) sample for each measurand and converts units to
 * W / A / V / kWh. Measurand defaults to Energy.Active.Import.Register per spec.
 */
export function parseMeterValues(meterValue: MeterValue[]): Readings {
  const out: Readings = {};
  if (!Array.isArray(meterValue) || meterValue.length === 0) return out;

  for (const mv of meterValue) {
    out.timestamp = mv.timestamp ?? out.timestamp;
    for (const sv of mv.sampledValue ?? []) {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (!HANDLED_MEASURANDS.has(measurand)) {
        // Recorded before the numeric check on purpose: a non-numeric unknown
        // (a status string, an enum) is exactly as interesting to discover.
        out.unhandled ??= {};
        out.unhandled[measurand] = [sv.value, sv.unit, sv.phase && `@${sv.phase}`]
          .filter(Boolean).join(' ');
        continue;
      }
      const num = toNumber(sv.value);
      if (num === undefined) continue;
      const { unit } = sv;

      switch (measurand) {
        case 'Power.Active.Import': {
          out.power = unit === 'kW' ? num * 1000 : num;
          break;
        }
        case 'Current.Import': {
          out.current = Math.max(out.current ?? 0, num);
          break;
        }
        case 'Voltage': {
          out.voltage = Math.max(out.voltage ?? 0, num);
          break;
        }
        case 'Energy.Active.Import.Register': {
          out.energyKwh = unit === 'Wh' || unit === undefined ? num / 1000 : num;
          break;
        }
        // HANDLED_MEASURANDS above is the gate, so anything reaching here is
        // one of the four cases.
        // no default
      }
    }
  }
  return out;
}

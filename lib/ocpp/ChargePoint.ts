'use strict';

import { EventEmitter } from 'events';
import {
  BootNotificationReq,
  ChargingProfileOptions,
  IdTagInfo,
  MeterValuesReq,
  parseMeterValues,
  Readings,
  StartTransactionReq,
  StatusNotificationReq,
  StopTransactionReq,
} from './types';

/** Minimal shape of an ocpp-rpc server-side client we rely on. */
export interface RpcClient {
  identity: string;
  handle(method: string, handler: (ctx: { params: unknown }) => Record<string, unknown>): void;
  handle(handler: (ctx: { method: string; params: unknown }) => Record<string, unknown>): void;
  // The OCPP response shape is genuinely dynamic (dispatched by method name at
  // runtime, not known statically here) - any is the honest type, not a gap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  close(opts?: { code?: number; reason?: string }): Promise<void> | void;
  on(event: 'close', listener: () => void): void;
}

/** How the app decides whether to authorise an idTag. */
export type AuthorizePolicy = (idTag: string) => boolean;

/** OCPP 1.6 ChargingProfile, as sent in SetChargingProfile.req. */
interface OcppChargingProfile {
  chargingProfileId: number;
  stackLevel: number;
  chargingProfilePurpose: 'TxProfile' | 'TxDefaultProfile';
  chargingProfileKind: 'Absolute';
  chargingSchedule: {
    chargingRateUnit: 'A';
    chargingSchedulePeriod: [{ startPeriod: number; limit: number; numberPhases: number }];
  };
  transactionId?: number;
}

/** OCPP 1.6 GetConfiguration.conf. */
interface OcppGetConfigurationResult {
  configurationKey?: Array<{ key: string; readonly: boolean; value?: string }>;
  unknownKey?: string[];
}

export interface ChargePointEvents {
  boot: (info: BootNotificationReq) => void;
  status: (info: StatusNotificationReq) => void;
  heartbeat: () => void;
  meterValues: (readings: Readings, raw: MeterValuesReq) => void;
  startTransaction: (transactionId: number, req: StartTransactionReq) => void;
  stopTransaction: (req: StopTransactionReq) => void;
  authorize: (idTag: string, accepted: boolean) => void;
  dataTransfer: (payload: { vendorId?: string; messageId?: string; data?: string }) => void;
  firmwareStatus: (status: string) => void;
  diagnosticsStatus: (status: string) => void;
  connect: () => void;
  disconnect: () => void;
}

/**
 * Represents a single physical charge point (one OCPP identity). It survives
 * reconnects: the underlying RPC client is swapped via {@link attach} while the
 * ChargePoint instance (and its listeners) persist. Encapsulates both inbound
 * handlers and the outbound command wrappers.
 */
export class ChargePoint extends EventEmitter {

  readonly identity: string;

  private client: RpcClient | null = null;

  private authorize: AuthorizePolicy;

  /** Monotonic transaction id source, seeded from persistence on the device. */
  private nextTransactionId: () => number;

  private heartbeatIntervalSec: number;

  /** Last StatusNotification / parsed readings, so a late-binding device can catch up. */
  private lastStatus: StatusNotificationReq | null = null;

  private lastReadings: Readings | null = null;

  constructor(opts: {
    identity: string;
    authorize: AuthorizePolicy;
    nextTransactionId: () => number;
    heartbeatIntervalSec?: number;
  }) {
    super();
    this.identity = opts.identity;
    this.authorize = opts.authorize;
    this.nextTransactionId = opts.nextTransactionId;
    this.heartbeatIntervalSec = opts.heartbeatIntervalSec ?? 60;
  }

  /** Is the charge point currently connected? */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Last known StatusNotification (for a device that binds after connect). */
  getLastStatus(): StatusNotificationReq | null {
    return this.lastStatus;
  }

  /** Last known parsed readings (for a device that binds after connect). */
  getLastReadings(): Readings | null {
    return this.lastReadings;
  }

  /** Update the authorize policy at runtime (e.g. settings change). */
  setAuthorizePolicy(policy: AuthorizePolicy): void {
    this.authorize = policy;
  }

  // ---------------------------------------------------------------------------
  // Inbound: attach handlers to a (re)connected client
  // ---------------------------------------------------------------------------

  attach(client: RpcClient): void {
    this.client = client;

    client.handle('BootNotification', ({ params }) => {
      this.emit('boot', params as BootNotificationReq);
      return {
        currentTime: new Date().toISOString(),
        interval: this.heartbeatIntervalSec,
        status: 'Accepted',
      };
    });

    client.handle('Heartbeat', () => {
      this.emit('heartbeat');
      return { currentTime: new Date().toISOString() };
    });

    client.handle('StatusNotification', ({ params }) => {
      this.lastStatus = params as StatusNotificationReq;
      this.emit('status', params as StatusNotificationReq);
      return {};
    });

    client.handle('Authorize', ({ params }) => {
      const { idTag } = params as { idTag: string };
      const accepted = this.authorize(idTag);
      const idTagInfo: IdTagInfo = { status: accepted ? 'Accepted' : 'Invalid' };
      this.emit('authorize', idTag, accepted);
      return { idTagInfo };
    });

    client.handle('StartTransaction', ({ params }) => {
      const req = params as StartTransactionReq;
      const accepted = this.authorize(req.idTag);
      const transactionId = this.nextTransactionId();
      const idTagInfo: IdTagInfo = { status: accepted ? 'Accepted' : 'Invalid' };
      if (accepted) this.emit('startTransaction', transactionId, req);
      return { transactionId, idTagInfo };
    });

    client.handle('StopTransaction', ({ params }) => {
      const req = params as StopTransactionReq;
      this.emit('stopTransaction', req);
      return { idTagInfo: { status: 'Accepted' } as IdTagInfo };
    });

    client.handle('MeterValues', ({ params }) => {
      const req = params as MeterValuesReq;
      const readings = parseMeterValues(req.meterValue);
      this.lastReadings = readings;
      this.emit('meterValues', readings, req);
      return {};
    });

    // Accept the optional messages so strictMode does not reject them.
    client.handle('DataTransfer', ({ params }) => {
      this.emit('dataTransfer', (params ?? {}) as { vendorId?: string; messageId?: string; data?: string });
      return { status: 'Accepted' };
    });
    client.handle('FirmwareStatusNotification', ({ params }) => {
      this.emit('firmwareStatus', (params as { status?: string } | undefined)?.status ?? 'Unknown');
      return {};
    });
    client.handle('DiagnosticsStatusNotification', ({ params }) => {
      this.emit('diagnosticsStatus', (params as { status?: string } | undefined)?.status ?? 'Unknown');
      return {};
    });

    client.on('close', () => {
      if (this.client === client) {
        this.client = null;
        this.emit('disconnect');
      }
    });

    this.emit('connect');
  }

  /** Called when the underlying client disconnects outside a 'close' we tracked. */
  detach(): void {
    this.client = null;
  }

  // ---------------------------------------------------------------------------
  // Outbound command wrappers
  // ---------------------------------------------------------------------------

  private requireClient(): RpcClient {
    if (!this.client) {
      throw new Error(`Charge point ${this.identity} is not connected`);
    }
    return this.client;
  }

  async remoteStartTransaction(idTag: string, connectorId = 1): Promise<boolean> {
    const res = await this.requireClient().call('RemoteStartTransaction', { idTag, connectorId });
    return res?.status === 'Accepted';
  }

  async remoteStopTransaction(transactionId: number): Promise<boolean> {
    const res = await this.requireClient().call('RemoteStopTransaction', { transactionId });
    return res?.status === 'Accepted';
  }

  /**
   * Apply a single-period charging profile with a stable id/stackLevel so each
   * call replaces the previous profile rather than stacking. limitAmps = 0 pauses.
   */
  async setChargingProfile(opts: ChargingProfileOptions): Promise<boolean> {
    const isTx = typeof opts.transactionId === 'number';
    const csChargingProfiles: OcppChargingProfile = {
      chargingProfileId: opts.chargingProfileId,
      stackLevel: opts.stackLevel,
      chargingProfilePurpose: isTx ? 'TxProfile' : 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: opts.limitAmps,
            numberPhases: opts.numberPhases,
          },
        ],
      },
    };
    if (isTx) csChargingProfiles.transactionId = opts.transactionId;

    const res = await this.requireClient().call('SetChargingProfile', {
      connectorId: opts.connectorId,
      csChargingProfiles,
    });
    return res?.status === 'Accepted';
  }

  async clearChargingProfile(chargingProfileId?: number): Promise<boolean> {
    const payload = chargingProfileId !== undefined ? { id: chargingProfileId } : {};
    const res = await this.requireClient().call('ClearChargingProfile', payload);
    return res?.status === 'Accepted';
  }

  async getConfiguration(keys?: string[]): Promise<OcppGetConfigurationResult> {
    return this.requireClient().call('GetConfiguration', keys ? { key: keys } : {});
  }

  async changeConfiguration(key: string, value: string): Promise<string> {
    const res = await this.requireClient().call('ChangeConfiguration', { key, value });
    return res?.status ?? 'Unknown';
  }

  async triggerMessage(requestedMessage: string, connectorId?: number): Promise<boolean> {
    const payload: { requestedMessage: string; connectorId?: number } = { requestedMessage };
    if (connectorId !== undefined) payload.connectorId = connectorId;
    const res = await this.requireClient().call('TriggerMessage', payload);
    return res?.status === 'Accepted';
  }

}

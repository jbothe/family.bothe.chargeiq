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
  // `force` skips the polite close handshake (and waiting on pending calls) and
  // terminates the socket outright - the only thing that reliably tears down a
  // half-open link, see onLivenessTimeout().
  close(opts?: { code?: number; reason?: string; force?: boolean }): Promise<void> | void;
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

/** Point-in-time view of the OCPP link, for connectivity reporting. */
export interface ConnectionInfo {
  connected: boolean;
  /** Epoch ms of the last inbound OCPP message, or null if none received yet. */
  lastSeenAt: number | null;
  /** Epoch ms the current (or most recent) client attached. */
  connectedAt: number | null;
  /** Epoch ms the link was last torn down, or null while connected. */
  disconnectedAt: number | null;
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
  /** The link went quiet past the liveness timeout and was dropped - see onLivenessTimeout(). */
  stale: (idleMs: number) => void;
}

/**
 * How many heartbeat intervals of total silence before the link is presumed
 * dead. The charge point is told to heartbeat every `heartbeatIntervalSec` (in
 * the BootNotification response), and MeterValues arrive far more often than
 * that during a session, so three missed intervals is already well past any
 * legitimate quiet period.
 */
const LIVENESS_HEARTBEAT_MULTIPLE = 3;

/** Floor on the above, so a very short heartbeat interval can't cause flapping. */
const MIN_LIVENESS_TIMEOUT_MS = 90_000;

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

  /** Transaction id granted to this charge point, if a session is on record - see getLastTransactionId(). */
  private lastTransactionId: number | null = null;

  /** Silence (ms) tolerated before the link is presumed dead; 0 disables the watchdog. */
  private livenessTimeoutMs: number;

  private lastSeenAt: number | null = null;

  private connectedAt: number | null = null;

  private disconnectedAt: number | null = null;

  private livenessTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    identity: string;
    authorize: AuthorizePolicy;
    nextTransactionId: () => number;
    heartbeatIntervalSec?: number;
    /** Override the derived liveness timeout (tests); 0 disables the watchdog. */
    livenessTimeoutMs?: number;
  }) {
    super();
    this.identity = opts.identity;
    this.authorize = opts.authorize;
    this.nextTransactionId = opts.nextTransactionId;
    this.heartbeatIntervalSec = opts.heartbeatIntervalSec ?? 60;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? Math.max(
      MIN_LIVENESS_TIMEOUT_MS,
      this.heartbeatIntervalSec * 1000 * LIVENESS_HEARTBEAT_MULTIPLE,
    );
  }

  /** Is the charge point currently connected? */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Connection liveness, for the controller's offline detection/reporting. */
  getConnectionInfo(): ConnectionInfo {
    return {
      connected: this.connected,
      lastSeenAt: this.lastSeenAt,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
    };
  }

  /** Last known StatusNotification (for a device that binds after connect). */
  getLastStatus(): StatusNotificationReq | null {
    return this.lastStatus;
  }

  /** Last known parsed readings (for a device that binds after connect). */
  getLastReadings(): Readings | null {
    return this.lastReadings;
  }

  /**
   * The transaction id most recently granted to this charge point, or null if
   * no session is on record. Tracked here, rather than only in the controller,
   * because the id is allocated and returned to the charger inside the
   * StartTransaction handler - which runs whether or not a controller happens
   * to be listening yet. Without this, an id handed out before the device
   * finished initialising would be known to the charger and to nobody else,
   * leaving every subsequent TxProfile write pointing at a stale id (observed
   * on real hardware: the app wrote tx=48 against a live session 49, and both
   * writes came back rejected). Same rationale as getLastStatus()/
   * getLastReadings(): a late-binding device must be able to catch up.
   */
  getLastTransactionId(): number | null {
    return this.lastTransactionId;
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
    this.connectedAt = Date.now();
    this.disconnectedAt = null;
    // A brand-new connection counts as contact in its own right: the watchdog
    // must start ticking from now, not from whenever the previous link last
    // spoke (which for a reconnect after a long outage is hours ago).
    this.markSeen();

    // Every inbound message goes through this wrapper so it refreshes the
    // liveness watchdog - registering a handler directly on `client` would
    // silently opt that message out of counting as contact.
    const handle = (method: string, fn: (ctx: { params: unknown }) => Record<string, unknown>) => {
      client.handle(method, (ctx) => {
        this.markSeen();
        return fn(ctx);
      });
    };

    handle('BootNotification', ({ params }) => {
      this.emit('boot', params as BootNotificationReq);
      return {
        currentTime: new Date().toISOString(),
        interval: this.heartbeatIntervalSec,
        status: 'Accepted',
      };
    });

    handle('Heartbeat', () => {
      this.emit('heartbeat');
      return { currentTime: new Date().toISOString() };
    });

    handle('StatusNotification', ({ params }) => {
      this.lastStatus = params as StatusNotificationReq;
      this.emit('status', params as StatusNotificationReq);
      return {};
    });

    handle('Authorize', ({ params }) => {
      const { idTag } = params as { idTag: string };
      const accepted = this.authorize(idTag);
      const idTagInfo: IdTagInfo = { status: accepted ? 'Accepted' : 'Invalid' };
      this.emit('authorize', idTag, accepted);
      return { idTagInfo };
    });

    handle('StartTransaction', ({ params }) => {
      const req = params as StartTransactionReq;
      const accepted = this.authorize(req.idTag);
      const transactionId = this.nextTransactionId();
      const idTagInfo: IdTagInfo = { status: accepted ? 'Accepted' : 'Invalid' };
      // Recorded before the emit, so it is set even if no controller is
      // listening yet (see getLastTransactionId()). Only on acceptance: a
      // rejected idTag still gets an id in the response per OCPP, but there is
      // no session to track.
      if (accepted) {
        this.lastTransactionId = transactionId;
        this.emit('startTransaction', transactionId, req);
      }
      return { transactionId, idTagInfo };
    });

    handle('StopTransaction', ({ params }) => {
      const req = params as StopTransactionReq;
      this.lastTransactionId = null;
      this.emit('stopTransaction', req);
      return { idTagInfo: { status: 'Accepted' } as IdTagInfo };
    });

    handle('MeterValues', ({ params }) => {
      const req = params as MeterValuesReq;
      const readings = parseMeterValues(req.meterValue);
      this.lastReadings = readings;
      this.emit('meterValues', readings, req);
      return {};
    });

    // Accept the optional messages so strictMode does not reject them.
    handle('DataTransfer', ({ params }) => {
      this.emit('dataTransfer', (params ?? {}) as { vendorId?: string; messageId?: string; data?: string });
      return { status: 'Accepted' };
    });
    handle('FirmwareStatusNotification', ({ params }) => {
      this.emit('firmwareStatus', (params as { status?: string } | undefined)?.status ?? 'Unknown');
      return {};
    });
    handle('DiagnosticsStatusNotification', ({ params }) => {
      this.emit('diagnosticsStatus', (params as { status?: string } | undefined)?.status ?? 'Unknown');
      return {};
    });

    client.on('close', () => {
      if (this.client === client) {
        this.client = null;
        this.disconnectedAt = Date.now();
        this.clearLiveness();
        this.emit('disconnect');
      }
    });

    this.emit('connect');
  }

  /** Called when the underlying client disconnects outside a 'close' we tracked. */
  detach(): void {
    this.client = null;
    this.disconnectedAt = Date.now();
    this.clearLiveness();
  }

  // ---------------------------------------------------------------------------
  // Liveness
  // ---------------------------------------------------------------------------

  /** Record inbound contact and restart the silence countdown. */
  private markSeen(): void {
    this.lastSeenAt = Date.now();
    if (!this.client || this.livenessTimeoutMs <= 0) return;
    this.clearLiveness();
    // eslint-disable-next-line homey-app/global-timers -- unref()'d below, cleared on close/detach
    this.livenessTimer = setTimeout(() => this.onLivenessTimeout(), this.livenessTimeoutMs);
    this.livenessTimer.unref?.();
  }

  private clearLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
  }

  /**
   * Nothing inbound for the whole liveness window. A WebSocket that is merely
   * half-open still looks OPEN to us - ocpp-rpc's own ping/pong is answered by
   * the peer's ws layer, so it can keep a link "up" long after the charge point
   * stopped participating in OCPP at all, and there is then no 'close' event to
   * learn from. This is the only signal for that failure.
   *
   * The local side is dropped *first* and 'disconnect' emitted directly, rather
   * than waiting for the close handshake to come back round: tearing down a
   * half-open socket is exactly the case that can hang indefinitely, and the app
   * must not depend on it to find out the charger is gone. The close-listener
   * above is left in place but self-guards on `this.client === client`, so the
   * eventual (or never-arriving) close cannot double-fire 'disconnect'.
   */
  private onLivenessTimeout(): void {
    const { client } = this;
    if (!client) return;
    const idleMs = this.lastSeenAt ? Date.now() - this.lastSeenAt : this.livenessTimeoutMs;
    this.client = null;
    this.disconnectedAt = Date.now();
    this.clearLiveness();
    this.emit('stale', idleMs);
    this.emit('disconnect');
    try {
      // force: terminate rather than negotiate - a polite close would first
      // await pending calls settling, which on a dead link never happens.
      const closing = client.close({ code: 1001, reason: 'No OCPP traffic', force: true });
      if (closing && typeof (closing as Promise<void>).catch === 'function') {
        (closing as Promise<void>).catch(() => { /* already gone */ });
      }
    } catch {
      /* already gone */
    }
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

'use strict';

import { EventEmitter } from 'events';
import { AuthorizePolicy, ChargePoint, RpcClient } from './ChargePoint';
// ocpp-rpc is a CommonJS module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RPCServer } = require('ocpp-rpc');

/**
 * Port the Central System listens on, and the one the pairing instructions tell
 * the user to point the charger at. Fixed rather than a setting: it was read
 * from `ocppPort` in app settings, but the app has no settings page to write it,
 * so the value was only ever this default. Change it here if 9000 ever clashes.
 */
export const DEFAULT_OCPP_PORT = 9000;

export interface CentralSystemOptions {
  port: number;
  host?: string;
  authorize: AuthorizePolicy;
  /** Allocates the next transaction id; the app persists the counter. */
  allocateTransactionId: () => number;
  heartbeatIntervalSec?: number;
  /** Silence (ms) tolerated before a charge point's link is presumed dead; 0 disables. */
  livenessTimeoutMs?: number;
  logger?: (msg: string, ...args: unknown[]) => void;
}

/** Minimal surface this file needs from the untyped ocpp-rpc RPCServer. */
interface RpcServerLike {
  on(event: 'client', listener: (client: RpcClient) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  listen(port: number, host: string): Promise<void>;
  close(opts?: { code?: number; reason?: string }): Promise<void>;
}

/**
 * Owns the ocpp-rpc RPCServer and a registry of {@link ChargePoint}s keyed by
 * OCPP identity. Lives on the App instance so the Central System is available
 * whenever the app runs, independent of device pairing.
 *
 * Events:
 *  - 'chargePoint' (cp)  — a brand-new identity connected for the first time
 *  - 'connect'    (cp)   — a charge point (re)connected
 *  - 'disconnect' (cp)   — a charge point dropped
 *  - 'stale' (cp, idleMs) — the link went silent past the liveness timeout and
 *    was dropped by the watchdog; always followed by 'disconnect'
 */
export class CentralSystem extends EventEmitter {

  private opts: CentralSystemOptions;

  private server: RpcServerLike | null = null;

  private points = new Map<string, ChargePoint>();

  private log: (msg: string, ...args: unknown[]) => void;

  constructor(opts: CentralSystemOptions) {
    super();
    this.opts = opts;
    this.log = opts.logger ?? (() => { /* noop */ });
  }

  async start(): Promise<void> {
    if (this.server) return;

    const server = new RPCServer({
      protocols: ['ocpp1.6'],
      strictMode: true,
    });

    server.on('client', (client: RpcClient) => {
      const { identity } = client;
      this.log(`[OCPP] client connected: ${identity}`);

      let cp = this.points.get(identity);
      const isNew = !cp;
      if (!cp) {
        cp = new ChargePoint({
          identity,
          authorize: this.opts.authorize,
          nextTransactionId: this.opts.allocateTransactionId,
          heartbeatIntervalSec: this.opts.heartbeatIntervalSec,
          livenessTimeoutMs: this.opts.livenessTimeoutMs,
        });
        cp.on('stale', (idleMs: number) => {
          this.log(`[OCPP] client ${identity} silent for ${Math.round(idleMs / 1000)}s - dropping the link`);
          this.emit('stale', cp, idleMs);
        });
        cp.on('disconnect', () => {
          this.log(`[OCPP] client disconnected: ${identity}`);
          this.emit('disconnect', cp);
        });
        this.points.set(identity, cp);
      }

      cp.attach(client);
      if (isNew) this.emit('chargePoint', cp);
      this.emit('connect', cp);
    });

    server.on('error', (err: Error) => this.log(`[OCPP] server error: ${err.message}`));

    await server.listen(this.opts.port, this.opts.host ?? '0.0.0.0');
    this.server = server;
    this.log(`[OCPP] Central System listening on ${this.opts.host ?? '0.0.0.0'}:${this.opts.port}`);
  }

  getChargePoint(identity: string): ChargePoint | undefined {
    return this.points.get(identity);
  }

  /** Identities seen this session (connected or previously connected). */
  listIdentities(): string[] {
    return [...this.points.keys()];
  }

  /**
   * Closing the server was not enough on its own: each ChargePoint holds a
   * liveness timer and a reference to its socket, and neither is reached by
   * closing the listener. They were left armed against a server that no longer
   * exists, and the registry kept handing the same stale instances back.
   *
   * detach() rather than a disconnect: this is a deliberate shutdown, and the
   * controller is being torn down alongside it, so emitting 'disconnect' here
   * would report an outage - marking the device unavailable and firing the
   * charger_offline Flow trigger - every time the app stops.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    for (const cp of this.points.values()) cp.detach();
    this.points.clear();
    try {
      await this.server.close({ code: 1001 });
    } catch (err) {
      this.log(`[OCPP] error closing server: ${(err as Error).message}`);
    }
    this.server = null;
  }

}

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { ChargePoint, RpcClient } from '../lib/ocpp/ChargePoint';

type NamedHandler = (ctx: { params: unknown }) => Record<string, unknown>;
type CatchAllHandler = (ctx: { method: string; params: unknown }) => Record<string, unknown>;

/**
 * Fake ocpp-rpc server-side client. Captures whatever ChargePoint.attach()
 * registers via handle() so tests can dispatch a synthetic inbound OCPP call
 * directly, without a real WebSocket/RPCServer round trip (that's what
 * test/ocpp-integration.test.ts is for).
 */
class FakeRpcClient implements RpcClient {
  identity = 'TEST01';

  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  closeListeners: Array<() => void> = [];

  private handlers = new Map<string, NamedHandler>();

  private catchAll: CatchAllHandler | null = null;

  handle(methodOrHandler: string | CatchAllHandler, handler?: NamedHandler): void {
    if (typeof methodOrHandler === 'string') {
      this.handlers.set(methodOrHandler, handler!);
    } else {
      this.catchAll = methodOrHandler;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, params?: Record<string, unknown>): Promise<any> {
    this.calls.push({ method, params });
    return { status: 'Accepted' };
  }

  closeOpts: Array<{ code?: number; reason?: string; force?: boolean } | undefined> = [];

  async close(opts?: { code?: number; reason?: string; force?: boolean }): Promise<void> {
    this.closeOpts.push(opts);
  }

  on(_event: 'close', listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Test helper: dispatch an inbound OCPP call as if the real charger sent it. */
  dispatch(method: string, params: unknown): Record<string, unknown> {
    const handler = this.handlers.get(method);
    if (handler) return handler({ params });
    if (this.catchAll) return this.catchAll({ method, params });
    throw new Error(`No handler registered for ${method}`);
  }
}

function makeCp(authorize: (idTag: string) => boolean = () => true): ChargePoint {
  return new ChargePoint({ identity: 'TEST01', authorize, nextTransactionId: () => 1 });
}

test('Authorize accepts/rejects per the authorize policy and emits the outcome', () => {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const cp = makeCp((idTag) => idTag === 'GOOD');
  cp.on('authorize', (idTag, ok) => (ok ? accepted : rejected).push(idTag));
  const client = new FakeRpcClient();
  cp.attach(client);

  assert.deepEqual(client.dispatch('Authorize', { idTag: 'GOOD' }), { idTagInfo: { status: 'Accepted' } });
  assert.deepEqual(accepted, ['GOOD']);

  assert.deepEqual(client.dispatch('Authorize', { idTag: 'BAD' }), { idTagInfo: { status: 'Invalid' } });
  assert.deepEqual(rejected, ['BAD']);
});

test('Heartbeat emits and returns the current server time', () => {
  let heartbeats = 0;
  const cp = makeCp();
  cp.on('heartbeat', () => {
    heartbeats += 1;
  });
  const client = new FakeRpcClient();
  cp.attach(client);

  const res = client.dispatch('Heartbeat', {});
  assert.equal(heartbeats, 1);
  assert.ok(typeof res.currentTime === 'string');
});

test('DataTransfer is forwarded verbatim and always accepted', () => {
  const payloads: unknown[] = [];
  const cp = makeCp();
  cp.on('dataTransfer', (p) => payloads.push(p));
  const client = new FakeRpcClient();
  cp.attach(client);

  const res = client.dispatch('DataTransfer', { vendorId: 'Wallbox', messageId: 'ping', data: 'x' });
  assert.deepEqual(res, { status: 'Accepted' });
  assert.deepEqual(payloads, [{ vendorId: 'Wallbox', messageId: 'ping', data: 'x' }]);
});

test('DataTransfer with no params still emits (an empty payload, not a crash)', () => {
  const payloads: unknown[] = [];
  const cp = makeCp();
  cp.on('dataTransfer', (p) => payloads.push(p));
  const client = new FakeRpcClient();
  cp.attach(client);

  client.dispatch('DataTransfer', undefined);
  assert.deepEqual(payloads, [{}]);
});

test('FirmwareStatusNotification / DiagnosticsStatusNotification emit the reported status, defaulting to Unknown', () => {
  const cp = makeCp();
  const firmware: string[] = [];
  const diagnostics: string[] = [];
  cp.on('firmwareStatus', (s) => firmware.push(s));
  cp.on('diagnosticsStatus', (s) => diagnostics.push(s));
  const client = new FakeRpcClient();
  cp.attach(client);

  client.dispatch('FirmwareStatusNotification', { status: 'Downloaded' });
  client.dispatch('DiagnosticsStatusNotification', {});
  assert.deepEqual(firmware, ['Downloaded']);
  assert.deepEqual(diagnostics, ['Unknown']);
});

test('detach() drops the client silently, without emitting disconnect', () => {
  const cp = makeCp();
  const client = new FakeRpcClient();
  cp.attach(client);
  assert.equal(cp.connected, true);

  let disconnected = false;
  cp.on('disconnect', () => {
    disconnected = true;
  });
  cp.detach();
  assert.equal(cp.connected, false);
  assert.equal(disconnected, false, 'detach() is a silent teardown, distinct from the close-listener path');
});

test('a close from a superseded (stale) client is ignored - only the current client can trigger disconnect', () => {
  const cp = makeCp();
  const clientA = new FakeRpcClient();
  cp.attach(clientA);
  let disconnects = 0;
  cp.on('disconnect', () => {
    disconnects += 1;
  });

  const clientB = new FakeRpcClient();
  cp.attach(clientB); // reconnect: swaps the underlying client
  clientA.closeListeners.forEach((l) => l());
  assert.equal(disconnects, 0, 'a stale close from the old client must not fire disconnect');
  assert.equal(cp.connected, true, 'still connected via the new client');

  clientB.closeListeners.forEach((l) => l());
  assert.equal(disconnects, 1);
  assert.equal(cp.connected, false);
});

// ---------------------------------------------------------------------------
// Liveness watchdog
// ---------------------------------------------------------------------------

/** Resolve after `ms` of real time - the watchdog is a plain setTimeout. */
const wait = (ms: number) => new Promise((r) => {
  setTimeout(r, ms);
});

test('attach() records contact immediately, and every inbound message refreshes it', () => {
  const cp = makeCp();
  const client = new FakeRpcClient();
  const before = Date.now();
  cp.attach(client);

  const onAttach = cp.getConnectionInfo();
  assert.equal(onAttach.connected, true);
  assert.ok(onAttach.lastSeenAt != null && onAttach.lastSeenAt >= before,
    'the connection itself counts as contact - the watchdog must not start from the previous link');
  assert.equal(onAttach.disconnectedAt, null);

  client.dispatch('Heartbeat', {});
  const afterBeat = cp.getConnectionInfo();
  assert.ok(afterBeat.lastSeenAt != null && afterBeat.lastSeenAt >= onAttach.lastSeenAt!);
});

test('a link with no inbound traffic for the liveness window is declared stale and dropped', async () => {
  const cp = new ChargePoint({
    identity: 'TEST01', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 30,
  });
  const client = new FakeRpcClient();
  const stale: number[] = [];
  let disconnects = 0;
  cp.on('stale', (idleMs: number) => {
    stale.push(idleMs);
  });
  cp.on('disconnect', () => {
    disconnects += 1;
  });
  cp.attach(client);

  await wait(60);
  assert.equal(stale.length, 1, 'silence past the window is reported');
  assert.equal(disconnects, 1, 'and drops the link, so the app learns the charger is gone');
  assert.equal(cp.connected, false);
  assert.ok(cp.getConnectionInfo().disconnectedAt != null);
  // A half-open socket is exactly what would leave a polite close hanging on
  // pending calls, so the teardown must terminate rather than negotiate.
  assert.deepEqual(client.closeOpts, [{ code: 1001, reason: 'No OCPP traffic', force: true }]);

  // The socket's own close may still arrive later (or never) - either way it
  // must not double-report the disconnect.
  client.closeListeners.forEach((l) => l());
  assert.equal(disconnects, 1);
});

test('inbound traffic keeps pushing the liveness deadline out', async () => {
  const cp = new ChargePoint({
    identity: 'TEST01', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 40,
  });
  const client = new FakeRpcClient();
  let disconnects = 0;
  cp.on('disconnect', () => {
    disconnects += 1;
  });
  cp.attach(client);

  for (let i = 0; i < 4; i += 1) {
    await wait(25);
    client.dispatch('Heartbeat', {});
  }
  assert.equal(disconnects, 0, 'total elapsed time is well past the window, but it was never silent for a whole one');
  assert.equal(cp.connected, true);

  await wait(80);
  assert.equal(disconnects, 1, 'and it still fires once the traffic actually stops');
});

test('livenessTimeoutMs: 0 disables the watchdog entirely', async () => {
  const cp = new ChargePoint({
    identity: 'TEST01', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  const client = new FakeRpcClient();
  let disconnects = 0;
  cp.on('disconnect', () => {
    disconnects += 1;
  });
  cp.attach(client);
  await wait(40);
  assert.equal(disconnects, 0);
  assert.equal(cp.connected, true);
});

test('a close or detach stops the watchdog, so a dead ChargePoint cannot re-report itself', async () => {
  const cp = new ChargePoint({
    identity: 'TEST01', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 30,
  });
  const client = new FakeRpcClient();
  const stale: number[] = [];
  cp.on('stale', (idleMs: number) => {
    stale.push(idleMs);
  });
  cp.attach(client);
  cp.detach();
  await wait(60);
  assert.deepEqual(stale, [], 'detach() already tore the link down - no watchdog left to fire');
  assert.deepEqual(client.closeOpts, [], 'and nothing to close');
});

test('setAuthorizePolicy() replaces the policy used by subsequent Authorize calls', () => {
  const cp = makeCp(() => false);
  const client = new FakeRpcClient();
  cp.attach(client);

  assert.deepEqual(client.dispatch('Authorize', { idTag: 'X' }), { idTagInfo: { status: 'Invalid' } });

  cp.setAuthorizePolicy(() => true);
  assert.deepEqual(client.dispatch('Authorize', { idTag: 'X' }), { idTagInfo: { status: 'Accepted' } });
});

test('outbound commands throw before a client is ever attached', async () => {
  const cp = makeCp();
  await assert.rejects(() => cp.remoteStartTransaction('X'), /not connected/);
});

test('clearChargingProfile() sends ClearChargingProfile, with or without a specific profile id', async () => {
  const cp = makeCp();
  const client = new FakeRpcClient();
  cp.attach(client);

  const acceptedAll = await cp.clearChargingProfile();
  assert.equal(acceptedAll, true);
  assert.deepEqual(client.calls[client.calls.length - 1], { method: 'ClearChargingProfile', params: {} });

  await cp.clearChargingProfile(5);
  assert.deepEqual(client.calls[client.calls.length - 1], { method: 'ClearChargingProfile', params: { id: 5 } });
});

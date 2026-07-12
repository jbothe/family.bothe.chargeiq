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

  async close(): Promise<void> { /* no-op */ }

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

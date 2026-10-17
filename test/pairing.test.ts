'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { resolvePairList, SINGLE_CHARGER_MESSAGE, waitForChargePoint } from '../lib/pairing';

/** A stand-in for CentralSystem: an emitter whose identity list tests set directly. */
class FakeSource extends EventEmitter {
  identities: string[] = [];

  listIdentities(): string[] {
    return [...this.identities];
  }

  connect(identity: string): void {
    this.identities.push(identity);
    this.emit('connect');
  }
}

test('offers every connected identity when no charger is paired yet', () => {
  const result = resolvePairList(0, ['CP-A', 'CP-B']);
  assert.ok('devices' in result);
  assert.deepEqual(result.devices, [
    { name: 'OCPP Smart EV Charger (CP-A)', data: { id: 'CP-A' } },
    { name: 'OCPP Smart EV Charger (CP-B)', data: { id: 'CP-B' } },
  ]);
});

test('offers an empty list (no error) when none have connected yet', () => {
  const result = resolvePairList(0, []);
  assert.deepEqual(result, { devices: [] });
});

test('refuses a second charger once one is already paired', () => {
  const result = resolvePairList(1, ['CP-A', 'CP-B']);
  assert.deepEqual(result, { error: SINGLE_CHARGER_MESSAGE });
});

test('waitForChargePoint answers at once when a charge point is already known', async () => {
  const source = new FakeSource();
  source.identities = ['CP-A'];
  assert.deepEqual(await waitForChargePoint(source, 60_000), ['CP-A']);
  assert.equal(source.listenerCount('connect'), 0, 'nothing left listening');
});

test('waitForChargePoint waits for a charger still booting, then cleans up', async () => {
  const source = new FakeSource();
  const pending = waitForChargePoint(source, 60_000);
  setTimeout(() => source.connect('CP-A'), 5);
  assert.deepEqual(await pending, ['CP-A']);
  assert.equal(source.listenerCount('connect'), 0);
});

test('waitForChargePoint gives up with an empty list after the timeout', async () => {
  const source = new FakeSource();
  assert.deepEqual(await waitForChargePoint(source, 10), []);
  assert.equal(source.listenerCount('connect'), 0);
});

test('waitForChargePoint stops waiting when the pair session closes', async () => {
  const source = new FakeSource();
  const closed = new AbortController();
  const pending = waitForChargePoint(source, 60_000, closed.signal);
  closed.abort();
  assert.deepEqual(await pending, []);
  assert.equal(source.listenerCount('connect'), 0);

  assert.deepEqual(await waitForChargePoint(source, 60_000, closed.signal), [],
    'an already-closed session does not wait at all');
});

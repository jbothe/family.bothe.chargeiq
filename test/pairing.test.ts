'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { resolvePairList, SINGLE_CHARGER_MESSAGE } from '../lib/pairing';

test('offers every connected identity when no charger is paired yet', () => {
  const result = resolvePairList(0, ['CP-A', 'CP-B']);
  assert.ok('devices' in result);
  assert.deepEqual(result.devices, [
    { name: 'EV Charger (CP-A)', data: { id: 'CP-A' } },
    { name: 'EV Charger (CP-B)', data: { id: 'CP-B' } },
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

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { parseMeterValues, MeterValue } from '../lib/ocpp/types';

function mv(sampledValue: MeterValue['sampledValue'], timestamp = '2024-01-01T00:00:00Z'): MeterValue {
  return { timestamp, sampledValue };
}

test('parseMeterValues returns an empty object for a missing or empty batch', () => {
  assert.deepEqual(parseMeterValues([]), {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(parseMeterValues(undefined as any), {});
});

test('an unrecognised measurand is ignored rather than crashing', () => {
  const out = parseMeterValues([mv([
    { value: '1', measurand: 'SoC' },
    { value: '230', measurand: 'Voltage' },
  ])]);
  assert.equal(out.voltage, 230);
  assert.equal('soc' in out, false);
});

test('a non-numeric sampled value is skipped', () => {
  const out = parseMeterValues([mv([
    { value: 'not-a-number', measurand: 'Power.Active.Import' },
  ])]);
  assert.equal(out.power, undefined);
});

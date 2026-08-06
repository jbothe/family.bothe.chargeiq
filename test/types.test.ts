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

test('an unrecognised measurand is ignored rather than crashing, but recorded for the log', () => {
  const out = parseMeterValues([mv([
    { value: '1', measurand: 'SoC' },
    { value: '230', measurand: 'Voltage' },
  ])]);
  assert.equal(out.voltage, 230);
  assert.equal('soc' in out, false);
  assert.deepEqual(out.unhandled, { SoC: '1' });
});

test('an unhandled measurand records its unit and phase, and a non-numeric value too', () => {
  const out = parseMeterValues([mv([
    { value: '42', measurand: 'SoC', unit: 'Percent' },
    {
      value: '16', measurand: 'Current.Offered', unit: 'A', phase: 'L1',
    },
    { value: 'Charging', measurand: 'Vendor.State' },
  ])]);
  assert.deepEqual(out.unhandled, {
    SoC: '42 Percent',
    'Current.Offered': '16 A @L1',
    'Vendor.State': 'Charging',
  });
});

test('a batch of only handled measurands leaves unhandled unset', () => {
  const out = parseMeterValues([mv([
    { value: '7200', measurand: 'Power.Active.Import' },
  ])]);
  assert.equal(out.unhandled, undefined);
});

test('the last sample wins for a repeated unhandled measurand', () => {
  const out = parseMeterValues([
    mv([{ value: '40', measurand: 'SoC', unit: 'Percent' }], '2024-01-01T00:00:00Z'),
    mv([{ value: '45', measurand: 'SoC', unit: 'Percent' }], '2024-01-01T00:00:10Z'),
  ]);
  assert.deepEqual(out.unhandled, { SoC: '45 Percent' });
});

test('a non-numeric sampled value is skipped', () => {
  const out = parseMeterValues([mv([
    { value: 'not-a-number', measurand: 'Power.Active.Import' },
  ])]);
  assert.equal(out.power, undefined);
});

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { currentLimitRange, currentLimitRangeUpdate } from '../lib/capabilities';

test('the slider range follows the configured amp limits', () => {
  assert.deepEqual(currentLimitRange(6, 32), { min: 6, max: 32 });
  // Below the 6A the capability manifest declares - the write Homey used to
  // reject, leaving the slider stuck while charging carried on correctly.
  assert.deepEqual(currentLimitRange(3, 32), { min: 3, max: 32 });
  // ...and above the 32A it declares, which the maxAmps setting allows up to 80.
  assert.deepEqual(currentLimitRange(6, 80), { min: 6, max: 80 });
});

test('maxAmps below minAmps resolves to the floor, as clampAmps does', () => {
  // Not a range at all, just a misconfiguration. ChargeController.clampAmps()
  // resolves the same contradiction the same way - max(minAmps, min(maxAmps, x))
  // yields minAmps - so the slider must not end up with min > max.
  assert.deepEqual(currentLimitRange(20, 10), { min: 20, max: 20 });
});

test('an update is only proposed when the bounds actually change', () => {
  // setCapabilityOptions is documented as expensive, and this runs on every
  // settings save - most of which do not touch the amp limits.
  assert.equal(currentLimitRangeUpdate({ min: 6, max: 32 }, 6, 32), null);
  assert.deepEqual(currentLimitRangeUpdate({ min: 6, max: 32 }, 6, 16), { min: 6, max: 16 });
  assert.deepEqual(currentLimitRangeUpdate({ min: 6, max: 32 }, 10, 32), { min: 10, max: 32 });
});

test('a device with no options set yet, or only one bound, counts as a change', () => {
  // getCapabilityOptions() is untyped and may return nothing at all for a device
  // paired before options were ever written, or a partial object.
  assert.deepEqual(currentLimitRangeUpdate(undefined, 6, 32), { min: 6, max: 32 });
  assert.deepEqual(currentLimitRangeUpdate(null, 6, 32), { min: 6, max: 32 });
  assert.deepEqual(currentLimitRangeUpdate({}, 6, 32), { min: 6, max: 32 });
  assert.deepEqual(currentLimitRangeUpdate({ min: 6 }, 6, 32), { min: 6, max: 32 });
  assert.deepEqual(currentLimitRangeUpdate({ max: 32 }, 6, 32), { min: 6, max: 32 });
});

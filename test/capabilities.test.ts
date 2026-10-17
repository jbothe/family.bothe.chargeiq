'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  resolveEnergyControl, targetPowerOptions, targetPowerOptionsUpdate, wattsToAmps,
} from '../lib/capabilities';

const OPTS_6_32 = {
  min: 0, max: 7360, step: 230, excludeMin: 0, excludeMax: 1380,
};

test('target_power options follow the configured amp limits', () => {
  assert.deepEqual(targetPowerOptions(6, 32, 230), OPTS_6_32);
  // Below the 6A the manifest declares - the kind of write Homey rejects,
  // leaving the value stuck while charging carried on correctly.
  assert.deepEqual(targetPowerOptions(3, 32, 230), { ...OPTS_6_32, excludeMax: 690 });
  // ...and above the 32A it declares, which the maxAmps setting allows up to 80.
  assert.deepEqual(targetPowerOptions(6, 80, 230), { ...OPTS_6_32, max: 18400 });
});

test('target_power options scale with voltage and phases', () => {
  // A 3-phase charger: one amp is 690W, and the step has to be that or Homey
  // asks for power levels between two amp settings.
  assert.deepEqual(targetPowerOptions(6, 16, 690), {
    min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 4140,
  });
});

test('the range always includes zero, so the charger can idle', () => {
  // Homey's own rule: min <= 0 <= max, and the exclude range must contain 0.
  const o = targetPowerOptions(6, 32, 230);
  assert.ok(o.min <= 0 && o.max >= 0);
  assert.ok(o.excludeMin <= 0 && o.excludeMax >= 0);
});

test('maxAmps below minAmps resolves to the floor, as clampAmps does', () => {
  // Not a range at all, just a misconfiguration. ChargeController.clampAmps()
  // resolves the same contradiction the same way - max(minAmps, min(maxAmps, x))
  // yields minAmps - so the range must not end up with max below the floor.
  assert.equal(targetPowerOptions(20, 10, 230).max, 4600);
});

test('an update is only proposed when the options actually change', () => {
  // setCapabilityOptions is documented as expensive, and this runs on every
  // settings save - most of which do not touch the amp limits.
  assert.equal(targetPowerOptionsUpdate(OPTS_6_32, 6, 32, 230), null);
  assert.deepEqual(targetPowerOptionsUpdate(OPTS_6_32, 6, 16, 230), { ...OPTS_6_32, max: 3680 });
  assert.deepEqual(targetPowerOptionsUpdate(OPTS_6_32, 10, 32, 230), { ...OPTS_6_32, excludeMax: 2300 });
  // A voltage change moves every figure, including the step.
  assert.deepEqual(targetPowerOptionsUpdate(OPTS_6_32, 6, 32, 240), {
    min: 0, max: 7680, step: 240, excludeMin: 0, excludeMax: 1440,
  });
});

test('a device with no options set yet, or only some, counts as a change', () => {
  // getCapabilityOptions() is untyped and may return nothing at all for a device
  // paired before options were ever written, or a partial object.
  assert.deepEqual(targetPowerOptionsUpdate(undefined, 6, 32, 230), OPTS_6_32);
  assert.deepEqual(targetPowerOptionsUpdate(null, 6, 32, 230), OPTS_6_32);
  assert.deepEqual(targetPowerOptionsUpdate({}, 6, 32, 230), OPTS_6_32);
  assert.deepEqual(targetPowerOptionsUpdate({ min: 0, max: 7360 }, 6, 32, 230), OPTS_6_32);
});

test('watts convert to amps rounding down, never up', () => {
  assert.equal(wattsToAmps(2300, 230), 10);
  assert.equal(wattsToAmps(2529, 230), 10, 'floored: 10.99A must not become 11A');
  assert.equal(wattsToAmps(0, 230), 0);
  assert.equal(wattsToAmps(-1000, 230), 0, 'no discharging on this charger');
  assert.equal(wattsToAmps(1000, 0), 0, 'no conversion factor yet means no current');
});

const NONE = { watts: null, charging: null };

test("Homey's Set target power card latches manual at that power", () => {
  // The card sets all three capabilities together.
  assert.deepEqual(
    resolveEnergyControl({ watts: 3450, mode: 'homey', charging: true }, NONE, 230),
    { action: 'charge', amps: 15 },
  );
  assert.deepEqual(
    resolveEnergyControl({ watts: 0, mode: 'homey', charging: false }, NONE, 230),
    { action: 'off' },
  );
});

test('a target_power on its own also starts or stops charging', () => {
  assert.deepEqual(
    resolveEnergyControl({ watts: 2300 }, { watts: 4600, charging: false }, 230),
    { action: 'charge', amps: 10 },
  );
  assert.deepEqual(
    resolveEnergyControl({ watts: 0 }, { watts: 4600, charging: true }, 230),
    { action: 'off' },
  );
  // Explicitly stopped wins over a positive power: the power is kept for next time.
  assert.deepEqual(
    resolveEnergyControl({ watts: 2300, charging: false }, NONE, 230),
    { action: 'off' },
  );
});

test('the charging toggle uses the current target_power, or the default when there is none', () => {
  assert.deepEqual(
    resolveEnergyControl({ charging: true }, { watts: 2760, charging: false }, 230),
    { action: 'charge', amps: 12 },
  );
  assert.deepEqual(
    resolveEnergyControl({ charging: true }, NONE, 230),
    { action: 'charge' },
  );
  assert.deepEqual(
    resolveEnergyControl({ charging: false }, { watts: 2760, charging: true }, 230),
    { action: 'off' },
  );
});

test('picking Homey mode alone freezes what is happening now as manual', () => {
  assert.deepEqual(
    resolveEnergyControl({ mode: 'homey' }, { watts: 2300, charging: true }, 230),
    { action: 'charge', amps: 10 },
  );
  assert.deepEqual(
    resolveEnergyControl({ mode: 'homey' }, { watts: 2300, charging: false }, 230),
    { action: 'off' },
  );
});

test('any non-Homey mode hands control back to ChargeIQ, whichever one was picked', () => {
  // Which of scheduled/solar/idle applies is derived, not chosen.
  for (const mode of ['scheduled', 'solar', 'idle', 'device']) {
    assert.deepEqual(resolveEnergyControl({ mode }, { watts: 2300, charging: true }, 230), { action: 'resume' });
  }
  assert.deepEqual(
    resolveEnergyControl({ mode: 'solar', watts: 2300, charging: true }, NONE, 230),
    { action: 'resume' },
  );
});

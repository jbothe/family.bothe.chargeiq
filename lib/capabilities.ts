'use strict';

/** Slider bounds for the `charge_current_limit` capability. */
export interface CurrentLimitRange {
  min: number;
  max: number;
}

/**
 * What the `charge_current_limit` slider's bounds should be for a device
 * configured with these amp limits.
 *
 * The capability's own manifest declares a single range for every install, but
 * the limits that actually govern charging are per-device settings - so the two
 * disagree whenever a charger isn't the one the manifest was written around.
 * Both directions bite: a `minAmps` below the declared floor, or a `maxAmps`
 * above the declared ceiling, produce a target the controller happily sends
 * over OCPP but that Homey rejects as a capability write, leaving the slider
 * silently stuck at a stale figure while charging carries on correctly.
 *
 * `maxAmps` below `minAmps` is a misconfiguration rather than a range; the
 * floor wins, matching ChargeController.clampAmps(), which resolves the same
 * contradiction the same way (`max(minAmps, min(maxAmps, x))` yields minAmps).
 */
export function currentLimitRange(minAmps: number, maxAmps: number): CurrentLimitRange {
  return { min: minAmps, max: Math.max(minAmps, maxAmps) };
}

/**
 * The bounds to write, or null when the device already has them.
 *
 * Homey documents `setCapabilityOptions` as expensive and to be used "only when
 * needed", so the caller must not write unconditionally - it runs on every
 * settings save, and most saves don't touch the amp limits at all. `current` is
 * whatever `getCapabilityOptions()` returned, which is untyped and may be
 * missing either bound (a device paired before options were ever set), so a
 * partial match counts as a change.
 */
export function currentLimitRangeUpdate(
  current: { min?: number; max?: number } | null | undefined,
  minAmps: number,
  maxAmps: number,
): CurrentLimitRange | null {
  const wanted = currentLimitRange(minAmps, maxAmps);
  if (current && current.min === wanted.min && current.max === wanted.max) return null;
  return wanted;
}

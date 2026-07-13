'use strict';

/**
 * ChargeIQ is deliberately a single-charger app for now: the whole solar /
 * household-cap / shared-circuit / widget model assumes one car drawing from
 * one house, and the shared electrical limits are enforced per-controller with
 * no cross-charger coordination. Pairing a second charger would silently give
 * uncoordinated grid/breaker limits, so pairing is capped at one device.
 * See docs/MULTI_DEVICE.md for what proper multi-charger support would require.
 */
export const SINGLE_CHARGER_MESSAGE = 'ChargeIQ supports a single charger. Remove the existing '
  + 'charger device before pairing a different one.';

/** One selectable charge point for Homey's list_devices pairing step. */
export interface PairDevice {
  name: string;
  data: { id: string };
}

/**
 * Decide what the pairing `list_devices` step should return. Pure so it can be
 * unit-tested without the Homey runtime (driver.ts is a thin adapter around it).
 *
 * - If a charger is already paired, refuse: `{ error }` (surfaced in the pair UI).
 * - Otherwise offer every charge point that has connected to the Central System
 *   this session, as a selectable device keyed by its OCPP identity.
 */
export function resolvePairList(
  existingDeviceCount: number,
  connectedIdentities: string[],
): { error: string } | { devices: PairDevice[] } {
  if (existingDeviceCount >= 1) {
    return { error: SINGLE_CHARGER_MESSAGE };
  }
  return {
    devices: connectedIdentities.map((identity) => ({
      name: `EV Charger (${identity})`,
      data: { id: identity },
    })),
  };
}

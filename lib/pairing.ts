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
      name: `OCPP Smart EV Charger (${identity})`,
      data: { id: identity },
    })),
  };
}

/**
 * How long `list_devices` waits for a charge point to connect before giving up.
 * Saving OCPP settings on a Wallbox restarts it, and it only connects once it
 * is back up - a minute or two - so answering straight away found nothing and
 * Homey showed "No devices found" while the charger was still booting.
 */
export const PAIR_WAIT_MS = 5 * 60 * 1000;

export const NO_CHARGER_MESSAGE = 'No charger has connected to ChargeIQ yet. Check that the charger\'s '
  + 'OCPP URL matches the one shown on the previous screen and that it uses OCPP 1.6J, then try again.';

/** The part of CentralSystem that {@link waitForChargePoint} needs. */
export interface ChargePointSource {
  listIdentities(): string[];
  on(event: 'connect', listener: () => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
}

/**
 * Resolves with the known identities as soon as there is at least one: at once
 * if a charge point has already connected, otherwise on the next 'connect'.
 * Resolves with an empty list after `timeoutMs`, or when `signal` aborts (the
 * pair session closed), so a waiting handler never outlives its session.
 */
export function waitForChargePoint(
  source: ChargePointSource,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const now = source.listIdentities();
  if (now.length > 0 || signal?.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      source.off('connect', finish);
      signal?.removeEventListener('abort', finish);
      resolve(source.listIdentities());
    };
    // eslint-disable-next-line homey-app/global-timers -- cleared in finish(), which closing the pair session also runs
    timer = setTimeout(finish, timeoutMs);
    source.on('connect', finish);
    signal?.addEventListener('abort', finish);
  });
}

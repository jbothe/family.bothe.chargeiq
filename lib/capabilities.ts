'use strict';

/**
 * `target_power` capability options for this charger. Homey's Energy reads them
 * to know what it can ask for: `min`/`max` the full range (which must include 0,
 * so the charger can idle), `step` one amp's worth of watts, and
 * `excludeMin`/`excludeMax` the dead zone below the minimum current, which Homey
 * itself rounds down to 0 before the listener ever sees it.
 */
export interface TargetPowerOptions {
  min: number;
  max: number;
  step: number;
  excludeMin: number;
  excludeMax: number;
}

/**
 * The options for a device configured with these amp limits. `wattsPerAmp` is
 * `voltage * phases`, the same conversion the controller uses everywhere.
 *
 * The manifest can only declare one range for every install, but the limits
 * that actually govern charging are per-device settings - so the two disagree
 * whenever a charger isn't the one the manifest was written around. Both
 * directions bite: a `minAmps` below the declared floor, or a `maxAmps` above
 * the declared ceiling, produce a target the controller happily sends over OCPP
 * but that Homey rejects as a capability write, leaving the value silently stuck
 * at a stale figure while charging carries on correctly.
 *
 * `maxAmps` below `minAmps` is a misconfiguration rather than a range; the
 * floor wins, matching ChargeController.clampAmps(), which resolves the same
 * contradiction the same way (`max(minAmps, min(maxAmps, x))` yields minAmps).
 */
export function targetPowerOptions(minAmps: number, maxAmps: number, wattsPerAmp: number): TargetPowerOptions {
  return {
    min: 0,
    max: Math.max(minAmps, maxAmps) * wattsPerAmp,
    step: wattsPerAmp,
    excludeMin: 0,
    excludeMax: minAmps * wattsPerAmp,
  };
}

/**
 * The options to write, or null when the device already has them.
 *
 * Homey documents `setCapabilityOptions` as expensive and to be used "only when
 * needed", so the caller must not write unconditionally - it runs on every
 * settings save, and most saves don't touch the amp limits at all. `current` is
 * whatever `getCapabilityOptions()` returned, which is untyped and may be
 * missing any field (a device paired before options were ever set), so a
 * partial match counts as a change.
 */
export function targetPowerOptionsUpdate(
  current: Partial<TargetPowerOptions> | null | undefined,
  minAmps: number,
  maxAmps: number,
  wattsPerAmp: number,
): TargetPowerOptions | null {
  const wanted = targetPowerOptions(minAmps, maxAmps, wattsPerAmp);
  const keys = Object.keys(wanted) as (keyof TargetPowerOptions)[];
  if (current && keys.every((k) => current[k] === wanted[k])) return null;
  return wanted;
}

/** Watts -> whole amps, floored like every other W->A conversion (never above what was asked). */
export function wattsToAmps(watts: number, wattsPerAmp: number): number {
  return wattsPerAmp > 0 ? Math.max(0, Math.floor(watts / wattsPerAmp)) : 0;
}

/**
 * One change to Homey's energy controls, as `registerMultipleCapabilityListener`
 * delivers it: only the capabilities that were actually set are present.
 */
export interface EnergyControlChange {
  watts?: number;
  mode?: string;
  charging?: boolean;
}

export type EnergyControl =
  | { action: 'resume' }
  /** amps absent: the controller's own default (its configured maximum). */
  | { action: 'charge'; amps?: number }
  | { action: 'off' }
  /** Nothing to do: a target_power kept for the next start (Homey stores the value itself). */
  | { action: 'none' };

/**
 * What a change to `target_power` / `target_power_mode` / `evcharger_charging`
 * means for the controller. Homey's "Set target power" card sets all three in
 * quick succession, the toggle and the system start/stop cards set only
 * `evcharger_charging`, and the picker only `target_power_mode`.
 *
 * `target_power_mode` `homey` *is* the manual latch: Homey (or the user) is in
 * charge. Any other value hands control back to ChargeIQ's own logic, whichever
 * value was picked - which of scheduled/solar/idle applies is derived, not
 * chosen, so the controller writes the real one back on its next tick.
 *
 * A `target_power` on its own never starts a charge. Homey's EV charger
 * contract keeps a lone target power while stopped until an explicit start, and
 * its card sends `evcharger_charging` (or the mode) alongside whenever it means
 * to start or stop. On its own it only adjusts, or stops, a charge already
 * requested.
 *
 * `current` fills in whatever wasn't part of the change: the stored
 * `target_power`, and whether ChargeIQ is asking the charger to charge right now
 * (a decided current above 0). That request, not `evcharger_charging`, which
 * drops to false whenever the car stops drawing - a full battery included,
 * while a manual charge is still latched.
 */
export function resolveEnergyControl(
  change: EnergyControlChange,
  current: { watts: number | null; charging: boolean },
  wattsPerAmp: number,
): EnergyControl {
  const handBack = change.mode !== undefined && change.mode !== 'homey';
  if (handBack) return { action: 'resume' };
  if (change.watts !== undefined) {
    const amps = wattsToAmps(change.watts, wattsPerAmp);
    if (change.charging === false) return { action: 'off' };
    // Sent with an explicit start, or with the switch to Homey mode (Homey's own
    // card): zero, or inside the exclude range Homey has already rounded to
    // zero, stops; anything else charges at that power.
    const explicit = change.charging === true || change.mode === 'homey';
    if (!explicit && !current.charging) return { action: 'none' };
    return amps > 0 ? { action: 'charge', amps } : { action: 'off' };
  }
  const charging = change.charging ?? current.charging;
  if (!charging) return { action: 'off' };
  // Charging switched on with no power given: at the current target_power, or
  // the controller's own default when there isn't one yet.
  const amps = wattsToAmps(current.watts ?? 0, wattsPerAmp);
  return amps > 0 ? { action: 'charge', amps } : { action: 'charge' };
}

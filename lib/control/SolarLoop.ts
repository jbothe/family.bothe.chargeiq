'use strict';

export interface SolarLoopConfig {
  voltage: number;
  phases: number;
  minAmps: number;
  maxAmps: number;
  /** Ignore current changes smaller than this (A). */
  deadbandA: number;
  /** Max change per evaluation (A). */
  rampA: number;
  /** Minimum time charging before it may pause (ms). */
  minOnMs: number;
  /** Minimum time off/paused before it may (re)start (ms). */
  minOffMs: number;
  /** Bias watts: positive reserves headroom (charge less), negative allows some import. */
  marginW: number;
}

export type SolarState = 'off' | 'charging' | 'paused';

export interface SolarInput {
  /** Grid power, import positive / export negative (W). */
  gridSignedW: number;
  /** Present charger draw (W) — already included in the grid reading. */
  chargerPowerW: number;
  /**
   * Battery power, charge positive / discharge negative (W). Optional - a
   * feed without a battery just omits it. Discharge is subtracted back out
   * of the surplus calc below (see evaluate()) - the home battery must never
   * be mistaken for solar surplus, matching the same principle already
   * applied to the schedule-boost feature (ChargeController.scheduledAmpsDetail).
   */
  batteryW?: number;
  now: number;
}

export interface SolarResult {
  /** null = no session desired yet (never started), 0 = pause (hold 0A, keep any
   *  existing session alive), >=minAmps = charge at that current. Callers should
   *  treat null the same as 0 - never a reason to end a live transaction. */
  target: number | null;
  state: SolarState;
  /** Computed surplus available to the car (W), for diagnostics/widget. */
  availableW: number;
}

/**
 * Stateful PV-surplus follower. Given grid export and current charger draw it
 * computes a target charge current, applying a deadband, per-step ramp, and
 * minimum on/off dwell times to avoid oscillation and session/relay flapping.
 * Pure and clock-injected for testing; holds only its own control state.
 */
export class SolarLoop {

  private cfg: SolarLoopConfig;

  private state: SolarState = 'off';

  private currentA = 0;

  private lastChangeAt = 0;

  constructor(cfg: SolarLoopConfig) {
    this.cfg = cfg;
  }

  setConfig(cfg: SolarLoopConfig): void {
    this.cfg = cfg;
  }

  getState(): SolarState {
    return this.state;
  }

  /** Reset control state (e.g. when leaving solar mode or on charger drop). */
  reset(): void {
    this.state = 'off';
    this.currentA = 0;
    this.lastChangeAt = 0;
  }

  private clamp(a: number): number {
    return Math.max(this.cfg.minAmps, Math.min(this.cfg.maxAmps, a));
  }

  evaluate(input: SolarInput): SolarResult {
    const { voltage, phases, minAmps, deadbandA, rampA, minOnMs, minOffMs, marginW } = this.cfg;
    // Power available to the car = what it already draws, minus the net grid flow
    // (export is negative grid so it adds capacity; import is positive so it subtracts),
    // minus a reserve margin. This works whether the meter is importing or exporting.
    // Battery discharge is subtracted back out: the grid meter alone can't tell real
    // PV export apart from the battery propping up that same export, so left in, a
    // discharging battery would get mistaken for solar surplus and fund EV charging
    // (the same failure mode the shared-circuit boost feature avoids by using the
    // real battery/pv readings instead of a grid-based proxy).
    const batteryDischargeW = Math.max(0, -(input.batteryW ?? 0));
    const availableW = input.chargerPowerW - input.gridSignedW - marginW - batteryDischargeW;
    // Floor to bias toward slight export rather than import.
    const desiredA = Math.max(0, Math.min(this.cfg.maxAmps, Math.floor(availableW / (voltage * phases))));
    const enough = desiredA >= minAmps;
    const since = input.now - this.lastChangeAt;

    switch (this.state) {
      case 'off':
        if (enough && since >= minOffMs) {
          this.state = 'charging';
          this.currentA = this.clamp(desiredA);
          this.lastChangeAt = input.now;
          return this.result(this.currentA, availableW);
        }
        return this.result(null, availableW);

      case 'charging':
        if (enough) {
          if (Math.abs(desiredA - this.currentA) >= deadbandA) {
            const step = Math.max(-rampA, Math.min(rampA, desiredA - this.currentA));
            this.currentA = this.clamp(this.currentA + step);
          }
          return this.result(this.currentA, availableW);
        }
        if (since >= minOnMs) {
          this.currentA = 0;
          this.lastChangeAt = input.now;
          this.state = 'paused';
          return this.result(0, availableW);
        }
        // Hold during minimum-on dwell.
        return this.result(this.currentA, availableW);

      case 'paused':
        if (enough && since >= minOffMs) {
          this.state = 'charging';
          this.currentA = this.clamp(desiredA);
          this.lastChangeAt = input.now;
          return this.result(this.currentA, availableW);
        }
        return this.result(0, availableW);

      default:
        return this.result(null, availableW);
    }
  }

  private result(target: number | null, availableW: number): SolarResult {
    return { target, state: this.state, availableW };
  }

}

'use strict';

/** Current below this is "no load": its voltage becomes the reference sag is measured against. */
export const NO_LOAD_MAX_A = 1;

/** Sag is only evaluated at a real charging current; below it the drop is lost in reading noise. */
export const LOADED_MIN_A = 6;

/**
 * A no-load reference older than this no longer says much on its own - grid
 * voltage drifts through the day (solar export across a whole street raises it,
 * evening load drops it). Sag against an older one is still reported, with its
 * age, but never counts toward the alarm.
 */
export const REFERENCE_MAX_AGE_MS = 30 * 60000;

/**
 * How far the rest of the household's draw from the supply may move after the
 * reference was taken before the reference stops describing "now". Sag against
 * it includes every other load's own drop on the shared supply, and the alarm
 * banner blames the charger's wiring - which is wrong when it was the house
 * that moved (confirmed on hardware: 11:00 brought a home battery charging at
 * 3.3kW plus the house, ~4.7kW, on top of a reference taken minutes earlier, and
 * a 6.7% "sag" latched the alarm). At the ~0.34Ω step impedance measured on the
 * same site, 1.5kW elsewhere (~6.5A) accounts for about 1 point of a 5% alarm.
 */
export const OTHER_LOAD_MAX_SHIFT_W = 1500;

/**
 * A loaded reading this far *above* the no-load reference is not a measurement
 * to trust. Voltage falls under load; it can sit a little above an older
 * reference (grid drift, another load switching off), but not by this much.
 * Confirmed on hardware: a Wallbox reported 254-281V at 23.7A against a ~240V
 * reference, while the car's own meter read 223V - its voltage (and the power
 * derived from it) went wrong while the car was cutting its own current for
 * voltage drop. Such a reading is dropped from sag, steps and the session stats.
 */
export const IMPLAUSIBLE_RISE_PCT = 3;

/** Sag at or above this share of the no-load voltage counts toward the alarm. */
export const SAG_ALARM_PCT = 5;

/** Consecutive loaded readings over SAG_ALARM_PCT before the alarm latches - one dip is noise. */
export const SAG_ALARM_READINGS = 3;

/** Smallest current change between consecutive readings worth an impedance estimate. */
export const STEP_MIN_A = 4;

/** Readings further apart than this aren't one step: other loads have had time to move too. */
export const STEP_MAX_GAP_MS = 30000;

/**
 * Fewer step estimates than this and the session summary gives no impedance.
 * One step can be a transient: confirmed on hardware, the car cutting its
 * current as it was unplugged read as 1.50Ω on a circuit whose deliberate steps
 * that day gave 0.33-0.52Ω - and as the session's only step, it became the
 * summary's "median".
 */
export const MIN_STEPS_FOR_MEDIAN = 3;

/** How many step estimates the session median is taken over. */
const STEP_HISTORY = 20;

export interface VoltageSample {
  /** Epoch ms the reading arrived. */
  at: number;
  voltage: number;
  current: number;
  /** Limit the charger last accepted when this reading arrived, or null if unknown. */
  limitA: number | null;
  /**
   * What the rest of the household was drawing from the supply around this
   * reading (W, grid import minus the charger, export negative), or null/absent
   * when unknown - e.g. no solar feed. Unknown never blocks the alarm.
   */
  otherLoadW?: number | null;
}

/** A current change between two consecutive readings, and what the voltage did across it. */
export interface VoltageStep {
  fromA: number;
  toA: number;
  fromV: number;
  toV: number;
  /**
   * -ΔV/ΔI: the impedance the charger sees looking back towards the supply
   * (its own circuit plus everything upstream). null when the voltage moved the
   * wrong way, i.e. some other load changed at the same moment and masked it.
   */
  ohms: number | null;
  /** Worst-case error from whole-volt readings: 1V / |ΔI|. */
  resolutionOhms: number;
  /** The charger's accepted limit at the later reading, or null if unknown. */
  limitA: number | null;
  /**
   * A drop the charger's limit didn't ask for: the limit held and still allowed
   * the earlier draw, so the car cut its own current.
   */
  uncommanded: boolean;
}

export interface SagReading {
  /** Last no-load voltage and how old it is, or null if none seen yet. */
  referenceV: number | null;
  referenceAgeMs: number | null;
  /** The reference is recent enough for the alarm to trust (see REFERENCE_MAX_AGE_MS). */
  referenceFresh: boolean;
  /** How far the rest of the household's draw moved since the reference (W), or null if unknown. */
  otherLoadShiftW: number | null;
  /** Fresh, and the rest of the household hasn't moved more than OTHER_LOAD_MAX_SHIFT_W: counts toward the alarm. */
  referenceTrusted: boolean;
  /** Drop from the reference at this reading, or null when not loaded or no reference. */
  sagV: number | null;
  sagPct: number | null;
  /** This reading set a new session high for sag (by at least 1V). */
  newMax: boolean;
  /** A qualifying current step since the previous reading, or null. */
  step: VoltageStep | null;
  /** The alarm latched on this reading. */
  alarmRaised: boolean;
  /**
   * Loaded, yet more than IMPLAUSIBLE_RISE_PCT above the reference: ignored for
   * sag, steps and the session stats (see IMPLAUSIBLE_RISE_PCT).
   */
  implausible: boolean;
}

/** What the alarm latched on - the reading that tipped it over. */
export interface SagAlarm {
  referenceV: number;
  voltage: number;
  current: number;
  sagPct: number;
}

export interface VoltageSessionSummary {
  loadedReadings: number;
  /** Lowest plausible loaded voltage and its current, or null when every loaded reading was implausible. */
  minV: number | null;
  minVAtA: number | null;
  maxSagV: number | null;
  maxSagPct: number | null;
  maxSagReferenceV: number | null;
  /** Whether the reading behind maxSag had a trusted reference (see SagReading.referenceTrusted). */
  maxSagTrusted: boolean | null;
  /** Median of the step estimates, or null with fewer than MIN_STEPS_FOR_MEDIAN of them. */
  medianOhms: number | null;
  stepEstimates: number;
  uncommandedDrops: number;
  /** Loaded readings ignored as implausible (see IMPLAUSIBLE_RISE_PCT). */
  implausibleReadings: number;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Voltage sag diagnostics at the charger. Pure and clock-free (every sample
 * carries its own time), so it is tested without the controller.
 *
 * Two independent measurements, because each misses what the other catches:
 * - **Sag against a no-load reference** is what an EV itself watches (a Tesla
 *   records the voltage before it draws and cuts to 75% when the drop under
 *   load looks wrong). It includes everything: the charger circuit, the house
 *   wiring, the network, and any other load that came on meanwhile.
 * - **Step impedance** (-ΔV/ΔI across a sudden current change 10s apart)
 *   mostly isolates the path the charger's own current flows through, since
 *   little else has time to change. Readings are whole volts, so each estimate
 *   carries its own resolution and the summary takes a median.
 */
export class VoltageMonitor {

  private reference: { voltage: number; at: number; otherLoadW: number | null } | null = null;

  private prev: VoltageSample | null = null;

  private overCount = 0;

  private alarmState: SagAlarm | null = null;

  private loadedReadings = 0;

  private minV: { voltage: number; current: number } | null = null;

  private maxSag: { sagV: number; sagPct: number; referenceV: number; trusted: boolean } | null = null;

  private stepOhms: number[] = [];

  private uncommandedDrops = 0;

  private implausibleReadings = 0;

  /** The latched alarm, or null. Survives endSession(); only clearAlarm() drops it. */
  get alarm(): SagAlarm | null {
    return this.alarmState;
  }

  add(s: VoltageSample): SagReading {
    const otherLoadW = s.otherLoadW ?? null;
    if (s.current < NO_LOAD_MAX_A) this.reference = { voltage: s.voltage, at: s.at, otherLoadW };
    const ref = this.reference;
    const implausible = ref != null && s.current >= LOADED_MIN_A
      && s.voltage > ref.voltage * (1 + IMPLAUSIBLE_RISE_PCT / 100);

    // An implausible reading is neither end of a step: the next one starts fresh.
    const step = implausible ? null : this.stepFrom(this.prev, s);
    this.prev = implausible ? null : s;
    if (step?.ohms != null) {
      this.stepOhms.push(step.ohms);
      if (this.stepOhms.length > STEP_HISTORY) this.stepOhms.shift();
    }
    if (step?.uncommanded) this.uncommandedDrops += 1;

    const referenceAgeMs = ref ? s.at - ref.at : null;
    const referenceFresh = referenceAgeMs != null && referenceAgeMs <= REFERENCE_MAX_AGE_MS;
    const otherLoadShiftW = ref?.otherLoadW != null && otherLoadW != null ? otherLoadW - ref.otherLoadW : null;
    // Either direction: a drop elsewhere raises the voltage and hides sag just as
    // a rise inflates it - the reference no longer describes the baseline.
    const referenceTrusted = referenceFresh
      && (otherLoadShiftW == null || Math.abs(otherLoadShiftW) <= OTHER_LOAD_MAX_SHIFT_W);

    const out: SagReading = {
      referenceV: ref?.voltage ?? null,
      referenceAgeMs,
      referenceFresh,
      otherLoadShiftW,
      referenceTrusted,
      sagV: null,
      sagPct: null,
      newMax: false,
      step,
      alarmRaised: false,
      implausible,
    };

    if (implausible) {
      // No information either way, so the alarm's run of readings is left as is.
      this.implausibleReadings += 1;
      return out;
    }
    if (s.current < LOADED_MIN_A) {
      this.overCount = 0;
      return out;
    }
    this.loadedReadings += 1;
    if (!this.minV || s.voltage < this.minV.voltage) this.minV = { voltage: s.voltage, current: s.current };
    if (!ref) {
      this.overCount = 0;
      return out;
    }

    const sagV = ref.voltage - s.voltage;
    const sagPct = (sagV / ref.voltage) * 100;
    out.sagV = sagV;
    out.sagPct = sagPct;
    if (sagV > 0 && (!this.maxSag || sagV >= this.maxSag.sagV + 1)) {
      this.maxSag = {
        sagV, sagPct, referenceV: ref.voltage, trusted: referenceTrusted,
      };
      out.newMax = true;
    }

    this.overCount = referenceTrusted && sagPct >= SAG_ALARM_PCT ? this.overCount + 1 : 0;
    if (!this.alarmState && this.overCount >= SAG_ALARM_READINGS) {
      this.alarmState = {
        referenceV: ref.voltage, voltage: s.voltage, current: s.current, sagPct,
      };
      out.alarmRaised = true;
    }
    return out;
  }

  private stepFrom(prev: VoltageSample | null, s: VoltageSample): VoltageStep | null {
    if (!prev || s.at - prev.at > STEP_MAX_GAP_MS) return null;
    const dI = s.current - prev.current;
    if (Math.abs(dI) < STEP_MIN_A) return null;
    const ohms = (prev.voltage - s.voltage) / dI;
    const uncommanded = dI < 0 && prev.limitA != null && s.limitA === prev.limitA
      && s.limitA >= prev.current - 1;
    return {
      fromA: prev.current,
      toA: s.current,
      fromV: prev.voltage,
      toV: s.voltage,
      ohms: ohms < 0 ? null : ohms,
      resolutionOhms: 1 / Math.abs(dI),
      limitA: s.limitA,
      uncommanded,
    };
  }

  /**
   * Close out the session's statistics and return them, or null if nothing was
   * measured under load. A session whose loaded readings were all implausible
   * still gets one: that count is the finding. The no-load reference and any latched alarm are kept -
   * the reference is still just a voltage, and the alarm is a claim the user
   * hasn't necessarily seen yet.
   */
  endSession(): VoltageSessionSummary | null {
    const summary = this.minV || this.implausibleReadings > 0 ? {
      loadedReadings: this.loadedReadings,
      minV: this.minV?.voltage ?? null,
      minVAtA: this.minV?.current ?? null,
      maxSagV: this.maxSag?.sagV ?? null,
      maxSagPct: this.maxSag?.sagPct ?? null,
      maxSagReferenceV: this.maxSag?.referenceV ?? null,
      maxSagTrusted: this.maxSag?.trusted ?? null,
      medianOhms: this.stepOhms.length >= MIN_STEPS_FOR_MEDIAN ? median(this.stepOhms) : null,
      stepEstimates: this.stepOhms.length,
      uncommandedDrops: this.uncommandedDrops,
      implausibleReadings: this.implausibleReadings,
    } : null;
    this.prev = null;
    this.overCount = 0;
    this.loadedReadings = 0;
    this.minV = null;
    this.maxSag = null;
    this.stepOhms = [];
    this.uncommandedDrops = 0;
    this.implausibleReadings = 0;
    return summary;
  }

  clearAlarm(): void {
    this.alarmState = null;
    this.overCount = 0;
  }

}

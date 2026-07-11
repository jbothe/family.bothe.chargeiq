'use strict';

/**
 * A weekly charging window. `days` uses JS day numbers (0 = Sunday .. 6 = Saturday).
 * `start`/`end` are "HH:MM" local time. If `end` <= `start` the window runs
 * overnight into the following day. `currentA` optionally overrides the charge
 * current while this window is active - here it acts as a floor, not a fixed
 * target, when `boostToCap` is set. `enabled` (default true) lets a window be
 * kept configured but temporarily inactive, instead of deleting it. `boostToCap`
 * lets the controller raise the current above `currentA` up to the shared-circuit
 * cap when there's spare capacity (see ChargeController.scheduledAmps).
 */
export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
  currentA?: number;
  enabled?: boolean;
  boostToCap?: boolean;
}

const MIN_PER_DAY = 1440;
const MIN_PER_WEEK = 7 * MIN_PER_DAY;

function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${s}"`);
  return h * 60 + min;
}

const DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Wall-clock day/hour/minute in `timezone` (an IANA name, e.g. "Europe/Amsterdam").
 * Falls back to the JS Date's own local getters when no timezone is given -
 * that's what makes this pure/testable without a Homey runtime. Homey apps run
 * with the underlying OS clock in UTC regardless of the user's configured
 * timezone, so schedule windows must be evaluated against the Homey-configured
 * timezone (see `this.homey.clock.getTimezone()`), not `Date`'s local getters.
 */
function minuteOfWeek(d: Date, timezone?: string): number {
  if (!timezone) return d.getDay() * MIN_PER_DAY + d.getHours() * 60 + d.getMinutes();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = DAY_INDEX[get('weekday')] ?? 0;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return day * MIN_PER_DAY + hour * 60 + minute;
}

interface Interval { start: number; end: number } // minutes-of-week; end may exceed MIN_PER_WEEK (wrap)

/** Expand one window to weekly-minute intervals (end may wrap past week end). No currentA attached. */
function expandWindow(w: ScheduleWindow): Interval[] {
  const out: Interval[] = [];
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  const overnight = e <= s;
  for (const day of w.days) {
    const start = day * MIN_PER_DAY + s;
    const end = day * MIN_PER_DAY + (overnight ? e + MIN_PER_DAY : e);
    out.push({ start, end });
    if (end > MIN_PER_WEEK) {
      out.push({ start: start - MIN_PER_WEEK, end: end - MIN_PER_WEEK });
    }
  }
  return out;
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  // Compare across a +/- one week shift so wrapped intervals still line up.
  for (const shift of [-MIN_PER_WEEK, 0, MIN_PER_WEEK]) {
    if (a.start < b.end + shift && b.start + shift < a.end) return true;
  }
  return false;
}

/** True if two windows share any active minute, ignoring `enabled`. */
export function windowsOverlap(a: ScheduleWindow, b: ScheduleWindow): boolean {
  const as = expandWindow(a);
  const bs = expandWindow(b);
  return as.some((ai) => bs.some((bi) => intervalsOverlap(ai, bi)));
}

/**
 * Pairs of window indexes (into `windows`) whose *enabled* windows overlap.
 * Disabled windows are ignored — they don't affect anything while disabled.
 */
export function findScheduleConflicts(windows: ScheduleWindow[]): Array<{ a: number; b: number }> {
  const enabledIdx = windows.map((w, i) => i).filter((i) => windows[i].enabled !== false);
  const conflicts: Array<{ a: number; b: number }> = [];
  for (let x = 0; x < enabledIdx.length; x++) {
    for (let y = x + 1; y < enabledIdx.length; y++) {
      const i = enabledIdx[x];
      const j = enabledIdx[y];
      if (windowsOverlap(windows[i], windows[j])) conflicts.push({ a: i, b: j });
    }
  }
  return conflicts;
}

/**
 * Pure evaluation of a weekly schedule. Handles overnight windows and week
 * wrap-around. All queries take an explicit `now` so the logic is unit-testable.
 */
export class Scheduler {

  private windows: ScheduleWindow[];

  /** IANA timezone (e.g. "Europe/Amsterdam") the schedule's HH:MM times are in. */
  private timezone?: string;

  constructor(windows: ScheduleWindow[] = []) {
    this.windows = windows;
  }

  setWindows(windows: ScheduleWindow[]): void {
    this.windows = windows;
  }

  setTimezone(timezone: string | undefined): void {
    this.timezone = timezone;
  }

  getWindows(): ScheduleWindow[] {
    return this.windows;
  }

  hasWindows(): boolean {
    return this.windows.length > 0;
  }

  /** Expand enabled windows to weekly-minute intervals (end may wrap past week end). */
  private intervals(): Array<Interval & { currentA?: number; boostToCap?: boolean }> {
    const out: Array<Interval & { currentA?: number; boostToCap?: boolean }> = [];
    for (const w of this.windows) {
      if (w.enabled === false) continue;
      for (const iv of expandWindow(w)) out.push({ ...iv, currentA: w.currentA, boostToCap: w.boostToCap });
    }
    return out;
  }

  private static contains(iv: Interval, mow: number): boolean {
    // Check the minute and its +week alias to handle wrap.
    return (mow >= iv.start && mow < iv.end) || (mow + MIN_PER_WEEK >= iv.start && mow + MIN_PER_WEEK < iv.end);
  }

  /** Is a charging window active at `now`? */
  isActive(now: Date): boolean {
    const mow = minuteOfWeek(now, this.timezone);
    return this.intervals().some((iv) => Scheduler.contains(iv, mow));
  }

  /** Charge current for the active window at `now`, if specified. */
  activeCurrent(now: Date): number | undefined {
    const mow = minuteOfWeek(now, this.timezone);
    const hit = this.intervals().find((iv) => Scheduler.contains(iv, mow));
    return hit?.currentA;
  }

  /** Whether the active window at `now` allows boosting above its current (see `ScheduleWindow.boostToCap`). */
  activeBoostToCap(now: Date): boolean {
    const mow = minuteOfWeek(now, this.timezone);
    const hit = this.intervals().find((iv) => Scheduler.contains(iv, mow));
    return hit?.boostToCap === true;
  }

  /**
   * The next Date at which the active/inactive state flips. Returns undefined
   * when there are no windows (nothing will ever change). Used to expire a
   * manual override "until the next schedule boundary".
   */
  nextBoundary(now: Date): Date | undefined {
    if (!this.hasWindows()) return undefined;
    const mow = minuteOfWeek(now, this.timezone);
    const boundaries = new Set<number>();
    for (const iv of this.intervals()) {
      boundaries.add(((iv.start % MIN_PER_WEEK) + MIN_PER_WEEK) % MIN_PER_WEEK);
      boundaries.add(((iv.end % MIN_PER_WEEK) + MIN_PER_WEEK) % MIN_PER_WEEK);
    }
    let best = Infinity;
    for (const b of boundaries) {
      const delta = b > mow ? b - mow : b + MIN_PER_WEEK - mow;
      if (delta > 0 && delta < best) best = delta;
    }
    if (!isFinite(best)) return undefined;
    return this.dateFromDelta(now, best);
  }

  /** The next Date a window starts (strictly after now), or undefined if none. */
  nextStart(now: Date): Date | undefined {
    if (!this.hasWindows()) return undefined;
    const mow = minuteOfWeek(now, this.timezone);
    let best = Infinity;
    for (const iv of this.intervals()) {
      const s = ((iv.start % MIN_PER_WEEK) + MIN_PER_WEEK) % MIN_PER_WEEK;
      const delta = s > mow ? s - mow : s + MIN_PER_WEEK - mow;
      if (delta > 0 && delta < best) best = delta;
    }
    return isFinite(best) ? this.dateFromDelta(now, best) : undefined;
  }

  /** If a window is active at `now`, the Date it ends; otherwise undefined. */
  currentEnd(now: Date): Date | undefined {
    const mow = minuteOfWeek(now, this.timezone);
    let best = Infinity;
    for (const iv of this.intervals()) {
      for (const m of [mow, mow + MIN_PER_WEEK]) {
        if (m >= iv.start && m < iv.end) {
          const delta = iv.end - m;
          if (delta > 0 && delta < best) best = delta;
        }
      }
    }
    return isFinite(best) ? this.dateFromDelta(now, best) : undefined;
  }

  private dateFromDelta(now: Date, deltaMinutes: number): Date {
    const secondsIntoMinute = now.getSeconds() + now.getMilliseconds() / 1000;
    const ms = (deltaMinutes * 60 - secondsIntoMinute) * 1000;
    return new Date(now.getTime() + ms);
  }

}

'use strict';

/**
 * A weekly charging window. `days` uses JS day numbers (0 = Sunday .. 6 = Saturday).
 * `start`/`end` are "HH:MM" local time. If `end` <= `start` the window runs
 * overnight into the following day. `currentA` optionally overrides the charge
 * current while this window is active.
 */
export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
  currentA?: number;
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

function minuteOfWeek(d: Date): number {
  return d.getDay() * MIN_PER_DAY + d.getHours() * 60 + d.getMinutes();
}

interface Interval { start: number; end: number } // minutes-of-week; end may exceed MIN_PER_WEEK (wrap)

/**
 * Pure evaluation of a weekly schedule. Handles overnight windows and week
 * wrap-around. All queries take an explicit `now` so the logic is unit-testable.
 */
export class Scheduler {

  private windows: ScheduleWindow[];

  constructor(windows: ScheduleWindow[] = []) {
    this.windows = windows;
  }

  setWindows(windows: ScheduleWindow[]): void {
    this.windows = windows;
  }

  getWindows(): ScheduleWindow[] {
    return this.windows;
  }

  hasWindows(): boolean {
    return this.windows.length > 0;
  }

  /** Expand configured windows to weekly-minute intervals (end may wrap past week end). */
  private intervals(): Array<Interval & { currentA?: number }> {
    const out: Array<Interval & { currentA?: number }> = [];
    for (const w of this.windows) {
      const s = parseHHMM(w.start);
      let e = parseHHMM(w.end);
      const overnight = e <= s;
      for (const day of w.days) {
        const start = day * MIN_PER_DAY + s;
        let end = day * MIN_PER_DAY + (overnight ? e + MIN_PER_DAY : e);
        // Normalise start into [0, week); keep end relative so containment can wrap.
        out.push({ start, end, currentA: w.currentA });
        if (end > MIN_PER_WEEK) {
          // also represented by its wrapped counterpart for boundary detection
          out.push({ start: start - MIN_PER_WEEK, end: end - MIN_PER_WEEK, currentA: w.currentA });
        }
      }
    }
    return out;
  }

  private static contains(iv: Interval, mow: number): boolean {
    // Check the minute and its +week alias to handle wrap.
    return (mow >= iv.start && mow < iv.end) || (mow + MIN_PER_WEEK >= iv.start && mow + MIN_PER_WEEK < iv.end);
  }

  /** Is a charging window active at `now`? */
  isActive(now: Date): boolean {
    const mow = minuteOfWeek(now);
    return this.intervals().some((iv) => Scheduler.contains(iv, mow));
  }

  /** Charge current for the active window at `now`, if specified. */
  activeCurrent(now: Date): number | undefined {
    const mow = minuteOfWeek(now);
    const hit = this.intervals().find((iv) => Scheduler.contains(iv, mow));
    return hit?.currentA;
  }

  /**
   * The next Date at which the active/inactive state flips. Returns undefined
   * when there are no windows (nothing will ever change). Used to expire a
   * manual override "until the next schedule boundary".
   */
  nextBoundary(now: Date): Date | undefined {
    if (!this.hasWindows()) return undefined;
    const mow = minuteOfWeek(now);
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
    const secondsIntoMinute = now.getSeconds() + now.getMilliseconds() / 1000;
    const ms = (best * 60 - secondsIntoMinute) * 1000;
    return new Date(now.getTime() + ms);
  }

}

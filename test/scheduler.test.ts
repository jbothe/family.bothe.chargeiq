'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { Scheduler, findScheduleConflicts, windowsOverlap } from '../lib/control/Scheduler';

/** Build a local Date for weekday (0=Sun) + HH:MM. 2024-01-07 is a Sunday. */
function at(day: number, hh: number, mm: number): Date {
  const d = new Date(2024, 0, 7);
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

test('daytime window Mon-Fri 09:00-17:00', () => {
  const s = new Scheduler([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', currentA: 20 }]);
  assert.equal(s.isActive(at(1, 10, 0)), true);
  assert.equal(s.isActive(at(1, 8, 59)), false);
  assert.equal(s.isActive(at(1, 17, 0)), false, 'end exclusive');
  assert.equal(s.isActive(at(0, 10, 0)), false, 'sunday not in days');
  assert.equal(s.activeCurrent(at(1, 10, 0)), 20);
});

test('nextBoundary returns the next state flip', () => {
  const s = new Scheduler([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]);
  const nb = s.nextBoundary(at(1, 10, 0));
  assert.ok(nb && nb.getDay() === 1 && nb.getHours() === 17);
  const nb2 = s.nextBoundary(at(1, 8, 0));
  assert.ok(nb2 && nb2.getHours() === 9);
});

test('overnight window 22:00-06:00 wraps midnight', () => {
  const s = new Scheduler([{ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' }]);
  assert.equal(s.isActive(at(2, 23, 0)), true);
  assert.equal(s.isActive(at(3, 2, 0)), true, 'after midnight');
  assert.equal(s.isActive(at(2, 12, 0)), false);
  assert.equal(s.isActive(at(3, 6, 0)), false, 'end exclusive');
});

test('schedule windows are evaluated in the Homey-configured timezone, not the OS clock (UTC)', () => {
  // 2024-07-08 11:22 UTC == Mon 21:22 in Sydney (AEST, UTC+10, no DST in July).
  // A window meant for 11:00-12:30 local must not be "active" at 9pm local
  // just because the underlying process clock reports 11:22 (UTC).
  const now = new Date(Date.UTC(2024, 6, 8, 11, 22));
  const s = new Scheduler([{ days: [1], start: '11:00', end: '12:30' }]);

  s.setTimezone('Australia/Sydney');
  assert.equal(s.isActive(now), false, 'it is 21:22 local - well outside the 11:00-12:30 window');

  // Interpreting the same instant as UTC (what the OS clock on a Homey Pro
  // actually reports, regardless of the configured Homey timezone) reads as
  // 11:22, which does fall inside the window - this is the bug the fix guards
  // against, not just a hypothetical.
  s.setTimezone('UTC');
  assert.equal(s.isActive(now), true, 'sanity check: this is the bug the timezone fix prevents');
});

test('no windows', () => {
  const s = new Scheduler([]);
  assert.equal(s.isActive(at(1, 10, 0)), false);
  assert.equal(s.nextBoundary(at(1, 10, 0)), undefined);
});

test('disabled window is never active', () => {
  const s = new Scheduler([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', enabled: false }]);
  assert.equal(s.isActive(at(1, 10, 0)), false);
  assert.equal(s.nextBoundary(at(1, 10, 0)), undefined);
});

test('re-enabling a window makes it active again', () => {
  const s = new Scheduler([{ days: [1], start: '09:00', end: '17:00', enabled: true }]);
  assert.equal(s.isActive(at(1, 10, 0)), true);
});

test('windowsOverlap: same day overlapping times', () => {
  const a = { days: [1], start: '09:00', end: '17:00' };
  const b = { days: [1], start: '16:00', end: '20:00' };
  assert.equal(windowsOverlap(a, b), true);
});

test('windowsOverlap: same day adjacent (end exclusive) does not overlap', () => {
  const a = { days: [1], start: '09:00', end: '17:00' };
  const b = { days: [1], start: '17:00', end: '20:00' };
  assert.equal(windowsOverlap(a, b), false);
});

test('windowsOverlap: different days does not overlap', () => {
  const a = { days: [1], start: '09:00', end: '17:00' };
  const b = { days: [2], start: '09:00', end: '17:00' };
  assert.equal(windowsOverlap(a, b), false);
});

test('windowsOverlap: overnight window overlaps next day morning window', () => {
  const overnight = { days: [1], start: '22:00', end: '06:00' }; // Mon 22:00 -> Tue 06:00
  const morning = { days: [2], start: '05:00', end: '09:00' }; // Tue 05:00-09:00
  assert.equal(windowsOverlap(overnight, morning), true);
});

test('windowsOverlap: overnight window does not overlap unrelated day', () => {
  const overnight = { days: [1], start: '22:00', end: '06:00' };
  const other = { days: [3], start: '05:00', end: '09:00' };
  assert.equal(windowsOverlap(overnight, other), false);
});

test('findScheduleConflicts: ignores disabled windows', () => {
  const windows = [
    { days: [1], start: '09:00', end: '17:00' },
    { days: [1], start: '10:00', end: '11:00', enabled: false },
  ];
  assert.deepEqual(findScheduleConflicts(windows), []);
});

test('findScheduleConflicts: reports overlapping enabled windows by index', () => {
  const windows = [
    { days: [1], start: '09:00', end: '17:00' },
    { days: [2], start: '09:00', end: '17:00' },
    { days: [1], start: '10:00', end: '11:00' },
  ];
  assert.deepEqual(findScheduleConflicts(windows), [{ a: 0, b: 2 }]);
});

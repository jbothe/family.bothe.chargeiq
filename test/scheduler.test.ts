'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { Scheduler } from '../lib/control/Scheduler';

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

test('no windows', () => {
  const s = new Scheduler([]);
  assert.equal(s.isActive(at(1, 10, 0)), false);
  assert.equal(s.nextBoundary(at(1, 10, 0)), undefined);
});

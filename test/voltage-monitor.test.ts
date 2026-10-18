'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  VoltageMonitor, VoltageSample, median, IMPLAUSIBLE_RISE_PCT, MIN_STEPS_FOR_MEDIAN, OTHER_LOAD_MAX_SHIFT_W,
  REFERENCE_MAX_AGE_MS, SAG_ALARM_READINGS, STEP_MAX_GAP_MS,
} from '../lib/control/VoltageMonitor';

const S = (at: number, voltage: number, current: number, limitA: number | null = 32): VoltageSample => ({
  at, voltage, current, limitA,
});

test('a no-load reading becomes the reference; a loaded one reports sag against it', () => {
  const m = new VoltageMonitor();
  const idle = m.add(S(0, 240, 0));
  assert.equal(idle.referenceV, 240);
  assert.equal(idle.sagV, null, 'no sag at no load');

  const r = m.add(S(10000, 222, 31.6));
  assert.equal(r.sagV, 18);
  assert.ok(Math.abs(r.sagPct! - 7.5) < 1e-9);
  assert.equal(r.referenceAgeMs, 10000);
  assert.ok(r.referenceFresh);
});

test('no sag without a reference, and none below charging current', () => {
  const m = new VoltageMonitor();
  assert.equal(m.add(S(0, 222, 31.6)).sagV, null, 'never seen the no-load voltage');
  m.add(S(10000, 240, 0));
  assert.equal(m.add(S(20000, 238, 3)).sagV, null, 'a trickle is within reading noise');
});

test('sag against an old reference is still reported, but flagged stale', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  const r = m.add(S(REFERENCE_MAX_AGE_MS + 1, 222, 31.6));
  assert.equal(r.sagV, 18);
  assert.equal(r.referenceFresh, false);
});

/** A reference with the rest of the house at `refW`, then readings 16V (6.7%) down with it at `nowW`. */
function sagWithHouseAt(refW: number | null, nowW: number | null, readings = SAG_ALARM_READINGS + 2) {
  const m = new VoltageMonitor();
  m.add({ ...S(0, 239, 0), otherLoadW: refW });
  let last = m.add({ ...S(10000, 223, 23), otherLoadW: nowW });
  for (let i = 1; i < readings; i++) last = m.add({ ...S(10000 + i * 5000, 223, 23), otherLoadW: nowW });
  return { m, last };
}

test('sag while the rest of the house moved a lot since the reference is reported, but never alarms', () => {
  // Hardware, 11:00: reference with the house at ~0, then a home battery and the house came on.
  const { m, last } = sagWithHouseAt(0, 4700);
  assert.equal(last.sagV, 16, 'still measured and reported');
  assert.equal(last.otherLoadShiftW, 4700);
  assert.equal(last.referenceFresh, true, 'not a question of age');
  assert.equal(last.referenceTrusted, false);
  assert.equal(m.alarm, null);
  assert.equal(m.endSession()!.maxSagTrusted, false, 'the summary says its max sag is not to be trusted');
});

test('a big drop elsewhere distrusts the reference too - it hides sag as surely as a rise inflates it', () => {
  const { last } = sagWithHouseAt(3000, 3000 - OTHER_LOAD_MAX_SHIFT_W - 1);
  assert.equal(last.referenceTrusted, false);
});

test('a shift within OTHER_LOAD_MAX_SHIFT_W still alarms', () => {
  const { m, last } = sagWithHouseAt(0, OTHER_LOAD_MAX_SHIFT_W);
  assert.equal(last.referenceTrusted, true);
  assert.ok(m.alarm, 'the charger circuit is the likely cause, so the banner still fires');
  assert.equal(m.endSession()!.maxSagTrusted, true);
});

test('an unknown household draw, on either side, never blocks the alarm', () => {
  assert.ok(sagWithHouseAt(null, 4700).m.alarm, 'no figure when the reference was taken');
  const { m, last } = sagWithHouseAt(0, null);
  assert.equal(last.otherLoadShiftW, null);
  assert.ok(m.alarm, 'no figure now - e.g. the solar feed went stale');
});

test('the alarm latches only after SAG_ALARM_READINGS consecutive fresh readings over 5%', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  let t = 0;
  for (let i = 0; i < SAG_ALARM_READINGS - 1; i++) assert.equal(m.add(S(t += 10000, 226, 32)).alarmRaised, false);
  m.add(S(t += 10000, 232, 32)); // 3.3% - breaks the run
  for (let i = 0; i < SAG_ALARM_READINGS - 1; i++) m.add(S(t += 10000, 226, 32));
  assert.equal(m.alarm, null, 'an interrupted run does not count');

  const r = m.add(S(t += 10000, 226, 32));
  assert.equal(r.alarmRaised, true);
  assert.deepEqual(m.alarm, {
    referenceV: 240, voltage: 226, current: 32, sagPct: (14 / 240) * 100,
  });
  assert.equal(m.add(S(t += 10000, 226, 32)).alarmRaised, false, 'raised once, not on every reading after');
});

test('a stale reference never raises the alarm', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  let t = REFERENCE_MAX_AGE_MS;
  for (let i = 0; i < SAG_ALARM_READINGS + 2; i++) m.add(S(t += 10000, 220, 32));
  assert.equal(m.alarm, null);
});

test('the hardware incident: 31.6A -> 23.7A with the limit held reads as an uncommanded drop', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 222, 31.6, 32));
  const { step } = m.add(S(10000, 223, 23.7, 32));
  assert.ok(step);
  assert.ok(Math.abs(step.ohms! - 1 / 7.9) < 1e-9, '1V back for 7.9A less');
  assert.ok(Math.abs(step.resolutionOhms - 1 / 7.9) < 1e-9);
  assert.equal(step.uncommanded, true);
});

test('a drop that follows a lower limit is commanded, and so is one with the limit unknown', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 222, 31.6, 32));
  assert.equal(m.add(S(10000, 226, 16, 16)).step?.uncommanded, false, 'limit moved');

  const n = new VoltageMonitor();
  n.add(S(0, 222, 31.6, null));
  assert.equal(n.add(S(10000, 226, 16, null)).step?.uncommanded, false, 'nothing to judge by');

  const o = new VoltageMonitor();
  o.add(S(0, 222, 31.6, 20));
  assert.equal(o.add(S(10000, 226, 20, 20)).step?.uncommanded, false,
    'the limit never allowed 31.6A - the drop is the charger catching up to it');
});

test('a ramp-up is never uncommanded', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0, 32));
  const { step } = m.add(S(10000, 228, 32, 32));
  assert.equal(step?.uncommanded, false);
  assert.equal(step?.ohms, 12 / 32);
});

test('no step across a small change, a long gap, and an inconclusive direction reports null ohms', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 222, 31.6));
  assert.equal(m.add(S(10000, 223, 29)).step, null, 'under STEP_MIN_A');
  assert.equal(m.add(S(10000 + STEP_MAX_GAP_MS + 1, 230, 16)).step, null, 'too far apart');
  const { step } = m.add(S(20000 + STEP_MAX_GAP_MS, 232, 32));
  assert.ok(step, 'still a step');
  assert.equal(step.ohms, null, 'voltage rose as the current rose - another load moved');
});

test('newMax fires on the first sag and then only on a rise of at least 1V', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  assert.equal(m.add(S(10000, 225, 32)).newMax, true);
  assert.equal(m.add(S(20000, 225, 32)).newMax, false);
  assert.equal(m.add(S(30000, 224.5, 32)).newMax, false);
  assert.equal(m.add(S(40000, 224, 32)).newMax, true);
});

test('endSession summarises and resets the stats, but keeps the reference and the alarm', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0, 32));
  m.add(S(10000, 226, 32, 32)); // step 14V/32A
  m.add(S(20000, 225, 32, 32));
  m.add(S(30000, 224, 32, 32));
  m.add(S(40000, 227, 24, 32)); // uncommanded, 3V/8A
  assert.ok(m.alarm);

  const s = m.endSession();
  assert.ok(s);
  assert.equal(s.loadedReadings, 4);
  assert.equal(s.minV, 224);
  assert.equal(s.minVAtA, 32);
  assert.equal(s.maxSagV, 16);
  assert.equal(s.maxSagReferenceV, 240);
  assert.equal(s.stepEstimates, 2);
  assert.equal(s.medianOhms, null, 'two steps are too few for a median (MIN_STEPS_FOR_MEDIAN)');
  assert.equal(s.uncommandedDrops, 1);

  assert.equal(m.endSession(), null, 'nothing measured since');
  assert.ok(m.alarm, 'the alarm outlives the session');
  const after = m.add(S(50000, 222, 32)); // 8A up from the last reading, 10s later
  assert.equal(after.referenceV, 240, 'and so does the reference');
  assert.equal(after.step, null, 'but a step never spans two sessions');

  m.clearAlarm();
  assert.equal(m.alarm, null);
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

// Hardware, 2026-10-18: a Wallbox reported 254-281V at 23.7A against a ~240V
// no-load reference while the car's own meter read 223V.
test('a loaded reading well above the no-load reference is ignored as implausible', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  const r = m.add(S(5000, 278, 23.7));
  assert.equal(r.implausible, true);
  assert.equal(r.sagV, null, 'no sag figure from a reading that cannot be trusted');
  assert.equal(r.step, null);
  const s = m.add(S(10000, 222, 31.6));
  assert.equal(s.implausible, false);
  assert.equal(s.step, null, 'a step never starts from an implausible reading');
  assert.equal(s.sagV, 18);
  const summary = m.endSession()!;
  assert.equal(summary.implausibleReadings, 1);
  assert.equal(summary.loadedReadings, 1, 'only the plausible reading counts');
  assert.equal(summary.minV, 222);
});

test('a loaded reading a little above the reference is still plausible', () => {
  // Grid drift, or another load switching off, can lift it slightly.
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  const edge = 240 * (1 + IMPLAUSIBLE_RISE_PCT / 100);
  const r = m.add(S(5000, Math.floor(edge), 31.6));
  assert.equal(r.implausible, false);
  assert.ok(r.sagV! < 0, 'reported as it is: a small negative sag');
  assert.equal(m.add(S(10000, Math.ceil(edge) + 1, 31.6)).implausible, true);
});

test('without a reference, or below charging current, nothing is judged implausible', () => {
  const m = new VoltageMonitor();
  assert.equal(m.add(S(0, 278, 23.7)).implausible, false, 'nothing to compare against');
  m.add(S(5000, 240, 0));
  assert.equal(m.add(S(10000, 260, 3)).implausible, false, 'not loaded');
});

test('an implausible reading leaves the alarm run where it was', () => {
  const m = new VoltageMonitor();
  m.add(S(0, 240, 0));
  for (let i = 1; i < SAG_ALARM_READINGS; i++) m.add(S(i * 5000, 222, 31.6));
  m.add(S(SAG_ALARM_READINGS * 5000, 280, 23.7));
  const r = m.add(S((SAG_ALARM_READINGS + 1) * 5000, 222, 31.6));
  assert.equal(r.alarmRaised, true, 'no information either way: it neither breaks nor extends the run');
});

test('the session median needs MIN_STEPS_FOR_MEDIAN steps', () => {
  // Hardware, 2026-10-18: the car cutting its current as it was unplugged read
  // as 1.50Ω, and as the session's only step it became the summary's "median".
  const m = new VoltageMonitor();
  m.add(S(0, 236, 6));
  m.add(S(5000, 232, 15.6)); // 4V/9.6A
  m.add(S(10000, 227, 25.6)); // 5V/10A
  assert.equal(m.endSession()!.medianOhms, null, `${MIN_STEPS_FOR_MEDIAN - 1} steps`);
  m.add(S(20000, 236, 6));
  m.add(S(25000, 232, 15.6));
  m.add(S(30000, 227, 25.6));
  m.add(S(35000, 225, 31.6)); // 2V/6A
  const s = m.endSession()!;
  assert.equal(s.stepEstimates, 3);
  assert.equal(s.medianOhms, median([4 / 9.6, 5 / 10, 2 / 6]));
});

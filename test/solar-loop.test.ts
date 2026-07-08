'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { SolarLoop, SolarLoopConfig } from '../lib/control/SolarLoop';

const T = 100000; // realistic time base (> dwell windows)
const cfg = (): SolarLoopConfig => ({
  voltage: 230, phases: 1, minAmps: 6, maxAmps: 31,
  deadbandA: 1, rampA: 3, minOnMs: 1000, minOffMs: 1000, marginW: 0,
});

test('starts charging when surplus >= min', () => {
  const l = new SolarLoop(cfg());
  const r = l.evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T });
  assert.equal(r.target, 10);
  assert.equal(r.state, 'charging');
  assert.equal(r.availableW, 2300);
});

test('deadband holds, ramp caps up and down', () => {
  const l = new SolarLoop(cfg());
  l.evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T });
  assert.equal(l.evaluate({ gridSignedW: 0, chargerPowerW: 2300, now: T + 2000 }).target, 10);
  assert.equal(l.evaluate({ gridSignedW: -690, chargerPowerW: 2300, now: T + 4000 }).target, 13, 'ramp +3');
  assert.equal(l.evaluate({ gridSignedW: 1150, chargerPowerW: 2990, now: T + 6000 }).target, 10, 'ramp -3');
});

test('below-min pauses at 0A then resumes', () => {
  const l = new SolarLoop(cfg());
  l.evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T });
  assert.equal(l.evaluate({ gridSignedW: 500, chargerPowerW: 0, now: T + 500 }).state, 'charging', 'min-on dwell');
  const paused = l.evaluate({ gridSignedW: 500, chargerPowerW: 0, now: T + 1500 });
  assert.equal(paused.target, 0);
  assert.equal(paused.state, 'paused');
  const resumed = l.evaluate({ gridSignedW: -1600, chargerPowerW: 0, now: T + 3000 });
  assert.equal(resumed.state, 'charging');
  assert.ok((resumed.target ?? 0) >= 6);
});

test('never starts below min, clamps to max, margin reserves headroom', () => {
  assert.equal(new SolarLoop(cfg()).evaluate({ gridSignedW: -1000, chargerPowerW: 0, now: T }).target, null);
  assert.equal(new SolarLoop(cfg()).evaluate({ gridSignedW: -20000, chargerPowerW: 0, now: T }).target, 31);
  const c = cfg(); c.marginW = 1000;
  assert.equal(new SolarLoop(c).evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T }).target, null);
});

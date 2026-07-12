'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { SolarLoop, SolarLoopConfig } from '../lib/control/SolarLoop';

const T = 100000; // realistic time base (> dwell windows)
const cfg = (): SolarLoopConfig => ({
  voltage: 230,
  phases: 1,
  minAmps: 6,
  maxAmps: 31,
  deadbandA: 1,
  rampA: 3,
  minOnMs: 1000,
  minOffMs: 1000,
  marginW: 0,
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

test('battery discharge fully funding an apparent export is not counted as solar surplus', () => {
  // Real-world incident: pv=520W, house(non-EV)=1118W, charger=1632W, battery
  // discharging 2270W to cover the shortfall, leaving a 40W export. Without
  // the battery, grid would need to import ~2230W - there is no genuine
  // surplus here at all.
  const l = new SolarLoop(cfg());
  const r = l.evaluate({
    gridSignedW: -40, chargerPowerW: 1632, batteryW: -2270, now: T,
  });
  // Raw availableW can go negative here (it's not the surplus metric itself -
  // ChargeController floors that at 0 for the widget/capability); what matters
  // is the resulting desiredA/target, which floors internally regardless.
  assert.equal(r.availableW, 1632 - -40 - 2270);
  assert.equal(r.target, null, 'never starts a session off battery-funded "surplus"');
});

test('battery discharge only cancels out its own contribution, not genuine solar export on top of it', () => {
  const l = new SolarLoop(cfg());
  // 3000W genuinely exported on top of a 1000W battery discharge - 2000W of
  // that export is real solar surplus and should still be usable.
  const r = l.evaluate({
    gridSignedW: -3000, chargerPowerW: 0, batteryW: -1000, now: T,
  });
  assert.equal(r.availableW, 2000);
  assert.equal(r.target, 8);
});

test('battery charging is not double-counted - the grid reading already reflects it', () => {
  const l = new SolarLoop(cfg());
  const withoutBattery = l.evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T });
  const l2 = new SolarLoop(cfg());
  const withCharging = l2.evaluate({
    gridSignedW: -2300, chargerPowerW: 0, batteryW: 1500, now: T,
  });
  assert.equal(withCharging.availableW, withoutBattery.availableW, 'positive (charging) batteryW needs no extra adjustment');
});

test('omitting batteryW behaves exactly as before (no battery present)', () => {
  const l = new SolarLoop(cfg());
  const r = l.evaluate({ gridSignedW: -2300, chargerPowerW: 0, now: T });
  assert.equal(r.availableW, 2300);
  assert.equal(r.target, 10);
});

test('setConfig() replaces the config used by subsequent evaluate() calls', () => {
  const l = new SolarLoop(cfg());
  assert.equal(l.evaluate({ gridSignedW: -1150, chargerPowerW: 0, now: T }).target, null,
    'below the original minAmps (6A ~ 1380W)');

  const lowered = cfg();
  lowered.minAmps = 3;
  l.setConfig(lowered);
  assert.equal(l.evaluate({ gridSignedW: -1150, chargerPowerW: 0, now: T + 2000 }).target, 5,
    'the same surplus now clears the lowered minAmps threshold');
});

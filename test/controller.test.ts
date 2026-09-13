'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import {
  ChargeController, ControllerHost, ChargingTokens, fmtDuration, toChargingState,
} from '../lib/control/ChargeController';
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { ChargePoint, RpcClient } from '../lib/ocpp/ChargePoint';
import { OcppStatus } from '../lib/ocpp/types';
import { ScheduleWindow } from '../lib/control/Scheduler';

function at(day: number, hh: number, mm: number): Date {
  const d = new Date(2024, 0, 7);
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/**
 * A CentralSystem stand-in with real EventEmitter semantics, for tests that
 * drive connect/disconnect themselves. Nothing is connected at init() time, so
 * the controller binds only when the test emits 'connect'.
 */
class FakeCentralSystem extends EventEmitter {
  getChargePoint(): ChargePoint | undefined {
    return undefined;
  }
}

const SCHED: ScheduleWindow[] = [{
  days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', currentA: 20,
}];

function makeController(schedule: ScheduleWindow[], extraSettings: Record<string, unknown> = {}): {
  c: ChargeController; caps: Record<string, unknown>; store: Record<string, unknown>; logs: string[];
} {
  const store: Record<string, unknown> = { schedule };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, ...extraSettings,
  };
  const caps: Record<string, unknown> = {};
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => undefined, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return {
    c, caps, store, logs,
  };
}

test('default outside a schedule is Solar; follows excess', () => {
  const { c } = makeController([]);
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', amps: 10 });
  c.setSolarTarget(null);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'solar', amps: 0 });
});

test('solarEnabled:false resolves Idle outside a schedule, ignoring any solar target', () => {
  const { c } = makeController([], { solarEnabled: false });
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'idle', amps: 0 });
});

test('solarEnabled:false still lets Scheduled and Manual take priority', async () => {
  const { c } = makeController(SCHED, { solarEnabled: false });
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'scheduled', amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).mode, 'idle', 'outside window with solar disabled -> idle');
  await c.startManual(16);
  assert.deepEqual(c.resolve(at(1, 20, 0)), { mode: 'manual', amps: 16 });
});

test('solarEnabled:false does not stop solar samples from updating the surplus meter', () => {
  const { c, caps } = makeController([], { solarEnabled: false });
  c.onSolarSample({ gridSignedW: -2000, pvW: 2000, batteryW: 0 });
  assert.equal(caps.measure_solar_surplus, 2000);
  assert.equal(c.resolve(at(0, 12, 0)).mode, 'idle', 'mode still gated even though surplus is tracked');
});

test('inside a schedule (no manual) is Scheduled; schedule beats solar', () => {
  const { c } = makeController(SCHED);
  c.setSolarTarget(10);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'scheduled', amps: 20 });
  assert.equal(c.resolve(at(1, 20, 0)).mode, 'solar', 'outside window -> solar');
});

test('manual start latches Manual until cleared; overrides schedule', async () => {
  const { c } = makeController(SCHED);
  await c.startManual(16);
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', amps: 16 });
  assert.deepEqual(c.resolve(at(1, 20, 0)), { mode: 'manual', amps: 16 });
});

test('manual stop cancels an active schedule (Manual, paused at 0A not a hard stop)', async () => {
  const { c } = makeController(SCHED);
  await c.stop();
  assert.deepEqual(c.resolve(at(1, 10, 0)), { mode: 'manual', amps: 0 });
});

test('a disabled schedule window is not applied', () => {
  const disabled: ScheduleWindow[] = [{ ...SCHED[0], enabled: false }];
  const { c } = makeController(disabled);
  c.setSolarTarget(10);
  assert.equal(c.resolve(at(1, 10, 0)).mode, 'solar', 'disabled window does not count as scheduled');
});

test('setSchedule rejects overlapping enabled windows', async () => {
  const { c } = makeController([]);
  const overlapping: ScheduleWindow[] = [
    { days: [1], start: '09:00', end: '17:00' },
    { days: [1], start: '16:00', end: '20:00' },
  ];
  await assert.rejects(() => c.setSchedule(overlapping), /overlap/i);
  assert.deepEqual(c.getSchedule(), [], 'rejected schedule must not be applied');
});

test('setSchedule allows overlapping windows when one is disabled', async () => {
  const { c, store } = makeController([]);
  const windows: ScheduleWindow[] = [
    { days: [1], start: '09:00', end: '17:00' },
    {
      days: [1], start: '16:00', end: '20:00', enabled: false,
    },
  ];
  await c.setSchedule(windows);
  assert.deepEqual(c.getSchedule(), windows);
  assert.deepEqual(store.schedule, windows);
});

test('moving the current slider switches to Manual at that current', async () => {
  const { c } = makeController([]);
  c.setSolarTarget(12); // solar would charge at 12A
  await c.setCurrentLimit(8);
  assert.deepEqual(c.resolve(at(0, 12, 0)), { mode: 'manual', amps: 8 });
});

test('a schedule window starting clears the manual latch', async () => {
  const { c } = makeController(SCHED);
  await c.stop(); // manual-off outside a window
  c.tick(at(1, 8, 59)); // just before window
  assert.equal(c.getMode(), 'manual');
  c.tick(at(1, 9, 0)); // window starts -> clears latch
  assert.equal(c.resolve(at(1, 9, 0)).mode, 'scheduled');
});

test('manual latch persists across restart (restored from store)', async () => {
  const { c, store } = makeController([]);
  await c.startManual(16);
  assert.ok(store.manualLatch, 'latch persisted');
  // New controller instance with the same store -> latch restored.
  const caps2: Record<string, unknown> = {};
  const host2: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps2[k] = v;
    },
    getSetting: () => undefined,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => undefined, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c2 = new ChargeController(host2, cs);
  c2.init();
  assert.equal(c2.resolve(new Date()).mode, 'manual');
});

test('household grid cap throttles the charger in any mode', async () => {
  const { c, caps } = makeController([]);
  await c.startManual(31);
  c.onSolarSample({ gridSignedW: 11700 }, Date.now());
  assert.equal(caps.charge_current_limit, 10, 'capped to 10A under household ceiling');
  c.onSolarSample({ gridSignedW: -2000 }, Date.now());
  assert.equal(caps.charge_current_limit, 31, 'uncapped when grid has headroom');
  assert.equal(caps.measure_solar_surplus, 2000, 'excess solar metric set');
});

test('shared circuit cap is disabled by default (sharedCircuitA=0)', async () => {
  const { c, caps } = makeController([]);
  await c.startManual(31);
  c.onSolarSample({ gridSignedW: -5000, pvW: 0, batteryW: 6900 }); // battery charging hard, no cap configured
  assert.equal(caps.charge_current_limit, 31, 'no shared-circuit restriction when sharedCircuitA is 0');
});

test('shared circuit cap throttles the charger in any mode (manual)', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  await c.startManual(31);
  // Battery charging at 14A (3220W), no solar -> cap = 32 - 14 - 2 = 16A.
  c.onSolarSample({ gridSignedW: 3220, pvW: 0, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 16, 'capped to 16A by the shared-circuit formula');
});

test('shared circuit cap rises with pv production, up to the hardware max', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  await c.startManual(31);
  // +20A pv, 14A battery charge -> cap = 32 + 20 - 14 - 2 = 36, clamped to maxAmps (31).
  c.onSolarSample({ gridSignedW: -1000, pvW: 4600, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 31, 'uncapped up to hardware max once solar covers the buffer');
});

test('shared circuit cap is a no-op on stale/absent solar data (trusts the configured ceiling)', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  await c.startManual(20); // no onSolarSample ever called -> lastSolarSampleAt stays 0 -> "stale"
  assert.equal(caps.charge_current_limit, 20, 'no shared-circuit restriction while solar data has never arrived');
});

test('shared circuit cap only counts pv when battery is excluded', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: false,
  });
  await c.startManual(31);
  // +20A pv would raise the cap, but battery charging at 14A is excluded -> cap = 32 + 20 - 2 = 50, uncapped.
  c.onSolarSample({ gridSignedW: -1000, pvW: 4600, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 31, 'battery term ignored, only pv counted (uncapped up to hardware max)');
});

test('shared circuit cap only counts battery when solar is excluded', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: false, sharedCircuitIncludeBattery: true,
  });
  await c.startManual(31);
  // +20A pv would offset it, but solar is excluded -> cap = 32 - 14 - 2 = 16A, same as if pv were 0.
  c.onSolarSample({ gridSignedW: -1000, pvW: 4600, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 16, 'pv term ignored, only battery counted');
});

test('shared circuit cap is a static number, independent of the solar feed, when neither solar nor battery is included', async () => {
  const { c, caps } = makeController([], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: false, sharedCircuitIncludeBattery: false,
  });
  // No onSolarSample ever called - a static cap must not depend on a solar feed reporting at all,
  // unlike the pv/battery-aware formula above (see the stale-data test).
  await c.startManual(31);
  assert.equal(caps.charge_current_limit, 30, 'static cap (32 - 2 buffer), never gated on solar feed freshness');
});

test('schedule boost is not blocked by battery discharge when the battery is excluded from the shared circuit', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: false, sharedCircuitIncludeBattery: false,
  });
  // Battery discharging would normally suppress the boost entirely, but it's not on this shared
  // circuit at all -> static cap (32 - 2 = 30) still boosts the floor.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: -2300 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 30 },
    'boost proceeds using the static cap - battery discharge is irrelevant to a circuit it is not part of');
});

test('schedule boost raises the target up to shared-circuit capacity when the battery is idle', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 }); // idle battery, no solar -> cap = 32 - 0 - 2 = 30
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 30 });
});

test('schedule boost matches the battery-charging + solar example (16A floor -> 20A)', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  // Battery charging at 14A (3220W, the rate that made 16A a sensible floor), pv +4A (920W) -> cap = 20.
  c.onSolarSample({ gridSignedW: 0, pvW: 920, batteryW: 3220 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 20 });
});

test('schedule boost clamps to the hardware maxAmps, not just the circuit rating', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 0, maxAmps: 31, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  c.onSolarSample({ gridSignedW: 0, pvW: 4600, batteryW: 0 }); // +20A pv -> cap = 52, way above hardware max
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 31 });
});

test('schedule boost never lowers below the configured floor', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  // Battery charging harder than assumed (20A) -> cap = 32 - 20 - 2 = 10, below the 16A floor.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 16 },
    'resolve() keeps the floor - the hard safety cap (tested separately) is what actually enforces the tighter limit');
});

test('the shared-circuit safety cap still throttles the charger even when the schedule floor asks for more', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c, caps } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 }); // cap = 10, below the 16A floor
  c.tick(at(1, 12, 0)); // re-resolve at a fixed in-window time (onSolarSample's own tick used real time)
  assert.equal(caps.charge_current_limit, 10, 'final applied current is safety-capped to 10A regardless of the floor');
});

test('schedule boost is fully suppressed while the battery is discharging', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  // No pv, battery discharging 10A -> the cap formula alone would say 32-(-10)-2=40A, but
  // discharge must never fund a boost above the floor.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: -2300 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 16 },
    'boost stays off entirely while discharging, even though the safety cap alone would allow much more');
});

test('schedule boost does nothing when the window has not opted in', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16,
  }]; // no boostToCap
  const { c } = makeController(sched, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 }); // plenty of spare capacity available
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 16 }, 'stays at the fixed floor without opt-in');
});

test('schedule boost does nothing when the shared-circuit cap is disabled', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched); // sharedCircuitA defaults to 0 (disabled)
  c.onSolarSample({ gridSignedW: 0, pvW: 4600, batteryW: 0 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 16 }, 'no cap configured -> nothing to boost to');
});

test('excess floored at 0 and logged with all components', () => {
  const { c, caps, logs } = makeController([]);
  c.onSolarSample({
    gridSignedW: 40, pvW: 100, batteryW: -50, houseW: 190,
  }, Date.now());
  assert.equal(caps.measure_solar_surplus, 0, 'excess floored at 0');
  const line = logs.find((l) => l.includes('[solar]')) || '';
  assert.ok(line.includes('solar=100W') && line.includes('battery=-50W') && line.includes('excess=0W'));
});

test('solar mode never charges off battery-funded "surplus" (real-hardware incident)', () => {
  const { c, caps } = makeController([]);
  // pv=520W, house(non-EV)=1118W, charger=1632W (not charging yet in this
  // test - charger=0), battery discharging 2270W to fund a 40W export.
  c.onSolarSample({
    gridSignedW: -40, pvW: 520, batteryW: -2270, houseW: 2750,
  });
  assert.equal(caps.measure_solar_surplus, 0, 'no surplus credited - it was entirely battery-funded');
  assert.deepEqual(c.resolve(new Date()), { mode: 'solar', amps: 0 });
});

test('solar mode still charges off genuine surplus on top of a discharging battery', () => {
  const { c, caps } = makeController([]);
  // 3000W export, only 1000W of which is battery discharge - 2000W is real solar surplus.
  c.onSolarSample({
    gridSignedW: -3000, pvW: 3500, batteryW: -1000, houseW: 500,
  });
  assert.equal(caps.measure_solar_surplus, 2000);
  assert.deepEqual(c.resolve(new Date()), { mode: 'solar', amps: 8 });
});

test('every tick logs a [decision] line, unconditionally, covering each branch', async () => {
  // Manual: off.
  {
    const { c, logs } = makeController([]);
    await c.stop();
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('manual: off (paused)') && line.includes('-> paused'));
  }
  // Manual: charging.
  {
    const { c, logs } = makeController([]);
    await c.startManual(20);
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('manual: charging at 20A') && line.includes('-> 20A'));
  }
  // Scheduled: boost not enabled for the window.
  {
    const sched: ScheduleWindow[] = [{
      days: [1], start: '11:00', end: '14:00', currentA: 16,
    }];
    const { c, logs } = makeController(sched);
    c.tick(at(1, 12, 0));
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('scheduled: floor 16A (boost not enabled for this window)') && line.includes('-> 16A'));
  }
  // Scheduled: boost blocked by battery discharge, even though caps have headroom.
  {
    const sched: ScheduleWindow[] = [{
      days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
    }];
    const { c, logs } = makeController(sched, {
      sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
    });
    c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: -2300 });
    c.tick(at(1, 12, 0));
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('boost blocked - battery discharging ~10A')
      && line.includes('shared circuit cap ok') && line.includes('-> 16A'));
  }
  // Scheduled: boosted, with pv/battery breakdown and both cap notes present.
  {
    const sched: ScheduleWindow[] = [{
      days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
    }];
    const { c, logs } = makeController(sched, {
      sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
    });
    c.onSolarSample({ gridSignedW: 0, pvW: 920, batteryW: 3220 });
    c.tick(at(1, 12, 0));
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('boosted floor 16A -> 20A') && line.includes('pv=920W battery=3220W')
      && line.includes('household cap ok') && line.includes('shared circuit cap ok') && line.includes('-> 20A'));
  }
  // Both caps present: circuit cap boosts the request, household cap then pauses it.
  {
    const sched: ScheduleWindow[] = [{
      days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
    }];
    const { c, logs } = makeController(sched, {
      sharedCircuitA: 32, sharedCircuitBufferA: 2, maxHouseholdA: 3000 / 230, householdPhases: 1, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
    });
    c.onSolarSample({ gridSignedW: 2800, pvW: 920, batteryW: 3220 });
    c.tick(at(1, 12, 0));
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('boosted floor 16A -> 20A') && line.includes('household cap 3000W -> pause')
      && line.includes('-> paused'), 'household cap overrides the boosted request down to a pause');
  }
  // Solar: idle (SolarLoop's 'off') vs paused (its 'paused') are distinguishable reasons.
  {
    const { c, logs } = makeController([]);
    c.tick(at(0, 12, 0));
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('solar: idle (no session started yet') && line.includes('-> paused'));
  }
  {
    const { c, logs } = makeController([]);
    c.setSolarTarget(0);
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes("solar: paused (stopped charging - won't resume") && line.includes('-> paused'));
  }
  // Solar: following surplus.
  {
    const { c, logs } = makeController([]);
    c.setSolarTarget(12);
    const line = logs.filter((l) => l.startsWith('[decision:')).pop();
    assert.ok(line?.includes('solar: following surplus at 12A') && line.includes('-> 12A'));
  }
});

test('the 10s backstop timer reschedules on every tick instead of firing on its own fixed schedule', () => {
  // Stub the global timer functions so we can observe scheduling/cancellation
  // without waiting on real 10s timers. Kept synchronous (no await) so nothing
  // else touches setTimeout/clearTimeout while they're overridden.
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let nextId = 0;
  const all: { id: number; ms: number }[] = [];
  const cleared: number[] = [];
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: unknown, ms: number) => {
    const id = ++nextId;
    all.push({ id, ms });
    return { id } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const id = (handle as { id?: number } | undefined)?.id;
    if (id != null) cleared.push(id);
  }) as typeof clearTimeout;

  // init() also arms the one-shot OCPP startup-grace timer (120s), which is a
  // different concern entirely - filter to the 15s backstop this test is about.
  const backstops = () => all.filter((t) => t.ms === 15000).map((t) => t.id);

  try {
    const { c } = makeController([]);
    assert.deepEqual(all.filter((t) => t.ms === 120000).length, 1,
      'the OCPP startup-grace timer is armed exactly once, on init');
    // init() fires one tick, which arms the first backstop timer.
    assert.deepEqual(backstops(), [2], 'one backstop timer armed on init');
    assert.deepEqual(cleared, [], 'nothing to cancel yet');

    c.setSolarTarget(10); // a tick from a different trigger
    assert.deepEqual(cleared, [2], 'the previous backstop was cancelled, not left to fire independently');
    assert.deepEqual(backstops(), [2, 3], 'a fresh backstop was armed instead');

    c.setSolarTarget(0); // another unrelated tick
    assert.deepEqual(cleared, [2, 3]);
    assert.deepEqual(backstops(), [2, 3, 4], 'each tick keeps pushing the backstop out, never stacking timers');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('mode metric + getModeInfo reflect the derived mode', () => {
  const { c, caps } = makeController(SCHED);
  c.tick(at(1, 10, 0));
  assert.equal(caps.charge_mode, 'scheduled');
  assert.equal(c.getModeInfo().mode, 'scheduled');
});

test('household cap nets out the charger\'s own draw once Charging, even without a known transaction id', async () => {
  // Mirrors the real incident: a Wallbox already mid-session that never
  // handed back a StartTransaction, so transactionId stays null forever.
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] }; // no transactionId anywhere
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(31);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { power: 6900 });
  assert.ok(!c.isCharging(), 'no transaction id known - this is the exact stuck scenario from real hardware');

  // baseLoadW = 10600 - 6900 = 3700; maxChargerW = 14200 - 3700 = 10500; cap = floor(10500/230) = 45A.
  c.onSolarSample({ gridSignedW: 10600, pvW: 0, batteryW: 0 });
  assert.equal(caps.charge_current_limit, 31,
    'the charger\'s own 6900W draw is netted out of the household cap even without a transaction id');
});

test('the solar surplus calc sees the charger\'s real power once Charging, even without a known transaction id', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { power: 3000 });

  // available = chargerPowerW - gridSignedW - margin = 3000 - 2000 - 0 = 1000W (not 0, as it would
  // be if the charger's own draw were wrongly reported as 0 despite genuinely charging).
  c.onSolarSample({ gridSignedW: 2000, pvW: 0, batteryW: 0 });
  assert.equal(caps.measure_solar_surplus, 1000, 'charger power is credited even without a known transaction id');
});

test('household cap is unavailable, not a guessed-low value, while Charging with no MeterValues yet this connection', async () => {
  // Mirrors a real restart-onto-an-already-charging-session log: status
  // flips to Charging (from a persisted transaction id / fresh reconnect)
  // before any MeterValues has come back on this connection - a fresh
  // ChargePoint instance has no cached reading to replay, and the triggered
  // MeterValues round trip takes a few real seconds. Netting out 0W for the
  // charger's own (unknown) draw would understate headroom and needlessly
  // throttle an already-fine session.
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(31);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }); // no meterValues emitted yet

  // If chargerW were wrongly netted as 0: baseLoadW = 11150, maxChargerW = 14200-11150 = 3050 -> 13A.
  // The fix instead leaves the cap unavailable (trusts the configured 31A ceiling).
  c.onSolarSample({ gridSignedW: 11150, pvW: 0, batteryW: 0 });
  assert.equal(caps.charge_current_limit, 31,
    'household cap is skipped (not guessed at 13A) until a real MeterValues reading arrives');

  cp.emit('meterValues', { power: 3550 });
  // Now netted correctly: baseLoadW = 11150-3550 = 7600. Tighten maxHouseholdA so the cap is
  // provably live and binding again (not just "no longer stale"): maxChargerW = 11050-7600 = 3450 ->
  // floor(3450/230) = 15A, below the 31A manual target.
  settings.maxHouseholdA = 11050 / 230;
  c.refreshConfig();
  c.onSolarSample({ gridSignedW: 11150, pvW: 0, batteryW: 0 });
  assert.equal(caps.charge_current_limit, 15, 'the cap is live again and binding once a real reading is known');
});

test('solar surplus evaluation is skipped, not zeroed, while Charging with no MeterValues yet this connection', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }); // no meterValues emitted yet

  c.onSolarSample({ gridSignedW: 2000, pvW: 0, batteryW: 0 });
  assert.equal(caps.measure_solar_surplus, undefined,
    'surplus is left untouched (not overwritten with a wrong 0-charger-power figure) while unknown');
  assert.ok(logs.some((l) => l.includes('no MeterValues yet this connection')), 'the gap is visible in the log');
});

test('household cap is unavailable, not a guessed pause, before any status arrives with a transaction id already known from a persisted restart', () => {
  // Mirrors a real restart log: SolarFeed produced its first sample several
  // seconds before OCPP even reconnected, so no StatusNotification had been
  // received at all yet - but transactionId=29 was already loaded from
  // store at init(), the signal that a session may already be live.
  const sched: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const store: Record<string, unknown> = { schedule: sched, transactionId: 29 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => undefined, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init(); // loads transactionId=29 from store - no status has ever been received yet

  // grid=13330W would leave almost no headroom (household cap -> pause) if the charger's own
  // draw were wrongly netted as 0 while its status simply isn't known yet.
  c.onSolarSample({ gridSignedW: 13330, pvW: 80, batteryW: 3290 });
  const line = logs.filter((l) => l.startsWith('[decision:')).pop();
  assert.ok(line?.includes('-> 16A'), `the schedule's floor should pass through uncapped, got: ${line}`);
  assert.ok(!line?.includes('household cap'), 'household cap note is absent (unavailable), not a wrongly-computed pause');
});

test('an unknown status with no known transaction id still nets as a confirmed 0 (no session to hide a draw)', () => {
  const { c, caps } = makeController([]);
  c.onSolarSample({ gridSignedW: 2000, pvW: 0, batteryW: 0 }); // no status, no transaction id ever set
  assert.equal(caps.measure_solar_surplus, 0,
    'surplus is computed (not skipped) - a never-connected/idle charger is confirmed 0, not "unknown"');
});

test('household cap is unavailable, not a guessed-low value, on a transient Available report while a transaction is still on record', () => {
  // Mirrors a real restart log: a lone Available report flipped back to
  // Charging just over a second later (the same reconnect-blip quirk
  // onStatus() already debounces via IDLE_RECONCILE_DELAY_MS for transaction
  // reconciliation) - trusting it as confirmed-0 drove a real, wrong,
  // artificially-low household cap write that then sat throttled for a full
  // writeThrottleMs before self-correcting.
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const sched: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const store: Record<string, unknown> = { schedule: sched, transactionId: 29 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init(); // loads transactionId=29 from store
  c.onSolarSample({ gridSignedW: 13330, pvW: 80, batteryW: 3290 }); // primes solar data
  logs.length = 0;

  // grid=13330W would leave almost no headroom (household cap -> pause) if the charger's own
  // draw were wrongly netted as 0 during this reconnect-blip Available.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  const line = logs.filter((l) => l.startsWith('[decision:')).pop();
  assert.ok(line?.includes('-> 16A'), `expected the schedule floor to pass through uncapped, got: ${line}`);
  assert.ok(!line?.includes('household cap'), 'household cap note is absent (unavailable), not a wrongly-computed drop');
});

test('a genuinely idle Available (no known transaction) still nets as a confirmed 0, not stuck unavailable forever', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const sched: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const store: Record<string, unknown> = { schedule: sched }; // no persisted transactionId - genuinely idle
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  c.onSolarSample({ gridSignedW: 13330, pvW: 80, batteryW: 3290 });
  logs.length = 0;

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  const line = logs.filter((l) => l.startsWith('[decision:')).pop();
  assert.ok(line?.includes('household cap'), `household cap should apply normally with no session on record, got: ${line}`);
});

test('profile writes reach the charger (TxDefaultProfile) even without a known transaction id, once Charging', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 0,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(15);
  calls.length = 0; // discard bind-time TriggerMessage calls

  // Target (15A) is unchanged across this transition - only eligibility
  // (charger just reported Charging) changes. The write must still fire.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.ok(calls.includes('SetChargingProfile'),
    'writes even though the target amps value itself did not change across becoming eligible');
  assert.ok(!calls.includes('RemoteStartTransaction'), 'no pointless start attempt while already Charging');
  assert.ok(!c.isCharging(), 'confirms this genuinely had no transaction id (not a false-positive via TxProfile)');

  calls.length = 0;
  await c.setCurrentLimit(20); // a genuine target change while still eligible
  assert.ok(calls.includes('SetChargingProfile'), 'subsequent target changes keep reaching the charger');
});

test('a pause (0A) decision reaches an already-mid-session charger, real-hardware scenario', async () => {
  // Boot outside any schedule/solar surplus (decision is "paused" from the
  // very first tick, well before the charger ever connects), then the
  // charger connects already Charging (no transaction id ever granted, as in
  // the confirmed real-hardware incident) - the pending 0A pause must still
  // reach it once it becomes eligible, not get silently stuck at whatever it
  // was already doing.
  const calls: Array<{ method: string; params: unknown }> = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params }); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] }; // no schedule, no transactionId
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14200 / 230, householdPhases: 1, writeThrottleMs: 0,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.deepEqual(c.resolve(new Date()), { mode: 'solar', amps: 0 }, 'idle/paused from the very first tick');

  calls.length = 0;
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // reconnect blip
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }); // already mid-session

  const write = calls.find((c) => c.method === 'SetChargingProfile');
  assert.ok(write, 'the pending pause reaches the charger once it becomes eligible, even though the target (0A) never changed');
  const profile = (write!.params as { csChargingProfiles: { chargingProfilePurpose: string; chargingSchedule: { chargingSchedulePeriod: [{ limit: number }] } } }).csChargingProfiles;
  assert.equal(profile.chargingProfilePurpose, 'TxDefaultProfile', 'no transaction id known, so it must be TxDefaultProfile');
  assert.equal(profile.chargingSchedule.chargingSchedulePeriod[0].limit, 0, 'the actual limit sent is 0A (pause)');
});

test('RemoteStartTransaction is only attempted while Preparing, not once already mid-session', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(15);
  calls.length = 0;

  for (const status of ['Charging', 'SuspendedEV', 'SuspendedEVSE']) {
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status });
    assert.ok(!calls.includes('RemoteStartTransaction'), `must not attempt a start while ${status}`);
  }

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  assert.ok(calls.includes('RemoteStartTransaction'), 'still attempts a start while genuinely Preparing');
});

test('a repeated identical status does not re-trigger the decision log/tick', () => {
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async () => ({ status: 'Accepted' }),
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();

  logs.length = 0; // discard init-time noise
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  assert.equal(logs.filter((l) => l.startsWith('[decision:status:')).length, 1,
    'first status emits exactly one decision line');
  assert.equal(logs.filter((l) => l.startsWith('[charger] status')).length, 1);

  // Mirrors bind()'s replay-cached-then-requestFreshState() pattern: the real
  // charger echoing back the same status must not add another decision line.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  assert.equal(logs.filter((l) => l.startsWith('[decision:status:')).length, 1,
    'a repeated identical status must not add another decision line');
  assert.equal(logs.filter((l) => l.startsWith('[charger] status')).length, 1,
    'the transition log itself also only fires on an actual change');
});

test('a transient Available (reconnect blip) does not wipe a live transaction', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const pending = new Set<() => void>();
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    pending.add(fn);
    return { fn } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const fn = (handle as { fn?: () => void } | undefined)?.fn;
    if (fn) pending.delete(fn);
  }) as typeof clearTimeout;

  try {
    const calls: string[] = [];
    const fakeClient: RpcClient = {
      identity: 'X',
      handle: () => {},
      call: async (method: string) => {
        calls.push(method); return { status: 'Accepted' };
      },
      close: async () => {},
      on: () => {},
    };
    const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
    cp.attach(fakeClient);

    // Mirrors the real incident: transactionId restored from the store at
    // boot (was already charging before the app restarted).
    const store: Record<string, unknown> = { schedule: [], transactionId: 55 };
    const settings: Record<string, unknown> = {
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
    };
    const host: ControllerHost = {
      identity: 'X',
      setCapability: () => {},
      getSetting: <T>(k: string) => settings[k] as T,
      getStore: <T>(k: string) => store[k] as T,
      setStore: async (k, v) => {
        store[k] = v;
      },
      setAvailable: () => {},
      setUnavailable: () => {},
      setWarning: () => {},
      log: () => {},
      error: () => {},
    };
    const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
    const c = new ChargeController(host, cs);
    c.init();

    pending.clear(); // isolate what this specific Available report schedules
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
    assert.ok(c.isCharging(), 'not wiped the instant Available is seen');
    const idleReconcileFn = [...pending][0];
    assert.ok(idleReconcileFn, 'a debounced reconcile was armed');

    // The real Wallbox flips back to Charging well within the debounce window.
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
    assert.ok(!pending.has(idleReconcileFn), 'the pending reconcile was cancelled by the Charging status');
    assert.ok(c.isCharging(), 'transaction survives the blip');
    assert.ok(!calls.includes('RemoteStartTransaction'), 'must not have attempted a redundant start');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('a genuinely sustained Available eventually reconciles a stale transaction id', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const pending = new Set<() => void>();
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    pending.add(fn);
    return { fn } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const fn = (handle as { fn?: () => void } | undefined)?.fn;
    if (fn) pending.delete(fn);
  }) as typeof clearTimeout;

  try {
    const fakeClient: RpcClient = {
      identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
    };
    const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
    cp.attach(fakeClient);

    const store: Record<string, unknown> = { schedule: [], transactionId: 55 };
    const settings: Record<string, unknown> = {
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
    };
    const host: ControllerHost = {
      identity: 'X',
      setCapability: () => {},
      getSetting: <T>(k: string) => settings[k] as T,
      getStore: <T>(k: string) => store[k] as T,
      setStore: async (k, v) => {
        store[k] = v;
      },
      setAvailable: () => {},
      setUnavailable: () => {},
      setWarning: () => {},
      log: () => {},
      error: () => {},
    };
    const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
    const c = new ChargeController(host, cs);
    c.init();

    pending.clear();
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
    assert.ok(c.isCharging(), 'not cleared immediately');
    const idleReconcileFn = [...pending][0];
    assert.ok(idleReconcileFn, 'a debounced reconcile was armed');

    idleReconcileFn(); // simulate the debounce delay elapsing with no follow-up status
    assert.ok(!c.isCharging(), 'stale transaction id reconciled once Available is confirmed to persist');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('EV-initiated Finishing (no StopTransaction) clears the stale transaction and re-arms starting', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method);
      if (method === 'RemoteStartTransaction') return { status: 'Accepted' };
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  // An always-on schedule window so there's still a genuine target once the
  // fresh-plug-in edge clears the manual latch below - otherwise mode falls
  // through to idle Solar (no target ever set here) at exactly the moment
  // Preparing arrives, which is a test artifact, not a realistic setup.
  const schedule: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const store: Record<string, unknown> = { schedule, transactionId: 5 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16); // manual latch: always try to charge

  assert.ok(c.isCharging(), 'restored transaction id from store looks like a live session');

  // The Wallbox stalls in Finishing without ever sending StopTransaction.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Finishing' });

  assert.equal(c.isCharging(), false, 'stale transaction cleared on Finishing');
  assert.equal(caps.evcharger_charging, false);
  assert.ok(!calls.includes('RemoteStartTransaction'), 'must not retry starting while still Finishing');

  // Physically unplugged and replugged: Available then Preparing - only
  // Preparing (genuinely awaiting a start) should attempt one, not Available.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  assert.ok(!calls.includes('RemoteStartTransaction'), 'must not attempt a start while merely Available (not yet Preparing)');
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });

  assert.ok(calls.includes('RemoteStartTransaction'), 'a new session can be started after replug');
});

test('manual off pauses at 0A (keeps the transaction) instead of hard-stopping', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 7 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 0,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });

  await c.stop(); // manual "off" while a transaction is live

  assert.ok(!calls.includes('RemoteStopTransaction'), 'must not end the transaction on manual off');
  assert.ok(c.isCharging(), 'transaction stays open (paused), so it can resume without a replug');

  const callsBeforeResume = calls.length;
  await c.startManual(10); // turn back on - must not require Finishing/replug to resume
  assert.ok(calls.slice(callsBeforeResume).includes('SetChargingProfile'),
    'resumes by writing a new profile on the still-open transaction');
  assert.ok(!calls.includes('RemoteStartTransaction'), 'no new session needed - it was never stopped');
  assert.ok(!calls.includes('RemoteStopTransaction'), 'still no hard stop anywhere in this flow');
});

test('manual latch set while unplugged is cleared by the fresh plug-in (never defaults to Manual)', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();

  // Charger idle (unplugged) before the manual latch is ever set.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  await c.startManual(6); // manual latch, still unplugged
  assert.equal(c.resolve(new Date()).mode, 'manual', 'latch is active while still unplugged');

  // A fresh plug-in (no schedule window, no prior replug) must clear the
  // latch and fall through to Solar - never stay Manual.
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'SuspendedEV' });
  assert.equal(c.resolve(new Date()).mode, 'solar', 'a fresh plug-in clears the latch -> Solar (no schedule)');
});

test('a transactionId restored from store at boot is never hard-stopped, confirmed or not', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient); // connected, but no StatusNotification has been seen yet

  // Solar target null (below excess threshold) -> controller wants to be idle.
  const store: Record<string, unknown> = { schedule: [], transactionId: 42 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init(); // fires an initial tick synchronously; transactionId=42 was restored from store
  c.setSolarTarget(null);

  assert.ok(!calls.includes('RemoteStopTransaction'),
    'idle (no target) pauses at 0A, it must never hard-stop an unconfirmed restored transaction');

  // A real status now arrives (e.g. TriggerMessage response, or a genuine change).
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });

  assert.ok(!calls.includes('RemoteStopTransaction'),
    'still no hard stop once a real status confirms the charger is live - pause only, never end the transaction');
});

// ---------------------------------------------------------------------------
// onStartTransaction / onStopTransaction bookkeeping
// ---------------------------------------------------------------------------

test('onStartTransaction persists the transaction id/meter start, flips the capability, and writes a pending target', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 0,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16); // sets desiredAmps, but not yet eligible to write (no transaction id, not plugged)
  calls.length = 0;

  cp.emit('startTransaction', 42, {
    connectorId: 1, idTag: 'TAG', meterStart: 100, timestamp: new Date().toISOString(),
  });

  assert.equal(store.transactionId, 42);
  assert.equal(store.meterStartWh, 100);
  assert.equal(caps.evcharger_charging, true);
  assert.ok(c.isCharging());
  assert.ok(calls.includes('SetChargingProfile'),
    'a known desiredAmps writes immediately once a transaction id is finally granted');
});

test('onStopTransaction clears the transaction id and flips the charging capability off', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 42 };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.ok(c.isCharging(), 'transaction id restored from store on init');

  cp.emit('stopTransaction', {
    transactionId: 42, meterStop: 500, timestamp: new Date().toISOString(), reason: 'Local',
  });

  assert.equal(store.transactionId, null);
  assert.equal(caps.evcharger_charging, false);
  assert.ok(!c.isCharging());
});

// ---------------------------------------------------------------------------
// Mid-session solar feed staleness (tick()'s fail-safe, distinct from the
// cap formulas' own "never arrived" staleness check)
// ---------------------------------------------------------------------------

test('a mid-session solar feed staleness pauses solar charging exactly once (deduped log)', () => {
  const { c, logs } = makeController([]);
  const start = Date.now();
  c.onSolarSample({ gridSignedW: -3000, pvW: 3000, batteryW: 0 }, start);
  assert.equal(c.resolve(new Date(start)).mode, 'solar');
  assert.ok((c.resolve(new Date(start)).amps ?? 0) > 0, 'solar is actively charging from a live sample');
  logs.length = 0;

  // Advance well past the default 60s solarStaleMs without another sample.
  const later = new Date(start + 70000);
  c.tick(later);
  assert.deepEqual(c.resolve(later), { mode: 'solar', amps: 0 }, 'fails safe to paused once the feed goes stale mid-session');
  assert.equal(logs.filter((l) => l.includes('Solar feed stale')).length, 1);

  c.tick(new Date(start + 80000)); // still stale
  assert.equal(logs.filter((l) => l.includes('Solar feed stale')).length, 1,
    'the stale warning is not repeated on every subsequent tick');
});

test('a fresh solar sample clears the stale warning latch, so a later re-staling logs again', () => {
  const { c, logs } = makeController([]);
  const start = Date.now();
  c.onSolarSample({ gridSignedW: -3000, pvW: 3000, batteryW: 0 }, start);
  c.tick(new Date(start + 70000));
  assert.equal(logs.filter((l) => l.includes('Solar feed stale')).length, 1);

  c.onSolarSample({ gridSignedW: -3000, pvW: 3000, batteryW: 0 }, start + 70000);
  logs.length = 0;
  c.tick(new Date(start + 140000));
  assert.equal(logs.filter((l) => l.includes('Solar feed stale')).length, 1, 'a fresh sample re-arms the warning');
});

// ---------------------------------------------------------------------------
// getModeInfo() / getDiagnostics()
// ---------------------------------------------------------------------------

test('getModeInfo() for manual mode with no schedule: only mode is populated', async () => {
  const { c } = makeController([]);
  await c.startManual(16);
  assert.deepEqual(c.getModeInfo(), {
    mode: 'manual', scheduleEndAt: null, nextScheduleStartAt: null, boostActive: false, solarEnough: null,
  });

  await c.stop();
  assert.deepEqual(c.getModeInfo(), {
    mode: 'manual', scheduleEndAt: null, nextScheduleStartAt: null, boostActive: false, solarEnough: null,
  }, 'manual on/off no longer changes the shape - the widget gets that from evcharger_charging_state instead');
});

test('getModeInfo() for manual mode includes the next schedule start time when one exists', async () => {
  const { c } = makeController(SCHED);
  await c.startManual(10);
  const info = c.getModeInfo();
  assert.equal(info.mode, 'manual');
  assert.equal(info.scheduleEndAt, null);
  assert.ok(info.nextScheduleStartAt, 'expected a next-schedule-start ISO timestamp');
  assert.ok(!Number.isNaN(Date.parse(info.nextScheduleStartAt as string)));
});

test('getModeInfo() for scheduled mode includes the window end time, not a next-start', () => {
  // All-day, every-day window so this isn't tied to exactly when the test happens to run.
  const allDay: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const { c } = makeController(allDay);
  c.tick();
  const info = c.getModeInfo();
  assert.equal(info.mode, 'scheduled');
  assert.equal(info.nextScheduleStartAt, null);
  assert.ok(info.scheduleEndAt, 'expected a window-end ISO timestamp');
  assert.ok(!Number.isNaN(Date.parse(info.scheduleEndAt as string)));
});

test('getModeInfo() boostActive reflects real-time boosting, not just the window\'s boostToCap config', () => {
  const allDayBoost: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(allDayBoost, {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, sharedCircuitIncludeBattery: true,
  });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 }); // idle battery, no solar -> cap = 30, above the 16A floor
  assert.equal(c.getModeInfo().boostActive, true);

  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 }); // cap = 10, below the 16A floor -> nothing to boost with
  assert.equal(c.getModeInfo().boostActive, false);
});

test('getModeInfo() for solar mode: solarEnough tracks whether the target meets minAmps', () => {
  const { c } = makeController([]);
  c.setSolarTarget(10);
  assert.deepEqual(c.getModeInfo(), {
    mode: 'solar', scheduleEndAt: null, nextScheduleStartAt: null, boostActive: false, solarEnough: true,
  });

  c.setSolarTarget(0);
  assert.equal(c.getModeInfo().solarEnough, false, 'paused (low excess) counts as not-enough');

  c.setSolarTarget(null);
  assert.equal(c.getModeInfo().solarEnough, false, 'idle (never started) also counts as not-enough');
});

test('getDiagnostics() reflects the live solar loop state, target, and available surplus', () => {
  const { c } = makeController([]);
  c.onSolarSample({ gridSignedW: -2300, pvW: 2300, batteryW: 0 });
  const diag = c.getDiagnostics();
  assert.equal(diag.mode, 'solar');
  assert.equal(diag.targetA, 10);
  assert.equal(diag.solarState, 'charging');
  assert.equal(diag.availableW, 2300);
});

test('getDiagnostics().chargerPowerW nets the charger\'s own draw for the widget\'s house-load calc', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => ({
      minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
    } as Record<string, unknown>)[k] as T,
    getStore: <T>(k: string) => ({ schedule: [] } as Record<string, unknown>)[k] as T,
    setStore: async () => {},
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.equal(c.getDiagnostics().chargerPowerW, 0, 'confirmed not delivering - nothing to net out yet');

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.equal(c.getDiagnostics().chargerPowerW, null,
    'Charging but no MeterValues on this connection yet - genuinely unknown, not guessed at 0');

  cp.emit('meterValues', { power: 3000 });
  assert.equal(c.getDiagnostics().chargerPowerW, 3000, 'known draw while actually delivering power');
});

test('getDiagnostics().limits resolves dashboard capacity-meter peaks from config, defaulting to 0', () => {
  const { c: defaultC } = makeController([]);
  assert.deepEqual(defaultC.getDiagnostics().limits, {
    chargerMaxW: 31 * 230, // maxAmps * voltage * phases, from makeController's default settings
    gridMaxW: 14000,
    batteryChargePeakW: 0,
    batteryDischargePeakW: 0,
    solarPeakW: 0,
  }, 'dashboard-only peaks default to 0 (meter hidden) when not configured');

  const { c } = makeController([], {
    maxAmps: 16,
    phases: 3,
    voltage: 230,
    maxHouseholdA: 10000 / 230,
    householdPhases: 1,
    peakSolarW: 6000,
    peakBatteryChargeW: 3000,
    peakBatteryDischargeW: 2600,
  });
  assert.deepEqual(c.getDiagnostics().limits, {
    chargerMaxW: 16 * 230 * 3,
    gridMaxW: 10000,
    batteryChargePeakW: 3000,
    batteryDischargePeakW: 2600,
    solarPeakW: 6000,
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

test('destroy() clears every timer it scheduled', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const scheduled = new Set<NodeJS.Timeout>();
  const cleared = new Set<NodeJS.Timeout>();
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    const handle = realSetTimeout(fn, ms);
    scheduled.add(handle);
    return handle;
  }) as typeof setTimeout;
  global.clearTimeout = ((handle: NodeJS.Timeout) => {
    cleared.add(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  try {
    const { c } = makeController([]); // init() arms the backstop timer
    c.destroy();
    assert.ok(scheduled.size >= 1, 'at least the backstop timer was scheduled');
    scheduled.forEach((h) => assert.ok(cleared.has(h), 'every scheduled timer was cleared by destroy()'));
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('destroy() unsubscribes from the CentralSystem and ChargePoint, so a later reconnect cannot revive it', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({
    identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();

  cs.emit('connect', cp);
  assert.equal(logs.filter((l) => l.includes('Controller bound to')).length, 1, 'bound once');
  assert.ok(cp.listenerCount('status') > 0, 'bind() subscribed to the charge point');

  c.destroy();
  assert.equal(cs.listenerCount('connect'), 0, 'destroy() released the CentralSystem connect listener');
  assert.equal(cs.listenerCount('disconnect'), 0, 'destroy() released the CentralSystem disconnect listener');
  assert.equal(cp.listenerCount('status'), 0, 'destroy() released the ChargePoint listeners');

  // The failure this guards: CentralSystem/ChargePoint live on the App, so a
  // still-subscribed dead controller gets revived by the next reconnect and
  // starts writing profiles again alongside the live one.
  const before = logs.length;
  cs.emit('connect', cp);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { power: 3000 });
  assert.equal(logs.length, before, 'a destroyed controller reacts to nothing');
  assert.equal(logs.filter((l) => l.includes('Controller bound to')).length, 1, 'never re-bound');
});

test('re-binding a different ChargePoint instance drops the previous one\'s listeners', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const mkCp = () => {
    const cp = new ChargePoint({
      identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
    });
    cp.attach(fakeClient);
    return cp;
  };
  const first = mkCp();
  const second = mkCp();

  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => ({ schedule: [] } as Record<string, unknown>)[k] as T,
    setStore: async () => {},
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();

  cs.emit('connect', first);
  assert.ok(first.listenerCount('status') > 0);
  cs.emit('connect', second);
  assert.equal(first.listenerCount('status'), 0, 'the superseded charge point is no longer listened to');
  assert.ok(second.listenerCount('status') > 0, 'the new one is');
  c.destroy();
});

// ---------------------------------------------------------------------------
// isWithinSchedule()
// ---------------------------------------------------------------------------

test('isWithinSchedule() reports whether now falls inside a configured window', () => {
  const { c } = makeController(SCHED);
  assert.equal(c.isWithinSchedule(at(1, 10, 0)), true);
  assert.equal(c.isWithinSchedule(at(1, 20, 0)), false);
});

// ---------------------------------------------------------------------------
// CentralSystem connect/disconnect wiring, and bind()'s same-ChargePoint
// reconnect branch (distinct from a fresh bind)
// ---------------------------------------------------------------------------

test('binds on a connect event, treats a rebind of the same ChargePoint as a reconnect, and disconnect clears it', () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  let availableCount = 0;
  let unavailableMsg: string | null = null;
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {
      availableCount += 1;
    },
    setUnavailable: (msg) => {
      unavailableMsg = msg;
    },
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.equal(availableCount, 0, 'no charge point connected at init - not bound yet');

  cs.emit('connect', cp);
  assert.equal(availableCount, 1, 'bind() marks the device available');
  assert.ok(logs.some((l) => l.includes('Controller bound to')));

  calls.length = 0;
  logs.length = 0;
  cs.emit('connect', cp); // the same ChargePoint object reconnecting (client swapped)
  assert.ok(logs.some((l) => l.includes('reconnected')), 'a rebind of the same ChargePoint logs distinctly from a fresh bind');
  assert.ok(calls.includes('TriggerMessage'), 'a reconnect still requests a fresh status/meter read');
  assert.equal(logs.filter((l) => l.includes('Controller bound to')).length, 0, 'not treated as a fresh bind a second time');

  cs.emit('disconnect', cp);
  assert.equal(unavailableMsg, 'Charger offline - no OCPP connection');
  assert.ok(logs.some((l) => l.includes('[ocpp] offline')));
  assert.equal(c.isOnline(), false);
});

// ---------------------------------------------------------------------------
// configureCharger() (boot-triggered) and its catch branch
// ---------------------------------------------------------------------------

test('a boot event triggers configureCharger(), which logs rather than throws on a rejected write', async () => {
  const calls: string[] = [];
  let rejectConfig = false;
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method);
      if (method === 'ChangeConfiguration' && rejectConfig) throw new Error('NotSupported');
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  calls.length = 0;

  cp.emit('boot', { chargePointVendor: 'Wallbox', chargePointModel: 'Pulsar Max' });
  await new Promise((r) => setTimeout(r, 0)); // let configureCharger()'s awaited calls settle
  assert.ok(calls.filter((m) => m === 'ChangeConfiguration').length >= 1);

  rejectConfig = true;
  calls.length = 0;
  cp.emit('boot', { chargePointVendor: 'Wallbox', chargePointModel: 'Pulsar Max' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(logs.some((l) => l.includes('Charger rejected MeterValues config')),
    'a rejected ChangeConfiguration is caught and logged, not left to crash the controller');
});

// ---------------------------------------------------------------------------
// Error-handling catch branches around outbound OCPP writes
// ---------------------------------------------------------------------------

test('a failed remote start attempt resets awaitingStart and reports the error, without throwing', async () => {
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      if (method === 'RemoteStartTransaction') throw new Error('boom');
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const errors: unknown[][] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: (...a) => {
      errors.push(a);
    },
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  await c.startManual(16);

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(errors.some((e) => e[0] === 'remoteStart'), 'the failure is reported via host.error, not thrown');
});

test('a failed SetChargingProfile write is caught and reported, not thrown', async () => {
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      if (method === 'SetChargingProfile') throw new Error('rejected by charger');
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 0,
  };
  const errors: unknown[][] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: (...a) => {
      errors.push(a);
    },
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }); // plugged -> eligible to write
  await c.startManual(16);
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(errors.some((e) => e[0] === 'SetChargingProfile failed:'),
    'a rejected profile write is caught and reported, not left to crash the controller');
});

// ---------------------------------------------------------------------------
// scheduleWrite()'s throttled (deferred) path
// ---------------------------------------------------------------------------

test('scheduleWrite() defers a write until writeThrottleMs has elapsed since the last one', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 200,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  await c.startManual(16);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.includes('SetChargingProfile'), 'first write goes through immediately (no prior write to throttle against)');

  calls.length = 0;
  await c.setCurrentLimit(20); // a genuine target change, immediately after the first write
  assert.ok(!calls.includes('SetChargingProfile'), 'throttled - deferred rather than sent immediately');

  await new Promise((r) => setTimeout(r, 250));
  assert.ok(calls.includes('SetChargingProfile'), 'the deferred write eventually fires once the throttle window elapses');
});

test('a hard cap tightening further jumps the write throttle instead of waiting it out', async () => {
  const writes: number[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: unknown) => {
      if (method === 'SetChargingProfile') {
        writes.push((params as { csChargingProfiles: { chargingSchedule: { chargingSchedulePeriod: [{ limit: number }] } } })
          .csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit);
      }
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  // Spans every day/hour so onSolarSample's own real-time tick lands inside
  // it regardless of when the test actually runs - avoids juggling a
  // fictional schedule-window clock against onSolarSample's real one.
  const sched: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 12, boostToCap: true,
  }];
  const store: Record<string, unknown> = { schedule: sched };
  const settings: Record<string, unknown> = {
    minAmps: 6,
    maxAmps: 32,
    phases: 1,
    voltage: 230,
    maxHouseholdA: 14000 / 230,
    householdPhases: 1,
    sharedCircuitA: 30,
    sharedCircuitBufferA: 0,
    sharedCircuitIncludeBattery: true,
    writeThrottleMs: 5000,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  // Solar data primed before the transaction exists, so desiredAmps is
  // already the boosted 30A by the time onStartTransaction's own write fires
  // (rather than that write firing early off the pre-solar-data 12A floor).
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 }); // idle battery -> circuit cap 30A
  cp.emit('startTransaction', 1, { idTag: 'x', meterStart: 0 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, [30],
    'boosted floor 12A -> 30A, first write goes through immediately (no prior write to throttle against)');

  // Battery ramps up hard on the shared circuit -> cap tightens 30A -> 10A,
  // well within the 5s throttle window of the write above.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, [30, 10],
    'the tightened cap is written immediately instead of waiting out writeThrottleMs');
});

test('a routine decrease with no cap tightening still respects the write throttle', async () => {
  const calls: string[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string) => {
      calls.push(method); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, writeThrottleMs: 200,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  await c.startManual(20);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.includes('SetChargingProfile'), 'first write goes through immediately (no prior write to throttle against)');

  calls.length = 0;
  await c.setCurrentLimit(10); // a manual decrease, not driven by a cap tightening
  assert.ok(!calls.includes('SetChargingProfile'),
    'still throttled - a plain decrease is not treated as urgent, only a cap getting tighter is');

  await new Promise((r) => setTimeout(r, 250));
  assert.ok(calls.includes('SetChargingProfile'), 'the deferred write eventually fires once the throttle window elapses');
});

test('an urgent cap-tightening write cancels an already-pending throttled write, not just a future one', async () => {
  const writes: number[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: unknown) => {
      if (method === 'SetChargingProfile') {
        writes.push((params as { csChargingProfiles: { chargingSchedule: { chargingSchedulePeriod: [{ limit: number }] } } })
          .csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit);
      }
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6,
    maxAmps: 32,
    phases: 1,
    voltage: 230,
    maxHouseholdA: 14000 / 230,
    householdPhases: 1,
    sharedCircuitA: 25,
    sharedCircuitBufferA: 0,
    sharedCircuitIncludeBattery: true,
    writeThrottleMs: 300,
  };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  // Latch the manual target before the charger is plugged in, so the only
  // write that ever fires is the eventual 16A one - not a spurious 0A write
  // off the bare Charging status alone.
  await c.startManual(16);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, [16], 'first write goes through immediately (no prior write to throttle against)');

  // Establishes lastSharedCircuitCapAmps (25A, idle battery) without itself
  // tightening anything yet - there's no prior sample to compare against.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 });

  // A genuine target change lands right after the first write - throttled,
  // so it only queues a deferred write rather than sending immediately.
  await c.setCurrentLimit(20);
  assert.deepEqual(writes, [16], 'the 20A write is deferred, not sent yet - still inside writeThrottleMs');

  // The battery ramps up hard before that deferred write fires -> shared
  // circuit cap collapses 25A -> 5A, below the 20A just requested.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, [16, 0],
    'the urgent write cancels the still-pending 20A write and sends the freshly-capped 0A instead');

  // The original deferred write's timer must actually have been cancelled -
  // nothing further arrives once it would have fired.
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(writes, [16, 0], 'no stale 20A write leaks out once the original throttle window passes');
});

// ---------------------------------------------------------------------------
// Unified started/paused/stopped Flow event, fault trigger, vehicle
// connect/disconnect triggers, and resumeAutomatic()
// ---------------------------------------------------------------------------

function makeBoundController(extraStore: Record<string, unknown> = {}, extraSettings: Record<string, unknown> = {}): {
  c: ChargeController; cp: ChargePoint; caps: Record<string, unknown>; store: Record<string, unknown>;
  events: { event: string; tokens: ChargingTokens }[]; faults: string[];
  connectEvents: true[]; disconnectEvents: true[];
  logs: string[]; warnings: (string | null)[];
  calls: { method: string; params?: Record<string, unknown> }[];
} {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params }); return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], ...extraStore };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1, ...extraSettings,
  };
  const caps: Record<string, unknown> = {};
  const events: { event: string; tokens: ChargingTokens }[] = [];
  const faults: string[] = [];
  const connectEvents: true[] = [];
  const disconnectEvents: true[] = [];
  const logs: string[] = [];
  const warnings: (string | null)[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: (msg) => {
      warnings.push(msg);
    },
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
    onChargingEvent: (event, tokens) => {
      events.push({ event, tokens });
    },
    onFault: (errorCode) => {
      faults.push(errorCode);
    },
    onVehicleConnected: () => {
      connectEvents.push(true);
    },
    onVehicleDisconnected: () => {
      disconnectEvents.push(true);
    },
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return {
    c, cp, caps, store, events, faults, connectEvents, disconnectEvents, logs, warnings, calls,
  };
}

test('the unified charging event fires started/paused/started across Charging -> SuspendedEVSE -> Charging', () => {
  const { cp, events } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'SuspendedEVSE' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.deepEqual(events.map((e) => e.event), ['started', 'paused', 'started']);
});

test('a repeated identical status does not re-emit the charging event', () => {
  const { cp, events } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.deepEqual(events.map((e) => e.event), ['started']);
});

test('Charging -> Finishing emits a single stopped event', () => {
  const { cp, events } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Finishing' });
  assert.deepEqual(events.map((e) => e.event), ['started', 'stopped']);
});

test('a transient Available (reconnect blip) does not emit a stopped or a redundant started event', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const pending = new Set<() => void>();
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    pending.add(fn);
    return { fn } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const fn = (handle as { fn?: () => void } | undefined)?.fn;
    if (fn) pending.delete(fn);
  }) as typeof clearTimeout;

  try {
    const { cp, events } = makeBoundController({ transactionId: 55 });
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
    pending.clear(); // isolate what this specific Available report schedules
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
    const idleReconcileFn = [...pending][0];
    assert.ok(idleReconcileFn, 'a debounced reconcile was armed');

    // The real Wallbox flips back to Charging well within the debounce window.
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
    assert.ok(!pending.has(idleReconcileFn), 'the pending reconcile was cancelled by the Charging status');
    assert.deepEqual(events.map((e) => e.event), ['started'],
      'no stopped in between, and the repeat Charging is deduped against the still-current started event');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('a genuinely sustained Available eventually emits a stopped event', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const pending = new Set<() => void>();
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    pending.add(fn);
    return { fn } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const fn = (handle as { fn?: () => void } | undefined)?.fn;
    if (fn) pending.delete(fn);
  }) as typeof clearTimeout;

  try {
    const { cp, events } = makeBoundController({ transactionId: 55 });
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
    pending.clear();
    cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
    const idleReconcileFn = [...pending][0];
    assert.ok(idleReconcileFn, 'a debounced reconcile was armed');

    idleReconcileFn(); // simulate the debounce delay elapsing with no follow-up status
    assert.deepEqual(events.map((e) => e.event), ['started', 'stopped']);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('charging-event tokens include target current, mode, live surplus, and session energy', async () => {
  const { c, cp, events } = makeBoundController();
  await c.startManual(16);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('startTransaction', 9, {
    connectorId: 1, idTag: 'CHARGEIQ', meterStart: 1000000, timestamp: new Date().toISOString(),
  });
  c.onSolarSample({ gridSignedW: -500, pvW: 500, batteryW: 0 }); // primes lastAvailableW for the surplus token
  cp.emit('meterValues', { energyKwh: 1002.5 }); // cumulative register reading; 2.5 kWh delivered this session

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Finishing' });

  const stopped = events.find((e) => e.event === 'stopped');
  assert.ok(stopped);
  assert.equal(stopped!.tokens.current, 16, 'target current at the moment charging stopped');
  assert.equal(stopped!.tokens.mode, 'manual');
  assert.ok(stopped!.tokens.surplus >= 0);
  assert.equal(stopped!.tokens.sessionEnergy, 2.5);
});

test('a Faulted status fires onFault with the errorCode', () => {
  const { cp, faults } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'GroundFailure', status: 'Faulted' });
  assert.deepEqual(faults, ['GroundFailure']);
});

test('a non-fault status does not fire onFault', () => {
  const { cp, faults } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.deepEqual(faults, []);
});

test('a Faulted status raises alarm_generic, and it clears on recovery', () => {
  const { cp, caps } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.equal(caps.alarm_generic, false);
  cp.emit('status', { connectorId: 1, errorCode: 'GroundFailure', status: 'Faulted' });
  assert.equal(caps.alarm_generic, true);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.equal(caps.alarm_generic, false);
});

test('session energy and duration capabilities update from a live transaction', () => {
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const { cp, caps } = makeBoundController({
    transactionId: 7, meterStartWh: 1_000_000, sessionStartMs: fiveMinAgo,
  });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { energyKwh: 1002.5 }); // cumulative register; 2.5 kWh this session
  assert.equal(caps['meter_power.session'], 2.5);
  assert.equal(caps.session_duration, 5);
});

test('an unhandled measurand is logged once, and only the newly-seen ones on a later report', () => {
  const { cp, logs } = makeBoundController();
  cp.emit('meterValues', { power: 7200, unhandled: { SoC: '42 Percent' } });
  const first = logs.filter((l) => l.includes('not used by this app'));
  assert.equal(first.length, 1);
  assert.match(first[0], /measurand not used by this app: SoC=42 Percent/);

  // Same measurand again (every 10s in reality) must not repeat.
  cp.emit('meterValues', { power: 7200, unhandled: { SoC: '43 Percent' } });
  assert.equal(logs.filter((l) => l.includes('not used by this app')).length, 1);

  // A name not seen before still gets reported, on its own.
  cp.emit('meterValues', {
    power: 7200,
    unhandled: { SoC: '44 Percent', 'Current.Offered': '16 A', Temperature: '21 Celsius' },
  });
  const lines = logs.filter((l) => l.includes('not used by this app'));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /measurands not used by this app: Current\.Offered=16 A, Temperature=21 Celsius/);
  assert.equal(lines[1].includes('SoC'), false, 'already-reported name is not repeated');
});

test('meter values with no unhandled measurands log nothing extra', () => {
  const { cp, logs } = makeBoundController();
  cp.emit('meterValues', { power: 7200 });
  assert.equal(logs.some((l) => l.includes('not used by this app')), false);
});

test('session meters are not written without a live transaction', () => {
  const { cp, caps } = makeBoundController(); // no transactionId in store
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { energyKwh: 5 });
  assert.equal(caps['meter_power.session'], undefined);
  assert.equal(caps.session_duration, undefined);
});

test('starting a new transaction re-bases the session meters to zero', () => {
  const { cp, caps, store } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('startTransaction', 11, {
    connectorId: 1, idTag: 'x', meterStart: 500_000, timestamp: new Date().toISOString(),
  });
  assert.equal(caps['meter_power.session'], 0);
  assert.equal(caps.session_duration, 0);
  assert.equal(store.meterStartWh, 500_000);
  assert.equal(typeof store.sessionStartMs, 'number');
});

test('a fresh plug-in fires onVehicleConnected exactly once, not on every subsequent plugged status', () => {
  const { cp, connectEvents } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // establishes prevPlugged=false
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  assert.equal(connectEvents.length, 1);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  assert.equal(connectEvents.length, 1, 'Preparing -> Charging is not a fresh plug-in');
});

test('booting straight into a plugged status fires neither connect nor disconnect (prevPlugged unknown)', () => {
  const { cp, connectEvents, disconnectEvents } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  assert.equal(connectEvents.length, 0, 'prevPlugged was null (never observed idle), not a genuine edge');
  assert.equal(disconnectEvents.length, 0);
});

test('an unplug fires onVehicleDisconnected', () => {
  const { cp, connectEvents, disconnectEvents } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // baseline
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  assert.equal(connectEvents.length, 1);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  assert.equal(disconnectEvents.length, 1);
});

test('unplugging a charger mid-session zeroes measure_power/measure_current instead of leaving the last charging reading stuck', () => {
  // Regression: a Wallbox stops sending MeterValues once a session ends, so
  // without an explicit reset on a confirmed stop, measure_power/current -
  // and anything reading them, e.g. the power-flow widget's EV tile - would
  // keep showing the last charging draw forever, even though
  // evcharger_charging_state (same StatusNotification) already reads
  // plugged_out.
  const { cp, caps } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // baseline (prevPlugged=false)
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { power: 7200, current: 32 });
  assert.equal(caps.measure_power, 7200);
  assert.equal(caps.evcharger_charging_state, 'plugged_in_charging');

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // unplugged
  assert.equal(caps.evcharger_charging_state, 'plugged_out');
  assert.equal(caps.measure_power, 0, 'power reading is cleared, not left at the last charging value');
  assert.equal(caps.measure_current, 0);
});

test('a transient Available reconnect blip (live transactionId) does not zero measure_power', () => {
  // Mirrors the debounced-idle-reconciliation scenario elsewhere in this
  // file: a lone Available report right after reconnect can flip back to
  // Charging under a second later. nettedChargerW() already treats this as
  // unknown (not confirmed-0) while a transactionId is still on record, and
  // the capability reset must respect the same caution - zeroing here would
  // wipe a real, still-live reading out from under an active session.
  const { cp, caps } = makeBoundController({ transactionId: 29 }); // c.init() loads a still-live transaction id
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  cp.emit('meterValues', { power: 7200 });

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' }); // reconnect blip
  assert.equal(caps.measure_power, 7200, 'not wiped while a transaction is still on record, unreconciled');

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' }); // flips back, as on real hardware
  assert.equal(caps.measure_power, 7200, 'reading survives the blip since it was never actually cleared');
});

test('resumeAutomatic() clears a manual latch and re-resolves out of manual mode', async () => {
  const { c } = makeBoundController();
  await c.startManual(16);
  assert.equal(c.getMode(), 'manual');
  c.resumeAutomatic();
  assert.equal(c.getMode(), 'solar', 'no schedule configured, so it falls back to the default Solar branch');
});

test('resumeAutomatic() is a no-op when no manual latch is set', () => {
  const { c, store } = makeBoundController();
  c.resumeAutomatic();
  assert.equal(store.manualLatch, undefined, 'setStore was never called - nothing to clear');
});

// ---------------------------------------------------------------------------
// OCPP connectivity: offline detection + reporting
// ---------------------------------------------------------------------------

interface ConnHarness {
  c: ChargeController;
  cp: ChargePoint;
  cs: CentralSystem;
  store: Record<string, unknown>;
  logs: string[];
  unavailable: (string | null)[];
  availableCount: () => number;
  conn: { online: boolean; offlineForMs: number | null }[];
  /** Run the pending startup-grace callback, standing in for its 120s elapsing. */
  fireGrace: () => void;
}

/**
 * A controller wired to a CentralSystem we can drive connect/disconnect on.
 * init() runs with setTimeout stubbed so the one-shot startup-grace timer can be
 * fired on demand instead of waiting out STARTUP_GRACE_MS.
 */
function makeConnController(extraStore: Record<string, unknown> = {}): ConnHarness {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  // Watchdog off: this harness drives disconnects explicitly, and its own
  // coverage lives in charge-point.test.ts.
  const cp = new ChargePoint({
    identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], ...extraStore };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 14000 / 230, householdPhases: 1,
  };
  const logs: string[] = [];
  const unavailable: (string | null)[] = [];
  const conn: { online: boolean; offlineForMs: number | null }[] = [];
  const h = { availableCount: 0 };
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {
      h.availableCount += 1;
    },
    setUnavailable: (msg) => {
      unavailable.push(msg);
    },
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
    onConnectivityChanged: (online, offlineForMs) => {
      conn.push({ online, offlineForMs });
    },
  };
  // Nothing bound at init(), so the startup grace window applies.
  const cs = Object.assign(new EventEmitter(), {
    getChargePoint: (): ChargePoint | undefined => undefined,
  }) as unknown as CentralSystem;
  const c = new ChargeController(host, cs);

  let grace: (() => void) | null = null;
  const realSetTimeout = global.setTimeout;
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) => {
    if (ms === 120000) grace = fn;
    return { id: 1 } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    c.init();
  } finally {
    global.setTimeout = realSetTimeout;
  }

  return {
    c,
    cp,
    cs,
    store,
    logs,
    unavailable,
    availableCount: () => h.availableCount,
    conn,
    fireGrace: () => {
      if (!grace) throw new Error('no startup-grace timer was armed');
      grace();
    },
  };
}

test('toChargingState maps every OCPP status onto Homey\'s evcharger_charging_state enum', () => {
  // Only Charging counts as actively charging.
  assert.equal(toChargingState('Charging'), 'plugged_in_charging');
  // Everything that means "a cable is in, but no current is flowing" collapses
  // to plugged_in - including Faulted and Reserved, which are not idle states.
  for (const s of ['Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Reserved', 'Faulted'] as const) {
    assert.equal(toChargingState(s), 'plugged_in', s);
  }
  // Available is genuinely nothing plugged in; Unavailable is the charger taken
  // out of service, which is reported through the offline/warning path instead,
  // so as a *charging* state it is likewise "no cable".
  assert.equal(toChargingState('Available'), 'plugged_out');
  assert.equal(toChargingState('Unavailable'), 'plugged_out');
  // An unrecognised status must fall through to plugged_out rather than
  // producing a value Homey's enum does not accept.
  assert.equal(toChargingState('SomethingNew' as OcppStatus), 'plugged_out');
});

test('fmtDuration renders a compact age across every unit boundary', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(12 * 60_000), '12m');
  assert.equal(fmtDuration(3 * 3_600_000), '3h');
  assert.equal(fmtDuration(12 * 3_600_000), '12h');
  assert.equal(fmtDuration(5 * 86_400_000), '5d');
});

test('connectivity starts unknown, not offline - an app restart must not report an outage that may not exist', () => {
  const h = makeConnController();
  assert.equal(h.c.getConnectionInfo().online, null, 'unresolved during the startup grace window');
  assert.equal(h.c.isOnline(), false, 'and isOnline() only ever claims a confirmed link');
  assert.deepEqual(h.conn, [], 'nothing reported yet');
  assert.deepEqual(h.unavailable, [], 'the device is not marked unavailable on a hunch');
});

test('a charger that connects within the grace window comes up silently, firing no Flow trigger', () => {
  const h = makeConnController();
  h.cs.emit('connect', h.cp);
  assert.equal(h.c.getConnectionInfo().online, true);
  assert.equal(h.c.isOnline(), true);
  assert.equal(h.availableCount(), 1);
  assert.deepEqual(h.conn, [], 'null -> true is the normal app-start path, not a recovery worth alerting on');
});

test('the grace window expiring with nothing connected reports the charger offline', () => {
  const h = makeConnController();
  h.fireGrace();
  assert.equal(h.c.getConnectionInfo().online, false);
  assert.deepEqual(h.unavailable, ['Charger offline - no OCPP connection']);
  assert.equal(h.conn.length, 1);
  assert.equal(h.conn[0].online, false);
  assert.equal(h.conn[0].offlineForMs, null, 'never seen this install - no last-contact time to measure from');
});

test('an outage spanning an app restart is still measured from the persisted last-contact time', () => {
  const twelveHoursAgo = Date.now() - 12 * 3_600_000;
  const h = makeConnController({ ocppLastSeenAt: twelveHoursAgo });
  h.fireGrace();

  const info = h.c.getConnectionInfo();
  assert.equal(info.online, false);
  assert.equal(info.offlineSince, new Date(twelveHoursAgo).toISOString(),
    'the outage predates this process - without the persisted value it would read as freshly gone');
  assert.equal(h.conn.length, 1);
  assert.ok(h.conn[0].offlineForMs! >= 12 * 3_600_000);
  assert.ok(h.logs.some((l) => l.includes('[ocpp] offline') && l.includes('12h ago')));
});

test('a disconnect reports offline, and the reconnect reports how long the outage lasted', () => {
  const h = makeConnController();
  h.cs.emit('connect', h.cp);
  h.conn.length = 0;

  // The link's last contact was an hour ago as far as the charge point knows.
  const hourAgo = Date.now() - 3_600_000;
  h.cp.emit('disconnect'); // not the CentralSystem's own event - see below
  assert.deepEqual(h.conn, [], 'the controller listens to the CentralSystem, not the ChargePoint directly');

  h.cs.emit('disconnect', h.cp);
  assert.equal(h.c.getConnectionInfo().online, false);
  assert.equal(h.c.isOnline(), false);
  assert.equal(h.conn.length, 1);
  assert.equal(h.conn[0].online, false);
  assert.ok(h.store.ocppLastSeenAt != null, 'the disconnect edge forces the last-seen write through');

  // Rewind the persisted figure to simulate an hour of downtime, then reconnect.
  h.store.ocppLastSeenAt = hourAgo;
  const h2 = makeConnController({ ocppLastSeenAt: hourAgo });
  h2.fireGrace();
  h2.cs.emit('connect', h2.cp);
  const recovery = h2.conn.filter((e) => e.online);
  assert.equal(recovery.length, 1, 'false -> true is a genuine recovery and is reported');
  assert.ok(recovery[0].offlineForMs! >= 3_600_000);
  assert.ok(h2.logs.some((l) => l.includes('[ocpp] online') && l.includes('offline')));
});

test('a repeated disconnect does not re-report an outage already reported', () => {
  const h = makeConnController();
  h.cs.emit('connect', h.cp);
  h.cs.emit('disconnect', h.cp);
  h.cs.emit('disconnect', h.cp);
  assert.equal(h.conn.filter((e) => !e.online).length, 1);
});

test('while offline, a last-known-Charging draw is reported unknown rather than as a live reading', () => {
  const h = makeConnController();
  h.cs.emit('connect', h.cp);
  h.cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  h.cp.emit('meterValues', { power: 7200 });
  assert.equal(h.c.getDiagnostics().chargerPowerW, 7200, 'live and known while connected');

  h.cs.emit('disconnect', h.cp);
  assert.equal(h.c.getDiagnostics().chargerPowerW, null,
    'the reading is now as old as the outage - null is "unknown", which callers must not default to 0');
});

test('while offline, a last-known-idle charger still nets as a confirmed zero', () => {
  const h = makeConnController();
  h.cs.emit('connect', h.cp);
  h.cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  h.cs.emit('disconnect', h.cp);
  assert.equal(h.c.getDiagnostics().chargerPowerW, 0,
    'the conservative direction, and it keeps a never-connected charger from disabling every cap');
});

test('the decision log calls out that a resolved target could not be sent while offline', () => {
  const h = makeConnController();
  h.fireGrace();
  h.logs.length = 0;
  h.c.tick(new Date(), 'timer');
  const line = h.logs.filter((l) => l.startsWith('[decision:')).pop();
  assert.ok(line?.includes('OFFLINE'), `expected the link state in the decision line, got: ${line}`);
  assert.ok(line?.includes('not sent'));
});

// ---------------------------------------------------------------------------
// The Finishing deadlock, and the stale transaction id behind it
// (both reproduced from a real hardware log: charger restarted mid-schedule,
// PowerLoss ended its session, and the app then spent 3m14s resolving
// 21A -> 22A -> 23A without attempting a single write)
// ---------------------------------------------------------------------------

const status = (s: string) => ({ connectorId: 1, errorCode: 'NoError', status: s });
const decisions = (logs: string[]) => logs.filter((l) => l.startsWith('[decision:'));

test('a target the charger cannot be given is logged as NOT SENT, never as if it had been applied', () => {
  const { c, cp, logs } = makeBoundController();
  cp.emit('startTransaction', 49, {
    connectorId: 1, idTag: 'X', meterStart: 0, timestamp: '',
  });
  cp.emit('status', status('Charging'));
  c.setSolarTarget(21);
  assert.ok(decisions(logs).pop()?.includes('-> 21A'));
  assert.ok(!decisions(logs).pop()?.includes('NOT SENT'), 'a live session applies normally');

  // PowerLoss ends the session; the Wallbox parks in Finishing, which clears
  // the transaction id and leaves ensureCharging() with nothing to write to.
  logs.length = 0;
  cp.emit('status', status('Finishing'));
  const line = decisions(logs).pop();
  assert.ok(line?.includes('-> 21A'), 'the decision itself is unchanged - solar still wants 21A');
  assert.ok(line?.includes('NOT SENT'), `expected a NOT SENT note, got: ${line}`);
  assert.ok(line?.includes('Finishing'), 'and it names the actual reason');
});

test('parking in Finishing with a live target raises a replug warning, cleared once it recovers', () => {
  const { c, cp, warnings } = makeBoundController();
  cp.emit('startTransaction', 49, {
    connectorId: 1, idTag: 'X', meterStart: 0, timestamp: '',
  });
  cp.emit('status', status('Charging'));
  c.setSolarTarget(21);
  warnings.length = 0;

  cp.emit('status', status('Finishing'));
  assert.equal(warnings.length, 1);
  assert.ok(String(warnings[0]).includes('unplug and replug'),
    'the one thing the user actually has to do, said out loud');

  // The physical replug: Finishing -> Available -> SuspendedEV, as on hardware.
  cp.emit('status', status('Available'));
  cp.emit('status', status('SuspendedEV'));
  assert.equal(warnings[warnings.length - 1], null, 'cleared once the charger can be driven again');
});

test('the replug warning does not fire for an ordinary idle charger with nothing plugged in', () => {
  const {
    c, cp, warnings, logs,
  } = makeBoundController();
  cp.emit('status', status('Available'));
  c.setSolarTarget(21);
  assert.deepEqual(warnings.filter((w) => w != null), [], 'no car plugged in is not something to nag about');
  assert.ok(decisions(logs).pop()?.includes('NOT SENT'), 'still logged honestly, just not escalated to a banner');
});

test('a fault warning is not clobbered by the next non-Faulted status report', () => {
  const { cp, warnings } = makeBoundController();
  cp.emit('status', { connectorId: 1, errorCode: 'GroundFailure', status: 'Faulted' });
  assert.ok(String(warnings[warnings.length - 1]).includes('GroundFailure'));
  cp.emit('status', status('Charging'));
  assert.equal(warnings[warnings.length - 1], null, 'and does clear once the fault actually goes away');
});

test('recovering from Finishing writes the profile even though the target never changed while blocked', () => {
  const { c, cp, logs } = makeBoundController();
  cp.emit('startTransaction', 49, {
    connectorId: 1, idTag: 'X', meterStart: 0, timestamp: '',
  });
  cp.emit('status', status('Charging'));
  c.setSolarTarget(21);
  cp.emit('status', status('Finishing'));

  // Targets keep moving while blocked - exactly what the hardware log showed -
  // so on recovery the value itself is unchanged and only the eligibility
  // transition can trigger the write.
  c.setSolarTarget(23);
  logs.length = 0;
  assert.equal(logs.filter((l) => l.includes('setting profile')).length, 0, 'nothing written while parked');

  cp.emit('status', status('Available'));
  cp.emit('status', status('SuspendedEV'));
  assert.ok(logs.some((l) => l.includes('setting profile: 23A')),
    'becoming write-eligible again must flush the current target, not wait for it to move');
});

test('bind() adopts the charge point\'s own transaction id over a stale stored one', () => {
  // Captures whatever attach() registers, so the real StartTransaction handler
  // can be driven - the point of this test is the id the *handler* records
  // while no controller is listening, which faking the event would skip.
  let startTransaction: ((ctx: { params: unknown }) => Record<string, unknown>) | null = null;
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: (m: unknown, h?: unknown) => {
      if (m === 'StartTransaction') startTransaction = h as typeof startTransaction;
    },
    call: async () => ({ status: 'Accepted' }),
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 49 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 48 };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => ({
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 60, householdPhases: 1,
    } as Record<string, unknown>)[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = Object.assign(new EventEmitter(), {
    getChargePoint: (): ChargePoint | undefined => undefined,
  }) as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.equal(store.transactionId, 48, 'nothing bound yet - the stored id stands');

  // The charge point answers a StartTransaction with 49 while nobody is
  // listening (device init racing the OCPP connection), then the controller
  // binds. Nothing persisted the id, so the store still says 48.
  const res = startTransaction!({
    params: {
      connectorId: 1, idTag: 'X', meterStart: 0, timestamp: '',
    },
  });
  assert.equal(res.transactionId, 49, 'the charger was told 49');
  assert.equal(store.transactionId, 48, 'and nothing wrote it down');
  cs.emit('connect', cp);

  assert.equal(store.transactionId, 49, 'the live connection wins over a previous process\'s record');
  assert.ok(logs.some((l) => l.includes('adopting transaction 49')));
  assert.ok(c.isCharging(), 'and the controller now tracks a session it would otherwise have missed');
});

test('a StopTransaction for an id we were not tracking is called out explicitly', () => {
  const { cp, logs } = makeBoundController();
  cp.emit('startTransaction', 48, {
    connectorId: 1, idTag: 'X', meterStart: 0, timestamp: '',
  });
  logs.length = 0;
  cp.emit('stopTransaction', {
    transactionId: 49, meterStop: 5324929, timestamp: '', reason: 'PowerLoss',
  });
  assert.ok(logs.some((l) => l.includes('transaction id mismatch') && l.includes('49') && l.includes('48')),
    'the tell-tale for a write that was going to a dead session');
});

/**
 * A controller whose charger can be told to reject any TxProfile (i.e. not
 * recognise the transaction id), for the write-retry path.
 */
function makeRetryController(rejectTxProfile: boolean): {
  c: ChargeController; cp: ChargePoint; logs: string[];
  profileTxIds: () => (number | undefined)[];
} {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method !== 'SetChargingProfile') return { status: 'Accepted' };
      const profile = (params as { csChargingProfiles?: { transactionId?: number } }).csChargingProfiles;
      return { status: profile?.transactionId != null && rejectTxProfile ? 'Rejected' : 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  const store: Record<string, unknown> = { schedule: [], transactionId: 48 };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => ({
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 60, householdPhases: 1,
    } as Record<string, unknown>)[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = { getChargePoint: () => cp, on: () => {}, removeListener: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  return {
    c,
    cp,
    logs,
    profileTxIds: () => calls.filter((x) => x.method === 'SetChargingProfile')
      .map((x) => (x.params as { csChargingProfiles: { transactionId?: number } }).csChargingProfiles.transactionId),
  };
}

/** Let writeProfile()'s awaits settle - it is fired from a synchronous path. */
const settle = () => new Promise((r) => {
  setImmediate(r);
});

test('a rejected TxProfile write is retried once as TxDefaultProfile, which needs no transaction id', async () => {
  const {
    c, cp, logs, profileTxIds,
  } = makeRetryController(true);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  c.setSolarTarget(21);
  await settle();

  assert.deepEqual(profileTxIds(), [48, undefined],
    'the rejected TxProfile is followed immediately by a TxDefaultProfile, not left until the target next moves');
  assert.ok(logs.some((l) => l.includes('retrying as TxDefaultProfile')));
  assert.ok(logs.some((l) => l.includes('profile retry accepted')));
});

test('an accepted TxProfile write is not followed by a pointless retry', async () => {
  const { c, cp, profileTxIds } = makeRetryController(false);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  c.setSolarTarget(21);
  await settle();
  assert.deepEqual(profileTxIds(), [48], 'the retry is specific to a rejection');
});

// ---------------------------------------------------------------------------
// Reporting a solar feed that has stopped delivering
// ---------------------------------------------------------------------------

/** A controller whose warnings and logs are both captured. */
function makeWarnController(extraSettings: Record<string, unknown> = {}, cs?: CentralSystem): {
  c: ChargeController; warnings: Array<string | null>; logs: string[];
} {
  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 63, householdPhases: 1, ...extraSettings,
  };
  const warnings: Array<string | null> = [];
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: (m) => {
      warnings.push(m);
    },
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const c = new ChargeController(
    host,
    cs ?? ({ getChargePoint: () => undefined, on: () => {}, removeListener: () => {} } as unknown as CentralSystem),
  );
  c.init();
  return { c, warnings, logs };
}

const HOUR_MS = 3600_000;

test('a solar feed that stops delivering is reported, and cleared when it comes back', () => {
  // A SolarEdge app wedged on a three-day-old reading.
  const { c, warnings, logs } = makeWarnController();
  c.onSolarSample({ gridSignedW: -3000, pvW: 4440, batteryW: 0 }, Date.now() - 3 * 24 * HOUR_MS);
  c.tick(new Date(), 'timer');

  assert.equal(warnings[warnings.length - 1], 'Solar feed stale - no update from the solar app. Solar charging is paused, '
    + 'and the household/charger-circuit limits are not being applied.');
  assert.ok(logs.some((l) => l.includes('[solar] feed stale - nothing received for 3d')),
    'the log carries the age; the banner deliberately does not (it would rewrite every minute)');

  warnings.length = 0;
  logs.length = 0;
  c.tick(new Date(), 'timer');
  assert.equal(warnings.length, 0, 'the banner is written on the transition, not on every tick');
  assert.equal(logs.filter((l) => l.includes('feed stale')).length, 0, 'and neither is the log line');

  c.onSolarSample({ gridSignedW: -3000, pvW: 4440, batteryW: 0 });
  assert.equal(warnings[warnings.length - 1], null, 'a fresh sample clears the banner');
  assert.ok(logs.some((l) => l.includes('[solar] feed recovered')));
  c.destroy();
});

test('a feed that has never delivered anything is not reported as stale', () => {
  // e.g. a Homey with no solar app at all.
  const { c, warnings, logs } = makeWarnController();
  c.tick(new Date(), 'timer');
  assert.equal(c.solarFeedAgeMs(), null);
  assert.equal(warnings.filter((w) => w != null).length, 0, 'no banner');
  assert.equal(logs.filter((l) => l.includes('feed stale')).length, 0, 'and nothing in the log either');
  c.destroy();
});

test('a brief gap in the solar feed drops the caps without raising a banner', () => {
  // 90s trips the 60s control gate but not the 5-minute reporting threshold.
  const { c, warnings } = makeWarnController({ sharedCircuitA: 32, sharedCircuitIncludeSolar: true });
  c.onSolarSample({ gridSignedW: -3000, pvW: 4440, batteryW: 0 }, Date.now() - 90_000);
  c.tick(new Date(), 'timer');
  assert.equal(c.getDiagnostics().solarFeed.stale, false, '90s is stale for the caps but not worth reporting');
  assert.equal(warnings.filter((w) => w != null).length, 0);
  c.destroy();
});

test('a charger fault outranks the solar-feed banner, and does not clobber it', () => {
  const fakeClient: RpcClient = {
    identity: 'X', handle: () => {}, call: async () => ({ status: 'Accepted' }), close: async () => {}, on: () => {},
  };
  const cp = new ChargePoint({
    identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  cp.attach(fakeClient);
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const { c, warnings } = makeWarnController({}, cs);
  cs.emit('connect', cp);

  c.onSolarSample({ gridSignedW: -3000, pvW: 4440, batteryW: 0 }, Date.now() - 3 * 24 * HOUR_MS);
  c.tick(new Date(), 'timer');
  assert.ok(String(warnings[warnings.length - 1]).startsWith('Solar feed stale'));

  cp.emit('status', { connectorId: 1, errorCode: 'GroundFailure', status: 'Faulted' });
  assert.equal(warnings[warnings.length - 1], 'Charger fault: GroundFailure',
    'the charger\'s own problem is the one worth showing');

  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Available' });
  assert.ok(String(warnings[warnings.length - 1]).startsWith('Solar feed stale'),
    'and clearing the fault surfaces the stale feed again rather than leaving nothing');
  c.destroy();
});

test('the decision line says why a boost-enabled window fell back to its floor', () => {
  const { c, logs } = makeController([{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00', currentA: 12, boostToCap: true,
  }], {
    sharedCircuitA: 32, sharedCircuitBufferA: 2, sharedCircuitIncludeSolar: true, solarStaleSec: 60,
  });
  assert.ok(logs.some((l) => l.includes('boost enabled, but shared-circuit cap unavailable - no solar sample received yet')),
    'before any sample, the cap is unavailable because nothing has been received');

  logs.length = 0;
  // A sample that arrived, then went quiet for longer than solarStaleSec.
  c.onSolarSample({ gridSignedW: -4000, pvW: 4440, batteryW: 0 }, Date.now() - 200_000);
  c.tick(new Date(), 'timer');
  assert.ok(logs.some((l) => l.includes('shared-circuit cap unavailable - solar feed stale, last sample')),
    'a feed that has gone quiet is named as the reason, not left as a bare "unavailable"');
  c.destroy();
});

// ---------------------------------------------------------------------------
// A target resolved before the charger connects still has to reach it
// ---------------------------------------------------------------------------

test('a target resolved while the charger is disconnected is written once it connects', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { status: 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({ identity: 'X', authorize: () => true, nextTransactionId: () => 1 });
  cp.attach(fakeClient);

  // Always-on window (end <= start wraps a full 24h) with boost enabled, and a
  // transaction id restored from a previous process - the app-restart case.
  const store: Record<string, unknown> = {
    transactionId: 93,
    schedule: [{
      days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00', currentA: 12, boostToCap: true,
    }],
  };
  const settings: Record<string, unknown> = {
    minAmps: 6,
    maxAmps: 32,
    phases: 1,
    voltage: 230,
    maxHouseholdA: 63,
    householdPhases: 1,
    sharedCircuitA: 32,
    sharedCircuitBufferA: 2,
    sharedCircuitIncludeSolar: true,
    sharedCircuitIncludeBattery: true,
  };
  const logs: string[] = [];
  const host: ControllerHost = {
    identity: 'X',
    setCapability: () => {},
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: (...a) => {
      logs.push(a.join(' '));
    },
    error: () => {},
  };
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init(); // nothing connected yet; no solar sample yet -> the 12A floor

  // The first solar sample beats the charger's reconnect (by ~11s on hardware),
  // so the boosted target is resolved while nothing is connected.
  c.onSolarSample({ gridSignedW: -4000, pvW: 4440, batteryW: 0 });
  assert.equal(calls.length, 0, 'nothing is written while disconnected');
  assert.ok(logs.some((l) => l.includes('-> 32A')), 'the boosted target was resolved before the charger connected');

  cs.emit('connect', cp);
  await new Promise((r) => setTimeout(r, 0));

  const profiles = calls.filter((k) => k.method === 'SetChargingProfile');
  assert.equal(profiles.length, 1, 'connecting is a write-eligibility edge, even with an unchanged target');
  assert.ok(logs.some((l) => l.includes('[charger] setting profile: 32A')),
    'the target the charger missed is the one it gets');
  c.destroy();
});

// ---------------------------------------------------------------------------
// Writes reconcile against what the charger accepted, not the last decision
// ---------------------------------------------------------------------------

/**
 * A controller bound to a real ChargePoint through a CentralSystem the test
 * drives, with every SetChargingProfile limit captured and a switch to make
 * the charger reject them.
 */
function makeWriteRig(writeThrottleMs: number): {
  c: ChargeController; cp: ChargePoint; cs: CentralSystem; writes: number[];
  caps: Record<string, unknown>; setReject(v: boolean): void;
} {
  const writes: number[] = [];
  let reject = false;
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: unknown) => {
      if (method !== 'SetChargingProfile') return { status: 'Accepted' };
      writes.push((params as { csChargingProfiles: { chargingSchedule: { chargingSchedulePeriod: [{ limit: number }] } } })
        .csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit);
      return { status: reject ? 'Rejected' : 'Accepted' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({
    identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  cp.attach(fakeClient);
  const store: Record<string, unknown> = { schedule: [] };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdA: 63, householdPhases: 1, writeThrottleMs,
  };
  const caps: Record<string, unknown> = {};
  const host: ControllerHost = {
    identity: 'X',
    setCapability: (k, v) => {
      caps[k] = v;
    },
    getSetting: <T>(k: string) => settings[k] as T,
    getStore: <T>(k: string) => store[k] as T,
    setStore: async (k, v) => {
      store[k] = v;
    },
    setAvailable: () => {},
    setUnavailable: () => {},
    setWarning: () => {},
    log: () => {},
    error: () => {},
  };
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  cs.emit('connect', cp);
  cp.emit('status', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
  return {
    c,
    cp,
    cs,
    writes,
    caps,
    setReject: (v) => {
      reject = v;
    },
  };
}

const waitMs = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('a write lost in a reconnect gap between ticks is re-sent when the charger comes back', async () => {
  // A disconnect/reconnect between two ticks: the throttled write fires into
  // the gap and is dropped, and the target never changes again to resend it.
  const {
    c, cs, cp, writes,
  } = makeWriteRig(200);
  await waitMs();
  writes.length = 0;

  await c.startManual(16); // throttled behind the status-driven write just made
  assert.deepEqual(writes, [], 'deferred by the write throttle');

  cs.emit('disconnect', cp); // no tick
  await waitMs(250); // the deferred write fires into the gap, and is dropped
  assert.deepEqual(writes, [], 'nothing can reach a disconnected charger');

  cs.emit('connect', cp);
  await waitMs();
  assert.deepEqual(writes, [16], 'the reconnect re-establishes the limit the gap swallowed');
  c.destroy();
});

test('a same-ChargePoint reconnect re-establishes the limit, even with an unchanged target', async () => {
  const {
    c, cs, cp, writes,
  } = makeWriteRig(0);
  await c.startManual(16);
  await waitMs();
  assert.equal(writes[writes.length - 1], 16);
  writes.length = 0;

  cs.emit('connect', cp); // client swapped under the same ChargePoint - the charger may have rebooted
  await waitMs();
  assert.deepEqual(writes, [16], 'what the charger was last told is not assumed to have survived');
  c.destroy();
});

test('a rejected write is retried on the next tick instead of being abandoned', async () => {
  const {
    c, writes, caps, setReject,
  } = makeWriteRig(0);
  await waitMs();
  setReject(true);
  writes.length = 0;
  await c.startManual(16);
  await waitMs();
  assert.deepEqual(writes, [16], 'attempted once, and rejected');
  assert.equal(caps.charge_current_applied, 0, 'the applied limit stays at the last one the charger took');

  setReject(false);
  c.tick(new Date(), 'timer'); // previously: target unchanged, so nothing was ever sent again
  await waitMs();
  assert.deepEqual(writes, [16, 16]);
  assert.equal(caps.charge_current_applied, 16, 'and once accepted, it is recorded as applied');
  c.destroy();
});

test('a charger rejecting every limit is retried once per tick, not in a loop', { timeout: 3000 }, async () => {
  // Retrying from the write's own completion at writeThrottleMs 0 was an endless
  // loop. The timeout makes a recurrence fail rather than hang.
  const {
    c, writes, setReject,
  } = makeWriteRig(0);
  setReject(true);
  await c.startManual(16);
  await waitMs(20);
  const before = writes.length;
  assert.ok(before <= 3, `a handful of attempts, not a loop (saw ${before})`);

  // Real ticks are seconds apart; yield between them so each finds the last
  // attempt settled (back-to-back ticks correctly find it still in flight).
  for (let i = 0; i < 3; i += 1) {
    c.tick(new Date(), 'timer');
    await waitMs(5); // eslint-disable-line no-await-in-loop
  }
  assert.equal(writes.length - before, 3, 'exactly one retry per tick');
  c.destroy();
});

test('the applied limit is published on acceptance and cleared when the link drops', async () => {
  const {
    c, cs, cp, caps,
  } = makeWriteRig(0);
  await c.startManual(20);
  await waitMs();
  assert.equal(caps.charge_current_limit, 20, 'what the controller decided');
  assert.equal(caps.charge_current_applied, 20, 'and what the charger accepted');

  cs.emit('disconnect', cp);
  assert.equal(caps.charge_current_applied, null, 'unknown once the link is gone - never the last figure as if current');
  c.destroy();
});

test('binding asks the charger to report Current.Offered, and logs it if the charger refuses', async () => {
  const configured: Array<{ key: string; value: string }> = [];
  const fakeClient: RpcClient = {
    identity: 'X',
    handle: () => {},
    call: async (method: string, params?: unknown) => {
      if (method !== 'ChangeConfiguration') return { status: 'Accepted' };
      configured.push(params as { key: string; value: string });
      return { status: 'Rejected' };
    },
    close: async () => {},
    on: () => {},
  };
  const cp = new ChargePoint({
    identity: 'X', authorize: () => true, nextTransactionId: () => 1, livenessTimeoutMs: 0,
  });
  cp.attach(fakeClient);
  const cs = new FakeCentralSystem() as unknown as CentralSystem;
  const { c, logs } = makeWarnController({}, cs);
  cs.emit('connect', cp); // no BootNotification - an app restart doesn't reboot the charger
  await waitMs(5);

  const sampled = configured.find((k) => k.key === 'MeterValuesSampledData');
  assert.ok(sampled?.value.split(',').includes('Current.Offered'), 'requested on bind, not only on boot');
  assert.ok(logs.some((l) => l.includes('MeterValues config not accepted (interval Rejected, measurands Rejected)')),
    'a refusal is reported, rather than the measurand just never appearing');
  c.destroy();
});

// ---------------------------------------------------------------------------
// A Wallbox can report SuspendedEV while delivering full power
// ---------------------------------------------------------------------------

test('a charger delivering in SuspendedEV is netted from its meter and shown as charging', async () => {
  const { c, cp, caps } = makeBoundController({}, { maxHouseholdA: 63 });
  cp.emit('status', status('SuspendedEV'));
  cp.emit('meterValues', { power: 7000 });
  assert.equal(c.getDiagnostics().chargerPowerW, 7000, 'the meter decides, not the status');
  assert.equal(caps.evcharger_charging_state, 'plugged_in_charging', 'the widget chip reads charging, not READY');
  assert.equal(caps.evcharger_charging, true);

  // The numbers from the field log: grid 7280W with the car's own 7000W in it.
  // Netted, the house is 280W and the household cap is nowhere near 32A;
  // counted as house load, it trimmed the car to 31A.
  await c.startManual(32);
  c.onSolarSample({ gridSignedW: 7280, pvW: 3670, batteryW: 0 });
  assert.equal(caps.charge_current_limit, 32);
  c.destroy();
});

test('a genuine suspend still nets as zero, and standby draw does not count as charging', () => {
  const { c, cp, caps } = makeBoundController();
  cp.emit('status', status('Charging'));
  cp.emit('meterValues', { power: 7000 });
  cp.emit('status', status('SuspendedEV'));
  assert.equal(c.getDiagnostics().chargerPowerW, 0,
    'the last Charging reading does not count once suspended - it would overstate the car\'s draw');
  assert.equal(caps.measure_power, 0, 'and the reading is still zeroed at the transition');
  assert.equal(caps.evcharger_charging_state, 'plugged_in');

  cp.emit('meterValues', { power: 40 });
  assert.equal(c.getDiagnostics().chargerPowerW, 0, 'a few watts of standby is not delivery');
  assert.equal(caps.evcharger_charging_state, 'plugged_in');
  assert.equal(caps.evcharger_charging, false);
  c.destroy();
});

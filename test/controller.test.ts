'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { ChargeController, ControllerHost } from '../lib/control/ChargeController';
import { CentralSystem } from '../lib/ocpp/CentralSystem';
import { ChargePoint, RpcClient } from '../lib/ocpp/ChargePoint';
import { ScheduleWindow } from '../lib/control/Scheduler';

function at(day: number, hh: number, mm: number): Date {
  const d = new Date(2024, 0, 7);
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

const SCHED: ScheduleWindow[] = [{
  days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', currentA: 20,
}];

function makeController(schedule: ScheduleWindow[], extraSettings: Record<string, unknown> = {}): {
  c: ChargeController; caps: Record<string, unknown>; store: Record<string, unknown>; logs: string[];
} {
  const store: Record<string, unknown> = { schedule };
  const settings: Record<string, unknown> = {
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000, ...extraSettings,
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
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
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
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
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
  const { c, caps } = makeController([], { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  await c.startManual(31);
  // Battery charging at 14A (3220W), no solar -> cap = 32 - 14 - 2 = 16A.
  c.onSolarSample({ gridSignedW: 3220, pvW: 0, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 16, 'capped to 16A by the shared-circuit formula');
});

test('shared circuit cap rises with pv production, up to the hardware max', async () => {
  const { c, caps } = makeController([], { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  await c.startManual(31);
  // +20A pv, 14A battery charge -> cap = 32 + 20 - 14 - 2 = 36, clamped to maxAmps (31).
  c.onSolarSample({ gridSignedW: -1000, pvW: 4600, batteryW: 3220 });
  assert.equal(caps.charge_current_limit, 31, 'uncapped up to hardware max once solar covers the buffer');
});

test('shared circuit cap is a no-op on stale/absent solar data (trusts the configured ceiling)', async () => {
  const { c, caps } = makeController([], { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  await c.startManual(20); // no onSolarSample ever called -> lastSolarSampleAt stays 0 -> "stale"
  assert.equal(caps.charge_current_limit, 20, 'no shared-circuit restriction while solar data has never arrived');
});

test('schedule boost raises the target up to shared-circuit capacity when the battery is idle', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 0 }); // idle battery, no solar -> cap = 32 - 0 - 2 = 30
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 30 });
});

test('schedule boost matches the battery-charging + solar example (16A floor -> 20A)', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  // Battery charging at 14A (3220W, the rate that made 16A a sensible floor), pv +4A (920W) -> cap = 20.
  c.onSolarSample({ gridSignedW: 0, pvW: 920, batteryW: 3220 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 20 });
});

test('schedule boost clamps to the hardware maxAmps, not just the circuit rating', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 0, maxAmps: 31 });
  c.onSolarSample({ gridSignedW: 0, pvW: 4600, batteryW: 0 }); // +20A pv -> cap = 52, way above hardware max
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 31 });
});

test('schedule boost never lowers below the configured floor', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  // Battery charging harder than assumed (20A) -> cap = 32 - 20 - 2 = 10, below the 16A floor.
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 });
  assert.deepEqual(c.resolve(at(1, 12, 0)), { mode: 'scheduled', amps: 16 },
    'resolve() keeps the floor - the hard safety cap (tested separately) is what actually enforces the tighter limit');
});

test('the shared-circuit safety cap still throttles the charger even when the schedule floor asks for more', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c, caps } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
  c.onSolarSample({ gridSignedW: 0, pvW: 0, batteryW: 4600 }); // cap = 10, below the 16A floor
  c.tick(at(1, 12, 0)); // re-resolve at a fixed in-window time (onSolarSample's own tick used real time)
  assert.equal(caps.charge_current_limit, 10, 'final applied current is safety-capped to 10A regardless of the floor');
});

test('schedule boost is fully suppressed while the battery is discharging', () => {
  const sched: ScheduleWindow[] = [{
    days: [1], start: '11:00', end: '14:00', currentA: 16, boostToCap: true,
  }];
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
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
  const { c } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
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
    const { c, logs } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
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
    const { c, logs } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2 });
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
    const { c, logs } = makeController(sched, { sharedCircuitA: 32, sharedCircuitBufferA: 2, maxHouseholdW: 3000 });
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
  const scheduled: number[] = [];
  const cleared: number[] = [];
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: unknown, _ms: number) => {
    const id = ++nextId;
    scheduled.push(id);
    return { id } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const id = (handle as { id?: number } | undefined)?.id;
    if (id != null) cleared.push(id);
  }) as typeof clearTimeout;

  try {
    const { c } = makeController([]);
    // init() fires one tick, which arms the first backstop timer.
    assert.deepEqual(scheduled, [1], 'one backstop timer armed on init');
    assert.deepEqual(cleared, [], 'nothing to cancel yet');

    c.setSolarTarget(10); // a tick from a different trigger
    assert.deepEqual(cleared, [1], 'the previous backstop was cancelled, not left to fire independently');
    assert.deepEqual(scheduled, [1, 2], 'a fresh backstop was armed instead');

    c.setSolarTarget(0); // another unrelated tick
    assert.deepEqual(cleared, [1, 2]);
    assert.deepEqual(scheduled, [1, 2, 3], 'each tick keeps pushing the backstop out, never stacking timers');
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14200,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14200,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
  // Now netted correctly: baseLoadW = 11150-3550 = 7600. Tighten maxHouseholdW so the cap is
  // provably live and binding again (not just "no longer stale"): maxChargerW = 11050-7600 = 3450 ->
  // floor(3450/230) = 15A, below the 31A manual target.
  settings.maxHouseholdW = 11050;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14200,
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
  const cs = { getChargePoint: () => undefined, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14200, writeThrottleMs: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
    const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
      minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
    const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 31, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 0,
  };
  const caps: Record<string, unknown> = {};
  const chargingChanged: boolean[] = [];
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
    onChargingChanged: (charging) => chargingChanged.push(charging),
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
  assert.deepEqual(chargingChanged, [true]);
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
  };
  const caps: Record<string, unknown> = {};
  const chargingChanged: boolean[] = [];
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
    onChargingChanged: (charging) => chargingChanged.push(charging),
  };
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
  const c = new ChargeController(host, cs);
  c.init();
  assert.ok(c.isCharging(), 'transaction id restored from store on init');

  cp.emit('stopTransaction', {
    transactionId: 42, meterStop: 500, timestamp: new Date().toISOString(), reason: 'Local',
  });

  assert.equal(store.transactionId, null);
  assert.equal(caps.evcharger_charging, false);
  assert.deepEqual(chargingChanged, [false]);
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

test('getModeInfo() detail text for manual mode: charging vs stopped', async () => {
  const { c } = makeController([]);
  await c.startManual(16);
  assert.deepEqual(c.getModeInfo(), { mode: 'manual', detail: 'charging' });

  await c.stop();
  assert.deepEqual(c.getModeInfo(), { mode: 'manual', detail: 'stopped' });
});

test('getModeInfo() detail text for manual mode appends the next schedule start time when one exists', async () => {
  const { c } = makeController(SCHED);
  await c.startManual(10);
  const { detail } = c.getModeInfo();
  assert.ok(detail.startsWith('charging · schedule '), `expected a schedule suffix, got: ${detail}`);
});

test('getModeInfo() detail text for scheduled mode shows the window end time', () => {
  // All-day, every-day window so this isn't tied to exactly when the test happens to run.
  const allDay: ScheduleWindow[] = [{
    days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', currentA: 16,
  }];
  const { c } = makeController(allDay);
  c.tick();
  const info = c.getModeInfo();
  assert.equal(info.mode, 'scheduled');
  assert.match(info.detail, /^until \d{1,2}:\d{2}/, `expected an end time, got: ${info.detail}`);
});

test('getModeInfo() detail text for solar mode: charging / paused / idle', () => {
  const { c } = makeController([]);
  c.setSolarTarget(10);
  assert.deepEqual(c.getModeInfo(), { mode: 'solar', detail: 'charging 10A' });

  c.setSolarTarget(0);
  assert.deepEqual(c.getModeInfo(), { mode: 'solar', detail: 'paused (low excess)' });

  c.setSolarTarget(null);
  assert.deepEqual(c.getModeInfo(), { mode: 'solar', detail: 'idle (low excess)' });
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  class FakeCentralSystem extends EventEmitter {
    getChargePoint(): ChargePoint | undefined {
      return undefined; // nothing connected yet at init() time
    }
  }
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
  assert.equal(unavailableMsg, 'Charger offline');
  assert.ok(logs.some((l) => l.includes('[charger] disconnected')));
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 200,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    maxHouseholdW: 14000,
    sharedCircuitA: 30,
    sharedCircuitBufferA: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    minAmps: 6, maxAmps: 32, phases: 1, voltage: 230, maxHouseholdW: 14000, writeThrottleMs: 200,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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
    maxHouseholdW: 14000,
    sharedCircuitA: 25,
    sharedCircuitBufferA: 0,
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
  const cs = { getChargePoint: () => cp, on: () => {} } as unknown as CentralSystem;
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

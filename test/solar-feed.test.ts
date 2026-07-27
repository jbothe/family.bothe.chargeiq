'use strict';

import test from 'node:test';
import assert from 'node:assert';
import {
  mergeSample, SolarFeed, HomeyApiClient, HomeyApiDevice, CapabilityInstance,
} from '../lib/solar/SolarFeed';

interface FakeCapabilityInstance extends CapabilityInstance {
  destroyed: boolean;
}

function fakeCapabilityInstance(): FakeCapabilityInstance {
  const inst: FakeCapabilityInstance = {
    destroyed: false,
    async destroy() {
      inst.destroyed = true;
    },
  };
  return inst;
}

/** Fake homey-api device: captures subscribed listeners so tests can trigger live updates. */
class FakeDevice implements HomeyApiDevice {
  driverId?: string;

  capabilities?: string[];

  capabilitiesObj?: { 'measure_power'?: { value?: number }; 'measure_battery'?: { value?: number } };

  listeners: Record<string, (value: number) => void> = {};

  instances: FakeCapabilityInstance[] = [];

  throwOnSubscribe = false;

  throwOnCapability: string | null = null;

  constructor(driverId: string, capabilities: string[], initial: { power?: number; battery?: number } = {}) {
    this.driverId = driverId;
    this.capabilities = capabilities;
    this.capabilitiesObj = {};
    if (initial.power !== undefined) this.capabilitiesObj.measure_power = { value: initial.power };
    if (initial.battery !== undefined) this.capabilitiesObj.measure_battery = { value: initial.battery };
  }

  makeCapabilityInstance(capabilityId: string, listener: (value: number) => void): CapabilityInstance {
    if (this.throwOnSubscribe || capabilityId === this.throwOnCapability) throw new Error('subscribe failed');
    this.listeners[capabilityId] = listener;
    const inst = fakeCapabilityInstance();
    this.instances.push(inst);
    return inst;
  }

  trigger(capabilityId: string, value: number): void {
    this.listeners[capabilityId]?.(value);
  }
}

function fakeApi(devices: Record<string, HomeyApiDevice>): HomeyApiClient {
  return { devices: { getDevices: async () => devices } };
}

/**
 * Stubs global setTimeout/clearTimeout so SolarFeed's emit debounce can be
 * driven synchronously instead of via real 2s delays - same approach used for
 * ChargeController's backstop-timer test (test/controller.test.ts). flush()
 * invokes whichever callback is currently pending, simulating the debounce
 * elapsing; a reschedule (clearTimeout + new setTimeout, as emitSample() does
 * on every call) replaces the pending callback rather than queuing a second
 * one, matching the real single-timer behaviour.
 */
function stubDebounceTimer(): { flush(): void; restore(): void } {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let pending: { id: number; fn: () => void } | null = null;
  let nextId = 0;
  (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    const id = ++nextId;
    pending = { id, fn };
    return { id } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  (global as unknown as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
    const id = (handle as { id?: number } | undefined)?.id;
    if (pending?.id === id) pending = null;
  }) as typeof clearTimeout;
  return {
    flush() {
      const p = pending;
      pending = null;
      p?.fn();
    },
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
  };
}

const INVERTER_ID = 'homey:app:bothe.family.solaredge:inverter';
const METER_ID = 'homey:app:bothe.family.solaredge:meter';
const BATTERY_ID = 'homey:app:bothe.family.solaredge:battery';

test('derives house load: pv + gridSigned - batterySigned', () => {
  // Exporting 2.1kW, PV 4.2kW, battery charging 0.6kW -> house = 4200 + (-2100) - 600 = 1500
  const s = mergeSample({ inverter: 4200, meter: -2100, battery: 600 }, true, 82);
  assert.equal(s.pvW, 4200);
  assert.equal(s.gridSignedW, -2100);
  assert.equal(s.batteryW, 600);
  assert.equal(s.houseW, 1500);
});

test('house load with grid import and battery discharge', () => {
  // Importing 1.2kW, no PV, battery discharging 0.8kW -> house = 0 + 1200 - (-800) = 2000
  const s = mergeSample({ inverter: 0, meter: 1200, battery: -800 }, true, 40);
  assert.equal(s.houseW, 2000);
});

test('battery SoC reported only when a battery is present', () => {
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, true, 55).batterySoc, 55);
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, false, 55).batterySoc, null);
  assert.equal(mergeSample({ inverter: 0, meter: 0, battery: 0 }, true, null).batterySoc, null);
});

// ---------------------------------------------------------------------------
// SolarFeed class: discovery, subscription, live updates, cleanup
// ---------------------------------------------------------------------------

test('discovers inverter/meter/battery by driverId and captures initial values', async () => {
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 1500 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: -300 });
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 600, battery: 82 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, meter, battery }));

  await feed.start();

  const sample = feed.getSample();
  assert.equal(sample.pvW, 1500);
  assert.equal(sample.gridSignedW, -300);
  assert.equal(sample.batteryW, 600);
  assert.equal(sample.batterySoc, 82);
  assert.equal(feed.hasGrid(), true);
});

test('devices outside the SolarEdge app, or with an unrecognised role suffix, are ignored', async () => {
  const other = new FakeDevice('homey:app:some.other.app:inverter', ['measure_power'], { power: 9999 });
  const unknownRole = new FakeDevice('homey:app:bothe.family.solaredge:unknown', ['measure_power'], { power: 9999 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ other, unknownRole }));

  await feed.start();

  assert.equal(feed.getSample().pvW, 0, 'unmatched devices never contribute to the sample');
  assert.equal(feed.hasGrid(), false);
});

test('a device without measure_power is skipped entirely, even if otherwise matching', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_voltage'], { power: 500 }); // no measure_power capability
  const feed = new SolarFeed(undefined, undefined, fakeApi({ meter }));

  await feed.start();

  assert.equal(feed.hasGrid(), false, 'not marked present without the measure_power capability');
  assert.equal(Object.keys(meter.listeners).length, 0, 'never subscribed');
});

test('live measure_power updates emit a fresh merged sample once debounced', async () => {
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 1000 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, meter }));
  const samples: number[] = [];
  feed.on('sample', (s) => samples.push(s.pvW));

  const timer = stubDebounceTimer();
  try {
    await feed.start();
    timer.flush(); // the initial discovery-time emission
    samples.length = 0; // discard it

    inverter.trigger('measure_power', 2500);
    assert.equal(samples.length, 0, 'debounced - not emitted synchronously');
    timer.flush();
    assert.equal(samples.length, 1);
    assert.equal(samples[0], 2500);
    assert.equal(feed.getSample().pvW, 2500, 'internal state updated, not just the emitted event');
  } finally {
    timer.restore();
  }
});

test('live measure_battery updates emit a fresh sample with the new SoC once debounced', async () => {
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 0, battery: 50 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ battery, meter }));
  const socs: (number | null)[] = [];
  feed.on('sample', (s) => socs.push(s.batterySoc));

  const timer = stubDebounceTimer();
  try {
    await feed.start();
    timer.flush();
    socs.length = 0;

    battery.trigger('measure_battery', 91);
    assert.equal(socs.length, 0, 'debounced - not emitted synchronously');
    timer.flush();
    assert.equal(socs.length, 1);
    assert.equal(socs[0], 91);
  } finally {
    timer.restore();
  }
});

test('a burst of capability updates within the debounce window collapses into a single sample', async () => {
  // Regression coverage for a real log where inverter/meter/battery updates
  // from the same underlying SolarEdge reading cycle landed ~150ms apart and
  // each fired its own 'sample' (and downstream ChargeController.tick()).
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 1000 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: -200 });
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 300, battery: 50 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, meter, battery }));
  const samples: number[] = [];
  feed.on('sample', (s) => samples.push(s.pvW));

  const timer = stubDebounceTimer();
  try {
    await feed.start();
    timer.flush(); // discovery-time emission
    samples.length = 0;

    // Each trigger clears/reschedules the same debounce timer rather than
    // emitting independently.
    inverter.trigger('measure_power', 2000);
    meter.trigger('measure_power', -100);
    battery.trigger('measure_power', 400);
    assert.equal(samples.length, 0, 'nothing emitted mid-burst');

    timer.flush();
    assert.equal(samples.length, 1, 'the whole burst collapsed into one emission');
    assert.equal(samples[0], 2000, 'reflects the latest merged values, not an intermediate one');
    assert.equal(feed.getSample().gridSignedW, -100);
    assert.equal(feed.getSample().batteryW, 400);
  } finally {
    timer.restore();
  }
});

test('stop() cancels a pending debounced emission', async () => {
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 100 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, meter }));
  let fired = false;
  feed.on('sample', () => {
    fired = true;
  });

  const timer = stubDebounceTimer();
  try {
    await feed.start(); // schedules the discovery-time emission
    await feed.stop();
    timer.flush(); // if stop() hadn't cancelled it, this would fire it
    assert.equal(fired, false, 'stop() cancelled the pending emission');
  } finally {
    timer.restore();
  }
});

test('an initial sample fires during discovery iff a meter device was found', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  let fired = false;
  const withMeter = new SolarFeed(undefined, undefined, fakeApi({ meter }));
  withMeter.on('sample', () => {
    fired = true;
  });
  const timer1 = stubDebounceTimer();
  try {
    await withMeter.start();
    assert.equal(fired, false, 'debounced - scheduled but not fired synchronously');
    timer1.flush();
    assert.equal(fired, true);
  } finally {
    timer1.restore();
  }

  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 500 });
  let firedWithoutMeter = false;
  const withoutMeter = new SolarFeed(undefined, undefined, fakeApi({ inverter }));
  withoutMeter.on('sample', () => {
    firedWithoutMeter = true;
  });
  const timer2 = stubDebounceTimer();
  try {
    await withoutMeter.start();
    timer2.flush(); // nothing was scheduled - a no-op
    assert.equal(firedWithoutMeter, false, 'no meter -> no initial emission, even with other devices present');
  } finally {
    timer2.restore();
  }
});

test('a subscription failure on one device does not prevent discovering the others', async () => {
  const broken = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 100 });
  broken.throwOnSubscribe = true;
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: -200 });
  const logs: unknown[][] = [];
  const feed = new SolarFeed(undefined, (...a) => logs.push(a), fakeApi({ broken, meter }));

  await feed.start();

  assert.equal(feed.getSample().gridSignedW, -200, 'the meter device still got discovered/subscribed');
  assert.ok(logs.some((l) => String(l[0]).includes('could not subscribe')), 'the failure was logged, not swallowed silently');
});

test('a battery SoC subscription failure is logged separately, without blocking the power reading', async () => {
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 500, battery: 70 });
  battery.throwOnCapability = 'measure_battery';
  const logs: unknown[][] = [];
  const feed = new SolarFeed(undefined, (...a) => logs.push(a), fakeApi({ battery }));

  await feed.start();

  assert.equal(feed.getSample().batteryW, 500, 'the power capability still subscribed fine');
  assert.equal(feed.getSample().batterySoc, 70, 'the initial SoC value was still captured from discovery, just not subscribed live');
  assert.ok(logs.some((l) => String(l[0]).includes('could not subscribe to battery SoC')),
    'the SoC-specific failure is logged distinctly from the power-capability failure');
});

test('stop() destroys every subscribed instance and is safe to call twice', async () => {
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 100 });
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 50, battery: 60 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, battery }));
  await feed.start();

  assert.equal(inverter.instances.length, 1);
  assert.equal(battery.instances.length, 2, 'battery device subscribes to both measure_power and measure_battery');

  await feed.stop();
  assert.ok(inverter.instances.every((i) => i.destroyed));
  assert.ok(battery.instances.every((i) => i.destroyed));

  await feed.stop(); // must not throw or re-destroy on a second call
});

// ---------------------------------------------------------------------------
// Recovery: discover() used to run exactly once, from start()
// ---------------------------------------------------------------------------

/** Like fakeApi, but the device set can change between calls - as it does when the SolarEdge app starts late. */
function mutableApi(devices: Record<string, HomeyApiDevice>): { api: HomeyApiClient; devices: Record<string, HomeyApiDevice>; calls: () => number } {
  let calls = 0;
  const set = devices;
  return {
    api: {
      devices: {
        getDevices: async () => {
          calls += 1;
          return set;
        },
      },
    },
    devices: set,
    calls: () => calls,
  };
}

test('a rescan picks up SolarEdge devices that were not there at boot', async () => {
  const { api, devices } = mutableApi({});
  const feed = new SolarFeed(undefined, undefined, api);

  await feed.start();
  assert.equal(feed.hasGrid(), false, 'nothing to find yet');

  // The SolarEdge app finishes starting after ChargeIQ did.
  devices.meter = new FakeDevice(METER_ID, ['measure_power'], { power: -450 });
  assert.equal(await feed.checkAndRecover(), true, 'nothing discovered yet, so it retries');
  assert.equal(feed.hasGrid(), true);
  assert.equal(feed.getSample().gridSignedW, -450);
});

test('a rescan retries after a discovery that failed outright, rather than giving up for the app lifetime', async () => {
  let fail = true;
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 120 });
  const api: HomeyApiClient = {
    devices: {
      getDevices: async () => {
        if (fail) throw new Error('HomeyAPI unavailable');
        return { meter };
      },
    },
  };
  const feed = new SolarFeed(undefined, undefined, api);

  await assert.rejects(() => feed.start(), /HomeyAPI unavailable/, 'the first failure still surfaces to the caller');
  await assert.rejects(() => feed.checkAndRecover(), /HomeyAPI unavailable/, 'still down');
  assert.equal(feed.hasGrid(), false);

  fail = false;
  assert.equal(await feed.checkAndRecover(), true);
  assert.equal(feed.getSample().gridSignedW, 120, 'recovered without restarting the app');
});

test('a healthy feed is left alone; one gone quiet is resubscribed', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 100 });
  const { api, calls } = mutableApi({ meter });
  const feed = new SolarFeed(undefined, undefined, api);

  await feed.start();
  const afterStart = calls();

  assert.equal(await feed.checkAndRecover(), false, 'just discovered - nothing to recover');
  assert.equal(calls(), afterStart, 'and it did not re-fetch the device list');

  // 31 minutes of total silence: past FEED_SILENT_MS (30m).
  const first = meter.instances[0];
  assert.equal(await feed.checkAndRecover(Date.now() + 31 * 60000), true);
  assert.ok(first.destroyed, 'the presumed-dead subscription was released, not left dangling');
  assert.equal(meter.instances.length, 2, 'and a fresh one was made');
});

test('a capability update counts as a sign of life and defers the next rescan', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 100 });
  const timer = stubDebounceTimer();
  const realNow = Date.now;
  // The listener stamps lastUpdateAt from Date.now(), so the clock has to be
  // driven to place the update somewhere between discovery and the check -
  // otherwise all three land on the same instant and the test proves nothing.
  const base = realNow();
  let clock = base;
  Date.now = () => clock;
  try {
    const feed = new SolarFeed(undefined, undefined, fakeApi({ meter }));
    await feed.start(); // discovery stamps lastUpdateAt = base

    clock = base + 25 * 60000;
    meter.trigger('measure_power', 250); // ...and this re-stamps it 25m later
    timer.flush();

    // 31m after discovery, but only 6m after the update.
    assert.equal(await feed.checkAndRecover(base + 31 * 60000), false,
      'silence is measured from the last update, not from discovery');
    assert.equal(meter.instances.length, 1, 'subscription left in place');

    // 31m after the update itself, though, is genuinely quiet.
    assert.equal(await feed.checkAndRecover(base + 56 * 60000), true);
  } finally {
    Date.now = realNow;
    timer.restore();
  }
});

test('rediscovery rebuilds what is present rather than accumulating it', async () => {
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 700, battery: 55 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 100 });
  const { api, devices } = mutableApi({ battery, meter });
  const feed = new SolarFeed(undefined, undefined, api);

  await feed.start();
  assert.equal(feed.getSample().batterySoc, 55, 'battery present');

  // The battery device is removed from Homey; a rescan must stop claiming it.
  delete devices.battery;
  await feed.checkAndRecover(Date.now() + 31 * 60000);
  assert.equal(feed.getSample().batterySoc, null, 'SoC is only reported while a battery is actually present');
});

test('a failed rediscovery leaves the last known presence intact rather than blanking it', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 100 });
  let fail = false;
  const api: HomeyApiClient = {
    devices: {
      getDevices: async () => {
        if (fail) throw new Error('HomeyAPI went away');
        return { meter };
      },
    },
  };
  const feed = new SolarFeed(undefined, undefined, api);
  await feed.start();
  assert.equal(feed.hasGrid(), true);

  fail = true;
  await assert.rejects(() => feed.checkAndRecover(Date.now() + 31 * 60000), /went away/);
  assert.equal(feed.hasGrid(), true, 'the fetch failed before presence was rebuilt, so nothing was lost');
});

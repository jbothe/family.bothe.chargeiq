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

test('live measure_power updates emit a fresh merged sample', async () => {
  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 1000 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ inverter, meter }));
  const samples: number[] = [];
  feed.on('sample', (s) => samples.push(s.pvW));

  await feed.start();
  samples.length = 0; // discard the initial discovery-time emission

  inverter.trigger('measure_power', 2500);
  assert.equal(samples.length, 1);
  assert.equal(samples[0], 2500);
  assert.equal(feed.getSample().pvW, 2500, 'internal state updated, not just the emitted event');
});

test('live measure_battery updates emit a fresh sample with the new SoC', async () => {
  const battery = new FakeDevice(BATTERY_ID, ['measure_power', 'measure_battery'], { power: 0, battery: 50 });
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  const feed = new SolarFeed(undefined, undefined, fakeApi({ battery, meter }));
  const socs: (number | null)[] = [];
  feed.on('sample', (s) => socs.push(s.batterySoc));

  await feed.start();
  socs.length = 0;

  battery.trigger('measure_battery', 91);
  assert.equal(socs.length, 1);
  assert.equal(socs[0], 91);
});

test('an initial sample fires during discovery iff a meter device was found', async () => {
  const meter = new FakeDevice(METER_ID, ['measure_power'], { power: 0 });
  let fired = false;
  const withMeter = new SolarFeed(undefined, undefined, fakeApi({ meter }));
  withMeter.on('sample', () => {
    fired = true;
  });
  await withMeter.start();
  assert.equal(fired, true);

  const inverter = new FakeDevice(INVERTER_ID, ['measure_power'], { power: 500 });
  let firedWithoutMeter = false;
  const withoutMeter = new SolarFeed(undefined, undefined, fakeApi({ inverter }));
  withoutMeter.on('sample', () => {
    firedWithoutMeter = true;
  });
  await withoutMeter.start();
  assert.equal(firedWithoutMeter, false, 'no meter -> no initial emission, even with other devices present');
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

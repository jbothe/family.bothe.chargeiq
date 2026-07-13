'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';
import { resolvePairList } from '../../lib/pairing';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
}

/** Minimal surface this file needs from the device a flow card runs against. */
interface FlowDevice {
  flowStart(current?: number): Promise<void>;
  flowStop(): Promise<void>;
  flowSetCurrent(current: number): Promise<void>;
  flowIsCharging(): boolean;
  flowModeIs(mode: string): boolean;
  flowWithinSchedule(): boolean;
}

module.exports = class ChargerDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;

    flow.getActionCard('start_charging')
      .registerRunListener((args: { device: FlowDevice; current?: number }) => args.device.flowStart(args.current));
    flow.getActionCard('stop_charging')
      .registerRunListener((args: { device: FlowDevice }) => args.device.flowStop());
    flow.getActionCard('set_current_limit')
      .registerRunListener((args: { device: FlowDevice; current: number }) => args.device.flowSetCurrent(args.current));

    flow.getConditionCard('is_charging')
      .registerRunListener((args: { device: FlowDevice }) => args.device.flowIsCharging());
    flow.getConditionCard('mode_is')
      .registerRunListener((args: { device: FlowDevice; mode: string }) => args.device.flowModeIs(args.mode));
    flow.getConditionCard('within_schedule')
      .registerRunListener((args: { device: FlowDevice }) => args.device.flowWithinSchedule());

    this.log('ChargerDriver initialised');
  }

  async onPair(session: Homey.Driver.PairSession) {
    // Instructions view: tell the user where to point the charger.
    session.setHandler('getConnectionInfo', async () => {
      let ip = '<homey-ip>';
      try {
        const address = await this.homey.cloud.getLocalAddress();
        ip = String(address).split(':')[0];
      } catch (err) {
        this.error('Could not resolve Homey LAN address:', err);
      }
      const port = (this.homey.settings.get('ocppPort') as number) || 9000;
      return { ip, port };
    });

    // List charge points that have connected to the Central System this session.
    // ChargeIQ is single-charger for now (see lib/pairing.ts / docs/MULTI_DEVICE.md):
    // refuse a second pairing rather than give uncoordinated grid/circuit limits.
    session.setHandler('list_devices', async () => {
      const cs = (this.homey.app as ChargeIQApp).getCentralSystem();
      const result = resolvePairList(this.getDevices().length, cs.listIdentities());
      if ('error' in result) throw new Error(result.error);
      return result.devices;
    });
  }

};

'use strict';

import Homey from 'homey';
import { CentralSystem } from '../../lib/ocpp/CentralSystem';

interface ChargeIQApp extends Homey.App {
  getCentralSystem(): CentralSystem;
}

module.exports = class ChargerDriver extends Homey.Driver {

  async onInit() {
    const flow = this.homey.flow;

    flow.getActionCard('start_charging')
      .registerRunListener((args: any) => args.device.flowStart(args.current));
    flow.getActionCard('stop_charging')
      .registerRunListener((args: any) => args.device.flowStop());
    flow.getActionCard('set_current_limit')
      .registerRunListener((args: any) => args.device.flowSetCurrent(args.current));

    flow.getConditionCard('is_charging')
      .registerRunListener((args: any) => args.device.flowIsCharging());
    flow.getConditionCard('mode_is')
      .registerRunListener((args: any) => args.device.flowModeIs(args.mode));
    flow.getConditionCard('within_schedule')
      .registerRunListener((args: any) => args.device.flowWithinSchedule());

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
    session.setHandler('list_devices', async () => {
      const cs = (this.homey.app as ChargeIQApp).getCentralSystem();
      return cs.listIdentities().map((identity) => ({
        name: `EV Charger (${identity})`,
        data: { id: identity },
      }));
    });
  }

};

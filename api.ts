'use strict';

/**
 * App API endpoints, callable from the widget and the settings page via
 * Homey.api('GET'|'POST', '/<name>', body). The widget stays thin: it only
 * reads merged state the app already owns.
 */
module.exports = {

  async getSchedule({ homey }: any) {
    return homey.app.getSchedule();
  },

  async setSchedule({ homey, body }: any) {
    await homey.app.setSchedule(Array.isArray(body?.windows) ? body.windows : []);
    return { ok: true };
  },

};

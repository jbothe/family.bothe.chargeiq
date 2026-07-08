'use strict';

/**
 * App API endpoints, callable from the widget and the settings page via
 * Homey.api('GET'|'POST', '/<name>', body). The widget stays thin: it only
 * reads merged state the app already owns.
 */
module.exports = {

  async getState({ homey }: any) {
    try {
      return homey.app.getWidgetState();
    } catch (err) {
      homey.app?.error?.('[api] getState failed:', err);
      throw err;
    }
  },

  async getSchedule({ homey }: any) {
    return homey.app.getSchedule();
  },

  async setSchedule({ homey, body }: any) {
    await homey.app.setSchedule(Array.isArray(body?.windows) ? body.windows : []);
    return { ok: true };
  },

};

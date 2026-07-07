'use strict';

// Widget-scoped API. The widget frontend calls Homey.api('GET', '/getState').
module.exports = {
  async getState({ homey }) {
    try {
      return homey.app.getWidgetState();
    } catch (err) {
      homey.app.error('[widget] getState failed:', err);
      throw err;
    }
  },
};

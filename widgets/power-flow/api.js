'use strict';

// Widget-scoped API. The widget frontend calls Homey.api('GET', '/state').
module.exports = {
  async getState({ homey }) {
    return homey.app.getWidgetState();
  },
};

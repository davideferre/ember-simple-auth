import Service from '@ember/service';

import Evented from '@ember/object/evented';

export default class PopupService extends Service.extend(Evented) {

  popup;

  open(url, options) {
    return new Promise((resolve, reject) => {
      const popup = window.open(url, '_blank', options);
      if (!popup) {
        reject(new Error('Could not open popup'));
      }
      this.popup = popup;
      this.popup.focus();
      resolve(this.popup);
    });
  }

  poll() {
    if (!this.popup) {
      return;
    }
    if (this.popup.closed) {
      this.trigger('closed');
    }
  }

  close() {
    if (this.popup) {
      this.popup.close();
      this.trigger('closed');
    }
  }
}

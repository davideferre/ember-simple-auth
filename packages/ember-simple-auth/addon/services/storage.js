import Service from '@ember/service';

import Evented from '@ember/object/evented';

export default class StorageService extends Service.extend(Evented) {
    defaultPrefix = 'dlabs_';

    constructor() {
        super(...arguments);
        window.onstorage = (event) => {
            this.trigger('changed', { action: 'storage', event: event });
        }
    }

    setItem(sKey, oValue) {
        window.localStorage.setItem(this.defaultPrefix + sKey, oValue);
        this.trigger('changed', { action: 'setItem', key: sKey, value: oValue });
    }

    getItem(sKey) {
        return window.localStorage.getItem(this.defaultPrefix + sKey);
    }

    removeItem(sKey) {
        window.localStorage.removeItem(this.defaultPrefix + sKey);
        this.trigger('changed', { action: 'removeItem', key: sKey });
    }

    clear() {
        window.localStorage.clear();
        this.trigger('changed', { action: 'clear' });
    }

    setPrefix(sPrefix) {
        this.defaultPrefix = sPrefix;
    }
}

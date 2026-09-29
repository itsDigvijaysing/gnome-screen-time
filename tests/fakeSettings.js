import GLib from 'gi://GLib';

// Just enough of Gio.Settings for the modules under test: integer reads, the
// `app-limits` dictionary, and `changed::<key>` signals a test can fire by
// setting a value.
export class FakeSettings {
    constructor(ints = {}, appLimits = {}) {
        this._ints = { 'retention-days': 90, 'max-interval': 300, 'purge-requested': 0, ...ints };
        this._values = {
            'app-limits': new GLib.Variant('a{si}', appLimits),
            'app-names': new GLib.Variant('a{ss}', {}),
        };
        this._handlers = new Map();
        this._nextId = 1;
    }

    get_int(key) {
        return this._ints[key];
    }

    set_int(key, value) {
        this._ints[key] = value;
        this._emit(`changed::${key}`);
    }

    get_value(key) {
        return this._values[key];
    }

    set_value(key, variant) {
        this._values[key] = variant;
        this._emit(`changed::${key}`);
    }

    connect(signal, cb) {
        let id = this._nextId++;
        this._handlers.set(id, { signal, cb });
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    _emit(signal) {
        for (let h of this._handlers.values()) {
            if (h.signal === signal)
                h.cb(this);
        }
    }
}

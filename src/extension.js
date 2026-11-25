import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore } from './usageStore.js';
import { LimitNotifier } from './limitNotifier.js';
import { isPaused } from './pause.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._indicator = new PanelIndicator();
        this._indicator.addToPanel(this.uuid);
        this._popup = new PopupWidget(this._indicator.menu, this._store,
            this._settings, () => this._openPrefs());
        this._tracker = new UsageTracker(this._store, this._settings);
        this._limitNotifier = new LimitNotifier(this._settings);

        this._store.onChange = (appId, displayName, seconds) => {
            this._indicator?.setTotal(this._store.getTodayTotal());
            if (appId)
                this._limitNotifier?.checkLimit(appId, displayName, seconds);
        };
        this._indicator.setTotal(this._store.getTodayTotal());

        // GNOME Shell 50 never calls disable() at logout. It destroys the
        // panel, then runs a nested main loop in its own `shutdown` handler
        // (main.js), where closing windows still change focus and the tracker
        // still credits time. So once the indicator is gone nothing may drive
        // UI any more, and the last stretch is saved here, because the
        // store's destroy() never runs on that path. Handlers run in connect
        // order, so this one comes after the Shell's nested loop has ended.
        // Destroying the tracker banks its final flush and stops it
        // listening, so nothing credited later in the teardown goes unsaved.
        this._indicator.connectObject('destroy', () => {
            if (this._store)
                this._store.onChange = null;
        }, this);
        global.connectObject('shutdown', () => {
            // No limit notifications into a message tray that is shutting
            // down, whether or not the panel is already gone.
            if (this._store)
                this._store.onChange = null;
            this._tracker?.destroy();
            this._tracker = null;
            this._store?.save();
        }, this);

        // connectObject takes the owner object ONCE, after every
        // (signal, handler) pair. Repeating it per pair makes the next pair's
        // owner land where a signal name is expected, and enable() throws
        // "Couldn't convert to string" before reaching the two syncs below:
        // the extension lands in ERROR state, its stylesheet is dropped, and
        // the panel keeps whatever defaults the indicator was built with.
        this._settings.connectObject(
            'changed::show-total-in-panel', () => this._syncPanelLabel(),
            'changed::paused-until', () => this._syncPaused(),
            this);
        this._syncPanelLabel();
        this._syncPaused();
    }

    // The Shell refuses a second preferences dialog while one is showing, so
    // if the prefs process already has a window up, raise that instead.
    _openPrefs() {
        let existing = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(w => w && (w.get_gtk_application_id?.() === 'org.gnome.Shell.Extensions' ||
                             w.get_wm_class() === 'org.gnome.Shell.Extensions'));
        if (existing) {
            existing.activate(global.get_current_time());
            return;
        }
        this.openPreferences();
    }

    _syncPanelLabel() {
        this._indicator.setShowTotal(
            this._settings.get_boolean('show-total-in-panel'));
    }

    // The tracker clears a lapsed pause, so this only has to mirror the key.
    _syncPaused() {
        this._indicator.setPaused(isPaused(
            this._settings.get_int64('paused-until'), Math.floor(Date.now() / 1000)));
    }

    disable() {
        this._settings.disconnectObject(this);
        global.disconnectObject(this);
        // The tracker's final flush still reaches the panel and the limit
        // check: disable() runs at lock or when switched off, never at
        // logout, so the indicator is alive here.
        this._tracker?.destroy();
        this._tracker = null;
        this._popup?.destroy();
        this._popup = null;
        this._indicator?.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
        this._limitNotifier = null;
        this._store?.destroy();
        this._store = null;
        this._settings = null;
    }
}

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

        this._settings.connectObject(
            'changed::show-total-in-panel', () => this._syncPanelLabel(), this,
            'changed::paused-until', () => this._syncPaused(), this);
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
        this._tracker?.destroy();
        this._tracker = null;
        this._popup?.destroy();
        this._popup = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._limitNotifier = null;
        this._store?.destroy();
        this._store = null;
        this._settings = null;
    }
}

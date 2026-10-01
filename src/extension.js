import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore } from './usageStore.js';
import { LimitNotifier } from './limitNotifier.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._indicator = new PanelIndicator();
        this._indicator.addToPanel(this.uuid);
        this._tracker = new UsageTracker(this._store, this._settings);
        // Before the popup's own handler, which builds from the store:
        // opening it was input, so everything held back is credited first.
        this._menuOpenId = this._indicator.menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._tracker?.flushNow();
        });
        this._popup = new PopupWidget(this._indicator.menu, this._store,
            this._settings, () => this._openPrefs());
        this._limitNotifier = new LimitNotifier(this._settings);

        this._store.onChange = (appId, displayName, seconds) => {
            this._syncPanelTotal();
            if (appId)
                this._limitNotifier?.checkLimit(appId, displayName, seconds);
        };
        this._tracker.onTick = () => this._syncPanelTotal();
        this._syncPanelTotal();

        this._settings.connectObject(
            'changed::show-total-in-panel', () => this._syncPanelLabel(), this);
        this._syncPanelLabel();
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

    // What's recorded, plus what the tracker is holding back since the last
    // input, so the panel keeps moving while you read; if that turns out to
    // be time away, it's dropped and the panel settles to what's recorded.
    _syncPanelTotal() {
        this._indicator?.setTotal(
            this._store.getTodayTotal() + (this._tracker?.pendingSeconds ?? 0));
    }

    _syncPanelLabel() {
        this._indicator.setShowTotal(
            this._settings.get_boolean('show-total-in-panel'));
    }

    disable() {
        this._settings.disconnectObject(this);
        if (this._menuOpenId) {
            this._indicator?.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
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

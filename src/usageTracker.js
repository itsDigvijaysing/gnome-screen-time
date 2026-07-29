import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

// Periodic flush so a long unbroken session still updates the total/limit
// checks without a focus change. Matches UsageStore's autosave cadence.
const FLUSH_INTERVAL = 30;

export class UsageTracker {
    constructor(store, settings) {
        this._store = store;
        this._settings = settings;
        this._lastTime = Date.now();
        this._appId = null;
        this._appName = null;

        // screenShield only exists when GNOME can lock at all (GDM + systemd),
        // so presence detection treats it as optional; max-interval is the backstop.
        this._shield = Main.screenShield ?? null;
        this._away = this._computeAway();

        this._focusId = global.display.connect(
            'notify::focus-window',
            this._onFocus.bind(this)
        );
        if (this._shield) {
            this._activeId = this._shield.connect(
                'active-changed', this._onPresenceChanged.bind(this));
            this._lockedId = this._shield.connect(
                'locked-changed', this._onPresenceChanged.bind(this));
        } else {
            console.debug('[ScreenTime] no screenShield available; ' +
                'relying on suspend detection and max-interval');
        }

        // Always returns an emitter (a no-op dummy without systemd), so this is safe.
        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect(
            'prepare-for-sleep',
            (lm, aboutToSuspend) => this._onPrepareForSleep(aboutToSuspend));

        this._flushId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, FLUSH_INTERVAL,
            () => this._onFlushTick()
        );
    }

    _getMaxInterval() {
        return this._settings.get_int('max-interval');
    }

    _computeAway() {
        return !!(this._shield && (this._shield.active || this._shield.locked));
    }

    _currentApp() {
        let win = global.display.focus_window;
        if (!win)
            return null;
        let app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return null;

        // window-backed apps (no .desktop file) get a per-launch `window:<n>` id;
        // WM_CLASS is stable across launches, so key those off it instead.
        if (app.is_window_backed()) {
            let wmClass = win.get_wm_class();
            if (wmClass)
                return { id: `wmclass:${wmClass}`, name: app.get_name() || wmClass };
        }
        return { id: app.get_id(), name: app.get_name() };
    }

    // Credits elapsed time (since _lastTime) to whatever app is currently
    // tracked. Callers are responsible for updating _lastTime afterward.
    _flush(now) {
        let secs = Math.min((now - this._lastTime) / 1000, this._getMaxInterval());
        if (this._appId && secs > 0)
            this._store.addTime(this._appId, this._appName, secs);
    }

    // Going away banks the time so far and stops tracking; coming back re-reads
    // the focused window so the gap in between belongs to nobody.
    _setAway(away) {
        let now = Date.now();
        this._away = away;
        if (away) {
            this._flush(now);
            this._appId = null;
            this._appName = null;
        } else {
            let app = this._currentApp();
            this._appId = app?.id ?? null;
            this._appName = app?.name ?? null;
        }
        this._lastTime = now;
    }

    _onPresenceChanged() {
        let away = this._computeAway();
        if (away !== this._away)
            this._setAway(away);
    }

    _onPrepareForSleep(aboutToSuspend) {
        if (aboutToSuspend)
            this._setAway(true);
        else if (!this._computeAway())
            this._setAway(false);   // resumed straight to the desktop
        // Otherwise the shield is up: stay away until it clears.
    }

    _onFocus() {
        if (this._away)
            return;

        let now = Date.now();
        this._flush(now);

        let app = this._currentApp();
        this._appId = app?.id ?? null;
        this._appName = app?.name ?? null;
        this._lastTime = now;
    }

    _onFlushTick() {
        if (!this._away && this._appId) {
            let now = Date.now();
            this._flush(now);
            this._lastTime = now;
        }
        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }
        if (this._activeId) {
            this._shield.disconnect(this._activeId);
            this._activeId = null;
        }
        if (this._lockedId) {
            this._shield.disconnect(this._lockedId);
            this._lockedId = null;
        }
        if (this._sleepId) {
            this._loginManager.disconnect(this._sleepId);
            this._sleepId = null;
        }
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = null;
        }
        this._flush(Date.now());
    }
}

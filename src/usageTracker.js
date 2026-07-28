import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

// How often to flush time for the app that's been continuously focused,
// independent of focus-change events. Without this, a 30-minute app limit
// (or the panel's live total) would never update while sitting in one app
// with no window switches. Matches UsageStore's own autosave cadence.
const FLUSH_INTERVAL = 30;

export class UsageTracker {
    constructor(store, settings) {
        this._store = store;
        this._settings = settings;
        this._lastTime = Date.now();
        this._appId = null;
        this._appName = null;

        // Presence is derived from three independent sources so that tracking
        // degrades gracefully across environments:
        //
        //  1. screenShield 'active-changed' — the screen blanking/curtain, which
        //     fires *before* the lock and also fires when locking is disabled
        //     but blanking is not.
        //  2. screenShield 'locked-changed' — the actual lock.
        //  3. logind 'prepare-for-sleep' — suspend/resume, which no shield
        //     signal covers; without it, resuming credits the whole sleep gap
        //     (capped at max-interval) to whatever was focused.
        //
        // Main.screenShield only exists when GNOME can lock at all (it needs
        // GDM + systemd), so it is optional; max-interval remains the backstop.
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

        // getLoginManager() always returns an emitter — a no-op dummy without
        // systemd — so connecting is safe regardless of the host system.
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

        // Apps with no .desktop file (typically AppImages) get a synthetic
        // "window-backed" app whose id is `window:<n>` — a different id on
        // every launch, which would scatter one app across many entries.
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

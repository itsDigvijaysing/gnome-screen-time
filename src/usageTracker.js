import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import { isPaused } from './pause.js';
import { advanceClock } from './trackerClock.js';

// Flush periodically so a long session in one app still updates the total.
const FLUSH_INTERVAL = 30;

export class UsageTracker {
    constructor(store, settings) {
        this._store = store;
        this._settings = settings;
        this._lastTime = Date.now();
        this._appId = null;
        this._appName = null;

        // Null when the session cannot lock (no GDM or no systemd).
        this._shield = Main.screenShield ?? null;
        this._idle = false;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._paused = false;
        this._pauseTimeoutId = 0;
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
        }

        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect(
            'prepare-for-sleep',
            (lm, aboutToSuspend) => this._onPrepareForSleep(aboutToSuspend));

        this._flushId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, FLUSH_INTERVAL,
            () => this._onFlushTick()
        );

        this._armIdleWatch();
        this._idleSettingId = this._settings.connect(
            'changed::idle-timeout', () => this._armIdleWatch());
        this._pauseSettingId = this._settings.connect(
            'changed::paused-until', () => this._syncPause());
        this._syncPause();

        // The window already focused at enable() fires no focus change.
        this._onFocus();
    }

    _armIdleWatch() {
        // Removing the watches also removes the one that would clear _idle.
        this._clearIdleWatches();
        if (this._idle) {
            this._idle = false;
            this._onPresenceChanged();
        }
        let seconds = this._settings.get_int('idle-timeout');
        if (seconds <= 0)
            return;
        this._idleWatchId = this._idleMonitor.add_idle_watch(
            seconds * 1000, () => this._onIdle());
    }

    _clearIdleWatches() {
        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
    }

    // Mutter holds idle watches back while something inhibits idle (a
    // playing video), so this only fires when the user is really away.
    _onIdle() {
        if (this._activeWatchId)
            return;
        // One-shot: Mutter removes it when it fires.
        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._idle = false;
            this._onPresenceChanged();
        });
        this._idle = true;
        this._onPresenceChanged();
    }

    // A GLib timeout does not count suspended time, so this also runs on resume.
    _syncPause() {
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = 0;
        }
        let until = this._settings.get_int64('paused-until');
        let now = Math.floor(Date.now() / 1000);
        if (until > 0 && until <= now) {
            // Clearing it re-enters here through the changed signal.
            this._settings.set_int64('paused-until', 0);
            return;
        }
        this._paused = isPaused(until, now);
        if (until > 0) {
            this._pauseTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, until - now, () => {
                    this._pauseTimeoutId = 0;
                    this._settings.set_int64('paused-until', 0);
                    return GLib.SOURCE_REMOVE;
                });
        }
        this._onPresenceChanged();
    }

    _computeAway() {
        return this._idle || this._paused ||
            !!(this._shield && (this._shield.active || this._shield.locked));
    }

    _currentApp() {
        let win = global.display.focus_window;
        if (!win)
            return null;
        let app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return null;

        // Apps without a .desktop file get a new `window:<n>` id each launch;
        // WM_CLASS stays the same, so key them on that.
        if (app.is_window_backed()) {
            // Desktop Icons NG draws the desktop as a gjs window.
            if (win.get_gtk_application_id() === 'com.rastersoft.ding')
                return {id: 'desktop', name: 'Desktop'};
            let wmClass = win.get_wm_class();
            if (wmClass)
                return {id: `wmclass:${wmClass}`, name: app.get_name() || wmClass};
            // Transient windows (portals, tooltips) have nothing stable to key on.
            return null;
        }
        return {id: app.get_id(), name: app.get_name()};
    }

    _flush(now) {
        if (!this._appId) {
            this._lastTime = now;
            return;
        }
        let {credited, lastTime} =
            advanceClock(this._lastTime, now, this._settings.get_int('max-interval'));
        if (credited > 0)
            this._store.addTime(this._appId, this._appName, credited);
        this._lastTime = lastTime;
    }

    _setAway(away) {
        this._away = away;
        this._flush(Date.now());
        let app = away ? null : this._currentApp();
        this._appId = app?.id ?? null;
        this._appName = app?.name ?? null;
    }

    _onPresenceChanged() {
        let away = this._computeAway();
        if (away !== this._away)
            this._setAway(away);
    }

    _onPrepareForSleep(aboutToSuspend) {
        if (aboutToSuspend) {
            this._setAway(true);
            return;
        }
        this._syncPause();
        if (!this._computeAway())
            this._setAway(false);
    }

    _onFocus() {
        if (this._away)
            return;

        this._flush(Date.now());

        let app = this._currentApp();
        this._appId = app?.id ?? null;
        this._appName = app?.name ?? null;
    }

    _onFlushTick() {
        if (!this._away && this._appId)
            this._flush(Date.now());
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
        if (this._idleSettingId) {
            this._settings.disconnect(this._idleSettingId);
            this._idleSettingId = null;
        }
        if (this._pauseSettingId) {
            this._settings.disconnect(this._pauseSettingId);
            this._pauseSettingId = null;
        }
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = 0;
        }
        this._clearIdleWatches();
        this._flush(Date.now());
    }
}

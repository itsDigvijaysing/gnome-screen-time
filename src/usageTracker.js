import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import { advanceClock, creditUntil } from './trackerClock.js';

// Periodic flush so a long unbroken session still updates the total/limit
// checks without a focus change. Matches UsageStore's autosave cadence.
const FLUSH_INTERVAL = 30;
// org.gnome.SessionManager's idle inhibit flag (GSM_INHIBITOR_FLAG_IDLE).
const IDLE_INHIBIT_FLAG = 8;
// While idle but inhibited, ask again this often.
const IDLE_RECHECK_SECONDS = 60;

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
        // Set once the idle monitor has seen `idle-timeout` seconds without
        // input, cleared on the next input. This covers the case the shield
        // never sees: a screen kept awake while nobody is at the keyboard.
        this._idle = false;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idleRecheckId = 0;
        // Cancels the inhibit query still in flight when the extension stops.
        this._cancellable = new Gio.Cancellable();
        this._away = this._computeAway();
        // Called after every periodic flush, so a panel showing
        // pendingSeconds keeps moving while nothing is being credited.
        this.onTick = null;
        // Whether something (a video) inhibits idle right now, followed from
        // the session manager's InhibitedActions; see _creditUntil().
        this._idleInhibited = false;
        this._watchInhibitors();

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

        this._armIdleWatch();
        this._idleSettingId = this._settings.connect(
            'changed::idle-timeout', () => this._armIdleWatch());

        // enable() runs at login and again after every unlock, where the window
        // that is already focused fires no focus change of its own. Sync once
        // from it: the same connect-then-call-once pattern extension.js uses.
        this._onFocus();
    }

    // (Re)installs the idle watch for the configured timeout. A timeout of 0
    // disables idle detection. Called at start and on every setting change.
    _armIdleWatch() {
        // Clearing drops the active watch that would have cleared _idle, so
        // come back first and let the new watch decide from scratch; Mutter
        // re-fires immediately if the session is already past the threshold.
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
        this._clearIdleRecheck();
    }

    // No input for the whole timeout. Something inhibiting idle (a video, a
    // presentation) means the user is still watching, so keep counting and
    // look again in a minute; otherwise stop until the next input. Observed
    // on GNOME 50 Wayland: Mutter already withholds idle watches while idle
    // is inhibited, so this check rarely runs there; it stays as the
    // backstop for sessions where it does not.
    _onIdle() {
        if (this._idle)
            return;
        this._armActiveWatch();
        this._checkIdleInhibited();
    }

    _checkIdleInhibited() {
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'IsInhibited',
            new GLib.Variant('(u)', [IDLE_INHIBIT_FLAG]), null,
            Gio.DBusCallFlags.NONE, 2000, this._cancellable,
            (conn, res) => {
                let inhibited = false;
                try {
                    [inhibited] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    // No session manager to ask: fall back to plain idleness.
                }
                // The user came back while we were asking.
                if (!this._activeWatchId)
                    return;
                if (inhibited) {
                    // Never leave an older recheck registered but unreachable.
                    this._clearIdleRecheck();
                    this._idleRecheckId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, IDLE_RECHECK_SECONDS, () => {
                            this._idleRecheckId = 0;
                            this._checkIdleInhibited();
                            return GLib.SOURCE_REMOVE;
                        });
                    return;
                }
                this._idle = true;
                this._onPresenceChanged();
            });
    }

    // One-shot: Mutter removes the watch itself when it fires.
    _armActiveWatch() {
        if (this._activeWatchId)
            return;
        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._clearIdleRecheck();
            if (this._idle) {
                this._idle = false;
                this._onPresenceChanged();
            }
        });
    }

    _clearIdleRecheck() {
        if (this._idleRecheckId) {
            GLib.source_remove(this._idleRecheckId);
            this._idleRecheckId = 0;
        }
    }

    _getMaxInterval() {
        return this._settings.get_int('max-interval');
    }

    _computeAway() {
        return this._idle ||
            !!(this._shield && (this._shield.active || this._shield.locked));
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
            // No .desktop file and no WM_CLASS: nothing stable to key on, and
            // Shell names these "Unknown". They are transient windows (portals,
            // tooltips, switchers), never an app you used, so skip them.
            return null;
        }
        return { id: app.get_id(), name: app.get_name() };
    }

    // Credits elapsed time (since _lastTime) to whatever app is currently
    // tracked and advances the clock; advanceClock() carries the rounding.
    //
    // `until` is how far to credit, by default up to the last input (see
    // _creditUntil()); what lies past it stays on the clock, uncredited,
    // until a later flush shows it was used, or going away drops it.
    _flush(now, until = this._creditUntil(now)) {
        if (!this._appId) {
            // Nothing tracked (away, or a transient window with no stable
            // id): the stretch belongs to nobody, and any fraction carried
            // from the previous app goes with it.
            this._lastTime = now;
            return;
        }
        let { credited, lastTime } =
            advanceClock(this._lastTime, until, this._getMaxInterval());
        if (credited > 0)
            this._store.addTime(this._appId, this._appName, credited);
        this._lastTime = lastTime;
    }

    // Going away banks the time so far and stops tracking; coming back re-reads
    // the focused window so the gap in between belongs to nobody.
    _setAway(away) {
        let now = Date.now();
        this._away = away;
        // Going away, this banks the tracked time up to the last input, and
        // what came after it (the idle timeout running out, the screen
        // blanking) is dropped by the next flush, with no app to credit;
        // coming back, _appId is already null, so it only resets the clock
        // for the app picked up next.
        this._flush(now);
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
        if (aboutToSuspend)
            this._setAway(true);
        else if (!this._computeAway())
            this._setAway(false);   // resumed straight to the desktop
        // Otherwise the shield is up: stay away until it clears.
    }

    _onFocus() {
        if (this._away)
            return;

        // Up to now, not to the last input: a focus change with no input
        // (a window closing itself) is rare, and whose time the gap was
        // would be guesswork.
        let now = Date.now();
        this._flush(now, now);

        let app = this._currentApp();
        this._appId = app?.id ?? null;
        this._appName = app?.name ?? null;
    }

    _onFlushTick() {
        if (!this._away && this._appId)
            this._flush(Date.now());
        this.onTick?.();
        return GLib.SOURCE_CONTINUE;
    }

    // How far a flush credits: the last keyboard or mouse input, unless idle
    // is inhibited (nobody types through a film) or idle detection is off
    // (the user asked for time to count regardless).
    _creditUntil(now) {
        let holdBack = !this._idleInhibited && this._settings.get_int('idle-timeout') > 0;
        return creditUntil(this._lastTime, now, this._idleMonitor.get_idletime(), !holdBack);
    }

    // Seconds on the clock not yet credited: time since the last input,
    // held back until input shows it was used (see _creditUntil()). For a
    // display that should keep moving meanwhile; never written anywhere.
    get pendingSeconds() {
        if (this._away || !this._appId)
            return 0;
        return Math.min(Math.max(0, (Date.now() - this._lastTime) / 1000), this._getMaxInterval());
    }

    // Credits everything up to the last input now, e.g. as the popup opens:
    // the click that opened it was input, so nothing is held back.
    flushNow() {
        if (!this._away && this._appId)
            this._flush(Date.now());
    }

    _watchInhibitors() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', this._cancellable,
            (_o, res) => {
                try {
                    this._sessionManager = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    // No session manager (or stopped first): never inhibited.
                    return;
                }
                let sync = () => {
                    let actions = this._sessionManager.get_cached_property('InhibitedActions');
                    this._idleInhibited = !!(actions && (actions.unpack() & IDLE_INHIBIT_FLAG));
                };
                sync();
                this._inhibitorsId = this._sessionManager.connect('g-properties-changed', sync);
            });
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
        // Watches first: clearing _activeWatchId is what makes a late reply to
        // the cancelled inhibit query bail out instead of marking us idle.
        this._clearIdleWatches();
        this._cancellable.cancel();
        if (this._inhibitorsId) {
            this._sessionManager.disconnect(this._inhibitorsId);
            this._inhibitorsId = null;
        }
        this._flush(Date.now());
    }
}

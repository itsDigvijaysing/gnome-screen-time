import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { getAppNames } from './appNames.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const STORE_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time'
]);
export const STORE_FILE = GLib.build_filenamev([STORE_DIR, 'usage.json']);
const AUTOSAVE_INTERVAL = 30;
const MANUAL_PURGE_DAYS = 7;

// Date keys double as the on-disk JSON keys, so every caller formats here.
// `startHour` moves the day boundary off midnight, so pass it only for a real
// instant: a key shifted by whole days is already a logical day.
export function dateKey(dateTime, startHour = 0) {
    let at = startHour > 0 ? dateTime.add_hours(-startHour) : dateTime;
    return at.format('%Y-%m-%d');
}

export function todayKey(startHour = 0) {
    return dateKey(GLib.DateTime.new_now_local(), startHour);
}

// What the callers holding a settings object want: today, for whichever day
// boundary the user configured. One place knows the key's name.
export function todayKeyFor(settings) {
    return todayKey(settings.get_int('day-start-hour'));
}

// appId -> displayName for every app in `data`, shared by UsageStore and
// prefs.js so both pick from the same set. Skips "Unknown", Shell's fallback
// name for windows it can't identify.
export function knownAppsFromData(data, names = {}) {
    let known = new Map();
    for (let day of Object.values(data)) {
        for (let [appId, info] of Object.entries(day)) {
            if (names[appId])
                known.set(appId, names[appId]);
            else if (info.displayName !== 'Unknown')
                known.set(appId, info.displayName);
        }
    }
    return known;
}

export class UsageStore {
    constructor(settings) {
        this._settings = settings;
        this._data = {};
        this._dirty = false;
        this._loaded = false;
        this._cancellable = new Gio.Cancellable();
        this.onChange = null;
        this._ensureDir();
        this._load();
        this._autoSaveId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, AUTOSAVE_INTERVAL,
            () => { this._save(); return GLib.SOURCE_CONTINUE; }
        );
        this._settingsId = settings.connect(
            'changed::retention-days', () => { this._cleanup(); }
        );
        this._purgeId = settings.connect(
            'changed::purge-requested', () => { this._onPurgeRequested(); }
        );
        // Moving the boundary re-labels which day "today" is, so anything
        // showing a total has to redraw even though no time was tracked.
        this._dayStartId = settings.connect(
            'changed::day-start-hour', () => { this.onChange?.(); }
        );
    }

    _getRetentionDays() {
        return this._settings.get_int('retention-days');
    }

    _dayStartHour() {
        return this._settings.get_int('day-start-hour');
    }

    _ensureDir() {
        let dir = Gio.File.new_for_path(STORE_DIR);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    }

    // Async so disk IO can't drop compositor frames (EGO-X-004). Time tracked
    // before the read lands is merged in, not discarded.
    async _load() {
        let loaded = null;
        try {
            let [contents] = await Gio.File.new_for_path(STORE_FILE)
                .load_contents_async(this._cancellable);
            loaded = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            // Cancelled by destroy(): the store is gone, nothing left to do.
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // A missing file is the normal first-run case, not an error.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`[ScreenTime] load error: ${e.message}`);
        }

        if (loaded)
            this._merge(loaded);
        this._loaded = true;
        this._dropEmptyEntries();
        this._cleanup();
        this.onChange?.();
    }

    _merge(loaded) {
        for (let [date, apps] of Object.entries(loaded)) {
            let day = this._data[date];
            if (!day) {
                this._data[date] = apps;
                continue;
            }
            // Keep anything tracked while the read was in flight, adding the
            // stored totals on top of it.
            for (let [appId, info] of Object.entries(apps)) {
                if (day[appId])
                    day[appId].seconds += info.seconds;
                else
                    day[appId] = info;
            }
        }
    }

    _save() {
        // Never write before the initial read resolves, or an empty object
        // would clobber the real history on disk.
        if (!this._dirty || !this._loaded) return;
        try {
            let json = JSON.stringify(this._data, null, 2);
            let file = Gio.File.new_for_path(STORE_FILE);
            file.replace_contents(
                new TextEncoder().encode(json),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            this._dirty = false;
        } catch (e) {
            console.error(`[ScreenTime] save error: ${e.message}`);
        }
    }

    // Zero-second rows written before addTime refused them. They hold no time,
    // so dropping them changes no total anywhere; it only stops them being
    // counted as apps. A day left with nothing in it goes too.
    _dropEmptyEntries() {
        for (let [date, day] of Object.entries(this._data)) {
            for (let [appId, info] of Object.entries(day)) {
                if (!info.seconds) {
                    delete day[appId];
                    this._dirty = true;
                }
            }
            if (Object.keys(day).length === 0) {
                delete this._data[date];
                this._dirty = true;
            }
        }
    }

    _cleanup() {
        let days = this._getRetentionDays();
        if (days <= 0) return;
        this._deleteOlderThan(days);
    }

    _onPurgeRequested() {
        if (this._deleteOlderThan(MANUAL_PURGE_DAYS)) {
            this._save();
            this.onChange?.();
        }
    }

    _deleteOlderThan(days) {
        let cutoffKey = dateKey(
            GLib.DateTime.new_now_local().add_days(-days), this._dayStartHour());
        let changed = false;
        for (let key in this._data) {
            if (key < cutoffKey) {
                delete this._data[key];
                changed = true;
            }
        }
        if (changed)
            this._dirty = true;
        return changed;
    }

    addTime(appId, displayName, seconds) {
        // A focus blink shorter than half a second rounds to nothing. Storing it
        // anyway would add a zero-second app to the day, which inflates the
        // popup's "Other N apps" count and grows the file for no time at all.
        let secs = Math.round(seconds);
        if (secs <= 0)
            return;

        let today = todayKey(this._dayStartHour());
        if (!this._data[today])
            this._data[today] = {};
        if (!this._data[today][appId])
            this._data[today][appId] = { displayName, seconds: 0 };
        this._data[today][appId].seconds += secs;
        this._data[today][appId].displayName = displayName;
        this._dirty = true;
        this.onChange?.(appId, this._nameFor(appId, displayName),
            this._data[today][appId].seconds);
    }

    // Removes one app's entry from one day, returning it so it can be put
    // back with restoreEntry(), or null if there was none. A day left empty
    // goes too.
    deleteEntry(dateKey, appId) {
        let day = this._data[dateKey];
        let entry = day?.[appId];
        if (!entry)
            return null;
        delete day[appId];
        if (Object.keys(day).length === 0)
            delete this._data[dateKey];
        this._dirty = true;
        this.onChange?.();
        return { ...entry };
    }

    // Undoes deleteEntry(). Time tracked for the app since the delete is
    // added to, not overwritten, so nothing recorded in between is lost.
    restoreEntry(dateKey, appId, entry) {
        this._data[dateKey] ??= {};
        let day = this._data[dateKey];
        let seconds = entry.seconds + (day[appId]?.seconds ?? 0);
        day[appId] = { ...entry, seconds };
        this._dirty = true;
        this.onChange?.();
    }

    // An app's name as shown: the user's rename if any, else the tracked one.
    _nameFor(appId, trackedName) {
        return getAppNames(this._settings)[appId] || trackedName;
    }

    getTodayTotal() {
        return this.getTotalForDate(todayKey(this._dayStartHour()));
    }

    // Per-app usage for one day, biggest first, unfiltered. Callers decide
    // what's worth showing. `trackedName` is the Shell's name, which
    // `displayName` differs from when the app was renamed.
    getUsageForDate(dateKey) {
        let day = this._data[dateKey];
        if (!day)
            return [];
        let names = getAppNames(this._settings);
        return Object.entries(day)
            .map(([appId, info]) => ({
                appId,
                displayName: names[appId] || info.displayName,
                trackedName: info.displayName,
                seconds: info.seconds,
            }))
            .sort((a, b) => b.seconds - a.seconds);
    }

    getTotalForDate(dateKey) {
        let day = this._data[dateKey];
        if (!day)
            return 0;
        return Object.values(day).reduce((s, a) => s + a.seconds, 0);
    }

    // Oldest day still on record, so the UI knows how far back it can page.
    getOldestDate() {
        let keys = Object.keys(this._data);
        if (keys.length === 0)
            return null;
        return keys.reduce((a, b) => (a < b ? a : b));
    }

    getKnownApps() {
        return knownAppsFromData(this._data, getAppNames(this._settings));
    }

    destroy() {
        this._cancellable.cancel();
        if (this._autoSaveId) {
            GLib.source_remove(this._autoSaveId);
            this._autoSaveId = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        if (this._purgeId) {
            this._settings.disconnect(this._purgeId);
            this._purgeId = null;
        }
        if (this._dayStartId) {
            this._settings.disconnect(this._dayStartId);
            this._dayStartId = null;
        }
        this._save();
    }
}

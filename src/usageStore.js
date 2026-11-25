import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const STORE_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time'
]);
export const STORE_FILE = GLib.build_filenamev([STORE_DIR, 'usage.json']);
const AUTOSAVE_INTERVAL = 30;
const MANUAL_PURGE_DAYS = 7;

// Pass `startHour` only for a real instant: a key already shifted by whole
// days is a logical day.
export function dateKey(dateTime, startHour = 0) {
    let at = startHour > 0 ? dateTime.add_hours(-startHour) : dateTime;
    return at.format('%Y-%m-%d');
}

export function todayKey(startHour = 0) {
    return dateKey(GLib.DateTime.new_now_local(), startHour);
}

export function todayKeyFor(settings) {
    return todayKey(settings.get_int('day-start-hour'));
}

// appId -> displayName, skipping "Unknown" (the Shell's name for windows it
// cannot identify).
export function knownAppsFromData(data) {
    let known = new Map();
    for (let day of Object.values(data)) {
        for (let [appId, info] of Object.entries(day)) {
            if (info.displayName !== 'Unknown')
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
            () => { this.save(); return GLib.SOURCE_CONTINUE; }
        );
        this._settingsId = settings.connect(
            'changed::retention-days', () => { this._cleanup(); }
        );
        this._purgeId = settings.connect(
            'changed::purge-requested', () => { this._onPurgeRequested(); }
        );
        // A new day boundary can change which day is today.
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

    // Async so disk IO cannot stall the compositor. Time tracked before the
    // read finishes is merged in.
    async _load() {
        let loaded = null;
        try {
            let [contents] = await Gio.File.new_for_path(STORE_FILE)
                .load_contents_async(this._cancellable);
            loaded = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // No file yet on a first run.
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
            for (let [appId, info] of Object.entries(apps)) {
                if (day[appId])
                    day[appId].seconds += info.seconds;
                else
                    day[appId] = info;
            }
        }
    }

    save() {
        // Writing before the first read would overwrite the history on disk.
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

    // Older versions could store zero-second entries.
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
            this.save();
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
        // A zero-second entry would still count as an app in the popup.
        let secs = Math.round(seconds);
        if (secs <= 0)
            return;

        let today = todayKey(this._dayStartHour());
        if (!this._data[today])
            this._data[today] = {};
        if (!this._data[today][appId])
            this._data[today][appId] = {displayName, seconds: 0};
        this._data[today][appId].seconds += secs;
        this._data[today][appId].displayName = displayName;
        this._dirty = true;
        this.onChange?.(appId, displayName, this._data[today][appId].seconds);
    }

    // Returns the removed entry for restoreEntry(), or null.
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
        return {...entry};
    }

    // Adds to any time tracked since the delete instead of replacing it.
    restoreEntry(dateKey, appId, entry) {
        this._data[dateKey] ??= {};
        let day = this._data[dateKey];
        let seconds = entry.seconds + (day[appId]?.seconds ?? 0);
        day[appId] = {...entry, seconds};
        this._dirty = true;
        this.onChange?.();
    }

    getTodayTotal() {
        return this.getTotalForDate(todayKey(this._dayStartHour()));
    }

    getUsageForDate(dateKey) {
        let day = this._data[dateKey];
        if (!day)
            return [];
        return Object.entries(day)
            .map(([appId, info]) => ({
                appId,
                displayName: info.displayName,
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

    getOldestDate() {
        let keys = Object.keys(this._data);
        if (keys.length === 0)
            return null;
        return keys.reduce((a, b) => (a < b ? a : b));
    }

    getKnownApps() {
        return knownAppsFromData(this._data);
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
        this.save();
    }
}

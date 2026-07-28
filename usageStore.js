import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const STORE_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time'
]);
export const STORE_FILE = GLib.build_filenamev([STORE_DIR, 'usage.json']);
const AUTOSAVE_INTERVAL = 30;
const MANUAL_PURGE_DAYS = 7;

export function todayKey() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

export class UsageStore {
    constructor(settings) {
        this._settings = settings;
        this._data = {};
        this._dirty = false;
        this._loaded = false;
        this._destroyed = false;
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
    }

    _getRetentionDays() {
        return this._settings.get_int('retention-days');
    }

    _ensureDir() {
        let dir = Gio.File.new_for_path(STORE_DIR);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    }

    // Async on purpose: this runs in the compositor process, where blocking on
    // disk IO can drop frames (and trips the EGO review rule against sync file
    // IO in shell code). Time tracked before the read lands is merged in, not
    // discarded.
    async _load() {
        let loaded = null;
        try {
            let [contents] = await Gio.File.new_for_path(STORE_FILE)
                .load_contents_async(null);
            loaded = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            // A missing file is the normal first-run case, not an error.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                log('[ScreenTime] load error: ' + e.message);
        }
        if (this._destroyed)
            return;

        if (loaded)
            this._merge(loaded);
        this._loaded = true;
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
            log('[ScreenTime] save error: ' + e.message);
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
        let cutoff = GLib.DateTime.new_now_local().add_days(-days);
        let cutoffKey = cutoff.format('%Y-%m-%d');
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
        let today = todayKey();
        if (!this._data[today])
            this._data[today] = {};
        if (!this._data[today][appId])
            this._data[today][appId] = { displayName, seconds: 0 };
        this._data[today][appId].seconds += Math.round(seconds);
        this._data[today][appId].displayName = displayName;
        this._dirty = true;
        this.onChange?.(appId, displayName, this._data[today][appId].seconds);
    }

    getTodayTotal() {
        return this.getTotalForDate(todayKey());
    }

    // Per-app usage for one day, biggest first. Unfiltered — callers decide
    // what is worth showing, so that a filtered list can still be reconciled
    // against getTotalForDate().
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

    // Oldest day still on record, so the UI knows how far back it can page.
    getOldestDate() {
        let keys = Object.keys(this._data);
        if (keys.length === 0)
            return null;
        return keys.reduce((a, b) => (a < b ? a : b));
    }

    destroy() {
        this._destroyed = true;
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
        this._save();
    }
}

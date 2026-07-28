import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class LimitNotifier {
    constructor(settings) {
        this._settings = settings;
        this._notifiedToday = {}; // appId -> 'YYYY-MM-DD' of last notification
    }

    // Called with the app that just had time added and its up-to-date
    // today-total, straight from UsageStore.onChange — no extra data lookups.
    checkLimit(appId, displayName, todaySeconds) {
        let limitMinutes = this._settings.get_value('app-limits').deep_unpack()[appId];
        if (!limitMinutes || todaySeconds < limitMinutes * 60)
            return;

        let today = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        if (this._notifiedToday[appId] === today)
            return;
        this._notifiedToday[appId] = today;

        Main.notify(
            'Screen Time',
            `You've reached your ${limitMinutes}-minute limit for ${displayName} today.`
        );
    }
}

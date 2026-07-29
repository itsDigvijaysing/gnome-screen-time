import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAppLimits } from './appLimits.js';

export class LimitNotifier {
    constructor(settings) {
        this._settings = settings;
        this._notifiedToday = {}; // appId -> 'YYYY-MM-DD' of last notification
    }

    // Driven by UsageStore.onChange, so no extra data lookups are needed here.
    checkLimit(appId, displayName, todaySeconds) {
        let limitMinutes = getAppLimits(this._settings)[appId];
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

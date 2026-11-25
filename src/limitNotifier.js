import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { claimLimitAlert } from './appLimits.js';
import { todayKeyFor } from './usageStore.js';

export class LimitNotifier {
    constructor(settings) {
        this._settings = settings;
    }

    checkLimit(appId, displayName, todaySeconds) {
        let limitMinutes = claimLimitAlert(this._settings, appId, todaySeconds,
            todayKeyFor(this._settings));
        if (!limitMinutes)
            return;
        Main.notify(
            'Screen Time',
            `You've reached your ${limitMinutes}-minute limit for ${displayName} today.`
        );
    }
}

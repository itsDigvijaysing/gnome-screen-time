import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAppLimits } from './appLimits.js';
import { todayKeyFor } from './usageStore.js';

// appId -> 'YYYY-MM-DD minutes' of the last notification, so raising a limit
// the same day lets the new one notify too. Module scope on purpose:
// the Shell disables the extension at every lock and enables it again at
// unlock, which builds a new LimitNotifier, and a record kept on the instance
// let the same notification fire again after each unlock. Modules stay
// loaded for the life of the Shell, so this lasts until logout.
const notifiedOn = new Map();

export class LimitNotifier {
    constructor(settings) {
        this._settings = settings;
    }

    // Driven by UsageStore.onChange, so no extra data lookups are needed here.
    checkLimit(appId, displayName, todaySeconds) {
        let limitMinutes = getAppLimits(this._settings)[appId];
        if (!limitMinutes || todaySeconds < limitMinutes * 60)
            return;

        let stamp = `${todayKeyFor(this._settings)} ${limitMinutes}`;
        if (notifiedOn.get(appId) === stamp)
            return;
        notifiedOn.set(appId, stamp);

        Main.notify(
            'Screen Time',
            `You've reached your ${limitMinutes}-minute limit for ${displayName} today.`
        );
    }
}

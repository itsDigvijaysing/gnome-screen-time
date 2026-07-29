import GLib from 'gi://GLib';

// Single point of read/write for the `app-limits` GSettings key, shared by
// prefs.js, limitNotifier.js, and appTimerSection.js so all three agree on
// exactly the same data.

export function getAppLimits(settings) {
    return settings.get_value('app-limits').deep_unpack();
}

export function setAppLimit(settings, appId, minutes) {
    let limits = getAppLimits(settings);
    limits[appId] = minutes;
    settings.set_value('app-limits', new GLib.Variant('a{si}', limits));
}

export function removeAppLimit(settings, appId) {
    let limits = getAppLimits(settings);
    delete limits[appId];
    settings.set_value('app-limits', new GLib.Variant('a{si}', limits));
}

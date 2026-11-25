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

// Apps a timer can be added for, as [appId, name] pairs sorted by name: the
// tracked apps the app grid still shows, minus those that already have a
// limit. `gridName(id)` is the grid's current name for an app, or null when
// it is uninstalled, hidden (crash dialogs, portals) or not an app at all
// (window-only ids). Taking the name from the grid rather than from history
// also picks up renames.
export function pickableApps(known, gridName, limited) {
    let apps = [];
    for (let id of known.keys()) {
        let name = limited.has(id) ? null : gridName(id);
        if (name)
            apps.push([id, name]);
    }
    return apps.sort((a, b) => a[1].localeCompare(b[1]));
}

// What to call an app that has a limit: its current name if it is installed,
// else the name it was tracked under, and the raw id only as a last resort.
export function limitLabel(appId, appName, known) {
    return appName(appId) ?? known.get(appId) ?? appId;
}

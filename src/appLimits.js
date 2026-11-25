import GLib from 'gi://GLib';

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

// [appId, name] pairs for tracked apps the app grid shows that have no limit
// yet. `gridName(id)` returns null for apps the grid does not show.
export function pickableApps(known, gridName, limited) {
    let apps = [];
    for (let id of known.keys()) {
        let name = limited.has(id) ? null : gridName(id);
        if (name)
            apps.push([id, name]);
    }
    return apps.sort((a, b) => a[1].localeCompare(b[1]));
}

export function limitLabel(appId, appName, known) {
    return appName(appId) ?? known.get(appId) ?? appId;
}

// Returns the limit in minutes if `appId` should notify now, else 0. Shown
// alerts are kept in a setting, since the extension is disabled at every lock.
export function claimLimitAlert(settings, appId, todaySeconds, day) {
    let limits = getAppLimits(settings);
    let minutes = limits[appId];
    if (!minutes || todaySeconds < minutes * 60)
        return 0;
    let stamp = `${day} ${minutes}`;
    let shown = settings.get_value('limit-notified').deep_unpack();
    if (shown[appId] === stamp)
        return 0;
    let kept = {};
    for (let id in shown) {
        if (id in limits)
            kept[id] = shown[id];
    }
    kept[appId] = stamp;
    settings.set_value('limit-notified', new GLib.Variant('a{ss}', kept));
    return minutes;
}

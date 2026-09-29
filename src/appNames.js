import GLib from 'gi://GLib';

// Single point of read/write for the `app-names` GSettings key: names the
// user gave level-1 apps whose Shell name is wrong or unhelpful (a raw
// WM_CLASS, say). Keyed on the app id, so a rename relabels every day of
// history without touching what is stored under it.

export function getAppNames(settings) {
    return settings.get_value('app-names').deep_unpack();
}

// An empty name drops the rename, restoring the tracked one.
export function setAppName(settings, appId, name) {
    let names = getAppNames(settings);
    if (name)
        names[appId] = name;
    else
        delete names[appId];
    settings.set_value('app-names', new GLib.Variant('a{ss}', names));
}

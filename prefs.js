import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { STORE_FILE } from './usageStore.js';
import { formatTime } from './formatTime.js';

const HISTORY_DAYS = 7;
const CHART_HEIGHT = 110;
// Same accent blue the popup uses for the largest app, so the two views read
// as one product.
const BAR_RGB = [0x35 / 255, 0x84 / 255, 0xe4 / 255];

// Reading synchronously is fine here and deliberately not shared with
// usageStore.js: prefs runs in its own process, so a brief blocking read
// can't stutter the compositor the way it would in shell code.
function loadUsageData() {
    let file = Gio.File.new_for_path(STORE_FILE);
    if (!file.query_exists(null))
        return {};
    try {
        let [ok, contents] = file.load_contents(null);
        return ok ? JSON.parse(new TextDecoder().decode(contents)) : {};
    } catch (e) {
        console.error(`[ScreenTime] history load error: ${e.message}`);
        return {};
    }
}

// Oldest first, so the chart reads left-to-right ending at today.
function lastDays(data, count) {
    let now = GLib.DateTime.new_now_local();
    let days = [];
    for (let i = count - 1; i >= 0; i--) {
        let day = now.add_days(-i);
        let seconds = Object.values(data[day.format('%Y-%m-%d')] ?? {})
            .reduce((s, a) => s + a.seconds, 0);
        days.push({
            label: i === 0 ? 'Today' : day.format('%a'),
            seconds,
        });
    }
    return days;
}

function buildHistogram(days) {
    let box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        css_classes: ['card'],
        margin_top: 8,
    });

    let area = new Gtk.DrawingArea({
        content_height: CHART_HEIGHT,
        hexpand: true,
        margin_top: 12,
        margin_start: 12,
        margin_end: 12,
    });
    area.set_draw_func((widget, cr, width, height) => {
        let max = Math.max(...days.map(d => d.seconds), 1);
        let slot = width / days.length;
        let barW = Math.min(slot * 0.55, 36);

        days.forEach((d, i) => {
            let x = i * slot + (slot - barW) / 2;

            // Faint full-height track keeps empty days visible.
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.15);
            cr.rectangle(x, 0, barW, height);
            cr.fill();

            if (d.seconds > 0) {
                let h = Math.max((d.seconds / max) * height, 2);
                cr.setSourceRGBA(BAR_RGB[0], BAR_RGB[1], BAR_RGB[2], 1);
                cr.rectangle(x, height - h, barW, h);
                cr.fill();
            }
        });
        cr.$dispose();
    });
    box.append(area);

    let labels = new Gtk.Box({
        homogeneous: true,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });
    for (let d of days) {
        let cell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
        });
        cell.append(new Gtk.Label({label: d.label, css_classes: ['caption']}));
        cell.append(new Gtk.Label({
            label: d.seconds > 0 ? formatTime(d.seconds) : '—',
            css_classes: ['caption', 'dim-label'],
        }));
        labels.append(cell);
    }
    box.append(labels);

    return box;
}

export default class ScreenTimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const data = loadUsageData();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // -- Panel --
        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);

        const showTotalRow = new Adw.SwitchRow({
            title: 'Show total time in panel',
            subtitle: 'Off shows only the icon.',
        });
        settings.bind('show-total-in-panel', showTotalRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showTotalRow);

        // -- Tracking --
        const intervalGroup = new Adw.PreferencesGroup({title: 'Tracking'});
        page.add(intervalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Max Interval',
            subtitle: 'Maximum seconds between focus events before capping.',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 10,
            }),
            value: settings.get_int('max-interval'),
            snap_to_ticks: true,
        });
        settings.bind('max-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(intervalRow);

        // -- App Time Limits --
        this._addLimitsGroup(page, settings, data);

        // -- Data Retention --
        const retentionGroup = new Adw.PreferencesGroup({title: 'Data Retention'});
        page.add(retentionGroup);

        const retentionRow = new Adw.SpinRow({
            title: 'Retention Days',
            subtitle: 'Number of days to keep usage data. 0 = keep forever.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 365,
                step_increment: 1,
            }),
            value: settings.get_int('retention-days'),
            snap_to_ticks: true,
        });
        settings.bind('retention-days', retentionRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        retentionGroup.add(retentionRow);

        // -- History (bottom) --
        const historyGroup = new Adw.PreferencesGroup({
            title: 'History',
            description: `Total screen time over the last ${HISTORY_DAYS} days.`,
        });
        page.add(historyGroup);
        historyGroup.add(buildHistogram(lastDays(data, HISTORY_DAYS)));

        const purgeRow = new Adw.ActionRow({
            title: `Delete data older than ${HISTORY_DAYS} days`,
            subtitle: 'Removes all tracked history beyond the last week. This cannot be undone.',
        });
        const purgeButton = new Gtk.Button({
            label: 'Delete',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        purgeButton.connect('clicked', () => {
            settings.set_int('purge-requested', GLib.DateTime.new_now_local().to_unix());
        });
        purgeRow.add_suffix(purgeButton);
        historyGroup.add(purgeRow);

        window.set_focus(null);
    }

    _addLimitsGroup(page, settings, data) {
        const limitsGroup = new Adw.PreferencesGroup({
            title: 'App Time Limits',
            description: 'Get notified once when an app crosses its daily limit.',
        });
        page.add(limitsGroup);

        // Only apps you've actually used can be picked — sourced from tracked
        // history rather than a full system app scan.
        const knownApps = new Map(); // appId -> displayName
        for (let day of Object.values(data)) {
            for (let [appId, info] of Object.entries(day))
                knownApps.set(appId, info.displayName);
        }
        const appIds = [...knownApps.keys()].sort(
            (a, b) => knownApps.get(a).localeCompare(knownApps.get(b)));

        const limitRows = new Map(); // appId -> Adw.ActionRow

        const addLimitRow = (appId, minutes) => {
            let row = new Adw.ActionRow({
                title: knownApps.get(appId) ?? appId,
                subtitle: `${minutes} min/day`,
            });
            let removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeButton.connect('clicked', () => {
                let current = settings.get_value('app-limits').deep_unpack();
                delete current[appId];
                settings.set_value('app-limits', new GLib.Variant('a{si}', current));
                limitsGroup.remove(row);
                limitRows.delete(appId);
            });
            row.add_suffix(removeButton);
            limitsGroup.add(row);
            limitRows.set(appId, row);
        };

        // Every configured limit is listed, even if that app has dropped out of
        // the retained history — the limit is still enforced, so it has to stay
        // visible and removable (falls back to the raw app id for its title).
        let limits = settings.get_value('app-limits').deep_unpack();
        for (let [appId, minutes] of Object.entries(limits))
            addLimitRow(appId, minutes);

        if (appIds.length === 0) {
            limitsGroup.add(new Adw.ActionRow({
                title: 'No tracked apps yet',
                subtitle: 'Use the computer a bit, then come back to set limits.',
            }));
            return;
        }

        const addRow = new Adw.ActionRow({title: 'Add a limit'});
        const appDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(appIds.map(id => knownApps.get(id))),
            valign: Gtk.Align.CENTER,
        });
        const minutesSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({lower: 1, upper: 1440, step_increment: 5}),
            value: 30,
            valign: Gtk.Align.CENTER,
        });
        const addButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addButton.connect('clicked', () => {
            let appId = appIds[appDropDown.selected];
            let minutes = minutesSpin.get_value_as_int();
            let current = settings.get_value('app-limits').deep_unpack();
            current[appId] = minutes;
            settings.set_value('app-limits', new GLib.Variant('a{si}', current));
            if (limitRows.has(appId))
                limitsGroup.remove(limitRows.get(appId));
            addLimitRow(appId, minutes);
        });
        addRow.add_suffix(appDropDown);
        addRow.add_suffix(minutesSpin);
        addRow.add_suffix(addButton);
        limitsGroup.add(addRow);
    }
}

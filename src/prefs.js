import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { STORE_FILE, knownAppsFromData, dateKey } from './usageStore.js';
import { formatTime } from './formatTime.js';
import {
    getAppLimits, setAppLimit, removeAppLimit, pickableApps, limitLabel,
} from './appLimits.js';

const RANGE_CHOICES = [7, 30, 90];
// The Delete button keeps its own window, whatever the chart shows.
const PURGE_DAYS = 7;
// Above this many bars, per-day labels give way to three date ticks.
const DENSE_AFTER = 14;
const CHART_HEIGHT = 110;
const BAR_RGB = [0x35 / 255, 0x84 / 255, 0xe4 / 255];

// Sync read is fine: prefs runs in its own process.
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

// Oldest first, ending today.
function lastDays(data, count, startHour) {
    // Shift once here, so dateKey() below is called without the hour.
    let now = GLib.DateTime.new_now_local();
    if (startHour > 0)
        now = now.add_hours(-startHour);
    let days = [];
    for (let i = count - 1; i >= 0; i--) {
        let day = now.add_days(-i);
        let seconds = Object.values(data[dateKey(day)] ?? {})
            .reduce((s, a) => s + a.seconds, 0);
        days.push({
            label: i === 0 ? 'Today' : day.format('%a'),
            tick: i === 0 ? 'Today' : day.format('%d %b'),
            seconds,
        });
    }
    return days;
}

// The average counts only days with data.
function summarise(days) {
    let used = days.filter(d => d.seconds > 0);
    let total = used.reduce((sum, d) => sum + d.seconds, 0);
    if (used.length === 0)
        return null;
    let busiest = used.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    return {
        total,
        average: Math.round(total / used.length),
        busiest,
        trackedDays: used.length,
    };
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
        let barW = Math.max(
            days.length > DENSE_AFTER ? slot - 1 : Math.min(slot * 0.55, 36), 1);

        days.forEach((d, i) => {
            let x = i * slot + (slot - barW) / 2;

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

    box.append(days.length > DENSE_AFTER ? buildTicks(days) : buildDayLabels(days));

    let stats = summarise(days);
    if (stats) {
        box.append(new Gtk.Label({
            label: `Total ${formatTime(stats.total)}  ·  ` +
                `Average ${formatTime(stats.average)} on the ${stats.trackedDays} ` +
                `day${stats.trackedDays === 1 ? '' : 's'} tracked  ·  ` +
                `Busiest ${stats.busiest.tick} (${formatTime(stats.busiest.seconds)})`,
            css_classes: ['caption', 'dim-label'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
        }));
    }

    return box;
}

function buildDayLabels(days) {
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
            label: d.seconds > 0 ? formatTime(d.seconds) : '-',
            css_classes: ['caption', 'dim-label'],
        }));
        labels.append(cell);
    }
    return labels;
}

function buildTicks(days) {
    let row = new Gtk.Box({
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });
    let picks = [
        [days[0], Gtk.Align.START, true],
        [days[Math.floor(days.length / 2)], Gtk.Align.CENTER, true],
        [days[days.length - 1], Gtk.Align.END, false],
    ];
    for (let [day, align, expand] of picks) {
        row.append(new Gtk.Label({
            label: day.tick,
            css_classes: ['caption', 'dim-label'],
            halign: align,
            hexpand: expand,
        }));
    }
    return row;
}

export default class ScreenTimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Kept on the window: a collected Gio.Settings stops its bindings.
        let settings = this.getSettings();
        window._settings = settings;
        let data = loadUsageData();

        let page = new Adw.PreferencesPage();
        window.add(page);

        let panelGroup = new Adw.PreferencesGroup({title: 'Top Bar'});
        page.add(panelGroup);

        let showTotalRow = new Adw.SwitchRow({
            title: 'Show today\'s total next to the icon',
            subtitle: 'Off shows only the icon in the top bar. '
                + 'The popup always shows the total.',
        });
        settings.bind('show-total-in-panel', showTotalRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showTotalRow);

        let intervalGroup = new Adw.PreferencesGroup({title: 'Tracking'});
        page.add(intervalGroup);

        let intervalRow = new Adw.SpinRow({
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

        // Stored in seconds, shown in minutes.
        let idleRow = new Adw.SpinRow({
            title: 'Idle Timeout',
            subtitle: 'Stop counting after this many minutes without keyboard or mouse input. 0 = never.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 120,
                step_increment: 1,
            }),
            value: Math.round(settings.get_int('idle-timeout') / 60),
            snap_to_ticks: true,
        });
        idleRow.connect('notify::value', () => {
            let seconds = idleRow.value * 60;
            if (settings.get_int('idle-timeout') !== seconds)
                settings.set_int('idle-timeout', seconds);
        });
        settings.connect('changed::idle-timeout', () => {
            let minutes = Math.round(settings.get_int('idle-timeout') / 60);
            if (idleRow.value !== minutes)
                idleRow.value = minutes;
        });
        intervalGroup.add(idleRow);

        let dayStartRow = new Adw.SpinRow({
            title: 'Day Starts At',
            subtitle: 'Hour a new day begins. 4 keeps work after midnight on the previous day.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 23,
                step_increment: 1,
            }),
            value: settings.get_int('day-start-hour'),
            snap_to_ticks: true,
        });
        settings.bind('day-start-hour', dayStartRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(dayStartRow);

        this._addLimitsGroup(page, settings, data);

        let retentionGroup = new Adw.PreferencesGroup({title: 'Data Retention'});
        page.add(retentionGroup);

        let retentionRow = new Adw.SpinRow({
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

        let historyGroup = new Adw.PreferencesGroup({
            title: 'History',
            description: 'How long you have spent at the computer each day.',
        });
        page.add(historyGroup);

        // Only ranges retention can fill, plus the retention window itself
        // (45 gives 7/30/45). 0 keeps everything.
        let retention = settings.get_int('retention-days');
        let longest = RANGE_CHOICES[RANGE_CHOICES.length - 1];
        let ranges = retention <= 0
            ? [...RANGE_CHOICES]
            : [...new Set([
                ...RANGE_CHOICES.filter(d => d <= retention),
                Math.min(retention, longest),
            ])].sort((a, b) => a - b);

        let switcher = new Gtk.Box({
            css_classes: ['linked'],
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            visible: ranges.length > 1,
        });
        historyGroup.add(switcher);
        let chartBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        historyGroup.add(chartBox);

        let showRange = days => {
            let previous = chartBox.get_first_child();
            if (previous)
                chartBox.remove(previous);
            chartBox.append(buildHistogram(
                lastDays(data, days, settings.get_int('day-start-hour'))));
        };

        // Connected after building, so no `toggled` fires before chartBox exists.
        let firstButton = null;
        for (let days of ranges) {
            let btn = new Gtk.ToggleButton({
                label: `${days} days`,
                active: days === ranges[0],
            });
            if (firstButton)
                btn.set_group(firstButton);
            else
                firstButton = btn;
            btn.connect('toggled', () => {
                if (btn.active)
                    showRange(days);
            });
            switcher.append(btn);
        }

        let purgeRow = new Adw.ActionRow({
            title: `Delete data older than ${PURGE_DAYS} days`,
            subtitle: 'Removes all tracked history beyond the last week. This cannot be undone.',
        });
        let purgeButton = new Gtk.Button({
            label: 'Delete',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        purgeButton.connect('clicked', () => {
            settings.set_int('purge-requested', GLib.DateTime.new_now_local().to_unix());
        });
        purgeRow.add_suffix(purgeButton);
        historyGroup.add(purgeRow);
        showRange(ranges[0]);

        let aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        page.add(aboutGroup);
        aboutGroup.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? `${this.metadata.version ?? ''}`,
        }));

        window.set_focus(null);
    }

    _addLimitsGroup(page, settings, data) {
        let limitsGroup = new Adw.PreferencesGroup({
            title: 'App Time Limits',
            description: 'Get notified once when an app crosses its daily limit.',
        });
        page.add(limitsGroup);

        // Same rule as the popup: used apps the app grid shows.
        let knownApps = knownAppsFromData(data);
        let installed = new Map(Gio.AppInfo.get_all().map(info =>
            [info.get_id(), {name: info.get_name(), shown: info.should_show()}]));
        let appName = id => installed.get(id)?.name ?? null;
        let gridName = id => (installed.get(id)?.shown ? installed.get(id).name : null);
        let pickable = pickableApps(knownApps, gridName, new Set());
        let appIds = pickable.map(([id]) => id);

        let limitRows = new Map(); // appId -> Adw.ActionRow

        let addLimitRow = (appId, minutes) => {
            let row = new Adw.ActionRow({
                title: limitLabel(appId, appName, knownApps),
                subtitle: `${minutes} min/day`,
            });
            let removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeButton.connect('clicked', () => {
                removeAppLimit(settings, appId);
                limitsGroup.remove(row);
                limitRows.delete(appId);
            });
            row.add_suffix(removeButton);
            limitsGroup.add(row);
            limitRows.set(appId, row);
        };

        // Listed even if the app left the retained history: the limit still applies.
        let limits = getAppLimits(settings);
        for (let [appId, minutes] of Object.entries(limits))
            addLimitRow(appId, minutes);

        if (appIds.length === 0) {
            limitsGroup.add(new Adw.ActionRow(knownApps.size === 0
                ? {
                    title: 'No tracked apps yet',
                    subtitle: 'Use the computer a bit, then come back to set limits.',
                }
                : {
                    title: 'No installed apps to set a limit for',
                    subtitle: 'Limits can be set for apps in the app grid that you have used.',
                }));
            return;
        }

        let addRow = new Adw.ActionRow({title: 'Add a limit'});
        let appDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(pickable.map(([, name]) => name)),
            valign: Gtk.Align.CENTER,
        });
        let minutesSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({lower: 1, upper: 1440, step_increment: 5}),
            value: 30,
            valign: Gtk.Align.CENTER,
        });
        let addButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addButton.connect('clicked', () => {
            let appId = appIds[appDropDown.selected];
            let minutes = minutesSpin.get_value_as_int();
            setAppLimit(settings, appId, minutes);
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

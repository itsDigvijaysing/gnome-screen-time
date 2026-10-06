import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { STORE_FILE, knownAppsFromData, dateKey } from './usageStore.js';
import { formatTime } from './formatTime.js';
import { getAppLimits, setAppLimit, removeAppLimit } from './appLimits.js';

// The chart's ranges. `purge-requested` is a fixed 7-day window defined by
// the schema, so it gets its own constant: changing what the chart shows must
// never change what the Delete button deletes.
const RANGE_CHOICES = [7, 30, 90];
const PURGE_DAYS = 7;
// Past this many bars the per-day labels stop fitting, so the axis switches
// to three date ticks instead.
const DENSE_AFTER = 14;
const CHART_HEIGHT = 110;
// Same accent blue the popup uses for the largest app, so the two views read
// as one product.
const BAR_RGB = [0x35 / 255, 0x84 / 255, 0xe4 / 255];

// Sync read is fine here: prefs runs in its own process, not the compositor.
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
function lastDays(data, count, startHour) {
    // Shift into logical-day space once, here, so the key of a day and the
    // weekday printed under it come from the same instant. dateKey() must then
    // be called without the hour, or every day would be offset a second time.
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

// Summary of a range: the three numbers that answer "how have I been doing",
// which a bare chart leaves you to eyeball. Days with no data are left out of
// the average, so a machine that was off for a week does not read as a week
// of light use.
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

// The bar chart. `days` is oldest-first, so it reads left to right ending at
// today. Above DENSE_AFTER bars the per-day labels are replaced by three date
// ticks, because 30 or 90 captions will not fit and overlap into mush.
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
        // A dense range gets thinner bars with a hairline gap, so 90 of them
        // still read as separate days rather than one solid block.
        let barW = Math.max(
            days.length > DENSE_AFTER ? slot - 1 : Math.min(slot * 0.55, 36), 1);

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

    box.append(days.length > DENSE_AFTER ? buildTicks(days) : buildDayLabels(days));

    let stats = summarise(days);
    if (stats) {
        // One line rather than three rows: this is context for the chart
        // above it, not something you act on.
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

// One caption per bar: weekday on top, time underneath. Short ranges only.
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

// Oldest, middle and today, pinned to the ends so they line up with the bars
// they describe rather than floating between them.
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
        // Anchored to the window: nothing else holds a reference, and a
        // collected Gio.Settings silently stops every binding on this page.
        const settings = this.getSettings();
        window._settings = settings;
        const data = loadUsageData();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: 'Top Bar'});
        page.add(panelGroup);

        // "Panel" is the GNOME term for the top bar, but to anyone who has
        // just clicked the icon, the panel is the popup. Spell out which one
        // this hides, and that the popup's own total is not affected.
        const showTotalRow = new Adw.SwitchRow({
            title: 'Show today\'s total next to the icon',
            subtitle: 'Off shows only the icon in the top bar. '
                + 'The popup always shows the total.',
        });
        settings.bind('show-total-in-panel', showTotalRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showTotalRow);

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

        // Stored in seconds like the other tracking keys, shown in minutes.
        const idleRow = new Adw.SpinRow({
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
            const seconds = idleRow.value * 60;
            if (settings.get_int('idle-timeout') !== seconds)
                settings.set_int('idle-timeout', seconds);
        });
        settings.connect('changed::idle-timeout', () => {
            const minutes = Math.round(settings.get_int('idle-timeout') / 60);
            if (idleRow.value !== minutes)
                idleRow.value = minutes;
        });
        intervalGroup.add(idleRow);

        const dayStartRow = new Adw.SpinRow({
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

        const historyGroup = new Adw.PreferencesGroup({
            title: 'History',
            description: 'How long you have spent at the computer each day.',
        });
        page.add(historyGroup);

        // Retention caps what is worth offering: with retention at 30 there is
        // nothing behind day 30, and a 90-day range would be 60 empty bars
        // pretending to be data. 0 means keep forever, so everything stands.
        const retention = settings.get_int('retention-days');
        const longest = RANGE_CHOICES[RANGE_CHOICES.length - 1];
        // Only ranges retention can actually fill, plus the retention window
        // itself when it falls between two choices (45 gives 7/30/45), so the
        // whole kept history stays reachable and no range is padded with days
        // that were already deleted. 0 keeps forever, so all choices stand.
        const ranges = retention <= 0
            ? [...RANGE_CHOICES]
            : [...new Set([
                ...RANGE_CHOICES.filter(d => d <= retention),
                Math.min(retention, longest),
            ])].sort((a, b) => a - b);

        // Both containers are added up front, in the order they are read:
        // range buttons, then the chart. Switching range only ever swaps the
        // chart's child, so the group's rows can never end up reordered, and
        // nothing has to be removed and re-added to stay above the Delete row.
        const switcher = new Gtk.Box({
            css_classes: ['linked'],
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            visible: ranges.length > 1,
        });
        historyGroup.add(switcher);
        const chartBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        historyGroup.add(chartBox);

        // Rebuilt rather than redrawn: above DENSE_AFTER days the axis swaps
        // per-day captions for date ticks, which is a different widget tree.
        const showRange = days => {
            let previous = chartBox.get_first_child();
            if (previous)
                chartBox.remove(previous);
            chartBox.append(buildHistogram(
                lastDays(data, days, settings.get_int('day-start-hour'))));
        };

        // Buttons are wired only now, so a `toggled` emitted while the group
        // is being built cannot reach showRange before chartBox exists.
        let firstButton = null;
        for (let days of ranges) {
            let btn = new Gtk.ToggleButton({
                label: `${days} days`,
                active: days === ranges[0],
            });
            // One group, so choosing one releases the others.
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

        const purgeRow = new Adw.ActionRow({
            title: `Delete data older than ${PURGE_DAYS} days`,
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
        showRange(ranges[0]);

        // Read from metadata.json rather than a constant here, so the version
        // has exactly one source of truth and can never drift from the build.
        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        page.add(aboutGroup);
        aboutGroup.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? `${this.metadata.version ?? ''}`,
        }));

        window.set_focus(null);
    }

    _addLimitsGroup(page, settings, data) {
        const limitsGroup = new Adw.PreferencesGroup({
            title: 'App Time Limits',
            description: 'Get notified once when an app crosses its daily limit.',
        });
        page.add(limitsGroup);

        // Only apps you've actually used can be picked, not a full system app scan.
        const knownApps = knownAppsFromData(data);
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
                removeAppLimit(settings, appId);
                limitsGroup.remove(row);
                limitRows.delete(appId);
            });
            row.add_suffix(removeButton);
            limitsGroup.add(row);
            limitRows.set(appId, row);
        };

        // Listed even if the app dropped out of retained history: the limit is
        // still enforced, so it must stay visible and removable.
        let limits = getAppLimits(settings);
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

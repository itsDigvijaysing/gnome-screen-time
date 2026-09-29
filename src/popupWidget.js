import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { todayKey, todayKeyFor, dateKey } from './usageStore.js';
import { AppTimerSection } from './appTimerSection.js';
import { ROW_W, DIM_OPACITY, makeUsageBar } from './usageBar.js';
import { setAppName } from './appNames.js';

const MAX_VISIBLE = 5;
// The edit pen sits at the row's right edge, under the end of the time
// label, in the room bars already leave there; bars stop a few pixels
// short of it. The Other row keeps the same length so every bar matches.
const PEN_W = 16;
const EDIT_BAR_W = ROW_W - PEN_W - 6;
// Resting opacity of the pen: faint until its row is hovered.
const PEN_OPACITY = 70;
const ENTER_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];
const MIN_ROW_SECONDS = 60;
const COLORS = ['#3584e4', '#33d17a', '#e5a50a', '#9141ac', '#ed333b'];

// The card paints its own background, so it needs its own dark-mode foreground too.
const CARD_FG = '#241f31';

// Adwaita palette; each tier lightens one shade on hover.
const USAGE_TIERS = [
    {limit: 2 * 3600, from: '#8ff0a4', to: '#57e389', hoverFrom: '#b3f7c4', hoverTo: '#8ff0a4'},
    {limit: 5 * 3600, from: '#99c1f1', to: '#62a0ea', hoverFrom: '#bfd8f7', hoverTo: '#99c1f1'},
    {limit: Infinity, from: '#ffbdb6', to: '#f66151', hoverFrom: '#ffd6d1', hoverTo: '#ffbdb6'},
];

function tierFor(seconds) {
    return USAGE_TIERS.find(t => seconds < t.limit) ?? USAGE_TIERS.at(-1);
}

function cardStyle(tier, hover) {
    let from = hover ? tier.hoverFrom : tier.from;
    let to = hover ? tier.hoverTo : tier.to;
    return 'margin: 4px 10px 2px 10px; padding: 10px 14px; border-radius: 14px; ' +
           'background-gradient-direction: vertical; ' +
           'background-gradient-start: ' + from + '; ' +
           'background-gradient-end: ' + to + ';';
}

function keyToDate(key) {
    let [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0);
}

function shiftKey(key, days) {
    return dateKey(keyToDate(key).add_days(days));
}

function labelForKey(key, startHour) {
    let today = todayKey(startHour);
    if (key === today)
        return 'Today';
    if (key === shiftKey(today, -1))
        return 'Yesterday';
    return keyToDate(key).format('%a, %b %-d');
}

export class PopupWidget {
    constructor(menu, store, settings, openPrefs) {
        this._menu = menu;
        this._store = store;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._date = todayKeyFor(settings);
        this._timerSection = new AppTimerSection(store, settings);
        // Row editing: the app whose action line is open, whether its name
        // is being typed, and the last delete, undoable until the popup
        // closes.
        this._editing = null;
        this._renaming = false;
        this._undo = null;
        this._otherExpanded = false;

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._refresh();
            else
                this._undo = null;
        });
    }

    _refresh() {
        this._date = todayKeyFor(this._settings);
        this._timerSection.reset();
        this._editing = null;
        this._renaming = false;
        this._otherExpanded = false;
        this._build();
    }

    // How far back paging is allowed: every day in the retention window,
    // even empty ones (they render a "no data" panel instead of a dead arrow).
    _earliestKey() {
        let retention = this._settings.get_int('retention-days');
        if (retention > 0)
            return shiftKey(todayKeyFor(this._settings), -retention);
        return this._store.getOldestDate() ?? todayKeyFor(this._settings);
    }

    _build() {
        this._menu.removeAll();

        let all = this._store.getUsageForDate(this._date);
        // Same number the panel label shows, so the two can never disagree.
        let total = this._store.getTotalForDate(this._date);
        // A delete still undoable keeps its place, so nothing moves under
        // the pointer: a placeholder at the entry's old rank, which the
        // total and the Other row leave out.
        let undo = this._undo?.date === this._date ? this._undo : null;
        if (undo) {
            all.push({appId: undo.appId, displayName: undo.name,
                seconds: undo.entry.seconds, deleted: true});
            all.sort((a, b) => b.seconds - a.seconds);
        }

        this._addDateNav();
        this._addTotalCard(total);
        this._addSeparator();

        if (all.length === 0) {
            let empty = new PopupMenu.PopupBaseMenuItem({activate: false});
            empty.track_hover = false;
            empty.style = 'padding: 0;';
            empty.add_child(new St.Label({
                text: 'No data for this day',
                opacity: DIM_OPACITY,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 12px; padding: 14px; width: ${ROW_W}px;`,
            }));
            this._menu.addMenuItem(empty);
        } else {
            let top = all.filter(a => a.seconds >= MIN_ROW_SECONDS)
                .slice(0, MAX_VISIBLE);
            for (let i = 0; i < top.length; i++)
                this._addAppRow(top[i], total, COLORS[i % COLORS.length]);

            // Everything not given its own row, including the sub-minute apps,
            // is folded in here, so the rows reconcile with the total.
            let rest = all.filter(a => !top.includes(a));
            if (rest.some(a => !a.deleted)) {
                let restSeconds = rest.reduce((s, a) => s + (a.deleted ? 0 : a.seconds), 0);
                this._addOtherAppsRow(rest, restSeconds, total,
                    COLORS[top.length % COLORS.length]);
            } else if (rest.length > 0) {
                // Only the deleted app was left to fold: no Other row for it.
                this._addAppRow(rest[0], total, null);
            }
        }

        this._addSeparator();
        this._timerSection.build(this._menu, () => this._build());
        if (this._timerSection.isOpen)
            this._addSeparator();
        this._addFooter();
    }

    _addSeparator() {
        let sep = new PopupMenu.PopupSeparatorMenuItem();
        sep.style = 'margin: 2px 10px;';
        this._menu.addMenuItem(sep);
    }

    _addDateNav() {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let row = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 10px 10px; min-height: 20px;',
        });

        let canPrev = this._date > this._earliestKey();
        let canNext = this._date < todayKeyFor(this._settings);

        row.add_child(this._navButton('go-previous-symbolic', canPrev, () => {
            this._date = shiftKey(this._date, -1);
            this._build();
        }));

        row.add_child(new St.Label({
            text: labelForKey(this._date, this._settings.get_int('day-start-hour')),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-weight: 700;',
        }));

        row.add_child(this._navButton('go-next-symbolic', canNext, () => {
            this._date = shiftKey(this._date, 1);
            this._build();
        }));

        item.add_child(row);
        this._menu.addMenuItem(item);
    }

    _navButton(iconName, enabled, onClick) {
        let btn = new St.Button({
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
            style_class: 'screen-time-nav-button',
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 55,
        });
        if (enabled)
            btn.connect('clicked', onClick);
        return btn;
    }

    _addTotalCard(total) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let tier = tierFor(total);
        let card = new St.BoxLayout({
            x_expand: true,
            reactive: true,
            track_hover: true,
            style_class: 'screen-time-card',
            style: cardStyle(tier, false),
        });

        card.add_child(new St.Label({
            text: 'Total Screen Time',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-weight: 600; color: ' + CARD_FG + ';',
        }));
        card.add_child(new St.BoxLayout({x_expand: true}));
        card.add_child(new St.Label({
            text: total > 0 ? formatTime(total) : '0m',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 17px; font-weight: 800; color: ' + CARD_FG + ';',
        }));

        // The gradient is per-usage and therefore inline, which outranks any
        // stylesheet :hover rule, so the hover swap is done here instead.
        card.connect('notify::hover', () => {
            card.style = cardStyle(tier, card.hover);
        });

        item.add_child(card);
        this._menu.addMenuItem(item);
    }

    _addAppRow(app, total, color) {
        if (app.deleted)
            return [this._addUndoRow()];
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(app.seconds / total * 100) : 0;

        let row = new St.BoxLayout({
            vertical: true,
            style: 'padding: 4px 10px; width: ' + ROW_W + 'px;',
        });

        let topRow = new St.BoxLayout();
        topRow.add_child(new St.Label({
            text: app.displayName,
            style: 'font-size: 11px; font-weight: 500;',
        }));
        topRow.add_child(new St.BoxLayout({x_expand: true}));
        topRow.add_child(new St.Label({
            text: formatTime(app.seconds) + ' · ' + pct + '%',
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        }));
        row.add_child(topRow);

        let barLine = new St.BoxLayout();
        barLine.add_child(makeUsageBar(Math.round(EDIT_BAR_W * pct / 100), color, EDIT_BAR_W));
        barLine.add_child(new St.Widget({x_expand: true}));
        let pen = this._penButton(app);
        barLine.add_child(pen);
        row.add_child(barLine);
        // The pen brightens while its row is hovered, and stays bright
        // while its line is open.
        row.reactive = true;
        row.track_hover = true;
        row.connect('notify::hover', () => {
            pen.opacity = row.hover || this._editing === app.appId ? 255 : PEN_OPACITY;
        });

        item.add_child(row);
        this._menu.addMenuItem(item);
        let items = [item];
        if (this._editing === app.appId)
            items.push(this._addActionsLine(app));
        return items;
    }

    // Opens or closes this app's action line; one row at a time.
    _penButton(app) {
        let open = this._editing === app.appId;
        let btn = new St.Button({
            child: new St.Icon({icon_name: 'document-edit-symbolic', icon_size: 12}),
            style_class: 'screen-time-nav-button',
            style: 'padding: 0 2px;',
            opacity: open ? 255 : PEN_OPACITY,
            can_focus: true,
            accessible_name: `Edit ${app.displayName}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('clicked', () => {
            this._editing = open ? null : app.appId;
            this._renaming = false;
            this._build();
        });
        return btn;
    }

    // Rename relabels the app on every day without touching its time; an
    // empty name restores the one the Shell reports. Delete removes this
    // day's entry, with an undo line until the popup closes.
    _addActionsLine(app) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let line = new St.BoxLayout({
            style: `padding: 0 10px 4px 10px; spacing: 4px; width: ${ROW_W}px;`,
        });

        if (this._renaming) {
            // Enter keeps the typed name, where empty restores the Shell's;
            // Escape (or the pen) closes the line unchanged; Reset, shown
            // once the app has been renamed, restores the Shell's name.
            let rename = name => {
                setAppName(this._settings, app.appId, name);
                this._closeEdit();
            };
            let entry = new St.Entry({
                text: app.displayName,
                hint_text: app.trackedName,
                can_focus: true,
                x_expand: true,
                style: 'font-size: 11px; padding: 2px 6px; min-height: 0;',
            });
            // ClutterText's `activate` does not reach us here (the input
            // method takes the key round trip), so Enter is caught directly.
            // Escape is caught here so it closes the line, not the popup.
            entry.clutter_text.connect('key-press-event', (_a, event) => {
                let key = event.get_key_symbol();
                if (ENTER_KEYS.includes(key))
                    rename(entry.text.trim());
                else if (key === Clutter.KEY_Escape)
                    this._closeEdit();
                else
                    return Clutter.EVENT_PROPAGATE;
                return Clutter.EVENT_STOP;
            });
            line.add_child(entry);
            if (app.displayName !== app.trackedName)
                line.add_child(this._lineButton('Reset', () => rename('')));
            item.add_child(line);
            this._menu.addMenuItem(item);
            entry.grab_key_focus();
            entry.clutter_text.set_selection(0, -1);
            return item;
        }

        line.add_child(this._lineButton('Rename', () => {
            this._renaming = true;
            this._build();
        }));
        line.add_child(this._lineButton('Delete', () => {
            let entry = this._store.deleteEntry(this._date, app.appId);
            if (entry)
                this._undo = {date: this._date, appId: app.appId, entry, name: app.displayName};
            this._closeEdit();
        }));
        item.add_child(line);
        this._menu.addMenuItem(item);
        return item;
    }

    _closeEdit() {
        this._editing = null;
        this._renaming = false;
        this._build();
    }

    _lineButton(label, onClick) {
        let btn = new St.Button({
            label,
            style_class: 'button',
            style: 'font-size: 10px; padding: 2px 10px;',
            can_focus: true,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    // Stands in for the row just deleted, until the popup closes.
    _addUndoRow() {
        let undo = this._undo;
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let line = new St.BoxLayout({style: `padding: 4px 10px; width: ${ROW_W}px;`});
        line.add_child(new St.Label({
            text: `${undo.name} deleted`,
            opacity: DIM_OPACITY,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px;',
        }));
        line.add_child(this._lineButton('Undo', () => {
            this._store.restoreEntry(undo.date, undo.appId, undo.entry);
            this._undo = null;
            this._build();
        }));
        item.add_child(line);
        this._menu.addMenuItem(item);
        return item;
    }

    _addOtherAppsRow(otherApps, otherTotal, total, color) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(otherTotal / total * 100) : 0;
        let fillW = Math.round(EDIT_BAR_W * pct / 100);

        let row = new St.BoxLayout({
            vertical: true,
            style: 'padding: 4px 10px; width: ' + ROW_W + 'px;',
        });

        let topRow = new St.BoxLayout();
        topRow.add_child(new St.Label({
            text: `Other ${otherApps.filter(a => !a.deleted).length} apps`,
            opacity: DIM_OPACITY,
            style: 'font-size: 11px; font-weight: 500;',
        }));
        topRow.add_child(new St.BoxLayout({x_expand: true}));
        topRow.add_child(new St.Label({
            text: formatTime(otherTotal) + ' · ' + pct + '%',
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        }));
        let expandArrow = new St.Label({
            text: this._otherExpanded ? ' ▾' : ' ▸',
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        });
        topRow.add_child(expandArrow);
        row.add_child(topRow);

        // No pen for a fold of many apps; the gap keeps the bars aligned.
        row.add_child(makeUsageBar(fillW, color, EDIT_BAR_W));

        let btn = new St.Button({child: row, style: 'padding: 0;'});
        item.add_child(btn);
        this._menu.addMenuItem(item);

        // Kept on the widget, so opening an app's action line in here (which
        // rebuilds the popup) leaves the list open.
        let otherItems = [];
        for (let i = 0; i < otherApps.length; i++) {
            otherItems.push(...this._addAppRow(otherApps[i], total,
                COLORS[(MAX_VISIBLE + i) % COLORS.length]));
        }
        let sync = () => {
            expandArrow.text = this._otherExpanded ? ' ▾' : ' ▸';
            for (let oi of otherItems)
                oi.visible = this._otherExpanded;
        };
        sync();

        btn.connect('clicked', () => {
            this._otherExpanded = !this._otherExpanded;
            sync();
        });
    }

    _addFooter() {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let row = new St.BoxLayout({x_expand: true, style: 'padding: 0 8px 2px 8px;'});
        row.add_child(this._timerSection.createToggleButton(() => this._build()));
        row.add_child(new St.BoxLayout({x_expand: true}));   // pushes the settings button right

        let btn = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 14}),
            style_class: 'screen-time-settings-button',
            opacity: DIM_OPACITY,
            can_focus: true,
        });
        btn.connect('clicked', () => {
            this._menu.close();
            this._openPrefs?.();
        });
        row.add_child(btn);

        item.add_child(row);
        this._menu.addMenuItem(item);
    }

    destroy() {
        // The menu itself is owned by PanelIndicator, but drop the handler
        // explicitly so a late emission can't reach an already-destroyed store.
        if (this._openId) {
            this._menu.disconnect(this._openId);
            this._openId = null;
        }
        this._menu = null;
        this._store = null;
        this._settings = null;
        this._openPrefs = null;
        this._timerSection = null;
    }
}

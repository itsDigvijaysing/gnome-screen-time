import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DateUtils from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { formatTime } from './formatTime.js';
import { todayKey, todayKeyFor, dateKey } from './usageStore.js';
import { AppTimerSection } from './appTimerSection.js';
import { ROW_W, DIM_OPACITY, VERTICAL_LAYOUT, makeUsageBar } from './usageBar.js';
import { pauseUntil, pauseKind } from './pause.js';

const MAX_VISIBLE = 5;
const MIN_ROW_SECONDS = 60;
const COLORS = ['#3584e4', '#33d17a', '#e5a50a', '#9141ac', '#ed333b'];
// Bars stop short of the edit pen at the end of each row.
const PEN_W = 16;
const EDIT_BAR_W = ROW_W - PEN_W - 6;
const PEN_OPACITY = 70;
// Fixed, so a long pause label cannot widen the popup.
const PAUSE_LABEL_W = ROW_W - 76;
// [choice, label, label while a timed pause is running]
const PAUSE_CHOICES = [
    ['30m', '30 minutes', '+30 min'],
    ['1h', '1 hour', '+1 hour'],
    ['tomorrow', 'Until tomorrow', 'Until tomorrow'],
    ['manual', 'Until I resume', 'Until I resume'],
];

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

// Dark text on the card's light gradient, in either theme.
const CARD_FG = '#241f31';

// Adwaita palette; each tier lightens one shade on hover.
const USAGE_TIERS = [
    {limit: 2 * 3600, from: '#8ff0a4', to: '#57e389', hoverFrom: '#b3f7c4', hoverTo: '#8ff0a4'},
    {limit: 5 * 3600, from: '#99c1f1', to: '#62a0ea', hoverFrom: '#bfd8f7', hoverTo: '#99c1f1'},
    {limit: Infinity, from: '#ffbdb6', to: '#f66151', hoverFrom: '#ffd6d1', hoverTo: '#ffbdb6'},
];

const PAUSED_TIER = {from: '#deddda', to: '#c0bfbc', hoverFrom: '#f6f5f4', hoverTo: '#deddda'};

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
        this._editing = null;
        this._undo = null;
        this._otherExpanded = false;

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._refresh();
            else
                this._undo = null;
        });
        // The tracker clears a pause that lapses while the popup is open.
        this._pauseId = this._settings.connect('changed::paused-until',
            () => this._rebuildSoon());
    }

    // Rebuilding inside a button's click handler destroys that button while
    // Clutter still holds its grab, and the next click is lost.
    _rebuildSoon() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            if (this._menu.isOpen)
                this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        this._date = todayKeyFor(this._settings);
        this._timerSection.reset();
        this._editing = null;
        this._otherExpanded = false;
        this._build();
    }

    // Every day in the retention window can be paged to, even empty ones.
    _earliestKey() {
        let retention = this._settings.get_int('retention-days');
        if (retention > 0)
            return shiftKey(todayKeyFor(this._settings), -retention);
        return this._store.getOldestDate() ?? todayKeyFor(this._settings);
    }

    _build() {
        this._menu.removeAll();

        let all = this._store.getUsageForDate(this._date);
        let total = this._store.getTotalForDate(this._date);
        // A deleted entry keeps its place as an undo row until the popup closes.
        let undo = this._undo?.date === this._date ? this._undo : null;
        if (undo) {
            all.push({appId: undo.appId, displayName: undo.name,
                seconds: undo.entry.seconds, deleted: true});
            all.sort((a, b) => b.seconds - a.seconds);
        }

        this._addDateNav();
        this._addTotalCard(total);
        this._addPauseBlock();
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
            // Everything without its own row, so the rows add up to the total.
            let rest = all.filter(a => !top.includes(a));
            let restSeconds = rest.reduce((s, a) => s + (a.deleted ? 0 : a.seconds), 0);
            // Bars scale to the longest row. Undo rows draw no bar, so they
            // are left out.
            let scale = Math.max(restSeconds,
                ...top.filter(a => !a.deleted).map(a => a.seconds), 1);
            for (let i = 0; i < top.length; i++)
                this._addAppRow(top[i], total, COLORS[i % COLORS.length], scale);

            if (rest.some(a => !a.deleted)) {
                this._addOtherAppsRow(rest, restSeconds, total,
                    COLORS[top.length % COLORS.length], scale);
            } else if (rest.length > 0) {
                // Only the deleted app was left: no Other row.
                this._addAppRow(rest[0], total, null, scale);
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

        let isToday = this._date === todayKeyFor(this._settings);
        let paused = isToday && pauseKind(this._settings.get_int64('paused-until'),
            nowSeconds(), this._settings.get_int('day-start-hour')) !== null;
        let tier = paused ? PAUSED_TIER : tierFor(total);
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
        if (isToday)
            card.add_child(this._pauseButton(paused));

        // An inline gradient cannot be changed by a stylesheet :hover rule.
        card.connect('notify::hover', () => {
            card.style = cardStyle(tier, card.hover);
        });

        // St.Button stops the release event, so a click on the icon does
        // not toggle twice.
        if (isToday) {
            card.connect('button-release-event', () => {
                this._setPause(paused ? null : 'manual');
                return Clutter.EVENT_STOP;
            });
        }

        item.add_child(card);
        this._menu.addMenuItem(item);
    }

    _setPause(choice) {
        let until = choice === null ? 0 : pauseUntil(choice, nowSeconds(),
            this._settings.get_int('day-start-hour'),
            this._settings.get_int64('paused-until'));
        this._settings.set_int64('paused-until', until);
    }

    _pauseButton(paused) {
        let btn = new St.Button({
            child: new St.Icon({
                icon_name: paused
                    ? 'media-playback-start-symbolic'
                    : 'media-playback-pause-symbolic',
                icon_size: 16,
                style: `color: ${CARD_FG};`,
            }),
            can_focus: true,
            accessible_name: paused ? 'Resume tracking' : 'Pause tracking',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'screen-time-card-button',
            style: 'margin-left: 8px;',
        });
        btn.connect('clicked', () => this._setPause(paused ? null : 'manual'));
        return btn;
    }

    // While paused: when it ends, and durations to change it.
    _addPauseBlock() {
        if (this._date !== todayKeyFor(this._settings))
            return;

        let now = nowSeconds();
        let until = this._settings.get_int64('paused-until');
        let startHour = this._settings.get_int('day-start-hour');
        let kind = pauseKind(until, now, startHour);
        if (!kind) {
            this._pauseMenuOpen = false;
            return;
        }

        let sub = new PopupMenu.PopupSubMenuMenuItem(
            this._pauseStateText(kind, until), true);
        sub.icon.icon_name = 'media-playback-pause-symbolic';
        sub.label.style = `width: ${PAUSE_LABEL_W}px;`;
        sub.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Keep the popup open when a duration is chosen.
        sub.menu.itemActivated = () => {};
        sub.menu.connect('open-state-changed', (m, open) => {
            this._pauseMenuOpen = open;
        });

        for (let [choice, label, addLabel] of PAUSE_CHOICES) {
            // During a timed pause the durations add to the time left.
            let item = new PopupMenu.PopupMenuItem(
                kind === 'until' ? addLabel : label);
            item.setOrnament(choice === kind
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            // Choosing the ticked state again resumes.
            item.connect('activate',
                () => this._setPause(choice === kind ? null : choice));
            sub.menu.addMenuItem(item);
        }
        this._menu.addMenuItem(sub);
        // Choosing a duration rebuilds the menu, so reopen this submenu.
        // GNOME 51 takes an options object, older versions a boolean.
        if (this._pauseMenuOpen)
            sub.menu.open(parseInt(Config.PACKAGE_VERSION) >= 51 ? {animate: false} : false);
    }

    _pauseStateText(kind, until) {
        if (kind === 'manual')
            return 'Paused till you resume';
        if (kind === 'tomorrow')
            return 'Paused till tomorrow';
        // A pause lasts at most a day, so the time alone is enough.
        return `Paused till ${DateUtils.formatTime(
            GLib.DateTime.new_from_unix_local(until), {timeOnly: true})}`;
    }

    _addAppRow(app, total, color, scale) {
        if (app.deleted)
            return [this._addUndoRow()];
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(app.seconds / total * 100) : 0;

        let row = new St.BoxLayout({
            ...VERTICAL_LAYOUT,
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
        barLine.add_child(makeUsageBar(
            Math.round(EDIT_BAR_W * app.seconds / scale), color, EDIT_BAR_W));
        barLine.add_child(new St.Widget({x_expand: true}));
        let pen = this._penButton(app);
        barLine.add_child(pen);
        row.add_child(barLine);
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
            this._build();
        });
        return btn;
    }

    _addActionsLine(app) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let line = new St.BoxLayout({
            style: `padding: 0 10px 4px 10px; spacing: 4px; width: ${ROW_W}px;`,
        });

        line.add_child(this._lineButton('Delete', () => {
            let entry = this._store.deleteEntry(this._date, app.appId);
            if (entry) {
                // Deleted again before an undo: fold in the first delete so
                // Undo restores both.
                let prev = this._undo;
                if (prev?.date === this._date && prev.appId === app.appId)
                    entry.seconds += prev.entry.seconds;
                this._undo = {date: this._date, appId: app.appId, entry, name: app.displayName};
            }
            this._closeEdit();
        }));
        item.add_child(line);
        this._menu.addMenuItem(item);
        return item;
    }

    _closeEdit() {
        this._editing = null;
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

    _addOtherAppsRow(otherApps, otherTotal, total, color, scale) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(otherTotal / total * 100) : 0;
        let fillW = Math.round(EDIT_BAR_W * otherTotal / scale);

        let row = new St.BoxLayout({
            ...VERTICAL_LAYOUT,
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

        row.add_child(makeUsageBar(fillW, color, EDIT_BAR_W));

        let btn = new St.Button({child: row, style: 'padding: 0;'});
        item.add_child(btn);
        this._menu.addMenuItem(item);

        let otherItems = [];
        for (let i = 0; i < otherApps.length; i++) {
            otherItems.push(...this._addAppRow(otherApps[i], total,
                COLORS[(MAX_VISIBLE + i) % COLORS.length], scale));
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
        row.add_child(new St.BoxLayout({x_expand: true}));

        let btn = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 14}),
            style_class: 'screen-time-settings-button',
            opacity: DIM_OPACITY,
            can_focus: true,
        });
        btn.connect('clicked', () => {
            this._menu.close();
            this._openPrefs();
        });
        row.add_child(btn);

        item.add_child(row);
        this._menu.addMenuItem(item);
    }

    destroy() {
        if (this._openId) {
            this._menu.disconnect(this._openId);
            this._openId = null;
        }
        if (this._pauseId) {
            this._settings.disconnect(this._pauseId);
            this._pauseId = null;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._menu = null;
        this._store = null;
        this._settings = null;
        this._openPrefs = null;
        this._timerSection = null;
    }
}

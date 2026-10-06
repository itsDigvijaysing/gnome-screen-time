import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DateUtils from 'resource:///org/gnome/shell/misc/dateUtils.js';
import { formatTime } from './formatTime.js';
import { todayKey, todayKeyFor, dateKey } from './usageStore.js';
import { AppTimerSection } from './appTimerSection.js';
import { ROW_W, BAR_W, DIM_OPACITY, makeUsageBar } from './usageBar.js';
import { pauseUntil, pauseKind } from './pause.js';

const MAX_VISIBLE = 5;
const PAUSE_CHOICES = [
    ['30m', '+30m'], ['1h', '+1h'], ['tomorrow', 'Tomorrow'], ['manual', 'Manual'],
];
// Under this much left, the paused line adds how long remains.
const SOON_SECONDS = 30 * 60;
const ACTIVE_STYLE = 'background-color: rgba(128,128,128,0.25);';

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}
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

// Grey while tracking is paused, whatever the usage: not counting.
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

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open) this._refresh();
        });
        // A pause can end, or be changed, while the popup is open: the
        // tracker clears one that lapses. Follow it rather than show a
        // pause that no longer holds.
        this._pauseId = this._settings.connect('changed::paused-until', () => {
            if (this._menu.isOpen)
                this._build();
        });
    }

    _refresh() {
        this._date = todayKeyFor(this._settings);
        this._timerSection.reset();
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
            for (let i = 0; i < top.length; i++)
                this._addAppRow(top[i], total, COLORS[i % COLORS.length]);

            // Everything not given its own row, including the sub-minute apps,
            // is folded in here, so the rows reconcile with the total.
            let rest = all.filter(a => !top.includes(a));
            if (rest.length > 0) {
                let restSeconds = rest.reduce((s, a) => s + a.seconds, 0);
                this._addOtherAppsRow(rest, restSeconds, total,
                    COLORS[top.length % COLORS.length]);
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

        // A pause is about now, so only today's card shows it.
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
        // Pause and resume, on today only: a pause is about now, not about
        // the day being looked at.
        if (isToday)
            card.add_child(this._pauseButton());

        // The gradient is per-usage and therefore inline, which outranks any
        // stylesheet :hover rule, so the hover swap is done here instead.
        card.connect('notify::hover', () => {
            card.style = cardStyle(tier, card.hover);
        });

        item.add_child(card);
        this._menu.addMenuItem(item);
    }

    // Pause while tracking, play while paused. Pausing starts open-ended;
    // the chips under the card then set a length.
    _pauseButton() {
        let paused = pauseKind(this._settings.get_int64('paused-until'), nowSeconds(),
            this._settings.get_int('day-start-hour')) !== null;
        let btn = new St.Button({
            child: new St.Icon({
                icon_name: paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic',
                icon_size: 12,
                style: `color: ${CARD_FG};`,
            }),
            can_focus: true,
            accessible_name: paused ? 'Resume tracking' : 'Pause tracking',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'screen-time-card-button',
            style: 'margin-left: 6px;',
        });
        btn.connect('clicked', () => this._setPause(paused ? null : 'manual'));
        return btn;
    }

    _setPause(choice) {
        let until = choice === null ? 0 : pauseUntil(choice, nowSeconds(),
            this._settings.get_int('day-start-hour'),
            this._settings.get_int64('paused-until'));
        // The write rebuilds the popup through the changed handler.
        this._settings.set_int64('paused-until', until);
    }

    // Only while paused: what the pause is and how to change it. +30m and
    // +1h add to a timed pause, so they are never lit; Tomorrow and Manual
    // are states, lit while they hold. The card's play button resumes.
    _addPauseBlock() {
        let now = nowSeconds();
        let until = this._settings.get_int64('paused-until');
        let kind = pauseKind(until, now, this._settings.get_int('day-start-hour'));
        if (!kind)
            return;

        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let col = new St.BoxLayout({vertical: true, x_expand: true, style: 'padding: 6px 10px 0 10px;'});

        let top = new St.BoxLayout();
        top.add_child(new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        let when = kind === 'manual' ? 'resumed' : kind === 'tomorrow' ? 'tomorrow' : null;
        if (when === null) {
            // A pause can run up to a day, so an end on a later calendar
            // day says so rather than passing for a time later today.
            let end = GLib.DateTime.new_from_unix_local(until);
            let sameDay = end.format('%F') === GLib.DateTime.new_from_unix_local(now).format('%F');
            when = (sameDay ? '' : 'tomorrow ') + DateUtils.formatTime(end, {timeOnly: true});
        }
        // Close to the end, how long is left reads quicker than the clock
        // time. Rounded up, so the last minute says 1m rather than 0m.
        if (kind === 'until' && until - now < SOON_SECONDS)
            when += ` (in ${formatTime(Math.ceil((until - now) / 60) * 60)})`;
        top.add_child(new St.Label({
            text: `Screen Time paused until ${when}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; padding-left: 6px;',
        }));
        col.add_child(top);

        let chips = new St.BoxLayout({style: 'spacing: 4px; padding-top: 4px;'});
        for (let [choice, label] of PAUSE_CHOICES) {
            let chip = new St.Button({
                label,
                style_class: 'screen-time-nav-button',
                style: 'font-size: 11px;' + (choice === kind ? ACTIVE_STYLE : ''),
                can_focus: true,
            });
            chip.connect('clicked', () => this._setPause(choice));
            chips.add_child(chip);
        }
        col.add_child(chips);

        item.add_child(col);
        this._menu.addMenuItem(item);
    }

    _addAppRow(app, total, color) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(app.seconds / total * 100) : 0;
        let fillW = Math.round(BAR_W * pct / 100);

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

        row.add_child(makeUsageBar(fillW, color));

        item.add_child(row);
        this._menu.addMenuItem(item);
        return item;
    }

    _addOtherAppsRow(otherApps, otherTotal, total, color) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let pct = total > 0 ? Math.round(otherTotal / total * 100) : 0;
        let fillW = Math.round(BAR_W * pct / 100);

        let row = new St.BoxLayout({
            vertical: true,
            style: 'padding: 4px 10px; width: ' + ROW_W + 'px;',
        });

        let topRow = new St.BoxLayout();
        topRow.add_child(new St.Label({
            text: `Other ${otherApps.length} apps`,
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
            text: ' ▸',
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        });
        topRow.add_child(expandArrow);
        row.add_child(topRow);

        row.add_child(makeUsageBar(fillW, color));

        let btn = new St.Button({child: row, style: 'padding: 0;'});
        item.add_child(btn);
        this._menu.addMenuItem(item);

        let expanded = false;
        let otherItems = [];
        for (let i = 0; i < otherApps.length; i++) {
            let appItem = this._addAppRow(otherApps[i], total,
                COLORS[(MAX_VISIBLE + i) % COLORS.length]);
            appItem.hide();
            otherItems.push(appItem);
        }

        btn.connect('clicked', () => {
            expanded = !expanded;
            expandArrow.text = expanded ? ' ▾' : ' ▸';
            for (let oi of otherItems) {
                if (expanded)
                    oi.show();
                else
                    oi.hide();
            }
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
        if (this._pauseId) {
            this._settings.disconnect(this._pauseId);
            this._pauseId = null;
        }
        this._menu = null;
        this._store = null;
        this._settings = null;
        this._openPrefs = null;
        this._timerSection = null;
    }
}

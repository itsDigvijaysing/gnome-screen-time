import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { todayKey } from './usageStore.js';

const ROW_W = 230;
const BAR_W = ROW_W - 16;
// Neutral grays, not tinted toward light or dark — these read correctly on both
// light and dark Shell themes, unlike a translucent white/black overlay.
const TRACK_BG = 'rgba(128,128,128,0.18)';
const CARD_BG = 'rgba(128,128,128,0.15)';
// Secondary text is dimmed with actor opacity rather than a fixed color: it
// stays correct under any theme because it fades whatever foreground colour
// the theme already supplies. (St has no `dim-label` — that is a GTK class.)
const DIM_OPACITY = 160;
const MAX_VISIBLE = 5;
const MIN_ROW_SECONDS = 60;
const COLORS = ['#3584e4', '#33d17a', '#e5a50a', '#9141ac', '#ed333b'];

function keyToDate(key) {
    let [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0);
}

function shiftKey(key, days) {
    return keyToDate(key).add_days(days).format('%Y-%m-%d');
}

function labelForKey(key) {
    let today = todayKey();
    if (key === today)
        return 'Today';
    if (key === shiftKey(today, -1))
        return 'Yesterday';
    return keyToDate(key).format('%a, %b %-d');
}

export class PopupWidget {
    constructor(menu, store, openPrefs) {
        this._menu = menu;
        this._store = store;
        this._openPrefs = openPrefs;
        this._date = todayKey();

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open) this._refresh();
        });
    }

    _refresh() {
        this._date = todayKey();
        this._build();
    }

    _build() {
        this._menu.removeAll();

        let all = this._store.getUsageForDate(this._date);
        // The true total, including apps too short to earn their own row — this
        // is the same number the panel label shows, so the two always agree.
        let total = this._store.getTotalForDate(this._date);

        this._addDateNav();
        this._addTotalCard(total);
        this._addSeparator();

        if (all.length === 0) {
            let empty = new PopupMenu.PopupBaseMenuItem({activate: false});
            empty.track_hover = false;
            empty.style = 'padding: 0;';
            empty.add_child(new St.Label({
                text: 'No Data',
                opacity: DIM_OPACITY,
                style: 'font-size: 12px; padding: 12px;',
            }));
            this._menu.addMenuItem(empty);
        } else {
            let top = all.filter(a => a.seconds >= MIN_ROW_SECONDS)
                .slice(0, MAX_VISIBLE);
            for (let i = 0; i < top.length; i++)
                this._addAppRow(top[i], total, COLORS[i % COLORS.length]);

            // Everything not given its own row — including the sub-minute apps
            // — is folded in here, so the rows reconcile with the total.
            let rest = all.filter(a => !top.includes(a));
            if (rest.length > 0) {
                let restSeconds = rest.reduce((s, a) => s + a.seconds, 0);
                this._addOtherAppsRow(rest, restSeconds, total,
                    COLORS[top.length % COLORS.length]);
            }
        }

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
            style: 'padding: 2px 6px 0 6px;',
        });

        let oldest = this._store.getOldestDate();
        // Stop paging back once there is nothing older on record.
        let canPrev = oldest !== null && this._date > oldest;
        let canNext = this._date < todayKey();

        row.add_child(this._navButton('go-previous-symbolic', canPrev, () => {
            this._date = shiftKey(this._date, -1);
            this._build();
        }));

        row.add_child(new St.Label({
            text: labelForKey(this._date),
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
            style: 'padding: 4px 8px; border-radius: 6px;',
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 60,
        });
        if (enabled)
            btn.connect('clicked', onClick);
        return btn;
    }

    _addTotalCard(total) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'margin: 4px 10px 2px 10px; padding: 10px 12px; ' +
                   'background-color: ' + CARD_BG + '; border-radius: 12px;',
        });
        card.add_child(new St.Label({
            text: 'Screen Time',
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        }));
        card.add_child(new St.Label({
            text: total > 0 ? formatTime(total) : '0m',
            style: 'font-size: 20px; font-weight: 800; padding-top: 2px;',
        }));

        item.add_child(card);
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

        let barContainer = new St.BoxLayout({
            style: 'margin-top: 3px; height: 4px; width: ' + BAR_W + 'px; ' +
                   'background-color: ' + TRACK_BG + '; border-radius: 3px;',
        });
        let barFill = new St.Widget({
            style: 'height: 4px; background-color: ' + color + '; border-radius: 3px;',
            x_expand: false,
        });
        barFill.set_width(fillW);
        barContainer.add_child(barFill);
        row.add_child(barContainer);

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

        let barContainer = new St.BoxLayout({
            style: 'margin-top: 3px; height: 4px; width: ' + BAR_W + 'px; ' +
                   'background-color: ' + TRACK_BG + '; border-radius: 3px;',
        });
        let barFill = new St.Widget({
            style: 'height: 4px; background-color: ' + color + '; border-radius: 3px;',
        });
        barFill.set_width(fillW);
        barContainer.add_child(barFill);
        row.add_child(barContainer);

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
        row.add_child(new St.BoxLayout({x_expand: true}));   // pushes the button right

        let btn = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 14}),
            style: 'padding: 4px 6px; border-radius: 6px;',
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
        this._openPrefs = null;
    }
};

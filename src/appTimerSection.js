import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { todayKey } from './usageStore.js';
import { getAppLimits, setAppLimit, removeAppLimit } from './appLimits.js';

const STEP_MINUTES = 5;
const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;
const DEFAULT_MINUTES = 30;
const DIM_OPACITY = 160;
const ROW_W = 230;
const BAR_W = ROW_W - 16;
const TRACK_BG = 'rgba(128,128,128,0.18)';
const UNDER_LIMIT_COLOR = '#3584e4';
const OVER_LIMIT_COLOR = '#e5a50a';
// Caps the panel to roughly 10 short rows before it scrolls, so a long app
// list can't run the popup off the bottom of the screen.
const MAX_PANEL_HEIGHT = 260;

// Inline "Active Timers" panel shown above the popup footer. Reads and writes
// the same `app-limits` key Preferences uses (via appLimits.js), so a timer
// set from either place is the exact same data.
export class AppTimerSection {
    constructor(store, settings) {
        this._store = store;
        this._settings = settings;
        this._open = false;
        this._mode = 'list'; // 'list' | 'pick-app' | 'pick-duration'
        this._pickingAppId = null;
        this._pickingAppName = null;
        this._durationMinutes = DEFAULT_MINUTES;
    }

    get isOpen() {
        return this._open;
    }

    // Called only when the popup is freshly opened, so paging between days
    // while the section is open doesn't collapse it.
    reset() {
        this._open = false;
        this._mode = 'list';
    }

    createToggleButton(rebuild) {
        let box = new St.BoxLayout();
        box.add_child(new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            icon_size: 14,
        }));
        box.add_child(new St.Label({
            text: 'App Timer',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding-left: 4px;',
        }));
        let btn = new St.Button({
            child: box,
            style_class: 'screen-time-nav-button',
            can_focus: true,
            style: this._open ? 'background-color: rgba(128,128,128,0.25);' : '',
        });
        btn.connect('clicked', () => {
            this._open = !this._open;
            this._mode = 'list';
            rebuild();
        });
        return btn;
    }

    // Appends the expand content to `menu` as one scrollable item. No-op
    // while closed. Assumes the caller already added a separator before it.
    build(menu, rebuild) {
        if (!this._open)
            return;

        this._box = new St.BoxLayout({vertical: true, style: `width: ${ROW_W}px;`});
        if (this._mode === 'pick-app')
            this._buildPickApp(rebuild);
        else if (this._mode === 'pick-duration')
            this._buildPickDuration(rebuild);
        else
            this._buildList(rebuild);

        let scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style: `max-height: ${MAX_PANEL_HEIGHT}px;`,
        });
        scrollView.add_child(this._box);

        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        item.add_child(scrollView);
        menu.addMenuItem(item);
    }

    _header(text) {
        this._box.add_child(new St.Label({
            text,
            opacity: DIM_OPACITY,
            style: 'font-size: 10px; font-weight: 700; letter-spacing: 0.03em; ' +
                   'padding: 8px 12px 4px;',
        }));
    }

    _placeholder(text) {
        this._box.add_child(new St.Label({
            text,
            opacity: DIM_OPACITY,
            style: 'font-size: 11px; padding: 4px 12px 10px;',
        }));
    }

    _textButton(text, onClick) {
        let btn = new St.Button({
            child: new St.Label({text, style: 'font-size: 11px;'}),
            style_class: 'screen-time-nav-button',
            can_focus: true,
            style: 'width: 100%;',
        });
        btn.connect('clicked', onClick);
        this._box.add_child(btn);
    }

    _backRow(onBack, rebuild) {
        let wrapper = new St.BoxLayout({style: 'padding: 2px 8px 0;'});
        let btn = new St.Button({
            child: new St.Label({text: '‹ Back', style: 'font-size: 11px;'}),
            style_class: 'screen-time-nav-button',
            can_focus: true,
        });
        btn.connect('clicked', () => { onBack(); rebuild(); });
        wrapper.add_child(btn);
        this._box.add_child(wrapper);
    }

    _buildList(rebuild) {
        this._header('Active Timers');

        let limits = getAppLimits(this._settings);
        let appIds = Object.keys(limits);

        if (appIds.length === 0) {
            this._placeholder('No app timers set yet');
        } else {
            let usage = this._store.getUsageForDate(todayKey());
            let usedById = new Map(usage.map(a => [a.appId, a]));
            for (let appId of appIds) {
                let used = usedById.get(appId);
                this._addTimerRow(appId, used?.displayName ?? appId,
                    used?.seconds ?? 0, limits[appId], rebuild);
            }
        }

        this._textButton('+  Add app timer', () => {
            this._mode = 'pick-app';
            rebuild();
        });
    }

    _addTimerRow(appId, displayName, usedSeconds, limitMinutes, rebuild) {
        let row = new St.BoxLayout({
            vertical: true,
            style: `padding: 5px 12px; width: ${ROW_W}px;`,
        });

        let limitSeconds = limitMinutes * 60;
        let topRow = new St.BoxLayout();
        topRow.add_child(new St.Label({
            text: displayName,
            style: 'font-size: 11px; font-weight: 500;',
        }));
        topRow.add_child(new St.BoxLayout({x_expand: true}));
        topRow.add_child(new St.Label({
            text: `${formatTime(usedSeconds)} / ${formatTime(limitSeconds)}`,
            opacity: DIM_OPACITY,
            style: 'font-size: 10px;',
        }));

        let removeBtn = new St.Button({
            child: new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 12}),
            style_class: 'screen-time-nav-button',
            can_focus: true,
            style: 'margin-left: 4px;',
        });
        removeBtn.connect('clicked', () => {
            removeAppLimit(this._settings, appId);
            rebuild();
        });
        topRow.add_child(removeBtn);
        row.add_child(topRow);

        let pct = Math.min(usedSeconds / limitSeconds, 1) * 100;
        let color = usedSeconds >= limitSeconds ? OVER_LIMIT_COLOR : UNDER_LIMIT_COLOR;
        let barContainer = new St.BoxLayout({
            style: `margin-top: 3px; height: 4px; width: ${BAR_W}px; ` +
                   `background-color: ${TRACK_BG}; border-radius: 3px;`,
        });
        let barFill = new St.Widget({
            style: `height: 4px; background-color: ${color}; border-radius: 3px;`,
        });
        barFill.set_width(Math.round(BAR_W * pct / 100));
        barContainer.add_child(barFill);
        row.add_child(barContainer);

        this._box.add_child(row);
    }

    _buildPickApp(rebuild) {
        this._backRow(() => { this._mode = 'list'; }, rebuild);
        this._header('Add a timer for');

        // "Unknown"-named entries are already excluded by getKnownApps().
        let known = this._store.getKnownApps();
        let limited = new Set(Object.keys(getAppLimits(this._settings)));
        let candidates = [...known.entries()]
            .filter(([id]) => !limited.has(id))
            .sort((a, b) => a[1].localeCompare(b[1]));

        if (candidates.length === 0) {
            this._placeholder(known.size === 0
                ? 'No tracked apps yet'
                : 'All tracked apps already have a timer');
            return;
        }

        for (let [appId, displayName] of candidates) {
            this._textButton(displayName, () => {
                this._pickingAppId = appId;
                this._pickingAppName = displayName;
                this._durationMinutes = DEFAULT_MINUTES;
                this._mode = 'pick-duration';
                rebuild();
            });
        }
    }

    _buildPickDuration(rebuild) {
        this._backRow(() => { this._mode = 'pick-app'; }, rebuild);
        this._header(`Set limit for ${this._pickingAppName}`);

        let row = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 6px 12px;',
        });
        row.add_child(new St.BoxLayout({x_expand: true}));

        let canDecrease = this._durationMinutes > MIN_MINUTES;
        row.add_child(this._navButton('–', canDecrease, () => {
            this._durationMinutes = Math.max(MIN_MINUTES, this._durationMinutes - STEP_MINUTES);
            rebuild();
        }));

        row.add_child(new St.Label({
            text: formatTime(this._durationMinutes * 60),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 14px; font-weight: 700; padding: 0 12px;',
        }));

        let canIncrease = this._durationMinutes < MAX_MINUTES;
        row.add_child(this._navButton('+', canIncrease, () => {
            this._durationMinutes = Math.min(MAX_MINUTES, this._durationMinutes + STEP_MINUTES);
            rebuild();
        }));
        row.add_child(new St.BoxLayout({x_expand: true}));
        this._box.add_child(row);

        let setBtn = new St.Button({
            child: new St.Label({
                text: 'Set Timer',
                x_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11px; font-weight: 600; color: white;',
            }),
            style: 'width: 100%; background-color: #3584e4; border-radius: 6px; padding: 5px;',
            can_focus: true,
        });
        setBtn.connect('clicked', () => {
            setAppLimit(this._settings, this._pickingAppId, this._durationMinutes);
            this._mode = 'list';
            rebuild();
        });
        let confirmWrapper = new St.BoxLayout({style: 'padding: 0 12px 10px;'});
        confirmWrapper.add_child(setBtn);
        this._box.add_child(confirmWrapper);
    }

    _navButton(label, enabled, onClick) {
        let btn = new St.Button({
            child: new St.Label({text: label, style: 'font-size: 15px;'}),
            style_class: 'screen-time-nav-button',
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 55,
        });
        if (enabled)
            btn.connect('clicked', onClick);
        return btn;
    }
}

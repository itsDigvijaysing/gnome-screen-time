import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from './formatTime.js';
import { DIM_OPACITY } from './usageBar.js';

export const PanelIndicator = class extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init(0.5, 'Screen Time');

        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        // The pause badge sits over the icon's bottom-right corner, so the
        // icon still says what the indicator is while it says "paused".
        // Centred, so the stack is the icon's height rather than the panel's
        // and the badge lands on the icon's corner.
        let iconStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconStack.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'system-status-icon',
        }));
        this._pauseBadge = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            icon_size: 10,
            // Faded, so it reads as secondary to the icon it sits on.
            opacity: DIM_OPACITY,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        iconStack.add_child(this._pauseBadge);
        hbox.add_child(iconStack);
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding-left: 4px;',
        });
        hbox.add_child(this._label);
        this.add_child(hbox);

        this._totalSeconds = 0;
        this._showTotal = true;
        this._updateLabel();
    }

    addToPanel(uuid) {
        Main.panel.addToStatusArea(uuid, this);
    }

    setTotal(seconds) {
        this._totalSeconds = seconds;
        this._updateLabel();
    }

    // A pause badges the icon rather than just fading the total, so a pause
    // left on cannot pass for normal tracking.
    setPaused(paused) {
        this._pauseBadge.visible = paused;
        this._label.opacity = paused ? DIM_OPACITY : 255;
    }

    setShowTotal(show) {
        this._showTotal = show;
        this._updateLabel();
    }

    // Hidden rather than blank when there is nothing to show, so the panel
    // doesn't reserve dead space next to the icon.
    _updateLabel() {
        let visible = this._showTotal && this._totalSeconds > 0;
        this._label.visible = visible;
        if (visible)
            this._label.text = formatTime(this._totalSeconds);
    }
};

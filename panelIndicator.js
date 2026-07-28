import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from './formatTime.js';

export const PanelIndicator = class extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init(0.5, 'Screen Time');

        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        this._icon = new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'system-status-icon',
        });
        hbox.add_child(this._icon);
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

    setTracking(active) {
        this._icon.opacity = active ? 255 : 128;
    }

    setTotal(seconds) {
        this._totalSeconds = seconds;
        this._updateLabel();
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

    destroy() {
        super.destroy();
    }
};

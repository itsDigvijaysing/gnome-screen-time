import St from 'gi://St';
import Clutter from 'gi://Clutter';

// GNOME 48 added `orientation`; 51 removed `vertical`.
export const VERTICAL_LAYOUT = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

export const ROW_W = 230;
export const BAR_W = ROW_W - 16;
// Neutral, so it works on light and dark themes.
export const TRACK_BG = 'rgba(128,128,128,0.18)';
export const DIM_OPACITY = 160;

export function makeUsageBar(fillWidth, color, width = BAR_W) {
    let track = new St.BoxLayout({
        style: `margin-top: 3px; height: 4px; width: ${width}px; ` +
               `background-color: ${TRACK_BG}; border-radius: 3px;`,
    });
    let fill = new St.Widget({
        style: `height: 4px; background-color: ${color}; border-radius: 3px;`,
        x_expand: false,
    });
    fill.set_width(fillWidth);
    track.add_child(fill);
    return track;
}

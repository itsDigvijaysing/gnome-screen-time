import St from 'gi://St';

// Shared popup metrics. popupWidget.js and appTimerSection.js stack rows in the
// same menu, so their widths and neutral tones have to stay in lockstep.
export const ROW_W = 230;
export const BAR_W = ROW_W - 16;
// Neutral gray reads correctly on both light and dark Shell themes.
export const TRACK_BG = 'rgba(128,128,128,0.18)';
// Actor opacity, not a fixed color, so it fades whatever the theme supplies
// (St has no `dim-label`; that's a GTK class).
export const DIM_OPACITY = 160;

// Callers pass the fill width in pixels rather than a percentage, because they
// derive it differently: share of the day's total vs share of an app's limit.
export function makeUsageBar(fillWidth, color, width = BAR_W) {
    let track = new St.BoxLayout({
        style: `margin-top: 3px; height: 4px; width: ${width}px; ` +
               `background-color: ${TRACK_BG}; border-radius: 3px;`,
    });
    let fill = new St.Widget({
        style: `height: 4px; background-color: ${color}; border-radius: 3px;`,
        // The width is set manually below, so the fill must never take extra
        // space from the track, otherwise every bar renders full-width.
        x_expand: false,
    });
    fill.set_width(fillWidth);
    track.add_child(fill);
    return track;
}

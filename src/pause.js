import GLib from 'gi://GLib';
import { dateKey } from './usageStore.js';

// `paused-until`: 0 is not paused, MANUAL is paused until resumed, anything
// else is the unix time the pause ends.
export const MANUAL = -1;

const LENGTHS = {'30m': 30 * 60, '1h': 3600};
const MAX_TIMED = 24 * 3600;

export function isPaused(until, now) {
    return until === MANUAL || until > now;
}

function nextDayStart(now, startHour) {
    let today = dateKey(GLib.DateTime.new_from_unix_local(now), startHour);
    let [y, m, d] = today.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, startHour, 0, 0).add_days(1).to_unix();
}

// A timed choice extends a timed pause still running (`current`).
export function pauseUntil(choice, now, startHour, current = 0) {
    if (choice === 'manual')
        return MANUAL;
    if (choice === 'tomorrow')
        return nextDayStart(now, startHour);
    let from = pauseKind(current, now, startHour) === 'until' ? current : now;
    return Math.min(from + LENGTHS[choice], now + MAX_TIMED);
}

// null when not paused, else 'manual', 'tomorrow' or 'until'.
export function pauseKind(until, now, startHour) {
    if (!isPaused(until, now))
        return null;
    if (until === MANUAL)
        return 'manual';
    return until === nextDayStart(now, startHour) ? 'tomorrow' : 'until';
}

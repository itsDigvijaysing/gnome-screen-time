import GLib from 'gi://GLib';
import { dateKey } from './usageStore.js';

// The `paused-until` setting: 0 is not paused, MANUAL is paused until the
// user resumes, anything else is the unix time the pause lapses. No Shell
// imports, so plain gjs tests cover it.
export const MANUAL = -1;

const LENGTHS = { '30m': 30 * 60, '1h': 3600 };
// Timed chips add up, so they stop here; longer than a day is what Manual is for.
const MAX_TIMED = 24 * 3600;

export function isPaused(until, now) {
    return until === MANUAL || until > now;
}

// Unix time the next day starts, for the configured day boundary.
function nextDayStart(now, startHour) {
    let today = dateKey(GLib.DateTime.new_from_unix_local(now), startHour);
    let [y, m, d] = today.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, startHour, 0, 0).add_days(1).to_unix();
}

// The `paused-until` value for a chip: '30m', '1h', 'tomorrow' or 'manual'.
// A timed chip adds to a timed pause still running (`current`), so pressing
// it again extends; off manual, tomorrow or no pause, it counts from now.
export function pauseUntil(choice, now, startHour, current = 0) {
    if (choice === 'manual')
        return MANUAL;
    if (choice === 'tomorrow')
        return nextDayStart(now, startHour);
    let from = pauseKind(current, now, startHour) === 'until' ? current : now;
    return Math.min(from + LENGTHS[choice], now + MAX_TIMED);
}

// How to describe a stored value: null when not paused, 'manual',
// 'tomorrow' when it lapses at the next day boundary, otherwise 'until'.
export function pauseKind(until, now, startHour) {
    if (!isPaused(until, now))
        return null;
    if (until === MANUAL)
        return 'manual';
    return until === nextDayStart(now, startHour) ? 'tomorrow' : 'until';
}

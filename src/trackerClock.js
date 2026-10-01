// The tracker's clock arithmetic, kept free of Shell imports so it can be
// tested under plain gjs.

// Works out how many whole seconds to credit for the stretch since lastTime,
// and where the clock should restart. The store keeps whole seconds, so the
// fraction rounded away is left on the clock instead of being dropped: short
// flushes (quick focus changes) then neither lose time nor inflate it.
export function advanceClock(lastTime, now, maxSecs) {
    let elapsed = (now - lastTime) / 1000;
    let secs = Math.min(elapsed, maxSecs);
    if (secs <= 0) {
        // In debt from a previous round-up: leave the clock so the debt is
        // repaid by the next flush. A whole negative second cannot come from
        // rounding, so that is a clock jump: resynchronise.
        return { credited: 0, lastTime: secs <= -1 ? now : lastTime };
    }
    let credited = Math.round(secs);
    // Advancing by exactly what was credited leaves the residual (or the
    // debt) between the clock and now, in whole milliseconds. When maxSecs
    // capped the stretch, the excess is discarded on purpose (that is what
    // the setting is for), so no residual.
    return {
        credited,
        lastTime: secs < elapsed ? now : lastTime + credited * 1000,
    };
}

// How far a flush may credit: up to the last keyboard or mouse input
// (`idleMs` before `now`), so a stretch with no input is held back until
// input shows it was used, and dropped if the user turns out to be away.
// While idle is inhibited (a video playing) nobody is expected to type, so
// up to now. Never behind `lastTime`: a focus change credits up to now, and
// a later cut must not walk back over time already credited.
export function creditUntil(lastTime, now, idleMs, idleInhibited) {
    let until = idleInhibited ? now : now - Math.max(0, idleMs);
    return Math.max(lastTime, until);
}

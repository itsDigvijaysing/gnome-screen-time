// Whole seconds to credit since lastTime, and where the clock restarts. The
// rounding remainder stays on the clock, so quick focus changes neither lose
// nor add time.
export function advanceClock(lastTime, now, maxSecs) {
    let elapsed = (now - lastTime) / 1000;
    let secs = Math.min(elapsed, maxSecs);
    if (secs <= 0) {
        // A whole second behind cannot come from rounding: the clock jumped.
        return {credited: 0, lastTime: secs <= -1 ? now : lastTime};
    }
    let credited = Math.round(secs);
    // Time cut off by maxSecs is dropped on purpose.
    return {
        credited,
        lastTime: secs < elapsed ? now : lastTime + credited * 1000,
    };
}

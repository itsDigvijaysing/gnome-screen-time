export function formatTime(totalSecs) {
    let h = Math.floor(totalSecs / 3600);
    let m = Math.floor((totalSecs % 3600) / 60);
    if (h > 0 && m > 0)
        return h + 'h' + m + 'm';
    if (h > 0)
        return h + 'h';
    return m + 'm';
}

import GLib from 'gi://GLib';
import { test, assertEqual } from './harness.js';
import { MANUAL, isPaused, pauseUntil, pauseKind } from '../src/pause.js';

const unix = (y, m, d, h, min) => GLib.DateTime.new_local(y, m, d, h, min, 0).to_unix();
const NOW = unix(2026, 9, 28, 14, 42);

test('isPaused: 0 is running, manual is paused until resumed', () => {
    assertEqual(isPaused(0, NOW), false);
    assertEqual(isPaused(MANUAL, NOW), true);
});

test('isPaused: a timed pause holds until its expiry, then lapses', () => {
    assertEqual(isPaused(NOW + 1, NOW), true);
    assertEqual(isPaused(NOW, NOW), false, 'expires on the second');
    assertEqual(isPaused(NOW - 60, NOW), false, 'a stale expiry is not a pause');
});

test('pauseUntil: timed choices count from now', () => {
    assertEqual(pauseUntil('30m', NOW, 0), NOW + 30 * 60);
    assertEqual(pauseUntil('1h', NOW, 0), NOW + 3600);
    assertEqual(pauseUntil('manual', NOW, 0), MANUAL);
});

test('pauseUntil: tomorrow is the next day boundary', () => {
    assertEqual(pauseUntil('tomorrow', NOW, 0), unix(2026, 9, 29, 0, 0));
    assertEqual(pauseUntil('tomorrow', NOW, 4), unix(2026, 9, 29, 4, 0));
    // 02:00 with a 04:00 boundary is still yesterday's day, so tomorrow
    // starts in two hours, not in a day and two.
    let early = unix(2026, 9, 28, 2, 0);
    assertEqual(pauseUntil('tomorrow', early, 4), unix(2026, 9, 28, 4, 0));
});

test('pauseKind: reads the choice back from the stored value', () => {
    assertEqual(pauseKind(0, NOW, 0), null);
    assertEqual(pauseKind(NOW - 1, NOW, 0), null, 'lapsed');
    assertEqual(pauseKind(MANUAL, NOW, 0), 'manual');
    assertEqual(pauseKind(pauseUntil('tomorrow', NOW, 4), NOW, 4), 'tomorrow');
    assertEqual(pauseKind(NOW + 3600, NOW, 4), 'until');
});

test('pauseUntil: a timed choice adds to a timed pause still running', () => {
    let until = pauseUntil('30m', NOW, 0);
    assertEqual(pauseUntil('1h', NOW, 0, until), until + 3600);
    assertEqual(pauseUntil('30m', NOW + 60, 0, until), until + 30 * 60,
        'from the old expiry, not from now');
});

test('pauseUntil: a timed choice counts from now off manual, tomorrow or a lapsed pause', () => {
    assertEqual(pauseUntil('1h', NOW, 0, MANUAL), NOW + 3600);
    assertEqual(pauseUntil('1h', NOW, 4, pauseUntil('tomorrow', NOW, 4)), NOW + 3600);
    assertEqual(pauseUntil('1h', NOW, 0, NOW - 5), NOW + 3600);
    assertEqual(pauseUntil('1h', NOW, 0, 0), NOW + 3600);
});

test('pauseUntil: timed choices stop at a day from now, however often pressed', () => {
    let until = 0;
    for (let i = 0; i < 30; i++)
        until = pauseUntil('1h', NOW, 0, until);
    assertEqual(until, NOW + 24 * 3600);
    assertEqual(pauseUntil('30m', NOW, 0, until), NOW + 24 * 3600, 'already at the cap');
});

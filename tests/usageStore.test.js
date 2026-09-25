import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import {
    UsageStore, STORE_FILE, todayKey, todayKeyFor, dateKey, knownAppsFromData,
} from '../src/usageStore.js';

function daysAgoKey(days) {
    return dateKey(GLib.DateTime.new_now_local().add_days(-days));
}

function writeStoreFile(data) {
    Gio.File.new_for_path(STORE_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify(data)),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function readStoreFile() {
    let [, contents] = Gio.File.new_for_path(STORE_FILE).load_contents(null);
    return JSON.parse(new TextDecoder().decode(contents));
}

// The initial read is asynchronous and fire-and-forget: the store announces it
// has landed by calling onChange with no arguments, where addTime always names
// the app it credited. Waiting for the argument-less call is how a test knows
// the store is ready without reaching into its internals.
function whenLoaded(store) {
    return new Promise(resolve => {
        store.onChange = (...args) => {
            if (args.length > 0)
                return;
            store.onChange = null;
            resolve();
        };
    });
}

// Each test starts from a known file, so the save in one test's destroy()
// cannot leak into the next.
async function freshStore(settings = new FakeSettings(), fileContents = null) {
    GLib.unlink(STORE_FILE);
    if (fileContents !== null)
        writeStoreFile(fileContents);
    let store = new UsageStore(settings);
    await whenLoaded(store);
    return store;
}

test('addTime: accumulates per app and reports the running total', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);
    store.addTime('a.desktop', 'A', 10);
    store.addTime('a.desktop', 'A', 5);
    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'A', seconds: 15 }]);
    assertEqual(calls, [['a.desktop', 'A', 10], ['a.desktop', 'A', 15]]);
    store.destroy();
});

test('addTime: each credit is rounded as it lands', async () => {
    let store = await freshStore();
    store.addTime('a.desktop', 'A', 10.4);
    store.addTime('a.desktop', 'A', 10.6);
    assertEqual(store.getTotalForDate(todayKey()), 21);
    store.destroy();
});

test('addTime: a renamed app keeps its time under the same id', async () => {
    let store = await freshStore();
    store.addTime('a.desktop', 'Old Name', 10);
    store.addTime('a.desktop', 'New Name', 10);
    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'New Name', seconds: 20 }]);
    store.destroy();
});

test('getUsageForDate: biggest first, and empty for a day with nothing', async () => {
    let store = await freshStore();
    store.addTime('small.desktop', 'Small', 5);
    store.addTime('big.desktop', 'Big', 50);
    store.addTime('mid.desktop', 'Mid', 20);
    assertEqual(store.getUsageForDate(todayKey()).map(e => e.appId),
        ['big.desktop', 'mid.desktop', 'small.desktop']);
    assertEqual(store.getUsageForDate('1999-01-01'), []);
    store.destroy();
});

test('totals: the day total is the sum of its apps', async () => {
    let yesterday = daysAgoKey(1);
    let store = await freshStore(new FakeSettings(), {
        [yesterday]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    store.addTime('a.desktop', 'A', 10);
    store.addTime('b.desktop', 'B', 20);
    assertEqual(store.getTodayTotal(), 30);
    assertEqual(store.getTotalForDate(yesterday), 60);
    assertEqual(store.getTotalForDate('1999-01-01'), 0);
    store.destroy();
});

test('getOldestDate: how far back the UI may page, null when empty', async () => {
    let store = await freshStore();
    assertEqual(store.getOldestDate(), null);
    store.destroy();

    let older = daysAgoKey(3);
    let store2 = await freshStore(new FakeSettings(), {
        [daysAgoKey(1)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [older]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store2.getOldestDate(), older);
    store2.destroy();
});

test('knownAppsFromData: every app across every day, minus Unknown', () => {
    let known = knownAppsFromData({
        '2026-01-01': {
            'a.desktop': { displayName: 'A', seconds: 10 },
            'window:1': { displayName: 'Unknown', seconds: 10 },
        },
        '2026-01-02': { 'b.desktop': { displayName: 'B', seconds: 10 } },
    });
    assertEqual([...known], [['a.desktop', 'A'], ['b.desktop', 'B']]);
});

test('getKnownApps: reads the live data through the same filter', async () => {
    let store = await freshStore();
    store.addTime('a.desktop', 'A', 10);
    store.addTime('window:1', 'Unknown', 10);
    assertEqual([...store.getKnownApps()], [['a.desktop', 'A']]);
    store.destroy();
});

test('retention: days past the setting are dropped when it changes', async () => {
    let settings = new FakeSettings({ 'retention-days': 90 });
    let store = await freshStore(settings, {
        [daysAgoKey(100)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [daysAgoKey(3)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store.getOldestDate(), daysAgoKey(3),
        'the load-time cleanup already applied the 90-day setting');

    settings.set_int('retention-days', 2);
    assertEqual(store.getOldestDate(), null, 'the shorter setting takes effect at once');
    store.destroy();
});

test('retention: 0 keeps everything', async () => {
    let store = await freshStore(new FakeSettings({ 'retention-days': 0 }), {
        [daysAgoKey(1000)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store.getOldestDate(), daysAgoKey(1000));
    store.destroy();
});

test('purge: the manual trigger clears anything older than a week', async () => {
    let settings = new FakeSettings({ 'retention-days': 0 });
    let store = await freshStore(settings, {
        [daysAgoKey(30)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [daysAgoKey(3)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    let notified = 0;
    store.onChange = () => notified++;

    settings.set_int('purge-requested', 1);
    assertEqual(store.getOldestDate(), daysAgoKey(3));
    assertEqual(notified, 1, 'the UI is told to redraw');
    assertEqual(Object.keys(readStoreFile()), [daysAgoKey(3)],
        'a purge is written out immediately, not left to the next autosave');
    store.destroy();
});

test('destroy: banks the day to disk, and the next store reads it back', async () => {
    let store = await freshStore();
    store.addTime('a.desktop', 'A', 42);
    store.destroy();
    assertEqual(readStoreFile(),
        { [todayKey()]: { 'a.desktop': { displayName: 'A', seconds: 42 } } });

    let reopened = new UsageStore(new FakeSettings());
    await whenLoaded(reopened);
    assertEqual(reopened.getTodayTotal(), 42);
    reopened.destroy();
});

test('load: time tracked before the read lands is added to it, not lost', async () => {
    GLib.unlink(STORE_FILE);
    writeStoreFile({
        [todayKey()]: {
            'a.desktop': { displayName: 'A', seconds: 60 },
            'b.desktop': { displayName: 'B', seconds: 60 },
        },
    });

    let store = new UsageStore(new FakeSettings());
    let loaded = whenLoaded(store);
    // Racing the read, exactly as a focus change during startup would.
    store.addTime('a.desktop', 'A', 5);
    store.addTime('c.desktop', 'C', 5);
    await loaded;

    assertEqual(store.getUsageForDate(todayKey()), [
        { appId: 'a.desktop', displayName: 'A', seconds: 65 },
        { appId: 'b.desktop', displayName: 'B', seconds: 60 },
        { appId: 'c.desktop', displayName: 'C', seconds: 5 },
    ]);
    store.destroy();
});

test('save: a store torn down before the read lands writes nothing', async () => {
    let stored = { [todayKey()]: { 'a.desktop': { displayName: 'A', seconds: 60 } } };
    GLib.unlink(STORE_FILE);
    writeStoreFile(stored);

    // Enabled and disabled again inside the same second: the read is still in
    // flight when destroy() saves. Those 10 seconds are dropped on purpose,
    // because writing them would take the whole stored day with them.
    let store = new UsageStore(new FakeSettings());
    store.addTime('b.desktop', 'B', 10);
    store.destroy();

    assertEqual(readStoreFile(), stored,
        'saving unloaded data would clobber the history it never read');
});

test('addTime: a sub-second focus blink is not recorded as an app', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);

    store.addTime('blink.desktop', 'Unknown', 0.4);

    assertEqual(store.getUsageForDate(todayKey()), [],
        'a credit that rounds to zero must not create a row');
    assertEqual(calls, [], 'and must not announce a change');
    store.destroy();
});

test('addTime: sub-second blinks never mask a real credit', async () => {
    let store = await freshStore();
    store.addTime('a.desktop', 'A', 0.4);
    store.addTime('a.desktop', 'A', 90);
    assertEqual(store.getTotalForDate(todayKey()), 90);
    store.destroy();
});

test('load: zero-second rows written by older versions are swept out', async () => {
    let store = await freshStore(new FakeSettings(), {
        [todayKey()]: {
            'a.desktop': { displayName: 'A', seconds: 60 },
            'window:1': { displayName: 'Unknown', seconds: 0 },
        },
        [daysAgoKey(1)]: {
            'window:2': { displayName: 'Unknown', seconds: 0 },
        },
    });

    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'A', seconds: 60 }]);
    assertEqual(store.getTotalForDate(todayKey()), 60, 'no total moves');
    assertEqual(store.getOldestDate(), todayKey(),
        'a day left with nothing in it is dropped too');
    store.destroy();
});

// The day boundary. dateKey() takes the hour and subtracts it before reading
// the date, so DST is GLib's problem: NZ's spring-forward day is 23 hours long
// and its fall-back day 25, and neither should move a night's work.
const at = (y, m, d, h, min) => GLib.DateTime.new_local(y, m, d, h, min, 0);

test('dateKey: hour 0 is the plain calendar day', () => {
    assertEqual(dateKey(at(2026, 9, 24, 1, 30), 0), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 1, 30)), '2026-09-24', 'and is the default');
});

test('dateKey: before the boundary belongs to the day before', () => {
    assertEqual(dateKey(at(2026, 9, 24, 1, 30), 4), '2026-09-23');
    assertEqual(dateKey(at(2026, 9, 24, 3, 59), 4), '2026-09-23');
});

test('dateKey: the boundary hour starts the new day', () => {
    assertEqual(dateKey(at(2026, 9, 24, 4, 0), 4), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 12, 0), 4), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 23, 59), 4), '2026-09-24');
});

test('dateKey: a 23-hour day (DST spring forward) keeps its night', () => {
    assertEqual(dateKey(at(2026, 9, 27, 1, 30), 4), '2026-09-26');
    assertEqual(dateKey(at(2026, 9, 27, 5, 0), 4), '2026-09-27');
});

test('dateKey: a 25-hour day (DST fall back) keeps its night', () => {
    assertEqual(dateKey(at(2026, 4, 5, 1, 30), 4), '2026-04-04');
    assertEqual(dateKey(at(2026, 4, 5, 6, 0), 4), '2026-04-05');
});

test('todayKeyFor: reads the boundary out of settings', () => {
    let settings = new FakeSettings({ 'day-start-hour': 0 });
    assertEqual(todayKeyFor(settings), todayKey(0));
    settings.set_int('day-start-hour', 23);
    assertEqual(todayKeyFor(settings), todayKey(23));
});

test('a day key shifted by whole days is never offset again', () => {
    // shiftKey() in the popup walks between keys that are already logical
    // days; running those back through the boundary would move every one.
    let key = dateKey(at(2026, 9, 24, 1, 30), 4);
    let [y, m, d] = key.split('-').map(Number);
    assertEqual(dateKey(GLib.DateTime.new_local(y, m, d, 0, 0, 0)), key);
});

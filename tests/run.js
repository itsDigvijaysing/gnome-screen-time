import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { runAll } from './harness.js';

// usageStore.js computes its file path from XDG_DATA_HOME at import time, so
// point that at a scratch directory before any test module is imported. This
// is why the test files are imported dynamically below, and why a run never
// touches the real usage.json.
let tmp = GLib.Dir.make_tmp('screen-time-test-XXXXXX');
GLib.setenv('XDG_DATA_HOME', tmp, true);

const FILES = [
    './formatTime.test.js',
    './appLimits.test.js',
    './usageStore.test.js',
    './pause.test.js',
    './trackerClock.test.js',
];

// Removes the scratch directory and everything UsageStore wrote inside it,
// so runs don't accumulate on disk.
function deleteRecursive(path) {
    let file = Gio.File.new_for_path(path);
    let enumerator = file.enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        let child = file.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            deleteRecursive(child.get_path());
        else
            child.delete(null);
    }
    enumerator.close(null);
    file.delete(null);
}

// A desktop session's gvfs metadata daemon can notice a freshly used
// XDG_DATA_HOME and drop a `gvfs-metadata` directory into it moments after
// the run, racing this cleanup. Retry a few times rather than leak the
// scratch directory over one lost race.
function cleanupTmp(path, attemptsLeft = 6) {
    try {
        deleteRecursive(path);
    } catch (e) {
        if (attemptsLeft <= 1) {
            printerr(`could not remove ${path}: ${e.message}`);
            return;
        }
        GLib.usleep(50000);
        cleanupTmp(path, attemptsLeft - 1);
    }
}

// UsageStore reads its file asynchronously, so the tests need a main loop to
// run in; `failed` stays non-zero if the run throws before runAll returns.
let loop = new GLib.MainLoop(null, false);
let failed = 1;
(async () => {
    for (let f of FILES)
        await import(f);
    failed = await runAll();
    cleanupTmp(tmp);
})().catch(e => {
    printerr(e.stack || String(e));
}).finally(() => loop.quit());
loop.run();
System.exit(failed ? 1 : 0);

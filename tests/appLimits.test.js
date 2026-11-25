import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import {
    getAppLimits, setAppLimit, removeAppLimit, pickableApps, limitLabel,
} from '../src/appLimits.js';

test('getAppLimits: unpacks the key into a plain object', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    assertEqual(getAppLimits(settings), { 'a.desktop': 30 });
});

test('getAppLimits: no limits set reads as an empty object', () => {
    assertEqual(getAppLimits(new FakeSettings()), {});
});

test('setAppLimit: adds one without disturbing the others', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    setAppLimit(settings, 'b.desktop', 45);
    assertEqual(getAppLimits(settings), { 'a.desktop': 30, 'b.desktop': 45 });
});

test('setAppLimit: an existing app is overwritten, not doubled up', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    setAppLimit(settings, 'a.desktop', 60);
    assertEqual(getAppLimits(settings), { 'a.desktop': 60 });
});

test('removeAppLimit: drops one and leaves the rest', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30, 'b.desktop': 45 });
    removeAppLimit(settings, 'a.desktop');
    assertEqual(getAppLimits(settings), { 'b.desktop': 45 });
});

test('removeAppLimit: an app with no limit is a no-op', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    removeAppLimit(settings, 'nothere.desktop');
    assertEqual(getAppLimits(settings), { 'a.desktop': 30 });
});

test('writes go through the settings key, so every reader sees them', () => {
    let settings = new FakeSettings();
    let seen = null;
    settings.connect('changed::app-limits', s => { seen = getAppLimits(s); });
    setAppLimit(settings, 'a.desktop', 15);
    assertEqual(seen, { 'a.desktop': 15 });
});

// Stand-ins for the Shell's app lookups: a Map of id -> name, null otherwise.
const lookup = names => id => names.get(id) ?? null;

test('pickableApps: only apps the grid still shows, named as it names them', () => {
    let known = new Map([
        ['chrome-a.desktop', 'ChatGPT'],
        ['brave-a.desktop', 'ChatGPT'],
        ['apport-gtk.desktop', 'Report a problem...'],
        ['wmclass:gjs', 'gjs'],
        ['ailinux.desktop', 'AI Linux'],
    ]);
    let grid = lookup(new Map([
        ['chrome-a.desktop', 'ChatGPT'],
        ['ailinux.desktop', 'Phoenix'],
    ]));
    assertEqual(pickableApps(known, grid, new Set()),
        [['chrome-a.desktop', 'ChatGPT'], ['ailinux.desktop', 'Phoenix']]);
});

test('pickableApps: an app that already has a limit is left out', () => {
    let known = new Map([['a.desktop', 'A'], ['b.desktop', 'B']]);
    let grid = lookup(new Map([['a.desktop', 'A'], ['b.desktop', 'B']]));
    assertEqual(pickableApps(known, grid, new Set(['a.desktop'])), [['b.desktop', 'B']]);
});

test('limitLabel: the installed app\'s current name comes first', () => {
    assertEqual(limitLabel('ailinux.desktop',
        lookup(new Map([['ailinux.desktop', 'Phoenix']])),
        new Map([['ailinux.desktop', 'AI Linux']])), 'Phoenix');
});

test('limitLabel: an uninstalled app keeps the name it was tracked under', () => {
    assertEqual(limitLabel('chrome-x-Default.desktop', lookup(new Map()),
        new Map([['chrome-x-Default.desktop', 'ChatGPT']])), 'ChatGPT');
});

test('limitLabel: the raw id only when nothing else is known', () => {
    assertEqual(limitLabel('gone.desktop', lookup(new Map()), new Map()), 'gone.desktop');
});

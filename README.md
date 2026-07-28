# Screen Time

A GNOME Shell extension that tracks how long you spend in each app, macOS Screen Time style.

The panel shows today's total at a glance. Click it for a per-app breakdown, and step back through previous days one at a time.

![Screen Time popup](assets/Look.gif)

## Features

- **Panel indicator** — today's total next to the clock, or just the icon if you prefer.
- **Per-app breakdown** — top five apps with usage bars and percentages; everything else folds into a collapsible "Other N apps" row, so the numbers always add up to the total.
- **Day-by-day history** — `‹ Today ›` steps back one day at a time.
- **App time limits** — set a daily limit per app and get a desktop notification once you cross it.
- **7-day chart** in preferences, with configurable retention and a one-click purge.
- **Accurate by default** — time on the lock screen, while the screen is blanked, or while suspended is never counted.
- **Local only** — a plain JSON file on your disk. No network access, no telemetry.

## Requirements

GNOME Shell 47, 48, 49 or 50. X11 or Wayland.

## Install

### From source

```bash
git clone <your-repo-url> gnome-screen-time
cd gnome-screen-time
make install
```

Then reload GNOME Shell and enable it:

- **Wayland** — log out and back in (there is no in-session reload).
- **X11** — press `Alt`+`F2`, type `r`, press `Enter`.

```bash
gnome-extensions enable screen-time@gnome-screen-time
```


### Preferences

Open from the gear icon at the bottom of the popup, or:

```bash
gnome-extensions prefs screen-time@gnome-screen-time
```

![Settings](assets/settings.png)

## Settings

| Setting | Default | What it does |
|---|---|---|
| Show total time in panel | On | Off shows only the icon. |
| Max interval | 600s | Caps any single tracked stretch, so a stall can't dump hours onto one app. |
| App time limits | — | Per-app daily limit in minutes; notifies once per day when crossed. |
| Retention days | 90 | How long history is kept. `0` keeps it forever. |

## How time is measured

Time is attributed to the app owning the **focused window**, updated on every focus change and every 30 seconds. Some consequences worth knowing:

- A video playing in an **unfocused** window is not counted — this measures interaction, not playback.
- Tracking **stops** when the screen blanks, when the session locks, and across suspend. It resumes from the moment you come back, so the gap belongs to nobody.
- There is **no idle detection** while the screen is still on. If you walk away without the screen blanking, that time is still counted.
- Apps without a `.desktop` file (typically AppImages) are identified by their window class, so their history accumulates instead of splitting across launches.

## Data

Usage is stored at:

```
~/.local/share/gnome-shell/screen-time/usage.json
```

It is keyed by date, then by app. Delete the file to reset everything, or use **Delete data older than 7 days** in preferences. Anything older than the retention setting is removed automatically.

## Development

```
src/        extension sources, metadata.json, stylesheet.css, schemas/
dist/       packaged release archive (build output)
assets/     screenshots
```

```bash
make            # compile the GSettings schema
make install    # install to ~/.local/share/gnome-shell/extensions/
make uninstall
make check      # syntax-check every module + validate metadata.json
make pack       # build dist/screen-time@gnome-screen-time.shell-extension.zip
make clean
```

`make check` uses `gjs -m` — note that `gjs -c` runs a string, it does **not** check syntax. `ImportError` for `resource:///org/gnome/...` and missing `Shell` typelibs are expected outside a live Shell; only `SyntaxError` counts as a failure.

The packaged archive is validated with [shexli](https://pypi.org/project/shexli/) before release:

```bash
shexli dist/screen-time@gnome-screen-time.shell-extension.zip   # expects: clean (0 findings)
```

## License

[GPL-3.0](LICENSE)

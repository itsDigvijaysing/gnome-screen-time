#!/usr/bin/env bash
# Regression test for `make install`: it must replace the installed files,
# never overwrite them in place. Overwriting schemas/gschemas.compiled changed
# the bytes under a running Shell's mmap of that file and aborted a live
# session. This holds a real mmap of an installed schema open across a second
# install and checks the mapping still reads the old bytes.
#
# Everything happens in a mktemp -d scratch tree. EXTENSION_DIR,
# EXTENSIONS_DIR and SRC_DIR are always passed on the `make` command line, so
# neither the install nor its sweep for `make reload` dev copies can touch the
# real extensions directory.
set -euo pipefail

UUID='screen-time@gnome-screen-time'
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT

EXTS_DIR="$ROOT/gnome-shell/extensions"
EXT_DIR="$EXTS_DIR/$UUID"
SRC_A="$ROOT/srcA"
SRC_B="$ROOT/srcB"

fail() { echo "install: FAIL - $*" >&2; exit 1; }

# The recipe runs rm -rf on EXTENSION_DIR: refuse outright if this run's
# path resolves anywhere under the live GNOME Shell tree.
live=$(realpath -m -- "$HOME/.local/share/gnome-shell")
case "$(realpath -m -- "$EXTS_DIR")" in
    "$live" | "$live"/*) fail "scratch dir resolves under $live" ;;
esac

run_make_install() {
    make -C "$REPO_ROOT" --no-print-directory install \
        EXTENSION_DIR="$EXT_DIR" EXTENSIONS_DIR="$EXTS_DIR" SRC_DIR="$1"
}

# Two source trees whose compiled schemas genuinely differ.
cp -r "$REPO_ROOT/src" "$SRC_A"
cp -r "$REPO_ROOT/src" "$SRC_B"
sed -i 's|</schema>|    <key name="install-test-marker" type="i"><default>0</default></key>\n</schema>|' \
    "$SRC_B/schemas/org.gnome.shell.extensions.screen-time.gschema.xml"

run_make_install "$SRC_A" >/dev/null
SCHEMA_FILE="$EXT_DIR/schemas/gschemas.compiled"
[ -f "$SCHEMA_FILE" ] || fail "$SCHEMA_FILE missing after installing A"
INODE_BEFORE=$(stat -c %i "$SCHEMA_FILE")
# A file B does not have, to check that installing B removes it.
STALE_FILE="$EXT_DIR/removed-module.js"
touch "$STALE_FILE"

# (a) Map A's schema, install B while the mapping is alive, then compare. An
# in-place rewrite either changes the mapped bytes or, if it shrank the file
# first, makes the read raise or kills the helper with SIGBUS.
set +e
OUTPUT=$(python3 - "$SCHEMA_FILE" "$REPO_ROOT" "$EXT_DIR" "$EXTS_DIR" "$SRC_B" <<'PY'
import mmap, os, subprocess, sys

schema_file, repo_root, ext_dir, exts_dir, src_b = sys.argv[1:6]
fd = os.open(schema_file, os.O_RDONLY)
before = os.read(fd, os.fstat(fd).st_size)
mm = mmap.mmap(fd, 0, prot=mmap.PROT_READ)
result = subprocess.run(
    ["make", "-C", repo_root, "--no-print-directory", "install",
     f"EXTENSION_DIR={ext_dir}", f"EXTENSIONS_DIR={exts_dir}", f"SRC_DIR={src_b}"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
if result.returncode != 0:
    print(f"installing B failed: {result.stdout.decode(errors='replace')}")
    sys.exit(1)
if mm[:] != before:
    print("the mapping of A's schema no longer reads A's bytes")
    sys.exit(1)
PY
)
STATUS=$?
set -e
[ "$STATUS" -lt 128 ] || fail "(a) the mmap helper died from signal $((STATUS - 128)) while installing B"
[ "$STATUS" -eq 0 ] || fail "(a) $OUTPUT"

# (b) B's schema is a new file, and (c) it holds B's bytes.
[ "$(stat -c %i "$SCHEMA_FILE")" != "$INODE_BEFORE" ] || fail "(b) the schema kept its inode"
cmp -s "$SCHEMA_FILE" "$SRC_B/schemas/gschemas.compiled" || fail "(c) the schema is not B's"

# (d) The directory was replaced, not merged.
[ ! -e "$STALE_FILE" ] || fail "(d) $STALE_FILE survived installing B"

echo "install: ok"

#!/usr/bin/env bash
# Regression test for `make install`: it must replace the installed extension
# directory by rename, never by overwriting files in it in place. An in-place
# overwrite of schemas/gschemas.compiled changed the bytes under a running
# Shell's mmap of that file and aborted a live session. This test reproduces
# the exact mechanism: it holds a real memory map of an installed schema file
# open across a second `make install` and checks that the mapping keeps
# reading the old, consistent bytes.
#
# Everything happens inside a throwaway scratch directory. EXTENSION_DIR,
# EXTENSIONS_DIR and SRC_DIR are always passed explicitly on the `make`
# command line so this test can never touch the real, live installation -
# EXTENSIONS_DIR included, so install's sweep for `make reload` dev copies
# looks inside the scratch tree instead of the user's extensions directory.
set -euo pipefail

UUID='screen-time@gnome-screen-time'

# --- Safety guard: must exist before any `make` invocation below. ---------
# This test is only safe because every EXTENSION_DIR it uses lives under a
# mktemp -d scratch root. Verify that structurally, not just by construction,
# before doing anything else.
abort_if_live() {
    local resolved live
    resolved=$(realpath -m -- "$1")
    live=$(realpath -m -- "$HOME/.local/share/gnome-shell")
    case "$resolved" in
        "$live" | "$live"/*)
            echo "install.sh: refusing to run - EXTENSION_DIR ($resolved) resolves under the live GNOME Shell extensions tree ($live)" >&2
            exit 1
            ;;
    esac
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

ROOT=$(mktemp -d)
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

EXTS_DIR="$ROOT/gnome-shell/extensions"
EXT_DIR="$EXTS_DIR/$UUID"
SRC_A="$ROOT/srcA"
SRC_B="$ROOT/srcB"
EXT_PARENT_PARENT=$(dirname "$(dirname "$EXT_DIR")")
STAGE_DIR="$EXT_PARENT_PARENT/.$UUID.staging"
OLD_DIR="$EXT_PARENT_PARENT/.$UUID.old"

# Guard checked against the actual path this run will use, before the first
# `make` call is even assembled below.
abort_if_live "$EXT_DIR"

# --- Build two source trees that compile to genuinely different schemas. --
cp -r "$REPO_ROOT/src" "$SRC_A"
cp -r "$REPO_ROOT/src" "$SRC_B"

python3 - "$SRC_B/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" <<'PY'
import sys

path = sys.argv[1]
with open(path) as f:
    xml = f.read()

marker = '    <key name="install-test-marker" type="i"><default>0</default></key>\n'
needle = '</schema>'
if needle not in xml:
    sys.exit(f"install.sh: no </schema> to insert marker key before in {path}")
xml = xml.replace(needle, marker + needle, 1)

with open(path, 'w') as f:
    f.write(xml)
PY

if diff -q \
    "$SRC_A/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" \
    "$SRC_B/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" >/dev/null; then
    echo "install.sh: FAIL - srcA and srcB schemas are identical; test setup is broken" >&2
    exit 1
fi

# The optional second argument is prepended to PATH, so (e) and (f) below can
# put a failing `mv` shim in front of the real one without affecting (a)-(d).
run_make_install() {
    local src_dir="$1" path_prefix="${2:-}"
    env PATH="${path_prefix:+$path_prefix:}$PATH" \
        make -C "$REPO_ROOT" --no-print-directory install \
        EXTENSION_DIR="$EXT_DIR" EXTENSIONS_DIR="$EXTS_DIR" SRC_DIR="$src_dir"
}

# A `mv` shim that fails only the exact rename that swaps the freshly built
# staging copy into place ($stage -> $ext in the Makefile's install recipe),
# and otherwise defers to the real `mv`. Used by (e) and (f) below to force
# install's final rename to fail without needing a real filesystem failure.
BIN_DIR="$ROOT/bin"
mkdir -p "$BIN_DIR"
REAL_MV=$(command -v mv)
cat > "$BIN_DIR/mv" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = "$STAGE_DIR" ] && [ "\$2" = "$EXT_DIR" ]; then
    echo "mv: simulated failure (install.sh test shim)" >&2
    exit 1
fi
exec "$REAL_MV" "\$@"
SHIM
chmod +x "$BIN_DIR/mv"

# --- Install A, then record the inode of its compiled schema. -------------
run_make_install "$SRC_A" >/dev/null

SCHEMA_FILE="$EXT_DIR/schemas/gschemas.compiled"
if [ ! -f "$SCHEMA_FILE" ]; then
    echo "install.sh: FAIL - $SCHEMA_FILE missing after installing A" >&2
    exit 1
fi

INODE_BEFORE=$(stat -c %i "$SCHEMA_FILE")

# --- Hold a real mmap of A's installed schema open across installing B. ---
# A small Python helper: it opens and maps the file, runs the second
# `make install` as a subprocess while the mapping is alive, then compares
# the mapped bytes to what it read before installing B. If an in-place
# overwrite corrupts or shrinks the file under the mapping, the read below
# can itself raise (or, in the worst case, deliver SIGBUS and kill this
# helper outright) - both are failures of assertion (a), handled below.
set +e
PY_OUTPUT=$(python3 - "$SCHEMA_FILE" "$REPO_ROOT" "$EXT_DIR" "$EXTS_DIR" "$SRC_B" <<'PY'
import mmap
import os
import subprocess
import sys

schema_file, repo_root, ext_dir, exts_dir, src_b = sys.argv[1:6]

fd = os.open(schema_file, os.O_RDONLY)
try:
    before = os.read(fd, os.fstat(fd).st_size)
    os.lseek(fd, 0, os.SEEK_SET)
    mm = mmap.mmap(fd, 0, prot=mmap.PROT_READ)
except OSError as exc:
    print(f"FAIL:setup:{exc}")
    sys.exit(1)

try:
    result = subprocess.run(
        ["make", "-C", repo_root, "--no-print-directory", "install",
         f"EXTENSION_DIR={ext_dir}", f"EXTENSIONS_DIR={exts_dir}",
         f"SRC_DIR={src_b}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
except OSError as exc:
    print(f"FAIL:install-b-exec:{exc}")
    sys.exit(1)

if result.returncode != 0:
    out = result.stdout.decode(errors="replace")
    print(f"FAIL:install-b-failed:rc={result.returncode}:{out}")
    sys.exit(1)

try:
    mapped = mm[:]
except (OSError, ValueError) as exc:
    # A truncate-then-rewrite in place can leave the mapping pointing past
    # the (transiently shorter) file; reading it then raises rather than
    # crashing the process outright.
    print(f"FAIL:mmap-read-raised:{exc}")
    sys.exit(1)

if mapped != before:
    print("FAIL:mapping-changed")
    sys.exit(1)

print("PASS:mapping-intact")
PY
)
PY_STATUS=$?
set -e

if [ "$PY_STATUS" -ne 0 ]; then
    if [ "$PY_STATUS" -ge 128 ]; then
        sig=$((PY_STATUS - 128))
        echo "install: FAIL - (a) mapping did not survive: the mmap helper died from signal $sig (likely SIGBUS from an in-place overwrite truncating the mapped file) while installing B" >&2
    else
        echo "install: FAIL - (a) mapping did not survive: $PY_OUTPUT" >&2
    fi
    exit 1
fi

case "$PY_OUTPUT" in
    PASS:mapping-intact) ;;
    FAIL:mapping-changed)
        echo "install: FAIL - (a) mapping of A's file no longer reads A's bytes after installing B" >&2
        exit 1
        ;;
    *)
        echo "install: FAIL - (a) mmap check errored: $PY_OUTPUT" >&2
        exit 1
        ;;
esac

# --- (b) the installed file now has a different inode. --------------------
INODE_AFTER=$(stat -c %i "$SCHEMA_FILE")
if [ "$INODE_AFTER" = "$INODE_BEFORE" ]; then
    echo "install: FAIL - (b) inode did not change after installing B (still $INODE_BEFORE)" >&2
    exit 1
fi

# --- (c) the installed file's content is B's compiled schema. -------------
if ! cmp -s "$SCHEMA_FILE" "$SRC_B/schemas/gschemas.compiled"; then
    echo "install: FAIL - (c) installed schema content does not match B's compiled schema" >&2
    exit 1
fi

# --- (d) neither the staging nor the .old directory is left behind. -------
if [ -e "$STAGE_DIR" ] || [ -e "$OLD_DIR" ]; then
    echo "install: FAIL - (d) leftover directory after install (staging: $STAGE_DIR, old: $OLD_DIR)" >&2
    exit 1
fi

# --- (e) a failed final rename must roll back to the previous good install.
# Start clean, install A normally, then install B with the failing `mv`
# shim active so the swap's last step (`mv "$stage" "$ext"`) fails. install
# must exit non-zero, and the extension directory must still be exactly A -
# not missing, not half-swapped.
rm -rf "$EXT_DIR" "$STAGE_DIR" "$OLD_DIR"
run_make_install "$SRC_A" >/dev/null

set +e
E_OUTPUT=$(run_make_install "$SRC_B" "$BIN_DIR" 2>&1)
E_STATUS=$?
set -e

if [ "$E_STATUS" -eq 0 ]; then
    echo "install: FAIL - (e) make install succeeded despite the failing rename shim" >&2
    exit 1
fi

if [ ! -d "$EXT_DIR" ]; then
    echo "install: FAIL - (e) extension directory missing after a failed install (no rollback); make output: $E_OUTPUT" >&2
    exit 1
fi

if ! cmp -s "$EXT_DIR/schemas/gschemas.compiled" "$SRC_A/schemas/gschemas.compiled"; then
    echo "install: FAIL - (e) extension directory does not hold A's schema after the failed install; make output: $E_OUTPUT" >&2
    exit 1
fi

# --- (f) an interrupted run must be healed, never destroyed on retry. -----
# Hand-construct the state a run interrupted between its two renames would
# leave: $ext absent, $old holding A's already-built install (exactly what
# `mv "$ext" "$old"` produces, one step before the recipe would normally
# move stage -> ext). Then install B with the failing shim active again:
# install must first heal $old back onto $ext, then fail the swap and roll
# back again - at no point may the only surviving copy be deleted.
rm -rf "$EXT_DIR" "$STAGE_DIR" "$OLD_DIR"
run_make_install "$SRC_A" >/dev/null
mv "$EXT_DIR" "$OLD_DIR"

set +e
F_OUTPUT=$(run_make_install "$SRC_B" "$BIN_DIR" 2>&1)
F_STATUS=$?
set -e

if [ "$F_STATUS" -eq 0 ]; then
    echo "install: FAIL - (f) make install succeeded despite the failing rename shim" >&2
    exit 1
fi

if [ ! -d "$EXT_DIR" ]; then
    echo "install: FAIL - (f) extension directory missing after healing an interrupted run and a failed install (only copy destroyed); make output: $F_OUTPUT" >&2
    exit 1
fi

if ! cmp -s "$EXT_DIR/schemas/gschemas.compiled" "$SRC_A/schemas/gschemas.compiled"; then
    echo "install: FAIL - (f) extension directory does not hold A's schema after healing and rollback; make output: $F_OUTPUT" >&2
    exit 1
fi

echo "install: ok"

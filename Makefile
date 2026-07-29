UUID          = screen-time@gnome-screen-time
VERSION       = 1.1.0
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR       = src
SCHEMAS_DIR   = $(SRC_DIR)/schemas
DIST_DIR      = dist
PACK_FILE     = $(DIST_DIR)/$(UUID).shell-extension.zip

.PHONY: all build schemas install uninstall pack lint check clean restart

all: build

# Compile GSettings schemas
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

build: schemas

# Install to the local GNOME Shell extensions directory. Copying the whole of
# src/ means a new module never has to be registered anywhere — if it is in
# src/, it ships.
install: build
	@mkdir -p $(EXTENSION_DIR)
	@cp -r $(SRC_DIR)/* $(EXTENSION_DIR)/
	@echo "Installed to $(EXTENSION_DIR)"
	@echo "Reload GNOME Shell: log out/in on Wayland, or Alt+F2 → 'r' on X11."

uninstall:
	@rm -rf $(EXTENSION_DIR)
	@echo "Uninstalled $(UUID)."

# Distributable archive for extensions.gnome.org.
# NOTE: per EGO-P-006, compiled schemas MUST NOT be shipped for shell-version
# 45+ — GNOME Shell compiles them at install time. This target therefore does
# NOT depend on `build`, and excludes any *.compiled defensively.
pack:
	@mkdir -p $(DIST_DIR)
	@rm -f $(PACK_FILE)
	@cd $(SRC_DIR) && zip -qr ../$(PACK_FILE) . -x "schemas/*.compiled" "*.compiled"
	@# The zip is a binary distribution of GPL source, so it carries its licence.
	@zip -q -j $(PACK_FILE) LICENSE
	@echo "Packed: $(PACK_FILE)"

# Syntax-check every module. `gjs -c` runs a string — it does NOT check syntax;
# `gjs -m` does. Import errors for resource:///org/gnome/... and missing Shell
# typelibs are expected outside a live Shell, so only SyntaxError counts.
check:
	@fail=0; \
	for f in $(SRC_DIR)/*.js; do \
		if gjs -m "$$f" 2>&1 | grep -qi "SyntaxError"; then \
			echo "SyntaxError in $$f"; fail=1; \
		fi; \
	done; \
	python3 -m json.tool $(SRC_DIR)/metadata.json >/dev/null || fail=1; \
	if [ $$fail -eq 0 ]; then echo "check: clean"; else exit 1; fi

lint:
	@if command -v eslint >/dev/null 2>&1; then \
		eslint $(SRC_DIR)/*.js; \
	else \
		echo "eslint not found. Install with: npm install -g eslint"; \
	fi

clean:
	@rm -rf $(DIST_DIR)
	@rm -f $(SCHEMAS_DIR)/*.compiled

restart:
	@if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'; \
	else \
		echo "On Wayland, log out and back in to reload extensions."; \
	fi

UUID    = screen-time@king
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

# Single source of truth: both `install` and `pack` copy exactly this list, so a
# new shared module only has to be added here once.
SOURCES = extension.js prefs.js metadata.json panelIndicator.js popupWidget.js \
          usageStore.js usageTracker.js formatTime.js limitNotifier.js

.PHONY: all schema install pack clean

all: schema

schema:
	glib-compile-schemas schemas/

install: all
	mkdir -p $(EXT_DIR)/schemas
	cp $(SOURCES) $(EXT_DIR)/
	cp schemas/*.xml $(EXT_DIR)/schemas/
	glib-compile-schemas $(EXT_DIR)/schemas/

# EGO-ready archive. Deliberately ships schemas/*.xml but NOT
# schemas/gschemas.compiled — extensions.gnome.org compiles schemas itself for
# shell 45+, and shipping the compiled blob is flagged on review.
pack:
	rm -rf build $(UUID).zip
	mkdir -p build/schemas
	cp $(SOURCES) LICENSE build/
	cp schemas/*.xml build/schemas/
	cd build && zip -qr ../$(UUID).zip .
	rm -rf build
	@echo "built $(UUID).zip"

clean:
	rm -rf build $(UUID).zip schemas/gschemas.compiled

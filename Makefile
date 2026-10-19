UUID    := downloads-dock@matthias
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions
BUILD   := build
ZIP     := $(BUILD)/$(UUID).shell-extension.zip

.PHONY: all schemas pack install link uninstall enable disable prefs nested clean

all: schemas

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas

# Build a zip you can install anywhere (or upload to extensions.gnome.org).
pack:
	mkdir -p $(BUILD)
	gnome-extensions pack --force --out-dir=$(BUILD) \
		--extra-source=downloadsMonitor.js \
		--extra-source=downloadsView.js \
		--extra-source=thumbnailer.js \
		.

# Copy-install for the current user.
install: pack
	gnome-extensions install --force $(ZIP)
	@echo
	@echo "Installed. On X11 press Alt+F2, type 'r', Enter; on Wayland log out and back in."
	@echo "Then run: make enable"

# Development install: symlink this folder so edits only need a shell restart.
link: schemas
	mkdir -p $(EXT_DIR)
	rm -rf $(EXT_DIR)/$(UUID)
	ln -s $(CURDIR) $(EXT_DIR)/$(UUID)

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(EXT_DIR)/$(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

# Try the extension in a nested GNOME Shell window. Uses throwaway config and
# data dirs, so your real settings and enabled extensions are left alone.
nested: schemas
	@tmp=$$(mktemp -d); \
	mkdir -p $$tmp/config $$tmp/data/gnome-shell/extensions; \
	ln -s $(CURDIR) $$tmp/data/gnome-shell/extensions/$(UUID); \
	cp $${XDG_CONFIG_HOME:-$$HOME/.config}/user-dirs.dirs $$tmp/config/ 2>/dev/null; \
	XDG_CONFIG_HOME=$$tmp/config XDG_DATA_HOME=$$tmp/data \
	XDG_CACHE_HOME=$$tmp/cache XDG_STATE_HOME=$$tmp/state \
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1400x900 \
	dbus-run-session -- sh -c "gsettings set org.gnome.shell enabled-extensions \"['$(UUID)']\" && \
		gnome-shell --nested --wayland --wayland-display=downloads-dock-nested"; \
	rm -rf $$tmp

clean:
	rm -rf $(BUILD) schemas/gschemas.compiled

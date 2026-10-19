// The Downloads popover content: header, list or grid of downloads, empty
// state, footer and the right-click menu for single files. It fills any
// PopupMenu, so it can hang off a dock icon.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const LIST_ICON_SIZE = 36;
const GRID_ICON_SIZE = 56;
const GRID_COLUMNS = 4;
const DIM_OPACITY = 165;
const MAX_IMAGE_PREVIEW_SIZE = 20 * 1024 * 1024;
const PREVIEWABLE_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon',
]);

// St.BoxLayout:vertical was replaced by :orientation in GNOME 48.
const HAS_ORIENTATION = 'orientation' in St.BoxLayout.prototype;

export function setVertical(box) {
    if (HAS_ORIENTATION)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

export function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function isSecondaryClick(event) {
    if (!event)
        return false;
    const type = event.type();
    return (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.BUTTON_PRESS) &&
        event.get_button() === Clutter.BUTTON_SECONDARY;
}

function isContextMenuKey(event) {
    const symbol = event.get_key_symbol();
    const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
    return symbol === Clutter.KEY_Menu || (shift && symbol === Clutter.KEY_F10);
}

// Apps that can open a content type: the default first, then the rest.
function appsForType(contentType) {
    const apps = [];
    const seen = new Set();
    const add = app => {
        const id = app?.get_id() ?? app?.get_commandline();
        if (!app || !app.should_show() || seen.has(id))
            return;
        seen.add(id);
        apps.push(app);
    };

    add(Gio.AppInfo.get_default_for_type(contentType, false));
    Gio.AppInfo.get_recommended_for_type(contentType).forEach(add);
    Gio.AppInfo.get_fallback_for_type(contentType).forEach(add);
    return apps;
}

function startOfDay(dt) {
    return GLib.DateTime.new_local(dt.get_year(), dt.get_month(), dt.get_day_of_month(), 0, 0, 0);
}

export function fallbackIcon(item) {
    return item.gicon ?? new Gio.ThemedIcon({name: 'text-x-generic'});
}

export function previewIcon(item) {
    if (item.thumbnail)
        return new Gio.FileIcon({file: Gio.File.new_for_path(item.thumbnail)});
    if (!item.partial && PREVIEWABLE_TYPES.has(item.contentType) &&
        item.size > 0 && item.size < MAX_IMAGE_PREVIEW_SIZE)
        return new Gio.FileIcon({file: item.file});
    return fallbackIcon(item);
}

function createThumbnail(item, size) {
    return new St.Icon({
        gicon: previewIcon(item),
        fallback_gicon: fallbackIcon(item),
        icon_size: size,
        style_class: 'downloads-thumbnail',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Indeterminate progress bar: a short bar gliding back and forth in a track.
// Browsers do not expose the total size, so we cannot show a real percentage.
export const PulseBar = GObject.registerClass(
class PulseBar extends St.Widget {
    _init(params) {
        const {barStyleClass, ...widgetParams} = params;
        super._init({
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
            ...widgetParams,
        });

        // BinLayout only honours alignment for children that expand.
        this._bar = new St.Widget({
            style_class: barStyleClass,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._bar);

        this._running = false;
        this.connect('notify::mapped', () => this._sync());
        this.connect('notify::width', () => this._sync());
    }

    setRunning(running) {
        if (this._running === running)
            return;
        this._running = running;
        this._sync();
    }

    _sync() {
        this._bar.remove_all_transitions();
        this._bar.translation_x = 0;

        if (!this._running || !this.mapped || !animationsEnabled())
            return;

        const [, barWidth] = this._bar.get_preferred_width(-1);
        const distance = this.width - barWidth;
        if (distance <= 0)
            return;

        this._bar.ease({
            translation_x: distance,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: -1,
            autoReverse: true,
        });
    }
});

// One download in the list view: thumbnail, name, details and a
// "show in Files" button, like Safari's downloads popover.
const DownloadRow = GObject.registerClass(
class DownloadRow extends PopupMenu.PopupBaseMenuItem {
    _init(item, view) {
        super._init({style_class: 'downloads-row'});
        this.item = item;
        this._view = view;

        this._thumbnail = createThumbnail(item, LIST_ICON_SIZE);
        this.add_child(this._thumbnail);

        const textBox = setVertical(new St.BoxLayout({
            style_class: 'downloads-row-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(textBox);

        const nameLabel = new St.Label({
            text: item.displayName,
            style_class: 'downloads-row-name',
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        textBox.add_child(nameLabel);
        this.label_actor = nameLabel;

        if (item.partial) {
            this._pulse = new PulseBar({
                style_class: 'downloads-progress-track',
                barStyleClass: 'downloads-progress-bar',
                x_expand: true,
            });
            textBox.add_child(this._pulse);
        }

        this._detailLabel = new St.Label({
            style_class: 'downloads-row-detail',
            opacity: DIM_OPACITY,
        });
        this._detailLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._detailLabel);

        const revealButton = new St.Button({
            style_class: 'downloads-reveal-button',
            child: new St.Icon({icon_name: 'system-search-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            accessible_name: _('Show in Files'),
        });
        revealButton.connect('clicked', () => this._view.revealItem(this.item));
        this.add_child(revealButton);

        this.connect('key-focus-in', () => {
            if (!this.hover)
                this._view.scrollToActor(this);
        });

        this.update();
    }

    setItem(item) {
        this.item = item;
        this.update();
    }

    refreshThumbnail() {
        this._thumbnail.gicon = previewIcon(this.item);
    }

    update() {
        this._detailLabel.text = this._view.describe(this.item);
        if (this._pulse) {
            this._pulse.visible = this.item.active;
            this._pulse.setRunning(this.item.active);
        }
    }

    vfunc_key_press_event(event) {
        if (isContextMenuKey(event)) {
            this._view.showContextMenu(this);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    activate(event) {
        if (isSecondaryClick(event))
            this._view.showContextMenu(this, event.get_coords());
        else
            this._view.openItem(this.item);
        super.activate(event);
    }
});

// One download in the grid view, like a macOS Dock stack in grid mode.
const DownloadTile = GObject.registerClass(
class DownloadTile extends PopupMenu.PopupBaseMenuItem {
    _init(item, view) {
        super._init({style_class: 'downloads-tile'});
        setVertical(this);
        this.item = item;
        this._view = view;

        this._thumbnail = createThumbnail(item, GRID_ICON_SIZE);
        this._thumbnail.x_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._thumbnail);

        const label = new St.Label({
            text: item.displayName,
            style_class: 'downloads-tile-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this.add_child(label);
        this.label_actor = label;

        this.connect('key-focus-in', () => {
            if (!this.hover)
                this._view.scrollToActor(this);
        });
    }

    setItem(item) {
        this.item = item;
    }

    update() {
    }

    refreshThumbnail() {
        this._thumbnail.gicon = previewIcon(this.item);
    }

    vfunc_key_press_event(event) {
        if (isContextMenuKey(event)) {
            this._view.showContextMenu(this);
            return Clutter.EVENT_STOP;
        }

        // Left/Right move between tiles instead of leaving the menu.
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
            const group = global.focus_manager.get_group(this);
            const direction = symbol === Clutter.KEY_Left
                ? St.DirectionType.LEFT : St.DirectionType.RIGHT;
            group?.navigate_focus(this, direction, false);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    activate(event) {
        if (isSecondaryClick(event))
            this._view.showContextMenu(this, event.get_coords());
        else
            this._view.openItem(this.item);
        super.activate(event);
    }
});

/**
 * Fills a PopupMenu with the downloads list and keeps it up to date.
 */
export class DownloadsView {
    constructor({menu, extension, settings, monitor, thumbnailer}) {
        this.menu = menu;
        this._extension = extension;
        this._settings = settings;
        this._monitor = monitor;
        this._thumbnailer = thumbnailer;
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._rows = [];
        this._contextRow = null;
        this._rebuildPending = false;

        this._buildContent();
        this._buildContextMenu();

        this.menu.connectObject(
            'open-state-changed', (m, open) => this._onMenuToggled(open),
            'menu-closed', () => {
                if (!this.menu.isOpen)
                    this._destroyRows();
            },
            this);
        this._monitor.connectObject(
            'changed', () => this._onItemsChanged(),
            'progress', () => this._onProgress(),
            this);
        this._thumbnailer.connectObject('thumbnail-ready',
            (t, item) => this._onThumbnailReady(item), this);
        this._settings.connectObject('changed::view-mode',
            () => this._rebuildList(), this);
    }

    destroy() {
        this.menu.disconnectObject(this);
        this._monitor.disconnectObject(this);
        this._thumbnailer.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._contextMenu.destroy();
        this._rows = [];
    }

    _buildContent() {
        this.menu.box.add_style_class_name('downloads-menu');

        // Header: title, Clear, settings
        const header = new St.BoxLayout({style_class: 'downloads-header', x_expand: true});
        header.add_child(new St.Label({
            text: _('Downloads'),
            style_class: 'downloads-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._clearButton = new St.Button({
            label: _('Clear'),
            style_class: 'downloads-pill-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton.connect('clicked',
            () => this._settings.set_int64('clear-before', GLib.get_real_time()));
        header.add_child(this._clearButton);

        const settingsButton = new St.Button({
            style_class: 'downloads-icon-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Settings'),
        });
        settingsButton.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        header.add_child(settingsButton);

        const headerSection = new PopupMenu.PopupMenuSection();
        headerSection.actor.add_child(header);
        this.menu.addMenuItem(headerSection);

        // Scrollable list of downloads
        this._listBox = setVertical(new St.BoxLayout({
            style_class: 'downloads-list',
            x_expand: true,
        }));
        this._scrollView = new St.ScrollView({
            style_class: 'downloads-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scrollView.set_child(this._listBox);

        this._emptyBox = setVertical(new St.BoxLayout({
            style_class: 'downloads-empty',
            x_expand: true,
            visible: false,
        }));
        this._emptyBox.add_child(new St.Icon({
            icon_name: 'folder-download-symbolic',
            style_class: 'downloads-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: DIM_OPACITY,
        }));
        this._emptyLabel = new St.Label({
            style_class: 'downloads-empty-label',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: DIM_OPACITY,
        });
        this._emptyBox.add_child(this._emptyLabel);

        const listSection = new PopupMenu.PopupMenuSection();
        listSection.actor.add_child(this._scrollView);
        listSection.actor.add_child(this._emptyBox);
        this.menu.addMenuItem(listSection);

        // Footer, like "Open in Finder"
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Open Downloads Folder'),
            () => this.openFolder(),
            'folder-open-symbolic');
    }

    _buildContextMenu() {
        // Opened at the pointer, like the desktop's right-click menu. It has
        // its own manager so it can sit on top of the open Downloads popover.
        this._contextMenu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        this._contextMenu.actor.add_style_class_name('downloads-context-menu');
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();

        this._contextMenuManager = new PopupMenu.PopupMenuManager(this._contextMenu.actor);
        this._contextMenuManager.addMenu(this._contextMenu);

        this._contextMenu.connectObject('open-state-changed', (menu, open) => {
            if (!open)
                this._onContextMenuClosed();
        }, this);
    }

    showContextMenu(row, coords = null) {
        const {item} = row;
        const menu = this._contextMenu;
        menu.removeAll();

        if (!item.partial) {
            menu.addAction(_('Open'), () => this.openItem(item));

            const apps = appsForType(item.contentType);
            if (apps.length > 0) {
                const defaultApp = Gio.AppInfo.get_default_for_type(item.contentType, false);
                const openWith = new PopupMenu.PopupSubMenuMenuItem(_('Open With'));
                apps.forEach(app => {
                    const name = defaultApp && app.get_id() === defaultApp.get_id()
                        ? _('%s (default)').format(app.get_name())
                        : app.get_name();
                    openWith.menu.addAction(name,
                        () => this._openWith(item, app),
                        app.get_icon() ?? 'application-x-executable-symbolic');
                });
                menu.addMenuItem(openWith);
            }

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        menu.addAction(_('Show in Files'), () => this.revealItem(item));

        let x, y;
        if (coords) {
            [x, y] = coords;
        } else {
            // Opened from the keyboard: anchor below the start of the row.
            const [rowX, rowY] = row.get_transformed_position();
            const [, rowHeight] = row.get_transformed_size();
            [x, y] = [rowX + 24 * scaleFactor(), rowY + rowHeight];
        }
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);

        this._contextRow = row;
        menu.open(BoxPointer.PopupAnimation.FULL);
        if (!coords)
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _onContextMenuClosed() {
        const row = this._contextRow;
        this._contextRow = null;

        if (!this.menu.isOpen)
            return;
        if (this._rebuildPending) {
            this._rebuildPending = false;
            this._rebuildList();
        } else if (row?.mapped) {
            row.grab_key_focus();
        }
    }

    _onMenuToggled(open) {
        if (!open) {
            this._contextMenu.close(BoxPointer.PopupAnimation.NONE);
            return;
        }

        this._rebuildList();
        const adjustment = this._scrollView.vadjustment ?? this._scrollView.vscroll?.adjustment;
        if (adjustment)
            adjustment.value = 0;
        this._markSeen();
    }

    _onItemsChanged() {
        if (this.menu.isOpen) {
            this._rebuildList();
            this._markSeen();
        }
    }

    _onProgress() {
        const current = new Map(this._monitor.items.map(item => [item.uri, item]));
        for (const row of this._rows) {
            const item = current.get(row.item.uri);
            if (item?.partial)
                row.setItem(item);
        }
    }

    _onThumbnailReady(item) {
        for (const row of this._rows) {
            if (row.item.uri === item.uri) {
                row.item.thumbnail = item.thumbnail;
                row.refreshThumbnail();
            }
        }
    }

    _destroyRows() {
        this._contextRow = null;
        this._listBox.destroy_all_children();
        this._rows = [];
    }

    _rebuildList() {
        if (!this.menu.isOpen)
            return;

        // Don't pull rows out from under an open right-click menu.
        if (this._contextMenu.isOpen) {
            this._rebuildPending = true;
            return;
        }

        const focus = global.stage.get_key_focus();
        const focusedUri = this._rows.find(row => row === focus)?.item.uri;
        this._destroyRows();

        const items = this._monitor.items;
        const hasItems = items.length > 0;
        this._scrollView.visible = hasItems;
        this._emptyBox.visible = !hasItems;
        this._clearButton.visible = items.some(item => !item.active);

        if (!hasItems) {
            const error = this._monitor.error;
            if (!error)
                this._emptyLabel.text = _('No Downloads');
            else if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                this._emptyLabel.text = _('Downloads folder not found');
            else
                this._emptyLabel.text = _('Cannot read the Downloads folder');
            return;
        }

        const grid = this._settings.get_string('view-mode') === 'grid';
        let gridRow = null;
        for (const item of items) {
            if (!grid || item.active) {
                const row = new DownloadRow(item, this);
                this._listBox.add_child(row);
                this._rows.push(row);
                continue;
            }

            if (!gridRow || gridRow.get_n_children() === GRID_COLUMNS) {
                gridRow = new St.BoxLayout({style_class: 'downloads-grid-row'});
                this._listBox.add_child(gridRow);
            }
            const tile = new DownloadTile(item, this);
            gridRow.add_child(tile);
            this._rows.push(tile);
        }

        if (focusedUri)
            this._rows.find(row => row.item.uri === focusedUri)?.grab_key_focus();
    }

    _markSeen() {
        this._settings.set_int64('last-seen', GLib.get_real_time());
    }

    scrollToActor(actor) {
        ensureActorVisibleInScrollView(this._scrollView, actor);
    }

    describe(item) {
        if (item.partial) {
            const size = GLib.format_size(item.size);
            if (!item.active)
                return _('Incomplete — %s').format(size);
            if (item.speed > 0)
                return _('%s — %s/s').format(size, GLib.format_size(Math.round(item.speed)));
            return _('Downloading — %s').format(size);
        }

        const sortKey = this._settings.get_string('sort-by') === 'modified' ? 'modified' : 'added';
        const parts = [
            item.isDir ? _('Folder') : GLib.format_size(item.size),
            this._formatWhen(item[sortKey]),
        ];
        if (item.origin)
            parts.push(item.origin);
        return parts.join(' · ');
    }

    _formatWhen(usec) {
        const now = GLib.DateTime.new_now_local();
        const then = GLib.DateTime.new_from_unix_local(Math.floor(usec / GLib.USEC_PER_SEC));
        const seconds = now.to_unix() - then.to_unix();

        if (seconds < 60)
            return _('Just now');
        if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            return ngettext('%d min ago', '%d min ago', minutes).format(minutes);
        }

        const clockFormat = this._interfaceSettings.get_string('clock-format') === '12h'
            ? '%l:%M %p' : '%H:%M';
        const time = then.format(clockFormat).trim();
        const days = Math.round(startOfDay(now).difference(startOfDay(then)) / GLib.TIME_SPAN_DAY);

        if (days === 0)
            return _('Today, %s').format(time);
        if (days === 1)
            return _('Yesterday, %s').format(time);
        if (days < 7)
            return then.format('%A');
        if (then.get_year() === now.get_year())
            return then.format('%e %b').trim();
        return then.format('%e %b %Y').trim();
    }

    openItem(item) {
        if (item.partial) {
            this.revealItem(item);
            return;
        }
        this._launchUri(item.uri, item.displayName);
    }

    openFolder() {
        this._launchUri(this._monitor.folder.get_uri());
    }

    revealItem(item) {
        this.menu.close();
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1',
            'ShowItems',
            new GLib.Variant('(ass)', [[item.uri], '']),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch {
                    this.openFolder();
                }
            });
    }

    _openWith(item, app) {
        this.menu.close();
        const context = global.create_app_launch_context(0, -1);
        app.launch_uris_async([item.uri], context, null, (o, result) => {
            try {
                app.launch_uris_finish(result);
            } catch (e) {
                Main.notifyError(
                    _('Could not open “%s” with %s').format(item.displayName, app.get_name()),
                    e.message);
            }
        });
    }

    _launchUri(uri, name = null) {
        this.menu.close();
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri_async(uri, context, null, (o, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (e) {
                Main.notifyError(
                    _('Could not open “%s”').format(name ?? Gio.File.new_for_uri(uri).get_basename()),
                    e.message);
            }
        });
    }
}

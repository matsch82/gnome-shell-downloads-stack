// Downloads Stack for the Dock: a macOS-style Downloads stack in the
// Ubuntu Dock / Dash to Dock.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {DownloadsMonitor} from './downloadsMonitor.js';
import {Thumbnailer} from './thumbnailer.js';
import {
    DownloadsView, PulseBar, animationsEnabled, fallbackIcon, previewIcon, scaleFactor,
} from './downloadsView.js';

// Dash to Dock wins when both are installed, like Ubuntu Dock itself does.
const DOCK_UUIDS = ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'];
const ACTIVE_STATE = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;

// Indexed by St.Side, matching the dock's own label style classes.
const SIDE_STYLE_CLASS = ['top', 'right', 'bottom', 'left'];

// Newest file in front, older ones fanned out behind it (offsets are
// fractions of the icon size).
const STACK_LAYERS = [
    {angle: 0, dx: 0, dy: 0},
    {angle: -12, dx: -0.09, dy: -0.04},
    {angle: 10, dx: 0.09, dy: -0.07},
];

const LABEL_SHOW_TIME = 150;

const ActorProto = Clutter.Actor.prototype;

function laterAdd(callback) {
    const laters = global.compositor?.get_laters?.();
    return laters
        ? laters.add(Meta.LaterType.BEFORE_REDRAW, callback)
        : Meta.later_add(Meta.LaterType.BEFORE_REDRAW, callback);
}

function laterRemove(id) {
    const laters = global.compositor?.get_laters?.();
    if (laters)
        laters.remove(id);
    else
        Meta.later_remove(id);
}

// An app icon (or Trash / drive) managed by the dock.
function isAppItem(actor) {
    return !!actor?.child?._delegate?.app && !actor.animatingOut;
}

function appIdOf(actor) {
    return actor.child._delegate.app.get_id() ?? '';
}

// Trash and drives, which the dock shows after the apps.
function isLocationId(id) {
    return id.startsWith('location:') || id.startsWith('mountable-volume:');
}

/**
 * Hides one child of the dock's icon box from the dock's own code. The dock
 * assumes every child of that box is an app icon and inserts icons by index
 * (also while you drag apps onto it), so it gets a view of the box without
 * our icon, and its indices are mapped back to the real children.
 */
class HiddenChildPatch {
    static METHODS = ['get_children', 'get_n_children', 'insert_child_at_index', 'set_child_at_index'];

    constructor(box, hidden, onChanged) {
        this._box = box;
        const visible = () => ActorProto.get_children.call(box).filter(c => c !== hidden);

        box.get_children = () => visible();
        box.get_n_children = () => visible().length;
        box.insert_child_at_index = (child, index) => {
            const ref = index >= 0 ? visible()[index] : undefined;
            if (ref)
                ActorProto.insert_child_below.call(box, child, ref);
            else
                ActorProto.insert_child_above.call(box, child, null);
            onChanged();
        };
        box.set_child_at_index = (child, index) => {
            const ref = index >= 0 ? visible().filter(c => c !== child)[index] : undefined;
            if (ref)
                ActorProto.set_child_below_sibling.call(box, child, ref);
            else
                ActorProto.set_child_above_sibling.call(box, child, null);
            onChanged();
        };
    }

    destroy() {
        for (const name of HiddenChildPatch.METHODS)
            delete this._box[name];
    }
}

/**
 * Shared state for all dock icons (one per monitor with multi-monitor docks).
 */
class DownloadsStack {
    constructor(extension) {
        this.extension = extension;
        this.settings = extension.getSettings();
        this.items = new Set();

        if (this.settings.get_int64('last-seen') === 0)
            this.settings.set_int64('last-seen', GLib.get_real_time());

        this.thumbnailer = new Thumbnailer();
        this.monitor = new DownloadsMonitor(this.settings);

        this.monitor.connectObject(
            'changed', () => this._onItemsChanged(),
            'download-finished', () => this.items.forEach(i => i.bounce()),
            this);
        this.thumbnailer.connectObject('thumbnail-ready', (t, item) => {
            if (this.recentFiles.some(f => f.uri === item.uri))
                this.items.forEach(i => i.updateIcon());
        }, this);
        this.settings.connectObject(
            'changed::generate-thumbnails', () => this._requestThumbnails(),
            'changed::icon-style', () => this.items.forEach(i => i.updateIcon()),
            'changed::show-badge', () => this.items.forEach(i => i.updateIcon()),
            'changed::last-seen', () => this.items.forEach(i => i.updateIcon()),
            'changed::dock-after', () => this.items.forEach(i => i.place()),
            'changed::dock-before', () => this.items.forEach(i => i.place()),
            'changed::dock-index', () => this.items.forEach(i => i.place()),
            this);

        this.monitor.start();
    }

    /**
     * Where the icon sits in the dock, relative to its neighbours when it was
     * dropped: {after, before} app ids and the slot index as a fallback.
     * index < 0 means the default spot, right before the Trash.
     */
    get placement() {
        return {
            after: this.settings.get_string('dock-after'),
            before: this.settings.get_string('dock-before'),
            index: this.settings.get_int('dock-index'),
        };
    }

    savePlacement({after, before, index}) {
        this.settings.delay();
        this.settings.set_string('dock-after', after);
        this.settings.set_string('dock-before', before);
        this.settings.set_int('dock-index', index);
        this.settings.apply();
    }

    resetPlacement() {
        this.settings.delay();
        ['dock-after', 'dock-before', 'dock-index'].forEach(k => this.settings.reset(k));
        this.settings.apply();
    }

    destroy() {
        this.items.forEach(i => i.destroy());
        this.items.clear();
        this.monitor.disconnectObject(this);
        this.thumbnailer.disconnectObject(this);
        this.settings.disconnectObject(this);
        this.thumbnailer.destroy();
        this.monitor.destroy();
    }

    /** The newest finished downloads, for the stacked dock icon. */
    get recentFiles() {
        return this.monitor.items.filter(e => !e.partial).slice(0, STACK_LAYERS.length);
    }

    get hasUnseen() {
        return this.monitor.newestAdded > this.settings.get_int64('last-seen');
    }

    _requestThumbnails() {
        this.thumbnailer.request(this.monitor.items,
            this.settings.get_boolean('generate-thumbnails'));
    }

    _onItemsChanged() {
        this._requestThumbnails();
        this.items.forEach(i => i.updateIcon());
    }
}

/**
 * The Downloads icon in one dock. Looks and sizes like the dock's own items.
 */
const DownloadsDockItem = GObject.registerClass(
class DownloadsDockItem extends Dash.DashItemContainer {
    _init(stack, dash) {
        super._init();

        this._stack = stack;
        this._dash = dash;
        this._position = dash._position ?? St.Side.BOTTOM;
        this._menuOpen = false;
        this._pinned = false;
        this._boxPatch = null;
        this._placeLaterId = 0;
        this._pressCoords = null;
        this._dragging = false;
        this._dragGrab = null;
        this._dragPlacement = null;

        this.add_style_class_name('downloads-dock-item');
        this.label?.add_style_class_name(SIDE_STYLE_CLASS[this._position]);

        this._button = new St.Button({
            style_class: 'overview-tile downloads-dock-button',
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this.icon = new IconGrid.BaseIcon(_('Downloads'), {
            setSizeManually: true,
            showLabel: false,
            createIcon: size => this._createIcon(size),
        });
        this.icon.pivot_point = new Graphene.Point({x: 0.5, y: 0.5});
        this._button.set_child(this.icon);
        this.setChild(this._button);
        this.setLabelText(_('Downloads'));
        this.icon.setIconSize(dash.iconSize);

        this._button.connect('clicked', (button, mouseButton) => {
            if (mouseButton === Clutter.BUTTON_SECONDARY)
                this._toggleOptionsMenu();
            else
                this._menu.toggle();
        });
        this._button.connect('popup-menu', () => this._toggleOptionsMenu());
        this._button.connect('captured-event', (b, event) => this._onButtonEvent(event));

        // The Downloads popover and the right-click options menu. Each gets its
        // own manager so hovering the icon doesn't swap one for the other.
        this._menu = this._createMenu('downloads-dock-popover');
        this._optionsMenu = this._createMenu('downloads-dock-options');
        this._view = new DownloadsView({
            menu: this._menu,
            extension: stack.extension,
            settings: stack.settings,
            monitor: stack.monitor,
            thumbnailer: stack.thumbnailer,
        });

        dash.connectObject('icon-size-changed',
            () => this.icon.setIconSize(dash.iconSize), this);
        try {
            dash._hookUpLabel(this);
        } catch (e) {
            console.warn(`[downloads-dock] No dock tooltip: ${e.message}`);
        }

        this.connect('destroy', () => this._onDestroy());
    }

    _createMenu(styleClass) {
        const menu = new PopupMenu.PopupMenu(this._button, 0.5, this._position);
        menu.actor.add_style_class_name(styleClass);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        const manager = new PopupMenu.PopupMenuManager(this._button);
        manager.addMenu(menu);

        menu.connect('open-state-changed', (m, open) => this._onMenuStateChanged(m, open));
        return menu;
    }

    _onMenuStateChanged(menu, open) {
        if (open) {
            // Fit on screen: the popover's list scrolls when space is short.
            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                Main.layoutManager.findIndexForActor(this));
            const margins = menu.actor.margin_top + menu.actor.margin_bottom;
            menu.actor.style = `max-height: ${Math.round((workArea.height - margins) / scaleFactor())}px;`;
        }

        const anyOpen = this._menu.isOpen || this._optionsMenu.isOpen;
        if (anyOpen === this._menuOpen)
            return;
        this._menuOpen = anyOpen;
        this._button.checked = anyOpen;
        this._syncPinned();
        this.updateIcon();
    }

    // Keeps the dock visible (and the tooltip hidden) while a menu is up or
    // the icon is being dragged, the same way the dock does for app menus.
    _syncPinned() {
        const pinned = this._menuOpen || this._dragging;
        if (pinned === this._pinned)
            return;
        this._pinned = pinned;
        try {
            this._dash._itemMenuStateChanged(this, pinned);
        } catch (e) {
            console.warn(`[downloads-dock] Cannot pin the dock open: ${e.message}`);
        }
    }

    /**
     * Puts the icon into the dock's row of app icons, where it can be moved.
     */
    attach() {
        const box = this._dash._box;
        if (!box) {
            // Unknown dock layout: sit after the icons, not movable.
            this._dash._dashContainer.insert_child_below(this, this._dash._showAppsIcon ?? null);
            return;
        }

        this._boxPatch = new HiddenChildPatch(box, this, () => this._queuePlace());
        ActorProto.add_child.call(box, this);
        box.connectObject(
            'child-added', () => this._queuePlace(),
            'child-removed', () => this._queuePlace(),
            this);
        this.place();
    }

    _queuePlace() {
        if (this._placeLaterId)
            return;
        this._placeLaterId = laterAdd(() => {
            this._placeLaterId = 0;
            this.place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _appItems() {
        return ActorProto.get_children.call(this._dash._box)
            .filter(c => c !== this && isAppItem(c));
    }

    /** Moves the icon to its saved spot among the dock's current icons. */
    place() {
        if (this._dragging || !this._boxPatch || this.get_parent() !== this._dash._box)
            return;
        const apps = this._appItems();
        this._moveToIndex(apps, this._targetIndex(apps, this._stack.placement));
    }

    _targetIndex(apps, {after, before, index}) {
        const ids = apps.map(appIdOf);

        if (index < 0) {
            // Default: right before the Trash, like on macOS.
            const trash = apps.findIndex(a => a.child._delegate.app.isTrash);
            return trash >= 0 ? trash : apps.length;
        }
        if (after === '')
            return 0;

        const afterAt = ids.indexOf(after);
        const beforeAt = ids.indexOf(before);
        if (beforeAt >= 0 && isLocationId(before))
            return beforeAt;
        if (afterAt >= 0 && AppFavorites.getAppFavorites().isFavorite(after))
            return afterAt + 1;
        if (beforeAt >= 0)
            return beforeAt;
        if (afterAt >= 0)
            return afterAt + 1;
        if (before === '')
            return apps.length;
        return Math.clamp(index, 0, apps.length);
    }

    _moveToIndex(apps, index) {
        const box = this._dash._box;
        const siblings = ActorProto.get_children.call(box);
        const current = siblings.slice(0, siblings.indexOf(this))
            .filter(c => apps.includes(c)).length;
        if (current === index)
            return;

        if (index < apps.length)
            ActorProto.set_child_below_sibling.call(box, this, apps[index]);
        else
            ActorProto.set_child_above_sibling.call(box, this, apps.at(-1) ?? null);
    }

    // Press and drag the icon along the dock to move it, like app icons.
    _onButtonEvent(event) {
        const type = event.type();

        if (this._dragging) {
            switch (type) {
            case Clutter.EventType.MOTION:
                this._dragTo(...event.get_coords());
                return Clutter.EVENT_STOP;
            case Clutter.EventType.BUTTON_RELEASE:
                this._endDrag(true);
                return Clutter.EVENT_STOP;
            case Clutter.EventType.KEY_PRESS:
                if (event.get_key_symbol() === Clutter.KEY_Escape)
                    this._endDrag(false);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        }

        switch (type) {
        case Clutter.EventType.BUTTON_PRESS:
            this._pressCoords = event.get_button() === Clutter.BUTTON_PRIMARY && this._boxPatch
                ? event.get_coords() : null;
            break;
        case Clutter.EventType.BUTTON_RELEASE:
            this._pressCoords = null;
            break;
        case Clutter.EventType.MOTION: {
            if (!this._pressCoords)
                break;
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this._pressCoords = null;
                break;
            }
            const [x, y] = event.get_coords();
            const [startX, startY] = this._pressCoords;
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(x - startX) > threshold || Math.abs(y - startY) > threshold) {
                this._beginDrag();
                this._dragTo(x, y);
                return Clutter.EVENT_STOP;
            }
            break;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag() {
        this._pressCoords = null;
        // Cancel the click, so letting go doesn't open the stack.
        this._button.fake_release();
        this._menu.close(BoxPointer.PopupAnimation.NONE);
        this._optionsMenu.close(BoxPointer.PopupAnimation.NONE);
        this.hideLabel();

        this._dragging = true;
        this._dragPlacement = null;
        this._dragGrab = global.stage.grab(this._button);
        this.opacity = 170;
        this._syncPinned();
    }

    _dragTo(x, y) {
        const apps = this._appItems();
        const horizontal = this._position === St.Side.TOP || this._position === St.Side.BOTTOM;
        const rtl = horizontal &&
            Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const pointer = horizontal ? x : y;

        // The slot is the number of icons whose middle lies before the pointer.
        let index = 0;
        for (const app of apps) {
            const [appX, appY] = app.get_transformed_position();
            const [width, height] = app.get_transformed_size();
            const middle = horizontal ? appX + width / 2 : appY + height / 2;
            if (rtl ? pointer < middle : pointer > middle)
                index++;
        }

        const ids = apps.map(appIdOf);
        this._dragPlacement = {after: ids[index - 1] ?? '', before: ids[index] ?? '', index};
        this._moveToIndex(apps, index);
    }

    _endDrag(commit) {
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        this._dragging = false;
        this.opacity = 255;

        const placement = this._dragPlacement;
        this._dragPlacement = null;
        if (commit && placement)
            this._stack.savePlacement(placement);
        this.place();
        this._syncPinned();
    }

    _toggleOptionsMenu() {
        const menu = this._optionsMenu;
        if (menu.isOpen) {
            menu.close(BoxPointer.PopupAnimation.FULL);
            return;
        }

        const {settings} = this._stack;
        menu.removeAll();
        menu.addAction(_('Open Downloads Folder'), () => this._view.openFolder());

        const addChoice = (title, key, choices) => {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
            const current = settings.get_string(key);
            for (const [value, label] of choices) {
                const choice = menu.addAction(label, () => settings.set_string(key, value));
                choice.setOrnament(value === current
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        };
        addChoice(_('Sort by'), 'sort-by', [
            ['added', _('Date Added')],
            ['modified', _('Date Modified')],
        ]);
        addChoice(_('Display as'), 'icon-style', [
            ['stack', _('Stack')],
            ['folder', _('Folder')],
        ]);
        addChoice(_('View content as'), 'view-mode', [
            ['grid', _('Grid')],
            ['list', _('List')],
        ]);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._stack.placement.index >= 0)
            menu.addAction(_('Reset Position in Dock'), () => this._stack.resetPlacement());
        menu.addAction(_('Settings…'), () => this._stack.extension.openPreferences());

        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _createIcon(size) {
        const scale = scaleFactor();
        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: `width: ${size}px; height: ${size}px;`,
        });

        const files = this._stack.settings.get_string('icon-style') === 'stack'
            ? this._stack.recentFiles : [];

        if (files.length === 0) {
            box.add_child(new St.Icon({
                gicon: new Gio.ThemedIcon({names: ['folder-download', 'folder-download-symbolic']}),
                icon_size: size,
                x_expand: true,
                y_expand: true,
            }));
        } else {
            // Back to front, so the newest file ends up on top.
            const layerSize = Math.round(size * 0.76);
            for (let i = files.length - 1; i >= 0; i--) {
                const {angle, dx, dy} = STACK_LAYERS[i];
                box.add_child(new St.Icon({
                    gicon: previewIcon(files[i]),
                    fallback_gicon: fallbackIcon(files[i]),
                    icon_size: layerSize,
                    style_class: 'downloads-dock-layer',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    y_expand: true,
                    pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                    rotation_angle_z: angle,
                    translation_x: dx * size * scale,
                    translation_y: dy * size * scale,
                }));
            }
        }

        const {monitor, settings} = this._stack;
        if (monitor.activeCount > 0) {
            const pulse = new PulseBar({
                style_class: 'downloads-dock-pulse-track',
                barStyleClass: 'downloads-dock-pulse-bar',
                style: `width: ${Math.round(size * 0.7)}px;`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
            });
            box.add_child(pulse);
            pulse.setRunning(true);
        }

        if (settings.get_boolean('show-badge') && !this._menuOpen && this._stack.hasUnseen) {
            box.add_child(new St.Widget({
                style_class: 'downloads-dock-badge',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            }));
        }

        return box;
    }

    updateIcon() {
        if (this.icon.update)
            this.icon.update();
        else
            this.icon._createIconTexture(this.icon.iconSize);
    }

    bounce() {
        if (this._menuOpen || !this._stack.settings.get_boolean('animate-icon') ||
            !animationsEnabled())
            return;

        // Jump away from the screen edge the dock sits on.
        const property = this._position === St.Side.LEFT || this._position === St.Side.RIGHT
            ? 'translation_x' : 'translation_y';
        const direction = this._position === St.Side.LEFT || this._position === St.Side.TOP ? 1 : -1;
        const height = Math.round(this._dash.iconSize * 0.45) * scaleFactor();

        const actor = this.icon;
        actor.remove_all_transitions();
        actor[property] = 0;
        const hop = (distance, then) => actor.ease({
            [property]: direction * distance,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => actor.ease({
                [property]: 0,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: then,
            }),
        });
        hop(height, () => hop(height / 2, () => {}));
    }

    // Like the dock's own items: place the tooltip next to the icon,
    // on the side facing away from the screen edge.
    showLabel() {
        if (!this._labelText || !this.label?.get_stage())
            return;

        this.label.set_text(this._labelText);
        this.label.opacity = 0;
        this.label.show();

        const [stageX, stageY] = this.get_transformed_position();
        const [itemWidth, itemHeight] = this.get_transformed_size();
        const labelWidth = this.label.get_width();
        const labelHeight = this.label.get_height();
        const offset = this.label.get_theme_node().get_length('-x-offset') ||
            this.label.get_theme_node().get_length('-y-offset');

        let x, y;
        switch (this._position) {
        case St.Side.LEFT:
            x = stageX + itemWidth + offset;
            y = stageY + Math.floor((itemHeight - labelHeight) / 2);
            break;
        case St.Side.RIGHT:
            x = stageX - labelWidth - offset;
            y = stageY + Math.floor((itemHeight - labelHeight) / 2);
            break;
        case St.Side.TOP:
            x = stageX + Math.floor((itemWidth - labelWidth) / 2);
            y = stageY + itemHeight + offset;
            break;
        default:
            x = stageX + Math.floor((itemWidth - labelWidth) / 2);
            y = stageY - labelHeight - offset;
        }

        const monitor = Main.layoutManager.findMonitorForActor(this);
        x = Math.clamp(x, monitor.x, monitor.x + monitor.width - labelWidth);

        this.label.set_position(Math.round(x), Math.round(y));
        this.label.ease({
            opacity: 255,
            duration: LABEL_SHOW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onDestroy() {
        this._stack.items.delete(this);
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        if (this._placeLaterId)
            laterRemove(this._placeLaterId);
        this._placeLaterId = 0;
        this._boxPatch?.destroy();
        this._boxPatch = null;
        this._dash.disconnectObject(this);
        this._view.destroy();
        this._menu.destroy();
        this._optionsMenu.destroy();
        if (this._pinned) {
            try {
                this._dash._itemMenuStateChanged(this, false);
            } catch {}
        }
    }
});

/**
 * Finds the running Ubuntu Dock / Dash to Dock and puts a Downloads icon into
 * every dock it creates, also after the dock rebuilds itself.
 */
class DockIntegration {
    constructor(stack) {
        this._stack = stack;
        this._dockUuid = null;
        this._dockManager = null;
        this._dockManagerIds = [];
        this._generation = 0;

        this._stateChangedId = Main.extensionManager.connect('extension-state-changed',
            () => this._sync().catch(logError));
        this._sync().catch(logError);
    }

    destroy() {
        this._generation++;
        Main.extensionManager.disconnect(this._stateChangedId);
        this._detach();
    }

    async _sync() {
        const generation = ++this._generation;
        const dock = DOCK_UUIDS
            .map(uuid => Main.extensionManager.lookup(uuid))
            .find(ext => ext?.state === ACTIVE_STATE);

        let dockManager = null;
        if (dock) {
            // Ubuntu Dock and Dash to Dock export their DockManager for other
            // extensions. Importing the same file returns the same module.
            const module = await import(dock.dir.get_child('extension.js').get_uri());
            dockManager = module.dockManager ?? null;
        }
        if (generation !== this._generation)
            return;

        if (dockManager === this._dockManager)
            return;

        this._detach();
        if (!dockManager) {
            if (!dock)
                console.log('[downloads-dock] Waiting for Ubuntu Dock or Dash to Dock');
            return;
        }

        this._dockUuid = dock.uuid;
        this._dockManager = dockManager;
        this._dockManagerIds = [
            dockManager.connect('docks-ready', () => this._attachAll()),
            dockManager.connect('docks-destroyed', () => this._stack.items.clear()),
        ];
        this._attachAll();
    }

    _detach() {
        this._dockManagerIds.forEach(id => this._dockManager?.disconnect(id));
        this._dockManagerIds = [];
        this._dockManager = null;
        this._dockUuid = null;
        [...this._stack.items].forEach(item => item.destroy());
        this._stack.items.clear();
    }

    _attachAll() {
        for (const dock of this._dockManager?._allDocks ?? []) {
            const {dash} = dock;
            if (!dash || [...this._stack.items].some(item => item._dash === dash))
                continue;

            const item = new DownloadsDockItem(this._stack, dash);
            item.attach();
            item.show(false);
            this._stack.items.add(item);
        }
    }
}

export default class DownloadsDockExtension extends Extension {
    enable() {
        this._stack = new DownloadsStack(this);
        this._integration = new DockIntegration(this._stack);
    }

    disable() {
        this._integration?.destroy();
        this._integration = null;
        this._stack?.destroy();
        this._stack = null;
    }
}

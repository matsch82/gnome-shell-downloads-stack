import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function defaultDownloadsPath() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
}

function bindEnumCombo(settings, key, row, values) {
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    settings.connect(`changed::${key}`, () => {
        row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    });
}

export default class DownloadsDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({
            title: _('Downloads Stack for the Dock'),
            icon_name: 'folder-download-symbolic',
        });
        window.add(page);

        // ---- Folder ----
        const folderGroup = new Adw.PreferencesGroup({title: _('Folder')});
        page.add(folderGroup);

        const folderRow = new Adw.ActionRow({title: _('Downloads folder')});
        const syncFolder = () => {
            const custom = settings.get_string('downloads-folder');
            folderRow.subtitle = custom || _('%s (default)').format(defaultDownloadsPath());
            resetButton.sensitive = custom !== '';
        };

        const chooseButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Choose folder…'),
            css_classes: ['flat'],
        });
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Choose Downloads Folder'), modal: true});
            const current = settings.get_string('downloads-folder') || defaultDownloadsPath();
            dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (d, result) => {
                try {
                    const folder = d.select_folder_finish(result);
                    if (folder?.get_path())
                        settings.set_string('downloads-folder', folder.get_path());
                } catch (e) {
                    if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                        logError(e);
                }
            });
        });

        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Use the default Downloads folder'),
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => settings.reset('downloads-folder'));

        folderRow.add_suffix(resetButton);
        folderRow.add_suffix(chooseButton);
        folderRow.activatable_widget = chooseButton;
        folderGroup.add(folderRow);
        settings.connect('changed::downloads-folder', syncFolder);
        syncFolder();

        // ---- Appearance ----
        const viewGroup = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(viewGroup);

        const viewRow = new Adw.ComboRow({
            title: _('View content as'),
            model: Gtk.StringList.new([_('Grid'), _('List')]),
        });
        bindEnumCombo(settings, 'view-mode', viewRow, ['grid', 'list']);
        viewGroup.add(viewRow);

        const sortRow = new Adw.ComboRow({
            title: _('Sort by'),
            model: Gtk.StringList.new([_('Date Added'), _('Date Modified')]),
        });
        bindEnumCombo(settings, 'sort-by', sortRow, ['added', 'modified']);
        viewGroup.add(sortRow);

        const countRow = new Adw.SpinRow({
            title: _('Number of downloads'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1, page_increment: 5}),
        });
        settings.bind('max-items', countRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        viewGroup.add(countRow);

        const previewsRow = new Adw.SwitchRow({
            title: _('Generate previews'),
            subtitle: _('Create thumbnails for downloads that have none yet, like Files does'),
        });
        settings.bind('generate-thumbnails', previewsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        viewGroup.add(previewsRow);

        const foldersRow = new Adw.SwitchRow({title: _('Show folders')});
        settings.bind('show-folders', foldersRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        viewGroup.add(foldersRow);

        const hiddenRow = new Adw.SwitchRow({title: _('Show hidden and backup files')});
        settings.bind('show-hidden', hiddenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        viewGroup.add(hiddenRow);

        // ---- Dock icon ----
        const dockGroup = new Adw.PreferencesGroup({
            title: _('Dock Icon'),
            description: _('Appears in Ubuntu Dock or Dash to Dock, after the app icons.'),
        });
        page.add(dockGroup);

        const styleRow = new Adw.ComboRow({
            title: _('Display as'),
            subtitle: _('A pile of your newest downloads, or the Downloads folder icon'),
            model: Gtk.StringList.new([_('Stack'), _('Folder')]),
        });
        bindEnumCombo(settings, 'icon-style', styleRow, ['stack', 'folder']);
        dockGroup.add(styleRow);

        const positionRow = new Adw.ActionRow({
            title: _('Position in the dock'),
            subtitle: _('Drag the Downloads icon along the dock to move it'),
        });
        const positionReset = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Put it back before the Trash'),
        });
        positionReset.connect('clicked', () => {
            settings.delay();
            ['dock-after', 'dock-before', 'dock-index'].forEach(k => settings.reset(k));
            settings.apply();
        });
        const syncPosition = () => {
            positionReset.sensitive = settings.get_int('dock-index') >= 0;
        };
        settings.connect('changed::dock-index', syncPosition);
        syncPosition();
        positionRow.add_suffix(positionReset);
        dockGroup.add(positionRow);

        const bounceRow = new Adw.SwitchRow({
            title: _('Bounce when a download finishes'),
        });
        settings.bind('animate-icon', bounceRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(bounceRow);

        const badgeRow = new Adw.SwitchRow({
            title: _('Show a dot for new downloads'),
            subtitle: _('Cleared when you open the stack'),
        });
        settings.bind('show-badge', badgeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockGroup.add(badgeRow);

        // ---- History ----
        const historyGroup = new Adw.PreferencesGroup({
            title: _('History'),
            description: _('“Clear” in the menu only hides downloads from the list. Files are never deleted.'),
        });
        page.add(historyGroup);

        const restoreRow = new Adw.ActionRow({title: _('Show cleared downloads again')});
        const restoreButton = new Gtk.Button({
            label: _('Restore'),
            valign: Gtk.Align.CENTER,
        });
        restoreButton.connect('clicked', () => settings.reset('clear-before'));
        const syncRestore = () => {
            restoreButton.sensitive = settings.get_int64('clear-before') !== 0;
        };
        settings.connect('changed::clear-before', syncRestore);
        syncRestore();
        restoreRow.add_suffix(restoreButton);
        restoreRow.activatable_widget = restoreButton;
        historyGroup.add(restoreRow);
    }
}

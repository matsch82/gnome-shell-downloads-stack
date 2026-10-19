// Watches the Downloads folder and keeps a sorted list of recent downloads,
// including files that are still being written by a browser.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

// Suffixes browsers use while a download is in progress
// (Firefox/Transmission, Chromium-based, Safari-style, wget2/others, Opera).
const PARTIAL_SUFFIXES = ['.part', '.crdownload', '.download', '.partial', '.opdownload'];

const ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::type',
    'standard::is-hidden',
    'standard::is-backup',
    'standard::size',
    'standard::content-type',
    'standard::icon',
    'time::modified',
    'time::modified-usec',
    'time::changed',
    'time::changed-usec',
    'thumbnail::path',
    'thumbnail::failed',
    'thumbnail::is-valid',
    'xattr::xdg.origin.url',
].join(',');

const PROGRESS_ATTRIBUTES = [
    'standard::size',
    'time::modified',
    'time::modified-usec',
    'time::changed',
    'time::changed-usec',
].join(',');

const RESCAN_DELAY_MS = 300;
const PROGRESS_INTERVAL_MS = 1000;
const STALLED_AFTER_US = 30 * GLib.USEC_PER_SEC;
const FRESH_WINDOW_US = 5 * 60 * GLib.USEC_PER_SEC;
const MAX_PARTIALS = 10;

function partialSuffix(name) {
    const lower = name.toLowerCase();
    return PARTIAL_SUFFIXES.find(s => lower.length > s.length && lower.endsWith(s)) ?? null;
}

function timeAttribute(info, name) {
    const attr = `time::${name}`;
    if (!info.has_attribute(attr))
        return 0;
    const usec = info.has_attribute(`${attr}-usec`)
        ? info.get_attribute_uint32(`${attr}-usec`) : 0;
    return info.get_attribute_uint64(attr) * GLib.USEC_PER_SEC + usec;
}

// "Date added" on Linux: ctime changes when a file is created, renamed or
// moved into the folder, which is when a finished download lands there.
function addedTime(info) {
    return timeAttribute(info, 'changed') || timeAttribute(info, 'modified');
}

function originHost(info) {
    const url = info.get_attribute_as_string('xattr::xdg.origin.url');
    if (!url)
        return null;
    try {
        const host = GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host();
        return host ? host.replace(/^www\./, '') : null;
    } catch {
        return null;
    }
}

function thumbnailPath(info) {
    if (info.get_attribute_boolean('thumbnail::failed'))
        return null;
    if (info.has_attribute('thumbnail::is-valid') &&
        !info.get_attribute_boolean('thumbnail::is-valid'))
        return null;
    return info.get_attribute_byte_string('thumbnail::path');
}

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export function resolveDownloadsFolder(settings) {
    const custom = settings.get_string('downloads-folder').trim();
    if (custom) {
        const path = custom.startsWith('~')
            ? GLib.build_filenamev([GLib.get_home_dir(), custom.slice(1)])
            : custom;
        return Gio.File.new_for_commandline_arg(path);
    }
    const xdg = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    return Gio.File.new_for_path(xdg ?? GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']));
}

/**
 * Emits:
 *  - 'changed': the visible list (or the error state) changed
 *  - 'progress': sizes/speeds of in-progress downloads were refreshed
 *  - 'download-finished' (entries): new completed files appeared
 */
export class DownloadsMonitor extends Signals.EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._entries = [];
        this._items = [];
        this._known = null;
        this._signature = null;
        this._error = null;
        this._scanning = false;
        this._rescanQueued = false;
        this._polling = false;
        this._scanTimeoutId = 0;
        this._progressId = 0;
        this._fileMonitor = null;

        this._settings.connectObject(
            'changed::downloads-folder', () => this._setupFolder(),
            'changed::show-hidden', () => this._queueScan(0),
            'changed::show-folders', () => this._queueScan(0),
            'changed::max-items', () => this._updateItems(),
            'changed::sort-by', () => this._updateItems(),
            'changed::clear-before', () => this._updateItems(),
            this);
    }

    start() {
        this._setupFolder();
    }

    destroy() {
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        this._fileMonitor?.cancel();
        this._fileMonitor = null;
        if (this._scanTimeoutId)
            GLib.source_remove(this._scanTimeoutId);
        this._scanTimeoutId = 0;
        if (this._progressId)
            GLib.source_remove(this._progressId);
        this._progressId = 0;
        this.disconnectAll();
    }

    get folder() {
        return this._folder;
    }

    get error() {
        return this._error;
    }

    /** In-progress downloads first, then the newest completed ones. */
    get items() {
        return this._items;
    }

    get activeCount() {
        return this._entries.filter(e => e.partial && e.active).length;
    }

    get newestAdded() {
        return this._items.reduce((max, e) => e.partial ? max : Math.max(max, e.added), 0);
    }

    _setupFolder() {
        if (this._fileMonitor) {
            this._fileMonitor.disconnectObject(this);
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }

        this._folder = resolveDownloadsFolder(this._settings);
        this._known = null; // the next scan is an initial one: no "finished" events

        try {
            this._fileMonitor = this._folder.monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
            this._fileMonitor.connectObject('changed',
                (monitor, file, otherFile, eventType) => this._onFolderChanged(file, eventType),
                this);
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`[gnome-downloads] Cannot watch ${this._folder.get_path()}: ${e.message}`);
        }

        this._queueScan(0);
    }

    _onFolderChanged(file, eventType) {
        switch (eventType) {
        case Gio.FileMonitorEvent.CHANGED:
            // Content writes; in-progress files are polled separately.
            return;
        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            if (file && partialSuffix(file.get_basename()))
                return;
            break;
        }
        this._queueScan(RESCAN_DELAY_MS);
    }

    _queueScan(delay) {
        if (this._scanTimeoutId) {
            if (delay > 0)
                return;
            GLib.source_remove(this._scanTimeoutId);
        }
        this._scanTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._scanTimeoutId = 0;
            this._scan().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _scan() {
        if (this._scanning) {
            this._rescanQueued = true;
            return;
        }
        this._scanning = true;

        const folder = this._folder;
        try {
            const entries = await this._enumerate(folder);
            if (folder !== this._folder)
                return;
            this._error = null;
            this._applyEntries(entries);
        } catch (e) {
            if (isCancelled(e) || folder !== this._folder)
                return;
            this._error = e;
            this._entries = [];
            this._known = null;
            this._updateItems();
            this._syncProgressPolling();
        } finally {
            this._scanning = false;
            if (this._rescanQueued) {
                this._rescanQueued = false;
                this._queueScan(RESCAN_DELAY_MS);
            }
        }
    }

    async _enumerate(folder) {
        const enumerator = await folder.enumerate_children_async(ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);

        const infos = [];
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const batch = await enumerator.next_files_async(200,
                    GLib.PRIORITY_LOW, this._cancellable);
                if (batch.length === 0)
                    break;
                infos.push(...batch);
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }

        const showHidden = this._settings.get_boolean('show-hidden');
        const showFolders = this._settings.get_boolean('show-folders');
        const names = new Set(infos.map(info => info.get_name()));
        const now = GLib.get_monotonic_time();

        return infos
            .map(info => this._makeEntry(folder, info, names, showHidden, showFolders, now))
            .filter(e => e !== null);
    }

    _makeEntry(folder, info, names, showHidden, showFolders, now) {
        const name = info.get_name();
        if (!showHidden && (info.get_is_hidden() || info.get_is_backup()))
            return null;

        const fileType = info.get_file_type();
        const isDir = fileType === Gio.FileType.DIRECTORY;
        if (isDir ? !showFolders : fileType !== Gio.FileType.REGULAR)
            return null;

        const suffix = isDir ? null : partialSuffix(name);
        const size = info.get_size();

        // Firefox keeps an empty placeholder next to "<name>.part".
        if (!suffix && !isDir && size === 0 &&
            PARTIAL_SUFFIXES.some(s => names.has(name + s)))
            return null;

        let displayName = info.get_display_name();
        let contentType = info.get_content_type();
        let gicon = info.get_icon();
        if (suffix) {
            if (displayName.toLowerCase().endsWith(suffix))
                displayName = displayName.slice(0, -suffix.length);
            [contentType] = Gio.content_type_guess(displayName, null);
            gicon = Gio.content_type_get_icon(contentType);
        }

        const file = folder.get_child(name);
        const modified = timeAttribute(info, 'modified');
        return {
            name,
            displayName,
            file,
            uri: file.get_uri(),
            isDir,
            size,
            contentType,
            gicon,
            thumbnail: suffix ? null : thumbnailPath(info),
            added: addedTime(info),
            modified,
            origin: originHost(info),
            partial: suffix !== null,
            active: suffix !== null && GLib.get_real_time() - modified < STALLED_AFTER_US,
            speed: 0,
            sampleSize: size,
            sampleTime: now,
        };
    }

    _applyEntries(entries) {
        const previous = new Map(this._entries.filter(e => e.partial).map(e => [e.name, e]));
        for (const entry of entries) {
            const prev = entry.partial ? previous.get(entry.name) : null;
            if (prev) {
                entry.speed = prev.speed;
                entry.sampleSize = prev.sampleSize;
                entry.sampleTime = prev.sampleTime;
            }
        }

        const completed = entries.filter(e => !e.partial);
        const now = GLib.get_real_time();
        const fresh = this._known
            ? completed.filter(e => !this._known.has(e.name) && now - e.added < FRESH_WINDOW_US)
            : [];
        this._known = new Set(completed.map(e => e.name));

        this._entries = entries;
        this._updateItems();
        this._syncProgressPolling();

        if (fresh.length > 0)
            this.emit('download-finished', fresh);
    }

    _updateItems() {
        const sortKey = this._settings.get_string('sort-by') === 'modified' ? 'modified' : 'added';
        const clearBefore = this._settings.get_int64('clear-before');
        const maxItems = this._settings.get_int('max-items');

        // Running downloads stay pinned on top; stalled ones sort like the rest.
        const running = this._entries
            .filter(e => e.partial && e.active)
            .sort((a, b) => b.added - a.added)
            .slice(0, MAX_PARTIALS);
        const rest = this._entries
            .filter(e => !(e.partial && e.active) && e.added > clearBefore)
            .sort((a, b) => b[sortKey] - a[sortKey])
            .slice(0, maxItems);
        this._items = [...running, ...rest];

        const signature = [
            this._error?.message ?? '',
            // Sizes and times of in-progress files change constantly; those
            // are reported through 'progress' instead of a full 'changed'.
            ...this._items.map(e => e.partial
                ? `p|${e.active ? 1 : 0}|${e.name}`
                : `f|${e.name}|${e.size}|${e.added}|${e.modified}|${e.thumbnail ?? ''}`),
        ].join('\n');

        if (signature !== this._signature) {
            this._signature = signature;
            this.emit('changed');
        }
    }

    _syncProgressPolling() {
        const wanted = this._entries.some(e => e.partial);
        if (wanted && !this._progressId) {
            this._progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_INTERVAL_MS, () => {
                this._pollProgress().catch(logError);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._progressId) {
            GLib.source_remove(this._progressId);
            this._progressId = 0;
        }
    }

    async _pollProgress() {
        if (this._polling)
            return;
        this._polling = true;

        let missing = false;
        try {
            const partials = this._entries.filter(e => e.partial);
            await Promise.all(partials.map(async entry => {
                try {
                    const info = await entry.file.query_info_async(PROGRESS_ATTRIBUTES,
                        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
                    this._sampleProgress(entry, info);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        missing = true;
                    else if (!isCancelled(e))
                        throw e;
                }
            }));
        } finally {
            this._polling = false;
        }

        if (this._cancellable.is_cancelled())
            return;

        if (missing)
            this._queueScan(0);
        this._updateItems();
        this.emit('progress');
    }

    _sampleProgress(entry, info) {
        const now = GLib.get_monotonic_time();
        const size = info.get_size();
        entry.size = size;
        entry.modified = timeAttribute(info, 'modified');
        entry.added = addedTime(info);
        entry.active = GLib.get_real_time() - entry.modified < STALLED_AFTER_US;

        const elapsed = (now - entry.sampleTime) / GLib.USEC_PER_SEC;
        if (elapsed <= 0)
            return;

        const rate = Math.max(0, size - entry.sampleSize) / elapsed;
        entry.speed = entry.speed > 0 ? entry.speed * 0.6 + rate * 0.4 : rate;
        if (rate === 0 && elapsed >= 3)
            entry.speed = 0;

        if (size !== entry.sampleSize || elapsed >= 3) {
            entry.sampleSize = size;
            entry.sampleTime = now;
        }
    }
}

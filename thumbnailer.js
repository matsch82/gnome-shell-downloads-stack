// Creates freedesktop thumbnails for downloads that don't have one yet,
// the same way Files does, so the menu can show real previews.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const Factory = GnomeDesktop.DesktopThumbnailFactory;
Gio._promisify(Factory.prototype, 'generate_thumbnail_async');
Gio._promisify(Factory.prototype, 'save_thumbnail_async');
Gio._promisify(Factory.prototype, 'create_failed_thumbnail_async');

const SIZE = GnomeDesktop.DesktopThumbnailSize.LARGE;

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Emits 'thumbnail-ready' (item) after item.thumbnail was filled in.
 */
export class Thumbnailer extends Signals.EventEmitter {
    constructor() {
        super();
        this._factory = Factory.new(SIZE);
        this._cancellable = new Gio.Cancellable();
        this._queue = [];
        this._attempted = new Set();
        this._running = false;
    }

    /**
     * Fills in thumbnails that already exist right away and queues the
     * missing ones for generation (one at a time).
     *
     * @param {object[]} items - entries from DownloadsMonitor
     * @param {boolean} generate - whether to create missing thumbnails
     */
    request(items, generate) {
        for (const item of items) {
            if (item.partial || item.isDir || item.thumbnail || !item.contentType)
                continue;

            const mtime = Math.floor(item.modified / GLib.USEC_PER_SEC);
            const existing = this._factory.lookup(item.uri, mtime);
            if (existing) {
                item.thumbnail = existing;
                continue;
            }

            const key = `${item.uri}\n${mtime}`;
            if (!generate || this._attempted.has(key))
                continue;
            this._attempted.add(key);
            this._queue.push(item);
        }
        this._run().catch(logError);
    }

    destroy() {
        this._cancellable.cancel();
        this._queue = [];
        this.disconnectAll();
    }

    async _run() {
        if (this._running)
            return;
        this._running = true;
        try {
            while (this._queue.length > 0 && !this._cancellable.is_cancelled()) {
                // eslint-disable-next-line no-await-in-loop
                await this._generate(this._queue.shift());
            }
        } finally {
            this._running = false;
        }
    }

    async _generate(item) {
        const mtime = Math.floor(item.modified / GLib.USEC_PER_SEC);
        if (!this._factory.can_thumbnail(item.uri, item.contentType, mtime) ||
            this._factory.has_valid_failed_thumbnail(item.uri, mtime))
            return;

        try {
            const pixbuf = await this._factory.generate_thumbnail_async(
                item.uri, item.contentType, this._cancellable);
            await this._factory.save_thumbnail_async(
                pixbuf, item.uri, mtime, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            await this._factory.create_failed_thumbnail_async(
                item.uri, mtime, this._cancellable).catch(() => {});
            return;
        }

        item.thumbnail = GnomeDesktop.desktop_thumbnail_path_for_uri(item.uri, SIZE);
        this.emit('thumbnail-ready', item);
    }
}

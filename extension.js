// Stable GNOME entry point. Feature changes belong in runtime.js/groups.js and
// runtime.css. GJS caches modules, so each update loads from a new revision URI.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FILES = ['runtime.js', 'groups.js', 'runtime.css'];
const DECODER = new TextDecoder();

export default class UniversalTabsBootstrap extends Extension {
    enable() {
        this._enabled = true;
        this._generation = (this._generation ?? 0) + 1;
        this._monitors = [];
        this._reloadTimer = 0;
        this.runtime = null;
        this._loaded = null;
        this._style = null;
        this._lastError = null;
        this._watch(this.dir);
        this._reload();
    }

    _read(file) {
        return DECODER.decode(file.load_contents(null)[1]);
    }

    _writeJson(name, value) {
        try {
            this.dir.get_child(name).replace_contents(JSON.stringify(value), null,
                false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            console.error(`[Universal Tabs] Writing ${name}: ${error}`);
        }
    }

    _status() {
        this._writeJson('runtime-status.json', {enabled: this._enabled,
            revision: this._loaded?.revision ?? null,
            error: this._lastError, timestamp: new Date().toISOString()});
    }

    _watch(directory) {
        const monitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', (_monitor, file, other) => {
            const names = [file?.get_basename(), other?.get_basename()];
            if (names.some(name => name === 'runtime.json' || FILES.includes(name)))
                this._scheduleReload();
        });
        this._monitors.push(monitor);
    }

    _scheduleReload() {
        if (!this._enabled)
            return;
        if (this._reloadTimer)
            GLib.source_remove(this._reloadTimer);
        this._reloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._reloadTimer = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _bundle() {
        const manifest = JSON.parse(this._read(this.dir.get_child('runtime.json')));
        if (manifest.sourceDirectory) {
            const source = Gio.File.new_for_path(manifest.sourceDirectory);
            if (this._sourcePath !== manifest.sourceDirectory) {
                this._sourceMonitor?.cancel();
                const oldCount = this._monitors.length;
                this._watch(source);
                this._sourceMonitor = this._monitors[oldCount];
                this._sourcePath = manifest.sourceDirectory;
            }
            const contents = FILES.map(name => this._read(source.get_child(name)));
            const revision = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
                JSON.stringify(contents), -1).slice(0, 20);
            const directory = this.dir.get_child('revisions').get_child(revision);
            if (!directory.query_exists(null)) {
                directory.make_directory_with_parents(null);
            }
            FILES.forEach((name, i) => {
                const file = directory.get_child(name);
                if (!file.query_exists(null) || this._read(file) !== contents[i])
                    file.replace_contents(contents[i], null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            });
            return {directory, revision};
        }
        if (!/^[a-f0-9]{20}$/.test(manifest.revision ?? ''))
            throw new Error('Invalid runtime revision');
        return {directory: this.dir.get_child('revisions').get_child(manifest.revision),
            revision: manifest.revision};
    }

    async _reload() {
        const generation = ++this._generation;
        let next = null;
        let nextStyle = null;
        const previous = this._loaded;
        let snapshot = null;
        let stopped = false;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        try {
            const bundle = this._bundle();
            if (this._loaded?.revision === bundle.revision)
                return;
            // Each relative dependency needs a new URI, too. A query string on
            // runtime.js alone would leave groups.js cached by GJS.
            const module = await import(bundle.directory.get_child('runtime.js').get_uri());
            if (!this._enabled || generation !== this._generation)
                return;
            nextStyle = bundle.directory.get_child('runtime.css');
            theme.load_stylesheet(nextStyle);
            snapshot = this.runtime?.snapshot() ?? null;
            this.runtime?.disable();
            stopped = true;
            next = new module.default(this);
            next.enable(snapshot);
            if (this._style)
                theme.unload_stylesheet(this._style);
            this.runtime = next;
            this._style = nextStyle;
            this._loaded = {...bundle, module};
            this._lastError = null;
            this._writeJson('last-good.json', {revision: bundle.revision});
            this._status();
            console.log(`[Universal Tabs] Runtime ${bundle.revision} loaded`);
        } catch (error) {
            if (!this._enabled || generation !== this._generation)
                return;
            this._lastError = `${error}\n${error.stack ?? ''}`;
            if (stopped) {
                try {
                    next?.disable();
                } catch (cleanupError) {
                    console.error(`[Universal Tabs] Update cleanup: ${cleanupError}`);
                }
                this.runtime = null;
                if (previous) {
                    try {
                        const restored = new previous.module.default(this);
                        restored.enable(snapshot);
                        this.runtime = restored;
                    } catch (restoreError) {
                        console.error(`[Universal Tabs] Rollback: ${restoreError}`);
                    }
                }
            }
            if (nextStyle)
                theme.unload_stylesheet(nextStyle);
            if (!this.runtime && this._enabled && generation === this._generation)
                await this._recoverSaved(generation);
            this._status();
            console.error(`[Universal Tabs] Update rejected; previous runtime retained: ${this._lastError}`);
            Main.notify('Universal Tabs update failed',
                this.runtime ? 'The previous version is still running. Fix the code and save to retry.'
                    : 'The runtime could not start. Check the extension status and logs.');
        }
    }

    async _recoverSaved(generation) {
        let recovered = null;
        let style = null;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        try {
            const saved = JSON.parse(this._read(this.dir.get_child('last-good.json')));
            if (!/^[a-f0-9]{20}$/.test(saved.revision ?? ''))
                return;
            const directory = this.dir.get_child('revisions').get_child(saved.revision);
            const module = await import(directory.get_child('runtime.js').get_uri());
            if (!this._enabled || generation !== this._generation)
                return;
            style = directory.get_child('runtime.css');
            theme.load_stylesheet(style);
            recovered = new module.default(this);
            recovered.enable();
            this.runtime = recovered;
            this._style = style;
            this._loaded = {directory, module, revision: saved.revision};
        } catch (error) {
            recovered?.disable();
            if (style)
                theme.unload_stylesheet(style);
            console.error(`[Universal Tabs] Saved revision recovery: ${error}`);
        }
    }

    disable() {
        this._enabled = false;
        ++this._generation;
        if (this._reloadTimer)
            GLib.source_remove(this._reloadTimer);
        this._reloadTimer = 0;
        for (const monitor of this._monitors ?? [])
            monitor.cancel();
        this._monitors = [];
        this._sourceMonitor = null;
        this._sourcePath = null;
        this.runtime?.disable();
        this.runtime = null;
        if (this._style)
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._style);
        this._style = null;
        this._status();
        this._loaded = null;
    }
}

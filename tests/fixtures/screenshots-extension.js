// Synthetic documentation screenshots. This fixture never connects to the real desktop bus.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'universal-tabs@extensions.local';
const DEMO_PREFIX = 'org.gnome.Extensions.UniversalTabsDemo.';
const delay = (milliseconds = 300) => new Promise(resolve => GLib.timeout_add(
    GLib.PRIORITY_DEFAULT, milliseconds, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const until = async (condition, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition())
            return;
        await delay(100);
    }
    throw new Error(`Screenshot fixture timed out: ${description}`);
};

export default class ScreenshotFixture extends Extension {
    enable() {
        this._clients = [];
        this._run().catch(error => this._finish({ok: false, error: `${error}\n${error.stack ?? ''}`}));
    }

    async _run() {
        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const appearance = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        appearance.set_string('color-scheme', 'default');
        appearance.set_boolean('enable-animations', false);
        wm.set_string('button-layout', ':close,minimize,maximize');
        const namespaces = () => ({
            'org.gnome.desktop.wm.preferences': {'button-layout': wm.get_value('button-layout')},
            'org.freedesktop.appearance': {'color-scheme': new GLib.Variant('u',
                appearance.get_string('color-scheme') === 'prefer-dark' ? 1 : 2)},
        });
        this._portal = Gio.DBusExportedObject.wrapJSObject(`<node>
            <interface name="org.freedesktop.portal.Settings">
                <property name="version" type="u" access="read"/>
                <method name="ReadAll"><arg type="as" direction="in"/><arg type="a{sa{sv}}" direction="out"/></method>
                <method name="Read"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
                <signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
            </interface></node>`, {
            get version() { return 1; },
            ReadAll() { return namespaces(); },
            Read(namespace, key) { return namespaces()[namespace]?.[key] ?? new GLib.Variant('s', ''); },
        });
        this._portal.export(Gio.DBus.session, '/org/freedesktop/portal/desktop');
        await new Promise(resolve => {
            this._portalName = Gio.bus_own_name_on_connection(Gio.DBus.session,
                'org.freedesktop.portal.Desktop', Gio.BusNameOwnerFlags.NONE, resolve, null);
        });
        this._wm = wm;
        this._layoutChanged = wm.connect('changed::button-layout', () => this._portal.emit_signal(
            'SettingChanged', new GLib.Variant('(ssv)', [
                'org.gnome.desktop.wm.preferences', 'button-layout', wm.get_value('button-layout')])));
        this._appearance = appearance;
        this._appearanceChanged = appearance.connect('changed::color-scheme', () => this._portal.emit_signal(
            'SettingChanged', new GLib.Variant('(ssv)', [
                'org.freedesktop.appearance', 'color-scheme', namespaces()['org.freedesktop.appearance']['color-scheme']])));

        for (const kind of ['Browser', 'Notes', 'Files', 'Reference']) {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.setenv('GDK_DEBUG', 'portals', true);
            this._clients.push(launcher.spawnv(['gjs', '-m', GLib.getenv('UT_DEMO_WINDOWS'), kind]));
        }
        const find = title => global.get_window_actors().map(actor => actor.meta_window)
            .find(window => window.get_title() === title && window.get_gtk_application_id()?.startsWith(DEMO_PREFIX));
        await until(() => ['Browser', 'Notes', 'Files', 'Reference'].every(title => find(title)?.mapped),
            'fictional application windows map');
        await until(() => !Main.layoutManager._startingUp, 'private desktop startup');
        const pointer = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        for (let attempt = 0; attempt < 2; attempt++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), 1200, 750);
            await delay(100);
        }
        Main.overview.hide();
        // Remove the wall clock rather than capture an actual date/time.
        Main.panel.statusArea.dateMenu?.container.hide();
        await delay(600);

        const manager = Main.extensionManager;
        if (!manager.lookup(UUID)) {
            await manager.loadExtension(manager.createExtensionObject(UUID,
                Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(),
                    'gnome-shell', 'extensions', UUID])), 2));
        }
        manager.enableExtension(UUID);
        await until(() => manager.lookup(UUID)?.stateObj?.runtime?._model, 'production extension enabled');
        const runtime = manager.lookup(UUID).stateObj.runtime;
        const appSystem = runtime._appSystem;
        const demoApps = appSystem.get_installed().filter(info => info.get_id().startsWith(DEMO_PREFIX));
        if (demoApps.length !== 12)
            throw new Error('Screenshot fixture requires exactly twelve fictional application entries');
        // The documentation UI receives only synthetic app metadata, including
        // the New tab grid and the excluded-app chooser in Settings.
        runtime._appSystem = {get_installed: () => demoApps, lookup_app: id => appSystem.lookup_app(id)};

        const browser = find('Browser');
        const notes = find('Notes');
        const files = find('Files');
        const reference = find('Reference');
        reference.minimize();
        const group = runtime._model.windows.get(browser).group;
        runtime._join(notes, group);
        runtime._join(files, group);
        runtime._select(browser);
        browser.move_resize_frame(true, 140, 170, 1000, 520);
        await until(() => browser.get_frame_rect().width === 1000 && browser.get_frame_rect().height === 520,
            'floating shared viewport configured');
        await until(() => runtime._bars.get(group)?.buttons.length === 3, 'three real cross-app tabs rendered');
        await delay(500);
        const bar = runtime._bars.get(group);
        const actions = new Map();
        for (const kind of ['Browser', 'Notes', 'Files', 'Reference']) {
            const groupActions = Gio.DBusActionGroup.get(Gio.DBus.session, DEMO_PREFIX + kind,
                '/org/gnome/Extensions/UniversalTabsDemo/' + kind);
            await until(() => groupActions.has_action('dark'), 'demo appearance action available');
            actions.set(kind, groupActions);
        }
        const setAppearance = async dark => {
            appearance.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
            for (const groupActions of actions.values())
                groupActions.activate_action('dark', new GLib.Variant('b', dark));
            await until(() => bar.actor.has_style_class_name(dark ? 'dark' : 'light'), 'extension appearance applied');
            await delay(400);
        };
        const capture = async name => {
            runtime._hideTooltip();
            global.stage.set_key_focus(null);
            await delay(150);
            const shot = new Shell.Screenshot();
            const output = Gio.File.new_for_path(GLib.build_filenamev([GLib.getenv('UT_DEMO_OUTPUT'), name]));
            const stream = output.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await new Promise((resolve, reject) => shot.screenshot(false, stream, (object, result) => {
                try { object.screenshot_finish(result); stream.close(null); resolve(); }
                catch (error) { reject(error); }
            }));
        };

        await setAppearance(false);
        await capture('floating-tabs.png');
        runtime._select(notes);
        notes.maximize();
        await until(() => notes.is_maximized() && notes.get_frame_rect().y === notes.get_work_area_current_monitor().y + 30,
            'maximized group reserves its real tab strip');
        await setAppearance(true);
        await capture('maximized-dark.png');
        await setAppearance(false);
        runtime._openNewTab(bar, group);
        await until(() => bar.page?.items.filter(item => !item.window).length === 12,
            'New tab displays only fictional application entries');
        await capture('new-tab.png');
        runtime._closeNewTab(bar);
        group.active.minimize();
        await until(() => !bar.actor.visible, 'documentation windows hidden before standalone settings');
        runtime._openSettings();
        await until(() => runtime._settingsDialog?.dialogLayout.mapped, 'standalone settings dialog visible');
        await capture('settings.png');
        await this._finish({ok: true, screenshots: [
            'floating-tabs.png', 'maximized-dark.png', 'new-tab.png', 'settings.png'],
        checks: ['actual production runtime', 'four fictional GTK apps', 'synthetic app metadata only', 'wall clock hidden']});
    }

    async _finish(result) {
        GLib.file_set_contents(GLib.getenv('UT_TEST_RESULT'), JSON.stringify(result, null, 2));
        Main.extensionManager.disableExtension(UUID);
        await delay(100);
        for (const client of this._clients)
            client.force_exit();
        if (this._layoutChanged)
            this._wm.disconnect(this._layoutChanged);
        if (this._appearanceChanged)
            this._appearance.disconnect(this._appearanceChanged);
        this._portal?.unexport();
        if (this._portalName)
            Gio.bus_unown_name(this._portalName);
        global.context.terminate();
    }
}

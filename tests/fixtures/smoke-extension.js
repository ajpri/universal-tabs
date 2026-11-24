import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {runSettingsChecks} from './settings-checks.js';
import {runMonitorChecks} from './monitor-checks.js';

function delay(ms = 300) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
async function until(predicate, message) {
    for (let i = 0; i < 80; i++) {
        if (predicate())
            return;
        await delay(100);
    }
    throw new Error(`Timed out: ${message}`);
}
function find(title) {
    return global.get_window_actors().map(actor => actor.meta_window).find(w => w.get_title() === title);
}

async function assertStillRestore(window, action, description, outgoing = []) {
    const actors = [...new Set([window, ...outgoing])].map(member => member.get_compositor_private());
    action();
    // Sample throughout both native animation durations, rather than checking
    // only after an unwanted animation would already have completed.
    for (let i = 0; i < 23; i++) {
        for (const actor of actors) {
            assert(!actor.__animationInfo && !Main.wm._minimizing.has(actor) && !Main.wm._resizing.has(actor) &&
                !Main.wm._resizePending.has(actor) && !Main.wm._unminimizing.has(actor) &&
                actor.scale_x === 1 && actor.scale_y === 1 && actor.opacity === 255 &&
                actor.translation_x === 0 && actor.translation_y === 0 &&
                !['scale-x', 'scale-y', 'translation-x', 'translation-y', 'opacity', 'x', 'y']
                    .some(property => actor.get_transition(property)),
                `${description}: ${actor.meta_window.get_title()} must not scale, fade, slide, or leave a resize clone (sample ${i})`);
        }
        await delay(20);
    }
}

async function dragTab(pointer, source, destination) {
    const [sx, sy] = source.get_transformed_position();
    const [dx, dy] = destination.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), sx + 30, sy + 15);
    await delay(100);
    // The new headless seat initializes one pointer axis on its first warp.
    // Prime both axes before issuing a button event.
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), sx + 30, sy + 15);
    await delay(100);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await delay(100);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), sx + 55, sy + 15);
    await delay(100);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), dx + 40, dy + 15);
    await delay(200);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await delay(600);
}

async function screenshot(suffix = '') {
    const shot = new Shell.Screenshot();
    const filename = GLib.getenv('UT_TEST_SCREENSHOT').replace('.png', `${suffix}.png`);
    const stream = Gio.File.new_for_path(filename).replace(null,
        false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Promise((resolve, reject) => shot.screenshot(false, stream, (object, result) => {
        try {
            object.screenshot_finish(result);
            stream.close(null);
            resolve();
        } catch (error) { reject(error); }
    }));
}

async function clickTab(pointer, button, mouseButton = Clutter.BUTTON_PRIMARY) {
    const [x, y] = button.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + Math.min(30, button.width / 2), y + button.height / 2);
    await delay(100);
    pointer.notify_button(GLib.get_monotonic_time(), mouseButton, Clutter.ButtonState.PRESSED);
    await delay(100);
    pointer.notify_button(GLib.get_monotonic_time(), mouseButton, Clutter.ButtonState.RELEASED);
    await delay(600);
}

async function hover(pointer, actor) {
    const [x, y] = actor.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + actor.width / 2, y + actor.height / 2);
    await delay(650);
}

async function wheel(pointer, actor, direction) {
    const [x, y] = actor.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + Math.min(30, actor.width / 2), y + actor.height / 2);
    await delay(60);
    pointer.notify_discrete_scroll(GLib.get_monotonic_time(), direction, Clutter.ScrollSource.WHEEL);
    await delay(160);
}

async function pressKey(keyboard, symbol, shift = false) {
    if (shift) {
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        await delay(20);
    }
    keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
    if (shift)
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    await delay(100);
}

async function doubleClick(pointer, actor) {
    const [x, y] = actor.get_transformed_position();
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + Math.min(30, actor.width / 2), y + actor.height / 2);
    await delay(100);
    for (let i = 0; i < 2; i++) {
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await delay(50);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await delay(60);
    }
    await delay(500);
}

async function moveHandle(pointer, actor, dx, dy) {
    const [x, y] = actor.get_transformed_position();
    const startX = x + actor.width / 2;
    const startY = y + actor.height / 2;
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX, startY);
    await delay(100);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await delay(100);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX + dx, startY + dy);
    await delay(200);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await delay(400);
}

export default class SmokeTest extends Extension {
    enable() {
        this._run().catch(error => this._finish({ok: false, error: `${error}\n${error.stack ?? ''}`}));
    }

    async _run() {
        const checks = [];
        const prepare = Main.wm._prepareAnimationInfo;
        const prepared = [];
        this._animationProbeOriginal = prepare;
        this._animationProbe = function (...args) {
            prepared.push(args[3]);
            return prepare.apply(this, args);
        };
        Main.wm._prepareAnimationInfo = this._animationProbe;
        const wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const originalControls = 'close,minimize,maximize:appmenu';
        wmSettings.set_string('button-layout', originalControls);
        // GTK 4.24 reads desktop settings through the portal. The private bus
        // intentionally has no real services; expose only this test preference.
        const controlsSchema = 'org.gnome.desktop.wm.preferences';
        this._settingsPortal = Gio.DBusExportedObject.wrapJSObject(`<node>
            <interface name="org.freedesktop.portal.Settings">
                <property name="version" type="u" access="read"/>
                <method name="ReadAll"><arg type="as" direction="in"/><arg type="a{sa{sv}}" direction="out"/></method>
                <method name="Read"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
                <signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
            </interface></node>`, {
            get version() { return 1; },
            ReadAll() { return {[controlsSchema]: {'button-layout': wmSettings.get_value('button-layout')}}; },
            Read() { return wmSettings.get_value('button-layout'); },
        });
        this._settingsPortal.export(Gio.DBus.session, '/org/freedesktop/portal/desktop');
        await new Promise(resolve => {
            this._settingsPortalName = Gio.bus_own_name_on_connection(Gio.DBus.session,
                'org.freedesktop.portal.Desktop', Gio.BusNameOwnerFlags.NONE, resolve, null);
        });
        this._controlsSignal = wmSettings.connect('changed::button-layout', () =>
            this._settingsPortal.emit_signal('SettingChanged', new GLib.Variant('(ssv)',
                [controlsSchema, 'button-layout', wmSettings.get_value('button-layout')])));
        this._testWmSettings = wmSettings;
        const clientLauncher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        // The fixture owns a portal name but intentionally has no activatable
        // service files. Force GTK to use that private test portal.
        clientLauncher.setenv('GDK_DEBUG', 'portals', true);
        this._client = clientLauncher.spawnv(['gjs', '-m', GLib.getenv('UT_TEST_WINDOWS')]);
        await until(() => find('UT Manual'), 'client windows mapped');
        const large = find('UT Large');
        const small = find('UT Small');
        const manual = find('UT Manual');
        manual.minimize();
        await delay();
        const uuid = 'universal-tabs@extensions.local';
        const manager = Main.extensionManager;
        const controlsProbe = Gio.DBusActionGroup.get(Gio.DBus.session,
            'org.gnome.Extensions.UniversalTabsTest', '/org/gnome/Extensions/UniversalTabsTest');
        const inspectControls = async hidden => {
            let lastState;
            for (let i = 0; i < 40; i++) {
                controlsProbe.activate_action('inspect-controls', null);
                await delay(80);
                if (!GLib.file_test(GLib.getenv('UT_TEST_CONTROLS'), GLib.FileTest.EXISTS))
                    continue;
                const [ok, bytes] = GLib.file_get_contents(GLib.getenv('UT_TEST_CONTROLS'));
                if (!ok)
                    continue;
                const state = JSON.parse(new TextDecoder().decode(bytes));
                lastState = state;
                if (hidden ? state.buttons.length === 0 && !/close|minimize|maximize/.test(state.layout)
                    : ['close', 'minimize', 'maximize'].every(name => state.buttons.includes(name)))
                    return state;
            }
            throw new Error(`GTK window controls did not reach the expected visibility: hidden=${hidden}, state=${JSON.stringify(lastState)}, preference=${wmSettings.get_string('button-layout')}`);
        };
        await inspectControls(false);
        // Reproduce first installation: files exist, but this UUID has never
        // been imported by Shell. Exercise the Looking Glass registration API.
        await manager.unloadExtension(manager.lookup(uuid));
        assert(!manager.lookup(uuid), 'fixture must begin with an unregistered extension');
        if (!manager.lookup(uuid)) {
            await manager.loadExtension(manager.createExtensionObject(uuid,
                Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(),
                    'gnome-shell', 'extensions', uuid])), 2));
        }
        manager.enableExtension(uuid);
        checks.push('one-time Looking Glass registration loads an unregistered local extension');
        await until(() => Main.extensionManager.lookup('universal-tabs@extensions.local')?.stateObj?.runtime?._model, 'extension enabled');
        const bootstrap = Main.extensionManager.lookup('universal-tabs@extensions.local').stateObj;
        let ext = bootstrap.runtime;
        assert(!Main.panel.statusArea[uuid], 'Universal Tabs must not add a top-panel indicator or settings menu');
        const controlsBackup = bootstrap.dir.get_child('window-controls-backup.json');
        assert(wmSettings.get_string('button-layout') === ':appmenu' && controlsBackup.query_exists(null),
            'enable must hide the three native controls and persist the original layout while retaining the menu');
        await inspectControls(true);
        checks.push('GNOME layout hides actual GTK close, minimize, and maximize buttons while keeping menu placement');
        await until(() => ext._bars.size === 3, 'floating tabs created');
        const pointer = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        // A new virtual pointer starts at the hot corner; settle it before
        // dismissing GNOME's overview so device creation cannot reopen it.
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 640, 700);
        await delay(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 640, 700);
        await delay(100);
        await until(() => !Main.layoutManager._startingUp, 'shell startup complete');
        Main.overview.hide();
        await delay(1000);
        assert(ext._bars.get(ext._model.windows.get(small).group).actor.visible, 'small window tab must be visible');
        checks.push('normal windows receive visible floating tabs');
        if (GLib.getenv('UT_TEST_MONITORS_ONLY') === '1') {
            const windowActions = Gio.DBusActionGroup.get(Gio.DBus.session,
                'org.gnome.Extensions.UniversalTabsTest', '/org/gnome/Extensions/UniversalTabsTest');
            await runMonitorChecks({bootstrap, large, small, manual, windowActions, pointer, checks,
                assert, until, delay, clickTab, screenshot});
            await this._finish({ok: true, checks});
            return;
        }
        if (GLib.getenv('UT_TEST_SETTINGS_ONLY') === '1') {
            const windowActions = Gio.DBusActionGroup.get(Gio.DBus.session,
                'org.gnome.Extensions.UniversalTabsTest', '/org/gnome/Extensions/UniversalTabsTest');
            await runSettingsChecks({bootstrap, manager, uuid, large, manual, windowActions, pointer,
                prepared, checks, inspectControls, originalControls, wmSettings, controlsBackup,
                assert, until, delay, clickTab, wheel, assertStillRestore, screenshot});
            await this._finish({ok: true, checks});
            return;
        }
        large.move_frame(true, 80, 140);
        small.move_frame(true, 900, 340);
        await delay();
        const bigSize = large.get_frame_rect();
        const smallSize = small.get_frame_rect();
        const animationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const animationsBefore = animationSettings.get_boolean('enable-animations');
        animationSettings.set_boolean('enable-animations', true);
        await until(() => St.Settings.get().enable_animations, 'animations enabled in the private desktop');
        const actor = large.get_compositor_private();
        let observed = prepared.length;
        await assertStillRestore(large, () => large.maximize(), 'maximize');
        assert(prepared.length === observed && !actor.__animationInfo && actor.scale_x === 1 && actor.translation_x === 0,
            'maximize must not prepare a clone or window scaling when system animations are enabled');
        await assertStillRestore(large, () => large.unmaximize(), 'restore from maximized');
        assert(prepared.length === observed && !actor.__animationInfo && actor.scale_x === 1,
            'restore must also skip only its size animation');
        assert(animationSettings.get_boolean('enable-animations'), 'extension must not overwrite saved animation preference');
        checks.push('maximize and restore skip their animation while the system animation setting stays enabled');
        large.minimize();
        await delay(40);
        assert(Main.wm._minimizing.has(actor), 'ordinary minimize must retain its native animation');
        await delay(450);
        await assertStillRestore(large, () => large.unminimize(), 'restore from minimized');
        const restoredBuffer = large.get_buffer_rect();
        assert(actor.x === restoredBuffer.x && actor.y === restoredBuffer.y,
            'a restored actor must land at its native window position');
        checks.push('minimized windows restore instantly while ordinary minimize still animates');
        const ownPrepare = Main.wm._prepareAnimationInfo;
        Main.wm._prepareAnimationInfo = this._animationProbe;
        try {
            await assertStillRestore(large, () => large.maximize(), 'maximize with a later animation hook');
            await assertStillRestore(large, () => large.unmaximize(), 'restore with a later animation hook');
        } finally {
            Main.wm._prepareAnimationInfo = ownPrepare;
        }
        checks.push('native size-effect cleanup still prevents restore motion when another extension replaces the preparation hook');
        await assertStillRestore(large, () => large.maximize(), 'maximize before minimized restore');
        large.minimize();
        await delay(450);
        await assertStillRestore(large, () => {
            large.unminimize();
            large.unmaximize();
        }, 'combined minimized and maximized restore');
        checks.push('restoring a minimized maximized window does not leave a fade or scaling animation');
        large.make_fullscreen();
        await delay(400);
        assert(prepared.slice(observed).includes(Meta.SizeChange.FULLSCREEN), 'fullscreen must retain GNOME animation preparation');
        large.unmake_fullscreen();
        await delay(400);
        assert(prepared.slice(observed).includes(Meta.SizeChange.UNFULLSCREEN), 'leaving fullscreen must retain GNOME animation preparation');
        checks.push('fullscreen transitions retain the original GNOME animation handler');
        animationSettings.set_boolean('enable-animations', animationsBefore);
        await delay();
        await screenshot();
        await dragTab(pointer, ext._bars.get(ext._model.windows.get(small).group).buttons[0].button,
            ext._bars.get(ext._model.windows.get(large).group).actor);
        assert(ext._model.windows.get(small).group === ext._model.windows.get(large).group,
            'real pointer drag must join windows');
        checks.push('real Wayland pointer drag joins windows');
        assert(large.minimized && !small.minimized, 'join must hide the inactive member');
        assert(small.get_frame_rect().width === bigSize.width && small.get_frame_rect().height === bigSize.height,
            'joining must resize the incoming window to the target viewport');
        checks.push('join resizes the incoming window to the shared viewport');
        await clickTab(pointer, ext._bars.get(ext._model.windows.get(large).group).buttons.find(item => item.window === large).button);
        assert(!large.minimized && small.minimized, 'switch must select the requested real window');
        assert(large.get_frame_rect().width === bigSize.width, 'large viewport must restore');
        checks.push('tab switching preserves the shared viewport');
        animationSettings.set_boolean('enable-animations', true);
        await until(() => St.Settings.get().enable_animations, 'enable animations for tab restore sampling');
        await assertStillRestore(small, () => ext._select(small), 'complete tab switch', [large]);
        await assertStillRestore(large, () => {
            ext._select(large);
            ext._select(small);
            ext._select(large);
        }, 'rapid tab switching', [small]);
        large.minimize();
        await delay(40);
        assert(Main.wm._minimizing.has(large.get_compositor_private()) && small.minimized,
            'explicitly minimizing the selected tab must still animate the whole group normally');
        await delay(450);
        await assertStillRestore(large, () => large.unminimize(), 'restore explicitly minimized group', [small]);
        checks.push('explicitly minimizing a group still animates, while switching tabs hides its previous member instantly');
        animationSettings.set_boolean('enable-animations', animationsBefore);
        await delay();
        checks.push('tab switches and rapid switches keep both incoming and outgoing windows free of scale, fade, and movement');
        await screenshot();

        let group = ext._model.windows.get(large).group;
        let bar = ext._bars.get(group);
        const firstMember = group.members[0];
        const secondMember = group.members[1];
        ext._select(firstMember);
        await delay(100);
        await wheel(pointer, bar.buttons[0].close, Clutter.ScrollDirection.DOWN);
        assert(group.active === secondMember && group.members.length === 2,
            'wheel down over a tab close button must select the next tab without closing it');
        await wheel(pointer, bar.buttons[1].button, Clutter.ScrollDirection.UP);
        assert(group.active === firstMember, 'wheel up must select the previous tab');
        await wheel(pointer, bar.buttons[0].button, Clutter.ScrollDirection.UP);
        assert(group.active === firstMember, 'wheel switching must stop at the first tab');
        await wheel(pointer, bar.buttons[0].button, Clutter.ScrollDirection.RIGHT);
        assert(group.active === secondMember, 'horizontal wheel right must select the next tab');
        await wheel(pointer, bar.buttons[1].button, Clutter.ScrollDirection.DOWN);
        assert(group.active === secondMember, 'wheel switching must stop at the last tab');
        await wheel(pointer, bar.buttons[1].button, Clutter.ScrollDirection.LEFT);
        assert(group.active === firstMember, 'horizontal wheel left must select the previous tab');
        await wheel(pointer, bar.minimize, Clutter.ScrollDirection.DOWN);
        await wheel(pointer, bar.moveHandle, Clutter.ScrollDirection.DOWN);
        assert(group.active === firstMember && !group.active.minimized, 'scrolling non-tab controls must not switch tabs');
        const [wheelX, wheelY] = bar.buttons[0].button.get_transformed_position();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), wheelX + 30, wheelY + 15);
        await delay(60);
        for (let i = 0; i < 3; i++) {
            pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0.1,
                Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
            await delay(30);
        }
        assert(group.active === firstMember, 'tiny smooth scroll movements must not jump between tabs');
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 20,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
        await delay(160);
        assert(group.active === secondMember, 'a smooth scroll gesture must switch to the next tab');
        ext._select(large);
        await delay(100);
        checks.push('real mouse-wheel and smooth scrolling switch tabs in both directions, stop at the ends, and ignore non-tab controls');
        assert(bar.minimize.get_transformed_position()[0] < bar.buttons[0].container.get_transformed_position()[0],
            'window controls must be to the left of the tabs');
        const [minimizeX, minimizeY] = bar.minimize.get_transformed_position();
        const [firstTabX, firstTabY] = bar.buttons[0].container.get_transformed_position();
        assert(bar.minimize.width === 30 && bar.minimize.height === 30 && bar.moveHandle.height === 30 &&
            minimizeY === firstTabY && Math.abs(minimizeX + bar.minimize.width - firstTabX) <= 1,
            `controls must match tabs: minimize=${bar.minimize.width}x${bar.minimize.height} at ${minimizeX},${minimizeY}; moveHeight=${bar.moveHandle.height}; firstTab=${firstTabX},${firstTabY}`);
        assert(!bar.maximize && !bar.closeWindow, 'only the minimize control should remain on the left');
        assert(bar.buttons.every(item => item.close && item.icon), 'tabs must retain individual close buttons and app icons');
        assert(bar.buttons.every(item => item.container.width >= 235 && item.container.width <= 241),
            'a few hanging tabs must use the wider capped width');
        const first = bar.buttons[0];
        const [iconX] = first.icon.get_transformed_position();
        const [titleX] = first.label.get_transformed_position();
        assert(titleX > iconX && first.label.clutter_text.get_line_alignment() === 0,
            'window titles must be left aligned after the application icon');
        checks.push('only minimize remains on the left; tab titles have left-aligned icons and individual close buttons');
        await hover(pointer, bar.minimize);
        assert(ext._tooltipActor?.visible && ext._tooltipActor.text === 'Minimize window group',
            'hovering an icon-only control must show its action tooltip');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 640, 720);
        await delay(100);
        assert(!ext._tooltipActor.visible, 'leaving a control must hide its tooltip');
        bar.plus.grab_key_focus();
        await until(() => ext._tooltipActor?.visible && ext._tooltipActor.text === 'New tab', 'keyboard tooltip');
        global.stage.set_key_focus(null);
        await delay(100);
        assert(!ext._tooltipActor.visible, 'leaving keyboard focus must hide its tooltip');
        checks.push('control tooltips appear on real pointer hover and keyboard focus and dismiss when leaving');
        await doubleClick(pointer, bar.buttons.find(item => item.window === large).button);
        await until(() => large.is_maximized(), 'double-click tab maximizes');
        await delay(400);
        const workArea = large.get_work_area_current_monitor();
        const maximizedFrame = large.get_frame_rect();
        assert(maximizedFrame.y === workArea.y + 30 && maximizedFrame.height === workArea.height - 30,
            `maximized frame must reserve exactly one tab strip: ${JSON.stringify(maximizedFrame)}`);
        const [, tabY] = bar.actor.get_transformed_position();
        assert(tabY >= workArea.y && tabY + bar.actor.height <= maximizedFrame.y,
            'maximized tabs must sit below the top panel and entirely above the app');
        assert(bar.actor.x === maximizedFrame.x && bar.actor.width === maximizedFrame.width,
            'maximized strips must remain flush with the native frame');
        assert(ext._model.rect(large).width === bigSize.width, 'maximize must preserve normal dimensions');
        await screenshot('-maximized');
        assert(!bar.moveHandle.visible, 'move handle must be hidden while maximized');
        checks.push('double-clicking a tab maximizes with tabs below the top panel');
        const appearance = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        appearance.set_string('color-scheme', 'default');
        await delay();
        const inactiveTab = bar.buttons.find(item => item.window !== group.active);
        const lightColor = inactiveTab.container.get_theme_node().get_background_color();
        const activeTab = bar.buttons.find(item => item.window === group.active);
        const activeLight = activeTab.container.get_theme_node().get_background_color();
        assert(activeLight.red >= 245 && activeLight.green >= 245 && activeLight.blue >= 245 &&
            activeTab.label.get_theme_node().get_foreground_color().red <= 60,
            'active tab must use a light background with readable dark text in light appearance');
        appearance.set_string('color-scheme', 'prefer-dark');
        await until(() => bar.actor.has_style_class_name('dark'), 'dark appearance applied');
        const darkColor = inactiveTab.container.get_theme_node().get_background_color();
        assert(darkColor.red < lightColor.red, 'system dark appearance must change the tab colors');
        const activeDark = activeTab.container.get_theme_node().get_background_color();
        assert(activeDark.red <= 40 && activeDark.green <= 40 && activeDark.blue <= 40 &&
            activeTab.label.get_theme_node().get_foreground_color().red >= 230,
            'active tab must use GNOME charcoal with light text in dark appearance');
        assert(bar.minimize.width === bar.minimize.height, 'minimize control must be square');
        await screenshot('-maximized-dark');
        appearance.set_string('color-scheme', 'default');
        await until(() => bar.actor.has_style_class_name('light'), 'light appearance restored');
        checks.push('system light/dark changes update neutral square GNOME controls and tabs live');
        await clickTab(pointer, bar.buttons.find(item => item.window === small).button);
        await until(() => small.is_maximized(), 'group maximization follows selected tab');
        assert(small.get_frame_rect().y === workArea.y + 30, 'small tab must also fit below the strip when maximized');
        await doubleClick(pointer, bar.freeSpace);
        await until(() => !small.is_maximized(), 'double-click empty strip restores');
        await delay();
        assert(small.get_frame_rect().width === bigSize.width, 'restore must recover the shared viewport');
        await clickTab(pointer, bar.buttons.find(item => item.window === large).button);
        await until(() => !large.is_maximized(), 'restored group switches back to larger tab');
        assert(large.get_frame_rect().width === bigSize.width, 'restoring the group must recover each member size');
        checks.push('double-clicking maximized empty space restores the shared viewport');
        await doubleClick(pointer, bar.buttons.find(item => item.window === small).button);
        assert(group.active === small && small.is_maximized(), 'double-clicking an inactive tab must select and maximize it once');
        await doubleClick(pointer, bar.buttons.find(item => item.window === small).button);
        assert(!small.is_maximized(), 'double-clicking a selected tab must restore it once');
        await clickTab(pointer, bar.buttons.find(item => item.window === large).button);
        checks.push('double-click works on both inactive and selected tabs without duplicate toggles');
        assert(bar.moveHandle.visible, 'floating group must have a move handle');
        assert(Math.abs(bar.moveHandle.width - bar.buttons[0].container.width * 0.75) <= 2,
            'the floating move handle must be 75% of a tab width when room permits');
        const beforeMove = large.get_frame_rect();
        const [handleX] = bar.moveHandle.get_transformed_position();
        assert(Math.abs(handleX + bar.moveHandle.width - (beforeMove.x + beforeMove.width - 12)) <= 1,
            'move rectangle must meet the inset strip edge clear of the rounded top-right corner');
        await moveHandle(pointer, bar.moveHandle, 60, 40);
        const afterMove = large.get_frame_rect();
        assert(afterMove.x !== beforeMove.x && afterMove.y !== beforeMove.y,
            'dragging the rectangle must move the native window');
        assert(small.get_frame_rect().x === afterMove.x && small.get_frame_rect().y === afterMove.y,
            'dragging the rectangle must move hidden group members too');
        assert(group.members.length === 2 && !ext._drag, 'group movement must not detach a tab');
        checks.push('top-right rectangle moves the complete floating group');
        large.move_frame(true, 1050, 220);
        await delay();
        const edge = large.get_frame_rect();
        assert(edge.x + edge.width > 1280, 'edge test must move the window partly beyond the right monitor edge');
        assert(bar.actor.x === edge.x + 12 && bar.actor.width === edge.width - 24,
            'floating tab strip must keep its corner inset even on a partly off-screen window');
        ext._select(small);
        await delay();
        assert(bar.actor.x === small.get_frame_rect().x + 12 && small.get_frame_rect().width === edge.width,
            'switching at the right edge must retain viewport size and alignment');
        checks.push('right-edge movement and tab switching keep the strip attached');
        ext._select(large);
        large.move_frame(true, 80, 140);
        await delay();
        let backgroundTab = bar.buttons.find(item => item.window === small);
        await clickTab(pointer, backgroundTab.button, Clutter.BUTTON_SECONDARY);
        assert(bar.contextMenu?.isOpen && bar.contextWindow === small,
            `right-click must open clicked tab menu: exists=${!!bar.contextMenu}, open=${bar.contextMenu?.isOpen}, active=${group.active.get_title()}, modal=${Main.modalCount}`);
        assert(group.active === large && small.minimized, 'right-clicking an inactive tab must not activate it');
        const contextAction = (currentBar, label) => currentBar.contextMenu._getMenuItems().find(item => item.label?.text === label);
        assert(contextAction(bar, 'Ungroup all windows') && contextAction(bar, 'Disable Universal Tabs'),
            'tab context menus must preserve global ungroup and disable actions after removing the panel menu');
        const detachAction = contextAction(bar, 'Detach tab');
        assert(detachAction?.sensitive, 'grouped tab must offer Detach');
        await clickTab(pointer, detachAction);
        await until(() => ext._model.windows.get(small).group !== group, 'menu detaches clicked tab');
        assert(!small.minimized && !large.minimized, 'menu detach must reveal both independent windows');
        checks.push('right-click context menu detaches the clicked background tab without switching on open');
        const soloBar = ext._bars.get(ext._model.windows.get(small).group);
        await clickTab(pointer, soloBar.buttons[0].button, Clutter.BUTTON_SECONDARY);
        assert(!contextAction(soloBar, 'Detach tab').sensitive, 'singleton Detach must be disabled');
        const settingsLabel = `${bootstrap.metadata.name} Settings`;
        const settingsIn = menu => menu._getMenuItems().find(item => item.label?.text === settingsLabel);
        const settingSwitch = key => [...ext._settingsSwitches].find(item => item._settingKey === key && !item._appId);
        const tabSettings = settingsIn(soloBar.contextMenu);
        assert(tabSettings && !Main.panel.statusArea[uuid] && !ext._preferences.hideMoveBar &&
            ext._settingsSwitches.size === 0 && !ext._preferencesFile.query_exists(null),
            'settings actions must be named from extension metadata and default to off without creating controls outside the modal');
        await clickTab(pointer, tabSettings);
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'tab context action opens settings modal');
        const firstSettingsDialog = ext._settingsDialog;
        const settingsModalCount = Main.modalCount;
        ext._openSettings();
        assert(ext._settingsDialog === firstSettingsDialog && Main.modalCount === settingsModalCount,
            'reopening settings must focus the existing dialog without another input grab');
        assert(!soloBar.contextMenu?.isOpen && !Main.panel.statusArea[uuid] && !settingSwitch('hideMoveBar').state,
            'settings must appear in a separate dialog with the source menus closed');
        await clickTab(pointer, settingSwitch('hideMoveBar'));
        assert(ext._preferences.hideMoveBar, 'clicking Hide move bar must enable the setting');
        await until(() => [...ext._bars.values()].filter(current => current.actor.visible)
            .every(current => !current.moveHandle.visible), 'move handles hidden for every visible group');
        const savedSettings = () => JSON.parse(new TextDecoder().decode(ext._preferencesFile.load_contents(null)[1]));
        assert(savedSettings().hideMoveBar && settingSwitch('hideMoveBar').state && group.active === large,
            'dialog setting must persist and leave the active window unchanged');
        await screenshot('-settings');
        ext._closeSettings();
        assert(!ext._settingsDialog && ext._settingsSwitches.size === 0,
            'closing settings must destroy its controls synchronously');
        await clickTab(pointer, soloBar.buttons[0].button, Clutter.BUTTON_SECONDARY);
        await until(() => soloBar.contextMenu?.isOpen, 'tab context menu reopened after closing settings');
        await clickTab(pointer, settingsIn(soloBar.contextMenu));
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'context action reopens the settings modal');
        assert(settingSwitch('hideMoveBar').state, 'new settings dialog must reflect the saved setting');
        await clickTab(pointer, settingSwitch('hideMoveBar'));
        await until(() => bar.moveHandle.visible && soloBar.moveHandle.visible, 'dialog setting restores all floating move handles');
        assert(!savedSettings().hideMoveBar && !settingSwitch('hideMoveBar').state,
            'dialog setting must save off and synchronize its displayed switch');
        const settingsKeyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        await pressKey(settingsKeyboard, Clutter.KEY_Escape);
        await until(() => !ext._settingsDialog, 'Escape closes the settings dialog');
        assert(ext._settingsSwitches.size === 0, 'Escape must destroy settings switches');
        checks.push('named tab settings actions open a separate singleton modal without a panel indicator, save preferences, and clean up on Escape');
        soloBar.closeContext();
        ext._join(small, group);
        ext._select(large);
        await delay();
        await clickTab(pointer, bar.buttons.find(item => item.window === small).button, Clutter.BUTTON_SECONDARY);
        await clickTab(pointer, contextAction(bar, 'Move tab left'));
        assert(group.members[0] === small && group.active === large, 'menu reordering must preserve the selected tab');
        checks.push('context menu reorders tabs without activation and disables invalid actions');
        const windowActions = Gio.DBusActionGroup.get(Gio.DBus.session,
            'org.gnome.Extensions.UniversalTabsTest', '/org/gnome/Extensions/UniversalTabsTest');
        await delay(100);
        const beforeCrowding = new Set(ext._model.windows.keys());
        for (let i = 0; i < 4; i++)
            windowActions.activate_action('extra', null);
        await until(() => [...ext._model.windows.keys()].filter(window => !beforeCrowding.has(window)).length === 4,
            'crowded strip test windows mapped');
        const crowded = [...ext._model.windows.keys()].filter(window => !beforeCrowding.has(window));
        for (const window of crowded)
            ext._join(window, group);
        await delay();
        assert(bar.buttons.every(item => item.container.width > 72 && item.container.width < 180),
            'adding windows must shrink all tabs equally to fit');
        const lastCrowded = crowded.at(-1);
        lastCrowded.move_resize_frame(true, 80, 140, 420, bigSize.height);
        await delay();
        assert(bar.buttons.every(item => Math.abs(item.container.width - 72) <= 1),
            'crowded narrow groups must retain a readable minimum tab width');
        const adjustment = bar.scroll.hadjustment;
        assert(adjustment.upper > adjustment.page_size && adjustment.value > 0,
            'overflowing tabs must scroll to the selected last tab');
        const lastTab = bar.buttons.find(item => item.window === lastCrowded);
        const [lastX] = lastTab.container.get_transformed_position();
        const [scrollX] = bar.scroll.get_transformed_position();
        assert(lastX >= scrollX - 1 && lastX + lastTab.container.width <= scrollX + bar.scroll.width + 1,
            'selected tab including its close button must remain fully visible');
        await wheel(pointer, lastTab.button, Clutter.ScrollDirection.UP);
        assert(group.active === group.members.at(-2), 'wheel must switch within an overflowing strip');
        await wheel(pointer, bar.buttons.find(item => item.window === group.active).button, Clutter.ScrollDirection.DOWN);
        assert(group.active === lastCrowded && adjustment.value > 0, 'wheel selection must reveal the last overflowing tab');
        ext._select(group.members[0]);
        await delay();
        assert(adjustment.value === 0, 'switching to the first tab must reveal the start of the row');
        for (const window of crowded)
            window.delete(global.get_current_time());
        await until(() => crowded.every(window => !ext._model.windows.has(window)), 'crowded test windows closed');
        ext._select(large);
        large.move_resize_frame(true, 80, 140, bigSize.width, bigSize.height);
        await delay();
        assert(bar.buttons.every(item => item.container.width >= 235), 'tabs must widen again when space returns');
        checks.push('hanging tabs widen, shrink equally, and scroll at their minimum while keeping the selected close button visible');
        await clickTab(pointer, bar.plus);
        assert(bar.page?.actor.visible && bar.page.tab.get_parent() === bar.actor,
            'plus must open a selected virtual New tab and a page in the group');
        assert(bar.page.actor.x === large.get_frame_rect().x && bar.page.actor.width === large.get_frame_rect().width,
            'new tab page must occupy exactly the native window viewport');
        assert(Math.abs(bar.page.tab.width - bar.buttons[0].container.width) <= 2 &&
            Math.abs(bar.moveHandle.width - bar.page.tab.width * 0.75) <= 2,
            'New tab must share app tab width while the move handle keeps its 75% ratio');
        assert(!bar.buttons.find(item => item.window === large).container.has_style_class_name('active'),
            'native tab must not look selected while the new tab page is selected');
        assert(!bar.page.windowsButton && !bar.page.appsButton &&
            bar.page.results.get_first_child() === bar.page.windowsSection &&
            bar.page.results.get_last_child() === bar.page.appsSection,
            'one page must show Open windows above the New window app grid with no section tabs');
        const linkedPage = bar.page;
        const [linkX, linkY] = linkedPage.settingsLink.get_transformed_position();
        const pageFrame = large.get_frame_rect();
        assert(linkX < pageFrame.x + 50 && linkY + linkedPage.settingsLink.height > pageFrame.y + pageFrame.height - 40,
            'New tab settings link must sit at the bottom left of the viewport');
        await clickTab(pointer, linkedPage.settingsLink);
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'footer pointer opens settings modal');
        assert(!Main.panel.statusArea[uuid] && bar.page === linkedPage,
            'clicking the footer link must open the separate settings modal without closing New tab');
        ext._closeSettings();
        linkedPage.search.grab_key_focus();
        const navKeyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const inSearch = () => bar.page.search.contains(global.stage.get_key_focus());
        assert(inSearch(), 'New tab must initially focus search');
        await pressKey(navKeyboard, Clutter.KEY_Tab);
        assert(global.stage.get_key_focus() === bar.page.items[0].button, 'Tab from search must focus the first result');
        await pressKey(navKeyboard, Clutter.KEY_Tab, true);
        assert(inSearch(), 'Shift+Tab from the first result must return to search');
        await pressKey(navKeyboard, Clutter.KEY_Down);
        assert(global.stage.get_key_focus() === bar.page.items[0].button, 'Down from search must enter results');
        const firstApp = bar.page.items.find(item => !item.window);
        firstApp.button.grab_key_focus();
        await pressKey(navKeyboard, Clutter.KEY_Right);
        const nextApp = bar.page.items.filter(item => !item.window)[1];
        assert(global.stage.get_key_focus() === nextApp.button, 'Right must advance within an app row');
        await pressKey(navKeyboard, Clutter.KEY_Left);
        assert(global.stage.get_key_focus() === firstApp.button, 'Left must return to the previous app');
        await pressKey(navKeyboard, Clutter.KEY_Down);
        const belowApp = bar.page.rows[firstApp.row + 1][0];
        assert(global.stage.get_key_focus() === belowApp.button, 'Down must move to the next app row');
        await pressKey(navKeyboard, Clutter.KEY_Up);
        assert(global.stage.get_key_focus() === firstApp.button, 'Up must return to the previous app row');
        bar.page.search.grab_key_focus();
        await pressKey(navKeyboard, Clutter.KEY_Up);
        const lastResult = bar.page.items.at(-1).button;
        assert(global.stage.get_key_focus() === lastResult && bar.page.scroll.vadjustment.value > 0,
            'Up from search must reveal and focus the last result');
        const [, resultY] = lastResult.get_transformed_position();
        const [, viewY] = bar.page.scroll.get_transformed_position();
        assert(resultY >= viewY - 1 && resultY + lastResult.height <= viewY + bar.page.scroll.height + 1,
            'keyboard selection must scroll the whole focused result into view');
        await pressKey(navKeyboard, Clutter.KEY_Tab);
        assert(global.stage.get_key_focus() === bar.page.settingsLink, 'Tab from the last result must reach the settings footer');
        await pressKey(navKeyboard, Clutter.KEY_space);
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'footer keyboard opens settings modal');
        assert(bar.page === linkedPage && !Main.panel.statusArea[uuid],
            'keyboard activation of the settings link must open the separate settings modal');
        ext._closeSettings();
        linkedPage.settingsLink.grab_key_focus();
        await pressKey(navKeyboard, Clutter.KEY_Tab);
        assert(inSearch(), 'Tab from the last result must cycle back to search');
        checks.push('bottom-left New tab settings link opens shared settings with pointer or keyboard and participates in Tab navigation');
        await pressKey(navKeyboard, Clutter.KEY_Down);
        assert(bar.page.scroll.vadjustment.value === 0, 'returning to the first result must reveal the top of the list');
        await pressKey(navKeyboard, Clutter.KEY_Up);
        assert(inSearch(), 'Up from the first result must return to search');
        checks.push('real Tab, Shift+Tab, and arrow keys navigate both result sections and scroll focused items into view');
        firstApp.button.grab_key_focus();
        const focusedAppId = firstApp.app.get_id();
        large.move_resize_frame(true, 80, 140, 620, bigSize.height);
        await until(() => bar.page.items.some(item => !item.window && item.app.get_id() === focusedAppId &&
            item.button !== firstApp.button && item.button.has_key_focus()), 'focus survives a grid rebuild');
        bar.page.search.grab_key_focus();
        bar.page.search.text = 'abc';
        bar.page.search.clutter_text.set_selection(2, 2);
        await pressKey(navKeyboard, Clutter.KEY_Left);
        assert(inSearch() && bar.page.search.clutter_text.get_cursor_position() === 1,
            'Left in search must edit the cursor rather than leave the entry');
        await pressKey(navKeyboard, Clutter.KEY_Right);
        assert(bar.page.search.clutter_text.get_cursor_position() === 2, 'Right in search must preserve text editing');
        bar.page.search.text = '';
        large.move_resize_frame(true, 80, 140, bigSize.width, bigSize.height);
        await until(() => bar.page.actor.width === bigSize.width, 'restore page width after keyboard resize check');
        await delay(100);
        checks.push('search retains cursor editing and keyboard focus survives responsive grid rebuilds');
        await screenshot('-new-tab');
        await moveHandle(pointer, bar.moveHandle, 24, 18);
        assert(bar.page && bar.page.actor.x === large.get_frame_rect().x && bar.page.actor.y === large.get_frame_rect().y,
            'native move handle must move the page along with its group');
        large.maximize();
        await delay();
        assert(bar.page.actor.width === large.get_frame_rect().width && bar.page.actor.y === large.get_frame_rect().y,
            'maximized new tab page must remain below the tab strip in the viewport');
        const rows = bar.page.appsGrid.get_children();
        assert(rows.length > 0 && rows.every(row => row.get_n_children() <= 8) &&
            rows[0].get_n_children() === Math.min(8, bar.page.items.filter(item => !item.window).length),
            'wide new-window grids must wrap after at most eight applications');
        const [gridX] = bar.page.appsGrid.get_transformed_position();
        const [sectionX] = bar.page.appsSection.get_transformed_position();
        assert(Math.abs(gridX + bar.page.appsGrid.width / 2 - sectionX - bar.page.appsSection.width / 2) <= 2,
            'the app grid must be centered within the page section');
        await screenshot('-app-grid');
        checks.push('maximized app grids use at most eight columns and remain centered');
        appearance.set_string('color-scheme', 'prefer-dark');
        await until(() => bar.page.actor.has_style_class_name('dark'), 'new tab page follows dark appearance');
        appearance.set_string('color-scheme', 'default');
        large.unmaximize();
        await delay();
        large.move_frame(true, 80, 140);
        await delay(100);
        checks.push('new tab follows native group movement, maximization, and live system appearance');
        bar.page.search.text = 'zzzz-no-application-match';
        await delay(100);
        assert(bar.page.items.length === 0 && bar.page.status.text === 'No matches found.', 'app search must filter results');
        bar.page.search.text = 'Universal Tabs Launcher Test';
        await delay(100);
        assert(bar.page.items.length === 1, 'grid must show and search a real installed desktop app');
        const appButton = bar.page.items[0].button;
        await hover(pointer, appButton);
        assert(appButton.get_child().get_last_child().clutter_text.get_layout().is_ellipsized() &&
            ext._tooltipActor?.visible && ext._tooltipActor.text.includes('Universal Tabs Launcher Test'),
            'a clipped app name must have a tooltip with its full title');
        bar.page.search.text = 'zzzz-no-application-match';
        await delay(100);
        assert(!ext._tooltipActor.visible && !ext._tooltipTimer, 'destroying a filtered-out item must dismiss its tooltip and timer');
        bar.page.search.text = 'Universal Tabs Launcher Test';
        await delay(100);
        checks.push('full app-name tooltips dismiss safely when search rebuilds the grid');
        bar.page.search.grab_key_focus();
        bar.page.search.text = '';
        for (const character of 'universal tabs launcher test') {
            navKeyboard.notify_keyval(GLib.get_monotonic_time(), character.codePointAt(0), Clutter.KeyState.PRESSED);
            navKeyboard.notify_keyval(GLib.get_monotonic_time(), character.codePointAt(0), Clutter.KeyState.RELEASED);
        }
        await until(() => bar.page.search.text === 'universal tabs launcher test' && bar.page.items.length === 1,
            'real typing filters launcher results');
        const launchPage = bar.page;
        const launchPositions = [launchPage.search, launchPage.results, launchPage.appsGrid]
            .map(actor => actor.get_transformed_position());
        await pressKey(navKeyboard, Clutter.KEY_Tab);
        assert(global.stage.get_key_focus() === bar.page.items[0].button,
            `filtered app must be reachable with Tab: focus=${global.stage.get_key_focus()}`);
        await pressKey(navKeyboard, Clutter.KEY_Return);
        assert(bar.page?.pending, 'launch must wait for a matching new application window');
        assert(bar.page.status.visible && bar.page.status.text.startsWith('Opening '),
            'launch progress must remain visible in the page header');
        assert([bar.page.search, bar.page.results, bar.page.appsGrid].every((actor, index) => {
            const [x, y] = actor.get_transformed_position();
            return Math.abs(x - launchPositions[index][0]) <= 1 && Math.abs(y - launchPositions[index][1]) <= 1;
        }), 'showing launch progress must not move the search, window list, or application grid');
        checks.push('launch feedback stays in the header without shifting page content');
        windowActions.activate_action('extra', null);
        await until(() => find('UT Launched') && ext._model.windows.get(find('UT Launched'))?.group === group,
            'launched app joins intended group');
        const launched = find('UT Launched');
        await until(() => launched.get_frame_rect().width === ext._model.rect(launched).width,
            'launched app configured to shared viewport');
        assert(!bar.page && group.active === launched && launched.get_frame_rect().width === large.get_frame_rect().width,
            `launch must close the page and adopt the existing group viewport: page=${!!bar.page}, active=${group.active.get_title()}, width=${launched.get_frame_rect().width}, anchor=${large.get_frame_rect().width}, model=${ext._model.rect(launched).width}`);
        await until(() => find('UT Extra') && ext._model.windows.has(find('UT Extra')), 'unrelated window mapped');
        assert(ext._model.windows.get(find('UT Extra')).group !== group,
            'launch association must not capture an unrelated newly opened window');
        checks.push('new tab app grid searches desktop apps and joins only the matching launched Wayland window');
        launched.delete(global.get_current_time());
        ext._select(large);
        await delay();
        await clickTab(pointer, bar.plus);
        assert(bar.page.items.some(item => item.window === find('UT Extra')), 'Open windows must list eligible other windows');
        assert(!bar.page.items.some(item => group.members.includes(item.window)), 'Open windows must exclude current members');
        bar.page.search.text = 'UT Extra';
        bar.page.search.grab_key_focus();
        await delay(100);
        await pressKey(navKeyboard, Clutter.KEY_Down);
        assert(global.stage.get_key_focus() === bar.page.items.find(item => item.window === find('UT Extra')).button,
            'filtered open window must be reachable with Down');
        await pressKey(navKeyboard, Clutter.KEY_Return);
        assert(!bar.page && ext._model.windows.get(find('UT Extra')).group === group,
            'choosing an open window must add it to the group and close the page');
        find('UT Extra').delete(global.get_current_time());
        ext._select(large);
        await delay();
        await clickTab(pointer, bar.plus);
        await clickTab(pointer, bar.buttons.find(item => item.window === large).button);
        assert(!bar.page && group.active === large, 'selecting an existing tab must dismiss New tab without closing a window');
        checks.push('new tab Open windows adds a chosen window and existing tabs dismiss the page safely');
        const notices = [];
        const noticeSources = new Map();
        const watchNotices = source => {
            if (noticeSources.has(source))
                return;
            const added = source.connect('notification-added', (_source, notification) => {
                if (!notification.title.endsWith(' opened separately'))
                    return;
                notices.push({title: notification.title, body: notification.body});
                // Exercise the real notification path, then dismiss its banner
                // before it can obstruct subsequent pointer checks.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!notification._destroyed)
                        notification.destroy();
                    return GLib.SOURCE_REMOVE;
                });
            });
            const destroyed = source.connect('destroy', () => noticeSources.delete(source));
            noticeSources.set(source, [added, destroyed]);
        };
        const noticeSourceAdded = Main.messageTray.connect('source-added', (_tray, source) => watchNotices(source));
        watchNotices(MessageTray.getSystemSource());
        try {
            for (const [name, title] of [['UniversalTabsLegacy', 'UT Separate'],
                ['Universal Tabs Fullscreen Test', 'UT Fullscreen']]) {
                const members = [...group.members];
                await clickTab(pointer, bar.plus);
                bar.page.search.text = name;
                await delay(100);
                assert(bar.page.items.length === 1, 'separate-window fixture must be searchable');
                if (title === 'UT Separate')
                    await pressKey(navKeyboard, Clutter.KEY_Return);
                else
                    await clickTab(pointer, bar.page.items[0].button);
                if (title === 'UT Separate') {
                    windowActions.activate_action('unrelated', null);
                    await until(() => find('UniversalTabsLegacy2Disk')?.mapped, 'unrelated lookalike window mapped');
                    assert(bar.page?.pending && notices.length === 0,
                        'a similar title in an unrelated app must not end a launch request');
                }
                await until(() => find(title)?.mapped && !bar.page, 'separate window noted and new-tab page dismissed');
                const separateWindow = find(title);
                assert(ext._model.windows.get(separateWindow)?.group !== group &&
                    group.members.length === members.length && group.members.every((window, index) => window === members[index]),
                    'an external result must leave the original tab group unchanged');
                assert(notices.at(-1)?.title === `${name} opened separately`,
                    'a separate result must display an explicit notification');
                if (title === 'UT Separate') {
                    assert(ext._tracker.get_window_app(separateWindow).is_window_backed(),
                        'legacy fixture must reproduce a window GNOME cannot associate with its desktop launcher');
                    find('UniversalTabsLegacy2Disk').delete(global.get_current_time());
                } else {
                    assert(separateWindow.is_fullscreen(), 'fullscreen launch must remain native and outside the group');
                }
                separateWindow.delete(global.get_current_time());
                ext._select(large);
                await delay();
            }
        } finally {
            Main.messageTray.disconnect(noticeSourceAdded);
            for (const [source, ids] of noticeSources)
                ids.forEach(id => source.disconnect(id));
        }
        checks.push('legacy backend handoffs close New tab and announce a separate window without claiming title lookalikes');
        checks.push('fullscreen launch results remain separate and dismiss New tab with a notification');
        await clickTab(pointer, bar.plus);
        await wheel(pointer, bar.page.tab.get_first_child(), Clutter.ScrollDirection.UP);
        assert(!bar.page && group.active === group.members.at(-1),
            `wheel up from New tab must return to the last application tab: page=${!!bar.page}, active=${group.active.get_title()}, expected=${group.members.at(-1).get_title()}`);
        ext._select(large);
        await delay(100);
        checks.push('wheel switching also works from New tab and keeps overflow selections visible');
        await clickTab(pointer, bar.plus);
        const keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await until(() => !bar.page, 'Escape closes the new tab page');
        assert(ext._model.windows.has(large) && group.active === large, 'Escape must preserve the native app');
        await clickTab(pointer, bar.plus);
        await clickTab(pointer, bar.page.tab.get_last_child());
        assert(!bar.page && ext._model.windows.has(large), 'new-tab close button must close only the virtual page');
        checks.push('Escape and the new-tab close button return to the app without closing a window');
        large.maximize();
        await delay();
        windowActions.activate_action('fixed', null);
        await until(() => find('UT Fixed') && ext._model.windows.has(find('UT Fixed')), 'fixed-size client mapped');
        const fixed = find('UT Fixed');
        ext._join(fixed, group);
        await delay();
        assert(fixed.get_frame_rect().width < bigSize.width && ext._model.rect(fixed).width === fixed.get_frame_rect().width,
            'window size limits must shrink the shared viewport');
        assert(!group.maximized, 'a window that cannot maximize must restore the group to its supported size');
        ext._select(large);
        await delay();
        assert(large.get_frame_rect().width === fixed.get_frame_rect().width,
            'other tabs must retain the viewport allowed by the fixed-size window');
        await clickTab(pointer, bar.buttons.find(item => item.window === fixed).close);
        await until(() => !ext._model.windows.has(fixed), 'fixed client closed');
        large.move_resize_frame(true, 80, 140, bigSize.width, bigSize.height);
        await delay();
        checks.push('only native window size limits shrink the incoming shared viewport');
        await clickTab(pointer, bar.minimize);
        assert(large.minimized && small.minimized && !bar.actor.visible, 'minimize control must minimize the group');
        ext._select(large);
        await delay();
        checks.push('left minimize control minimizes the group and activation restores it');

        // Exercise GNOME's actual mode-driven disable/enable lifecycle without
        // authenticating or touching the user's real desktop lock screen.
        const lockCycle = async duringLock => {
            const retired = ext;
            Main.sessionMode.pushMode('unlock-dialog');
            await until(() => !bootstrap.runtime && !retired._model, 'GNOME disables extension in locked mode');
            assert(typeof bootstrap._universalTabsLockSnapshot === 'string' &&
                retired._bars.size === 0 && retired._sources.size === 0 && !retired._tooltipActor &&
                !retired._settingsDialog && retired._settingsSwitches.size === 0,
                'lock teardown must retain only serialized state and remove UI, hooks, and timers');
            if (duringLock)
                await duringLock();
            Main.sessionMode.popMode('unlock-dialog');
            await until(() => bootstrap.runtime?._model, 'GNOME re-enables extension after unlock');
            ext = bootstrap.runtime;
            group = ext._model.windows.get(large).group;
            await until(() => ext._bars.has(group), 'restored group strip');
            bar = ext._bars.get(group);
            await delay();
            assert(manual.minimized, 'lock recovery must preserve independently minimized windows');
        };
        const beforeLock = {...ext._model.rect(large)};
        const orderBeforeLock = [...group.members];
        ext._setHideMoveBar(true);
        const beforeSettingsLock = Main.modalCount;
        ext._openSettings();
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'settings modal opened before locking');
        await lockCycle();
        assert(ext._model.windows.get(small).group === group && group.active === large &&
            group.members.every((window, index) => window === orderBeforeLock[index]),
            'unlock must restore group membership, order, and selected tab');
        assert(group.x === beforeLock.x && group.y === beforeLock.y && group.width === beforeLock.width &&
            group.height === beforeLock.height && !large.minimized && small.minimized,
            'unlock must restore normal viewport, position, and inactive window visibility');
        assert(ext._preferences.hideMoveBar && !bar.moveHandle.visible && !ext._settingsDialog &&
            ext._settingsSwitches.size === 0 && Main.modalCount === beforeSettingsLock,
            'locking must retain the saved setting while destroying the settings modal and releasing its input grab');
        ext._setHideMoveBar(false);
        await until(() => bar.moveHandle.visible, 'move bar restored after lock settings test');
        checks.push('saved move-bar preference survives the GNOME lock/unlock lifecycle');
        checks.push('normal lock/unlock restores groups, tab order, active tab, viewport, and user-minimized windows');
        large.maximize();
        await delay();
        await lockCycle();
        assert(ext._model.windows.get(small).group === group && group.active === large &&
            group.maximized && large.is_maximized() && group.width === beforeLock.width &&
            large.get_frame_rect().y === large.get_work_area_current_monitor().y + 30,
            'maximized group must survive repeated lock/unlock with native tab space and normal restore size');
        checks.push('maximized groups survive repeated lock/unlock with correct reserved tab space');
        large.unmaximize();
        await delay();

        const source = Gio.File.new_for_path(GLib.getenv('UT_TEST_SOURCE'));
        const decoder = new TextDecoder();
        const read = name => decoder.decode(source.get_child(name).load_contents(null)[1]);
        const write = (name, text) => source.get_child(name).replace_contents(text, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        const original = read('runtime.js');
        windowActions.activate_action('extra', null);
        await until(() => find('UT Extra')?.mapped && ext._model.windows.has(find('UT Extra')), 'lock-close test window mapped');
        const closedWhileLocked = find('UT Extra');
        ext._join(closedWhileLocked, group);
        closedWhileLocked.move_resize_frame(true, 80, 140, 620, 360);
        await delay();
        let openedWhileLocked;
        await lockCycle(async () => {
            closedWhileLocked.delete(global.get_current_time());
            await until(() => !global.get_window_actors().some(actor => actor.meta_window === closedWhileLocked),
                'window closes while extension is inactive');
            windowActions.activate_action('extra', null);
            await until(() => find('UT Extra')?.mapped, 'new window maps while extension is inactive');
            openedWhileLocked = find('UT Extra');
            write('runtime.js', original + '\n// Runtime published while locked\n');
        });
        assert(!ext._model.windows.has(closedWhileLocked) && ext._model.windows.get(small).group === group &&
            group.members.length === 2 && group.members.includes(group.active) &&
            group.active.get_frame_rect().width === 620 && group.active.get_frame_rect().height === 360,
            'unlock must omit closed members and resize the surviving active tab to the saved viewport');
        assert(ext._model.windows.get(openedWhileLocked).group !== group && !bootstrap._lastError,
            'unlock must load the current runtime and leave newly opened windows independent');
        checks.push('unlock after an update handles closed active tabs and windows opened while locked');
        openedWhileLocked.delete(global.get_current_time());
        ext._select(large);
        await until(() => large.get_frame_rect().width === 620 && large.get_frame_rect().height === 360,
            'selected app acknowledges the recovered viewport');
        large.move_resize_frame(true, 80, 140, bigSize.width, bigSize.height);
        await until(() => group.width === bigSize.width && large.get_frame_rect().width === bigSize.width,
            'normal viewport reset before runtime update checks');
        large.maximize();
        await delay();
        const updated = original + '\nUniversalTabs.prototype.revisionMarker = "runtime-updated";\n';
        const previous = ext;
        bar = ext._bars.get(group);
        ext._openNewTab(bar, group);
        // Exercise the same pending-launch cleanup with no external side effect.
        ext._launchApp(bar, group, {get_windows: () => [], can_open_new_window: () => true,
            get_id: () => 'never-mapped-test.desktop', get_name: () => 'Pending launch test', open_new_window() {}});
        let pageDestroyed = false;
        bar.page.actor.connect('destroy', () => { pageDestroyed = true; });
        await hover(pointer, bar.plus);
        assert(ext._tooltipActor?.visible, 'tooltip must be visible before runtime-update cleanup');
        let tooltipDestroyed = false;
        ext._tooltipActor.connect('destroy', () => { tooltipDestroyed = true; });
        const beforeContextUpdate = Main.modalCount;
        await clickTab(pointer, ext._bars.get(group).buttons.find(item => item.window === small).button,
            Clutter.BUTTON_SECONDARY);
        assert(ext._bars.get(group).contextMenu?.isOpen, 'context menu must be open before update');
        await clickTab(pointer, settingsIn(ext._bars.get(group).contextMenu));
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'settings modal opened before update');
        await clickTab(pointer, settingSwitch('hideMoveBar'));
        const retiredSettingsDialog = ext._settingsDialog;
        let settingsDestroyed = false;
        retiredSettingsDialog.dialogLayout.connect('destroy', () => { settingsDestroyed = true; });
        write('groups.js', read('groups.js') + '\nGroups.prototype.revisionMarker = "dependency-updated";\n');
        write('runtime.css', read('runtime.css') + '\n.universal-tabs-tab { padding-left: 17px; }\n');
        write('runtime.js', updated);
        await until(() => bootstrap.runtime !== previous && bootstrap.runtime?.revisionMarker,
            'live source update loaded');
        ext = bootstrap.runtime;
        await delay();
        assert(Main.modalCount === beforeContextUpdate, 'live update must release the settings modal input grab');
        assert([...ext._bars.values()].every(current => !current.contextMenu), 'update must leave no stale context menus');
        assert(ext._preferences.hideMoveBar && !ext._settingsDialog && settingsDestroyed &&
            !previous._settingsDialog && previous._settingsSwitches.size === 0,
            'live updates must retain settings and destroy the retired modal and all settings switches');
        ext._setHideMoveBar(false);
        checks.push('live update preserves settings and destroys an open settings modal without retaining controls or input grabs');
        checks.push('live update closes context menus and releases their input grab');
        assert(pageDestroyed && previous._sources.size === 0 && [...ext._bars.values()].every(current => !current.page),
            'runtime update must destroy the new-tab page and cancel pending launch timers');
        checks.push('runtime update cleans the new-tab page and pending launch association while keeping app tabs');
        assert(tooltipDestroyed && !previous._tooltipActor, 'runtime update must remove its old tooltip actor');
        assert(ext._model.revisionMarker === 'dependency-updated', 'relative dependency must reload too');
        assert(ext._model.windows.get(large).group === ext._model.windows.get(small).group,
            'update must retain group membership');
        assert(ext._model.windows.get(large).group.active === large, 'update must preserve active tab');
        assert(ext._model.rect(small).width === bigSize.width,
            `update must preserve shared viewport: actual=${ext._model.rect(small).width}, expected=${bigSize.width}`);
        assert(ext._model.windows.get(large).group.maximized && large.is_maximized(),
            'live update must preserve maximized group state');
        const tab = ext._bars.get(ext._model.windows.get(large).group).buttons[0].container;
        assert(tab.get_theme_node().get_padding(St.Side.LEFT) === 17, 'CSS must reload too');
        checks.push('live edits reload runtime, relative modules, and CSS while preserving groups and sizes');

        write('runtime.js', updated + '\nfunction broken( {\n');
        await until(() => bootstrap._lastError, 'syntax error rejected');
        assert(bootstrap.runtime === ext, 'syntax errors must keep the existing runtime running');
        checks.push('syntax error leaves the last working runtime running');
        write('runtime.js', updated + '\nconst realEnable = UniversalTabs.prototype.enable;\n' +
            'UniversalTabs.prototype.enable = function(state) { realEnable.call(this, state); throw new Error("intentional enable failure"); };\n');
        await until(() => bootstrap._lastError?.includes('intentional enable failure'), 'failed enable rolled back');
        ext = bootstrap.runtime;
        assert(ext?._model.windows.get(large).group === ext?._model.windows.get(small).group,
            'rollback must preserve the group');
        assert(!large.minimized && small.minimized, 'rollback must restore active and hidden members');
        checks.push('failed enable cleans up and rolls back with group state intact');
        write('runtime.js', updated + '\n// recovered source\n');
        await until(() => !bootstrap._lastError, 'fixed source loaded');
        ext = bootstrap.runtime;
        checks.push('saving fixed source recovers automatically');

        await doubleClick(pointer, ext._bars.get(ext._model.windows.get(large).group).buttons.find(item => item.window === large).button);
        assert(!large.is_maximized() && large.get_frame_rect().width === bigSize.width,
            'updated runtime must retain native restore behavior');
        // Keep the next pointer test clear of deliberate update-error banners.
        large.move_frame(true, 80, 250);
        await delay();

        const baselineModals = Main.modalCount;
        const dragged = ext._bars.get(ext._model.windows.get(large).group).buttons.find(item => item.window === large).button;
        const [dragX, dragY] = dragged.get_transformed_position();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), dragX + 30, dragY + 15);
        await delay(100);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await delay(100);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), dragX + 60, dragY + 15);
        await delay(200);
        assert(ext._drag, 'drag must be in progress before update');
        const draggingRuntime = ext;
        write('runtime.js', updated + '\n// update during drag\n');
        await until(() => bootstrap.runtime !== draggingRuntime && !bootstrap._lastError, 'update during drag');
        ext = bootstrap.runtime;
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await delay(300);
        assert(Main.modalCount === baselineModals && !ext._drag, 'update must release the old drag input grab');
        assert(global.window_group.get_children().filter(actor => actor._universalTabsGroup).length === ext._bars.size,
            'old runtime must leave no duplicate tab strips');
        checks.push('updating during a drag releases input and leaves no duplicate tabs');
        const actions = Gio.DBusActionGroup.get(Gio.DBus.session,
            'org.gnome.Extensions.UniversalTabsTest', '/org/gnome/Extensions/UniversalTabsTest');
        await delay();
        actions.activate_action('dialog', null);
        await until(() => find('UT Dialog'), 'modal opened');
        assert(!ext._model.windows.has(find('UT Dialog')), 'modal must stay outside tab groups');
        checks.push('modal receives no tab and stays outside group membership');
        find('UT Dialog').delete(global.get_current_time());
        await delay();

        actions.activate_action('extra', null);
        await until(() => find('UT Extra') && ext._model.windows.has(find('UT Extra')), 'close test window mapped');
        const extra = find('UT Extra');
        ext._join(extra, ext._model.windows.get(large).group);
        ext._select(large);
        await delay();
        group = ext._model.windows.get(large).group;
        bar = ext._bars.get(group);
        await clickTab(pointer, bar.buttons.find(item => item.window === extra).close);
        await until(() => !ext._model.windows.has(extra), 'inactive tab close button');
        assert(group.active === large && !large.minimized, 'closing an inactive tab must not activate or close a neighbor');
        checks.push('per-tab close button closes an inactive window without switching tabs');
        const smallTab = ext._bars.get(ext._model.windows.get(small).group).buttons.find(item => item.window === small).button;
        await dragTab(pointer, smallTab, {get_transformed_position: () => [1000, 650]});
        assert(!small.minimized && !large.minimized, 'detach must reveal both independent windows');
        assert(ext._model.windows.get(small).group !== ext._model.windows.get(large).group,
            'drag outside a strip must detach the window');
        checks.push('real pointer drag detaches into independent windows');
        ext._join(small, ext._model.windows.get(large).group);
        await delay();
        await delay();
        await clickTab(pointer, ext._bars.get(ext._model.windows.get(small).group).buttons.find(item => item.window === small).close);
        await until(() => !ext._model.windows.has(small), 'closed tab removed');
        await delay();
        assert(!large.minimized, 'closing active tab must reveal a surviving member');
        checks.push('individual tab close button closes the active window and reveals the surviving tab');
        // Restore a group with a hidden member for disable recovery.
        manual.unminimize();
        ext._join(manual, ext._model.windows.get(large).group);
        await delay();
        Main.extensionManager.disableExtension('universal-tabs@extensions.local');
        await until(() => !ext._model, 'extension disabled');
        assert(!large.minimized, 'disable must reveal extension-hidden window');
        assert(wmSettings.get_string('button-layout') === originalControls && !controlsBackup.query_exists(null),
            'normal disable must restore the original customized button layout and clear recovery data');
        await inspectControls(false);
        checks.push('disabling restores actual GTK window controls and the saved customized layout');
        assert(!bootstrap._universalTabsLockSnapshot, 'explicit disable must clear retained lock state');
        checks.push('disable restores extension-hidden windows');
        // Re-enable with a window minimized by the user, then disable again.
        manual.minimize();
        const nativeRestore = large.get_frame_rect();
        assert(Main.wm._prepareAnimationInfo === this._animationProbe, 'disable must restore the existing animation handler');
        observed = prepared.length;
        large.maximize();
        await delay();
        assert(prepared.slice(observed).includes(Meta.SizeChange.MAXIMIZE), 'native animation preparation must return when disabled');
        checks.push('disable restores the previous maximize animation handler');
        Main.extensionManager.enableExtension('universal-tabs@extensions.local');
        await until(() => bootstrap.runtime?._model, 'extension re-enabled');
        ext = bootstrap.runtime;
        await delay();
        assert(large.get_frame_rect().y === large.get_work_area_current_monitor().y + 30,
            'windows maximized before enabling must also reserve tab space');
        large.unmaximize();
        await delay();
        assert(large.get_frame_rect().width === nativeRestore.width && large.get_frame_rect().height === nativeRestore.height,
            'window already maximized before enabling must retain native restore size');
        checks.push('already-maximized windows gain tab space and retain their native restore rectangle');
        large.maximize();
        await delay();
        Main.extensionManager.disableExtension('universal-tabs@extensions.local');
        await until(() => !ext._model, 'extension disabled again');
        await delay();
        assert(large.is_maximized() && large.get_frame_rect().y === large.get_work_area_current_monitor().y,
            'disable must remove reserved space and preserve native maximization');
        checks.push('disable removes per-window tab constraints and restores normal maximized bounds');
        assert(manual.minimized, 'disable must preserve user-minimized state');
        checks.push('re-enable is clean and preserves user-minimized windows');

        write('runtime.js', updated + '\nfunction invalidOnNextEnable( {\n');
        Main.extensionManager.enableExtension('universal-tabs@extensions.local');
        await until(() => bootstrap.runtime?._model && bootstrap._lastError, 'persisted working revision recovered');
        ext = bootstrap.runtime;
        assert(ext.revisionMarker === 'runtime-updated', 'startup with bad source must recover the saved good revision');
        checks.push('last working revision also recovers after disable/re-enable with broken source');

        // Migrate the old development install to an isolated published revision.
        const manifest = bootstrap.dir.get_child('runtime.json');
        manifest.replace_contents(JSON.stringify({revision: bootstrap._loaded.revision}), null,
            false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await delay(700);
        const isolatedRuntime = bootstrap.runtime;
        write('runtime.js', updated + '\n// unpublished edit\n');
        await delay(800);
        assert(bootstrap.runtime === isolatedRuntime, 'source edits must not replace an isolated installed runtime');
        checks.push('detaching the source link prevents project edits from changing the running extension');
        const names = ['runtime.js', 'groups.js', 'runtime.css'];
        const contents = names.map(read);
        const revision = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
            JSON.stringify(contents), -1).slice(0, 20);
        const candidate = bootstrap.dir.get_child('revisions').get_child(revision);
        if (!candidate.query_exists(null))
            candidate.make_directory_with_parents(null);
        names.forEach((name, index) => candidate.get_child(name).replace_contents(contents[index],
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null));
        manifest.replace_contents(JSON.stringify({revision}), null,
            false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        await until(() => bootstrap.runtime !== isolatedRuntime && bootstrap._loaded?.revision === revision,
            'explicitly published revision loaded');
        assert(!bootstrap._lastError, 'published update must load without errors');
        checks.push('explicit publication updates the installed runtime without a session restart');
        ext = await runSettingsChecks({bootstrap, manager, uuid, large, manual, windowActions, pointer,
            prepared, checks, inspectControls, originalControls, wmSettings, controlsBackup,
            assert, until, delay, clickTab, wheel, assertStillRestore, screenshot});
        const disableControlsTest = async () => {
            manager.disableExtension(uuid);
            await until(() => !bootstrap.runtime, 'disable for window-control recovery');
        };
        const enableControlsTest = async () => {
            manager.enableExtension(uuid);
            await until(() => bootstrap.runtime?._model, 'enable for window-control recovery');
        };
        const overrideControls = 'maximize:close,minimize';
        wmSettings.set_string('button-layout', overrideControls);
        await disableControlsTest();
        assert(wmSettings.get_string('button-layout') === overrideControls,
            'disable must preserve a newer layout written by the user or another extension');
        controlsBackup.replace_contents(JSON.stringify({version: 1, previousUser: overrideControls, applied: ':'}),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        wmSettings.set_string('button-layout', ':');
        await enableControlsTest();
        await disableControlsTest();
        assert(wmSettings.get_string('button-layout') === overrideControls && !controlsBackup.query_exists(null),
            'saved recovery state must retain the original layout after an interrupted session');
        checks.push('window-control recovery preserves other layout changes and recovers the pre-crash preference');
        wmSettings.reset('button-layout');
        await enableControlsTest();
        await disableControlsTest();
        assert(wmSettings.get_user_value('button-layout') === null,
            'a previously unset button-layout preference must remain unset after disable');
        wmSettings.set_string('button-layout', ':appmenu');
        await enableControlsTest();
        await disableControlsTest();
        assert(wmSettings.get_string('button-layout') === ':appmenu' && !controlsBackup.query_exists(null),
            'a user layout with no window controls must be left alone');
        checks.push('window-control cleanup preserves unset defaults and layouts already hiding buttons');
        this._finish({ok: true, checks});
    }

    async _finish(result) {
        GLib.file_set_contents(GLib.getenv('UT_TEST_RESULT'), JSON.stringify(result, null, 2));
        Main.extensionManager.disableExtension('universal-tabs@extensions.local');
        await delay(300);
        if (this._controlsSignal)
            this._testWmSettings.disconnect(this._controlsSignal);
        this._settingsPortal?.unexport();
        if (this._settingsPortalName)
            Gio.bus_unown_name(this._settingsPortalName);
        if (Main.wm._prepareAnimationInfo === this._animationProbe)
            Main.wm._prepareAnimationInfo = this._animationProbeOriginal;
        this._client?.force_exit();
        global.context.terminate();
    }

    disable() {}
}

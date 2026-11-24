import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Runs on the private compositor after bootstrap publication tests have finished.
export async function runSettingsChecks({bootstrap, manager, uuid, large, manual, windowActions,
    pointer, prepared, checks, inspectControls, originalControls, wmSettings, controlsBackup,
    assert, until, delay, clickTab, wheel, assertStillRestore, screenshot}) {
    let ext = bootstrap.runtime;
    let checkedAppearance = false;
    const find = title => global.get_window_actors().map(actor => actor.meta_window)
        .find(window => window.get_title() === title);
    const findItem = (menu, label) => menu._getMenuItems().find(item => item.label?.text === label);
    const openSettings = async () => {
        if (!ext._settingsDialog) {
            const group = ext._model.windows.get(large)?.group;
            const bar = ext._bars.get(group);
            if (bar?.actor.visible) {
                await clickTab(pointer, bar.buttons.find(item => item.window === group.active).button,
                    Clutter.BUTTON_SECONDARY);
                await until(() => bar.contextMenu?.isOpen, 'tab context menu opened for settings');
                const settings = findItem(bar.contextMenu, `${bootstrap.metadata.name} Settings`);
                assert(settings && !settings.menu, 'tab context menu must expose a settings action instead of inline controls');
                await clickTab(pointer, settings);
            } else {
                ext._openSettings();
            }
        }
        await until(() => ext._settingsDialog?.dialogLayout.mapped, 'separate settings modal opened for expanded options');
        if (!checkedAppearance) {
            const appearance = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const original = appearance.get_string('color-scheme');
            const surface = ext._settingsDialog.contentLayout.get_parent();
            appearance.set_string('color-scheme', 'default');
            await until(() => surface.get_theme_node().get_background_color().red >= 245 &&
                surface.get_theme_node().get_foreground_color().red < 70, 'settings dialog uses light system appearance');
            await screenshot('-settings');
            appearance.set_string('color-scheme', 'prefer-dark');
            await until(() => surface.get_theme_node().get_background_color().red <= 40 &&
                surface.get_theme_node().get_foreground_color().red >= 230, 'settings dialog switches to dark system appearance live');
            appearance.set_string('color-scheme', original);
            checkedAppearance = true;
            checks.push('standalone settings dialog follows system light/dark appearance live with readable native controls');
        }
        assert(!Main.panel.statusArea[uuid] && [...ext._bars.values()].every(bar => !bar.contextMenu?.isOpen),
            'opening settings must close source tab menus and never add a top-panel indicator');
        return ext._settingsDialog;
    };
    const toggle = async (label, key, expected) => {
        const dialog = await openSettings();
        const item = [...ext._settingsSwitches].find(control => control._settingKey === key && !control._appId);
        assert(item && item.label.text === label && item.state !== expected,
            `${label} must expose the current saved state in the dialog`);
        await clickTab(pointer, item);
        await until(() => ext._preferences[key] === expected, `${label} applied`);
        assert(ext._settingsDialog === dialog && dialog.dialogLayout.mapped,
            'changing a setting must leave its dialog open');
        ext._closeSettings();
        assert(!ext._settingsDialog && ext._settingsSwitches.size === 0,
            'closing settings must remove modal controls before testing native windows');
    };
    const saved = () => JSON.parse(new TextDecoder().decode(ext._preferencesFile.load_contents(null)[1]));
    const disable = async () => {
        manager.disableExtension(uuid);
        await until(() => !bootstrap.runtime, 'disable while testing saved settings');
    };
    const enable = async () => {
        manager.enableExtension(uuid);
        await until(() => bootstrap.runtime?._model, 'enable while testing saved settings');
        ext = bootstrap.runtime;
        await until(() => ext._bars.has(ext._model.windows.get(large)?.group), 'restored settings-test strip');
        await delay();
    };

    if (large.is_maximized()) {
        large.unmaximize();
        await delay();
    }
    ext._select(large);
    large.move_resize_frame(true, 60, 140, 1100, 500);
    await delay();
    await toggle('Hide native window buttons', 'hideNativeButtons', false);
    await inspectControls(false);
    assert(wmSettings.get_string('button-layout') === originalControls && !controlsBackup.query_exists(null),
        'turning native-button hiding off must restore the original customized desktop layout');
    await toggle('Hide native window buttons', 'hideNativeButtons', true);
    await inspectControls(true);
    assert(saved().hideNativeButtons && controlsBackup.query_exists(null),
        'turning native-button hiding back on must save the setting and original layout again');
    checks.push('settings modal toggles actual GTK controls off and on through real interaction while retaining recovery data');

    const beforeWindows = new Set(ext._model.windows.keys());
    windowActions.activate_action('extra', null);
    await until(() => [...ext._model.windows.keys()].some(window => !beforeWindows.has(window)),
        'extra window for expanded settings');
    const extra = [...ext._model.windows.keys()].find(window => !beforeWindows.has(window));
    await until(() => extra.mapped && extra.get_compositor_private()?.mapped, 'settings-test extra window mapped');
    let group = ext._model.windows.get(large).group;
    ext._join(extra, group);
    await until(() => extra.get_frame_rect().width === 1100, 'incoming settings-test window acknowledges the shared viewport');
    ext._select(large);
    await delay();
    let bar = ext._bars.get(group);

    const animationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const animationsBefore = animationSettings.get_boolean('enable-animations');
    animationSettings.set_boolean('enable-animations', true);
    await until(() => St.Settings.get().enable_animations, 'native animations enabled for settings');
    await toggle('Disable maximize/restore animations', 'disableAnimations', false);
    const actor = large.get_compositor_private();
    let observed = prepared.length;
    large.maximize();
    await until(() => prepared.slice(observed).includes(Meta.SizeChange.MAXIMIZE),
        'native maximize preparation restored by setting');
    assert(actor.__animationInfo || Main.wm._resizing.has(actor) || Main.wm._resizePending.has(actor),
        'allowing animations must leave the native maximize effect running instead of immediately completing it');
    await delay(450);
    observed = prepared.length;
    large.unmaximize();
    await until(() => prepared.slice(observed).includes(Meta.SizeChange.UNMAXIMIZE),
        'native restore preparation restored by setting');
    await delay(450);
    large.minimize();
    await delay(450);
    large.unminimize();
    await until(() => Main.wm._unminimizing.has(actor), 'ordinary minimized restore allowed by setting');
    await delay(450);
    await assertStillRestore(extra, () => ext._select(extra), 'tab switch with native animations allowed', [large]);
    await assertStillRestore(large, () => ext._select(large), 'returning tab with native animations allowed', [extra]);
    await toggle('Disable maximize/restore animations', 'disableAnimations', true);
    await assertStillRestore(large, () => large.maximize(), 'maximize suppression re-enabled by setting');
    await assertStillRestore(large, () => large.unmaximize(), 'restore suppression re-enabled by setting');
    animationSettings.set_boolean('enable-animations', animationsBefore);
    checks.push('animation setting restores native maximize, restore, and ordinary unminimize effects while tab switching stays instant');

    bar = ext._bars.get(group);
    await toggle('Scroll wheel switches tabs', 'scrollSwitchesTabs', false);
    const selected = group.active;
    const selectedIndex = group.members.indexOf(selected);
    const direction = selectedIndex < group.members.length - 1 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
    await wheel(pointer, bar.buttons.find(item => item.window === selected).button, direction);
    assert(group.active === selected, 'disabling wheel switching must leave the selected app tab unchanged');
    ext._openNewTab(bar, group);
    await delay();
    await wheel(pointer, bar.page.tab, Clutter.ScrollDirection.UP);
    assert(bar.page && group.active === selected, 'disabled wheel switching must also leave New tab open');
    ext._closeNewTab(bar);
    await toggle('Scroll wheel switches tabs', 'scrollSwitchesTabs', true);
    await wheel(pointer, bar.buttons.find(item => item.window === selected).button, direction);
    assert(group.active !== selected, 're-enabling wheel switching must restore switching immediately');
    ext._select(large);
    checks.push('wheel preference stops switching on both real tabs and New tab, then restores scrolling immediately');

    const widthDialog = await openSettings();
    assert(ext._settingsWidthDecrease && ext._settingsWidthIncrease && ext._settingsWidthLabel.text.includes('240'),
        'settings modal must expose the saved width and decrease/increase buttons');
    await clickTab(pointer, ext._settingsWidthDecrease);
    assert(ext._preferences.preferredTabWidth === 180,
        `decreasing preferred width must save the next step: preference=${ext._preferences.preferredTabWidth}`);
    assert(ext._settingsDialog === widthDialog && ext._settingsWidthLabel.text.includes('180'),
        'width changes must update the visible value without closing settings');
    ext._closeSettings();
    await delay(300);
    assert(bar.buttons.every(item => Math.abs(item.container.width - 180) <= 1),
        `preferred width applied to real tabs: cap=${ext._preferences.preferredTabWidth}, desired=${bar.tabWidth}, widths=${bar.buttons.map(item => item.container.width)}, visible=${bar.actor.visible}, frame=${JSON.stringify(large.get_frame_rect())}`);
    ext._openNewTab(bar, group);
    await delay();
    assert(Math.abs(bar.page.tab.width - 180) <= 1 && Math.abs(bar.moveHandle.width - 135) <= 2,
        'New tab and move handle must share the changed preferred tab width');
    ext._closeNewTab(bar);
    await openSettings();
    await clickTab(pointer, ext._settingsWidthIncrease);
    assert(ext._preferences.preferredTabWidth === 240 && ext._settingsWidthLabel.text.includes('240'),
        'increasing preferred width must restore and display the next step');
    ext._closeSettings();
    await until(() => bar.buttons.every(item => Math.abs(item.container.width - 240) <= 1), 'default tab width restored');
    checks.push('settings width buttons resize actual tabs and New tab while preserving the move handle ratio');

    large.maximize();
    await delay();
    const baseAppId = 'org.gnome.Extensions.UniversalTabsTest.desktop';
    assert(extra.minimized && ext._hidden.has(extra) && manual.minimized && !ext._hidden.has(manual),
        'exclusion test must distinguish extension-hidden and user-minimized windows');
    const exclusionDialog = await openSettings();
    const search = ext._settingsSearch;
    assert(search?.mapped && ext._settingsAppList,
        'settings modal must expose the searchable excluded-app chooser directly');
    search.text = 'Universal Tabs Window Test';
    await until(() => [...ext._settingsSwitches].some(item => item._appId === baseAppId), 'excluded app search filters the modal list');
    const choice = [...ext._settingsSwitches].find(item => item._appId === baseAppId);
    assert(choice && !choice.state, 'searching must show the installed fixture app as initially included');
    await until(() => choice.has_allocation() && choice.width > 0, 'filtered app row allocated');
    choice.grab_key_focus();
    await delay(150);
    await clickTab(pointer, choice);
    await until(() => ext._preferences.excludedApps.includes(baseAppId) &&
        [large, extra, manual].every(window => !ext._model.windows.has(window)), 'app excluded from every existing group');
    assert(ext._settingsDialog === exclusionDialog,
        'excluding all tracked windows of an app must leave the independent settings modal open');
    ext._closeSettings();
    await until(() => !extra.minimized && large.get_frame_rect().y === large.get_work_area_current_monitor().y,
        'excluded hidden window revealed and maximized constraint removed');
    assert(large.is_maximized() && manual.minimized &&
        [large, extra, manual].every(window => !ext._windowSignals.has(window)),
        'exclusion must retain native maximization, preserve user minimization, and release managed window signals');
    ext._setPreference('excludedApps', []);
    await until(() => [large, extra, manual].every(window => ext._model.windows.has(window)), 'removing exclusion retracks existing windows');
    await until(() => large.get_frame_rect().y === large.get_work_area_current_monitor().y + 30,
        're-included maximized window reserves native tab space again');
    assert(manual.minimized && !extra.minimized &&
        ext._model.windows.get(large).group !== ext._model.windows.get(extra).group,
        'removing exclusion must create independent groups without reviving old hidden state');
    checks.push('searchable app exclusions release hidden windows and maximize constraints, preserve user-minimized windows, and retrack safely when removed');

    const launchId = 'org.gnome.Extensions.UniversalTabsLaunchTest.desktop';
    ext._setPreference('excludedApps', [launchId]);
    group = ext._model.windows.get(large).group;
    await until(() => ext._bars.has(group), 'group available for excluded launch');
    bar = ext._bars.get(group);
    ext._openNewTab(bar, group);
    await delay();
    const launcher = ext._appSystem.lookup_app(launchId);
    assert(launcher, 'excluded launcher must remain installed and launchable');
    ext._launchApp(bar, group, launcher);
    await until(() => find('UT Launched')?.mapped && !bar.page, 'excluded launch opens separately and dismisses New tab');
    const launched = find('UT Launched');
    assert(!ext._model.windows.has(launched) && group.members.length === 1 && group.active === large,
        'excluded launch must never join or alter the requesting group');
    launched.delete(global.get_current_time());
    await until(() => !find('UT Launched'), 'excluded launch window closed');
    ext._setPreference('excludedApps', []);
    extra.delete(global.get_current_time());
    await until(() => !ext._model.windows.has(extra), 'settings-test extra window closed');
    checks.push('excluded apps remain launchable from New tab and open separately without changing the group');

    const preferencesFile = ext._preferencesFile;
    await disable();
    preferencesFile.replace_contents(JSON.stringify({hideMoveBar: true, futureSetting: 'preserve-me'}),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await enable();
    assert(ext._preferences.hideMoveBar && ext._preferences.hideNativeButtons && ext._preferences.disableAnimations &&
        ext._preferences.scrollSwitchesTabs && ext._preferences.preferredTabWidth === 240 &&
        ext._preferences.excludedApps.length === 0, 'old move-bar-only settings must inherit every new approved default');
    ext._setHideMoveBar(false);
    assert(saved().futureSetting === 'preserve-me', 'saving a known setting must preserve unknown future configuration fields');
    checks.push('legacy settings acquire approved defaults and unknown configuration fields survive later saves');

    ext._setPreference('hideNativeButtons', false);
    await inspectControls(false);
    for (const [key, value] of Object.entries({hideMoveBar: true, disableAnimations: false,
        scrollSwitchesTabs: false, preferredTabWidth: 180, excludedApps: [launchId]}))
        ext._setPreference(key, value);
    await disable();
    controlsBackup.replace_contents(JSON.stringify({version: 1, previousUser: originalControls, applied: ':appmenu'}),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    wmSettings.set_string('button-layout', ':appmenu');
    await enable();
    await inspectControls(false);
    assert(!ext._preferences.hideNativeButtons && wmSettings.get_string('button-layout') === originalControls &&
        !controlsBackup.query_exists(null), 'saved native-button hiding off must recover interrupted hidden controls on enable');
    assert(ext._preferences.hideMoveBar && !ext._preferences.disableAnimations &&
        !ext._preferences.scrollSwitchesTabs && ext._preferences.preferredTabWidth === 180 &&
        ext._preferences.excludedApps.includes(launchId), 'all nondefault preferences must survive disable and re-enable');
    for (const [key, value] of Object.entries({hideMoveBar: false, hideNativeButtons: true,
        disableAnimations: true, scrollSwitchesTabs: true, preferredTabWidth: 240, excludedApps: []}))
        ext._setPreference(key, value);
    await inspectControls(true);
    assert(ext._preferences.disableAnimations && ext._preferences.scrollSwitchesTabs &&
        ext._preferences.preferredTabWidth === 240 && !ext._preferences.hideMoveBar &&
        ext._preferences.excludedApps.length === 0, 'expanded settings tests must restore the normal runtime defaults');
    checks.push('all saved nondefault preferences survive re-enable and interrupted native-button changes recover even when hiding is off');
    return ext;
}

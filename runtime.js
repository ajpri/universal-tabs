import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Groups} from './groups.js';

const TAB_HEIGHT = 30;
const FLOATING_TAB_INSET = 12;
const CONTROLS_WIDTH = TAB_HEIGHT;
const PLUS_WIDTH = 30;
const MAX_TAB_WIDTH = 240;
const MIN_TAB_WIDTH = 72;
const DEFAULT_PREFERENCES = {hideMoveBar: false, hideNativeButtons: true,
    disableAnimations: true, scrollSwitchesTabs: true, preferredTabWidth: MAX_TAB_WIDTH, excludedApps: []};
const MOVE_HANDLE_RATIO = 0.75;
const MAX_APP_COLUMNS = 8;

// A distinct GType per imported revision avoids clashes during live updates.
// Instances are detached from every window before that runtime is disabled.
const TabSpaceConstraint = GObject.registerClass({
    GTypeName: `UniversalTabsSpace${GLib.get_monotonic_time()}`,
    Implements: [Meta.ExternalConstraint],
}, class TabSpaceConstraint extends GObject.Object {
    vfunc_constrain(window, info) {
        if (window.is_fullscreen() || !(window.get_maximize_flags() & Meta.MaximizeFlags.VERTICAL))
            return true;
        const proposed = info.new_rect;
        const monitor = window.get_display().get_monitor_index_for_rect(proposed);
        const area = monitor >= 0 ? window.get_work_area_for_monitor(monitor)
            : window.get_work_area_current_monitor();
        info.set_rect(new Mtk.Rectangle({x: proposed.x, y: area.y + TAB_HEIGHT,
            width: proposed.width, height: Math.max(1, area.height - TAB_HEIGHT)}));
        return true;
    }
});

export default class UniversalTabs {
    constructor(extension) {
        this.uuid = extension.uuid;
        this._extension = extension;
    }

    enable(snapshot = null) {
        this._enabled = true;
        this._model = new Groups();
        this._signals = [];
        this._windowSignals = new Map();
        this._closing = new WeakSet();
        this._bars = new Map();
        this._hidden = new Set();
        this._instantRestores = new Set();
        this._sources = new Set();
        this._drag = null;
        this._renderSource = 0;
        this._settingsSwitches = new Set();
        this._preferencesFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_config_dir(), this.uuid, 'settings.json']));
        this._preferences = {...DEFAULT_PREFERENCES};
        try {
            this._preferences = this._readPreferences();
        } catch (error) {
            console.error(`[Universal Tabs] Reading settings: ${error}`);
        }
        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
        this._appsGeneration = 0;
        this._connect(this._appSystem, 'installed-changed', () => {
            this._appsGeneration++;
            this._queueRender();
        });
        this._constraint = new TabSpaceConstraint();
        this._appearance = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        if (this._preferences.hideNativeButtons)
            this._hideNativeControls();
        else
            this._restoreNativeControls();
        this._connect(this._appearance, 'changed::color-scheme', () => {
            this._syncSettingsAppearance();
            this._queueRender();
        });
        this._connect(this._tracker, 'tracked-windows-changed', () => this._scan());
        this._connect(this._tracker, 'startup-sequence-changed', (_tracker, sequence) => {
            const id = sequence.get_id();
            const appId = GLib.path_get_basename(sequence.get_application_id() ?? '');
            for (const bar of this._bars.values()) {
                const pending = bar.page?.pending;
                if (pending?.appId === appId && !pending.beforeSequences.has(id))
                    pending.startupIds.add(id);
            }
            this._queueRender();
        });
        this._suppressMaximizeAnimation();
        this._suppressRestoreAnimations();

        this._connect(global.display, 'window-created', () => this._later(() => this._scan()));
        this._connect(global.window_manager, 'map', (_wm, actor) => {
            this._track(actor.meta_window);
            this._queueRender();
        });
        this._connect(global.display, 'notify::focus-window', () => this._focusChanged());
        this._connect(global.display, 'window-entered-monitor', (_display, _monitor, window) => {
            this._remember(window);
            this._queueRender();
        });
        this._connect(global.display, 'restacked', () => this._queueRender());
        this._connect(global.display, 'workareas-changed', () => this._queueRender());
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._queueRender());
        this._connect(Main.overview, 'showing', () => this._queueRender());
        this._connect(Main.overview, 'hidden', () => this._queueRender());
        this._connect(Main.sessionMode, 'updated', () => this._queueRender());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            for (const group of this._model.groups)
                this._remember(group.active);
            this._queueRender();
        });

        this._dragMonitor = {
            dragMotion: event => {
                if (!this._drag)
                    return DND.DragMotionResult.CONTINUE;
                const target = this._targetGroup(event.targetActor);
                for (const [group, bar] of this._bars)
                    bar.actor.set_style_pseudo_class(group === target ? 'drop-target' : null);
                return DND.DragMotionResult.MOVE_DROP;
            },
            dragDrop: event => {
                if (this._drag) {
                    const [x, y] = event.clutterEvent.get_coords();
                    const group = this._targetGroup(event.targetActor);
                    this._drag.drop = {x, y, group, index: this._dropIndex(group, x)};
                }
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        this._scan();
        if (snapshot) {
            this._model.restore(snapshot);
            this._reconcile();
        } else if (this._extension._universalTabsLockSnapshot) {
            // Only plain JSON survives the lock teardown. Resolve still-open
            // windows in this Shell session; closed windows are omitted.
            const windows = new Map([...this._model.windows.keys()]
                .map(window => [window.get_stable_sequence(), window]));
            this._model.restore(JSON.parse(this._extension._universalTabsLockSnapshot), id => windows.get(id));
            for (const group of this._model.groups)
                this._place(group.active);
            this._reconcile();
        }
    }

    snapshot() {
        return this._model?.snapshot() ?? null;
    }

    _readPreferences() {
        if (!this._preferencesFile.query_exists(null))
            return {...DEFAULT_PREFERENCES};
        const options = JSON.parse(new TextDecoder().decode(this._preferencesFile.load_contents(null)[1]));
        if (!options || typeof options !== 'object' || Array.isArray(options) ||
            ['hideMoveBar', 'hideNativeButtons', 'disableAnimations', 'scrollSwitchesTabs']
                .some(key => key in options && typeof options[key] !== 'boolean') ||
            ('preferredTabWidth' in options && (!Number.isInteger(options.preferredTabWidth) ||
                options.preferredTabWidth < MIN_TAB_WIDTH || options.preferredTabWidth > 480)) ||
            ('excludedApps' in options && (!Array.isArray(options.excludedApps) ||
                options.excludedApps.some(id => typeof id !== 'string' || !id))))
            throw new Error('Invalid settings file; the saved file has been left unchanged');
        return {...DEFAULT_PREFERENCES, ...options};
    }

    _setHideMoveBar(hidden) {
        return this._setPreference('hideMoveBar', hidden);
    }

    _setPreference(key, value) {
        if (JSON.stringify(value) === JSON.stringify(this._preferences[key]))
            return;
        const previous = this._preferences[key];
        let nativeChanged = false;
        try {
            const options = {...this._readPreferences(), [key]: value};
            if (key === 'hideNativeButtons') {
                nativeChanged = true;
                if (value)
                    this._hideNativeControls();
                else
                    this._restoreNativeControls();
            }
            const directory = this._preferencesFile.get_parent();
            if (!directory.query_exists(null))
                directory.make_directory_with_parents(null);
            this._preferencesFile.replace_contents(JSON.stringify(options, null, 2) + '\n', null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._preferences = options;
            if (key === 'excludedApps') {
                this._scan();
                this._fillSettingsApps();
            }
            if (key === 'scrollSwitchesTabs') {
                for (const bar of this._bars.values()) {
                    bar.wheelDelta = 0;
                    bar.wheelTime = 0;
                }
            }
            this._queueRender();
        } catch (error) {
            if (nativeChanged) {
                try {
                    if (previous)
                        this._hideNativeControls();
                    else
                        this._restoreNativeControls();
                } catch (recoveryError) {
                    console.error(`[Universal Tabs] Settings recovery: ${recoveryError}`);
                }
            }
            console.error(`[Universal Tabs] Saving settings: ${error}`);
            Main.notify(`${this._extension.metadata.name} Settings`, 'Could not save the setting. Your saved settings were left unchanged.');
        }
        this._syncSettingsMenus();
    }

    _syncSettingsMenus() {
        for (const item of this._settingsSwitches)
            item.setToggleState(item._appId ? this._preferences.excludedApps.includes(item._appId)
                : this._preferences[item._settingKey]);
        if (this._settingsWidthLabel) {
            const width = this._preferences.preferredTabWidth;
            this._settingsWidthLabel.text = `${width} px`;
            this._settingsWidthDecrease.reactive = this._settingsWidthDecrease.can_focus = width > MIN_TAB_WIDTH;
            this._settingsWidthIncrease.reactive = this._settingsWidthIncrease.can_focus = width < 480;
        }
        this._syncSettingsAppearance();
    }

    _settingsSwitch(container, label, key, appId = null) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, appId
            ? this._preferences.excludedApps.includes(appId) : this._preferences[key]);
        item._settingKey = key;
        item._appId = appId;
        this._settingsSwitches.add(item);
        item.connect('toggled', (_item, state) => {
            if (appId) {
                if (state === this._preferences.excludedApps.includes(appId))
                    return;
                this._later(() => {
                    const ids = this._preferences.excludedApps.filter(id => id !== appId);
                    if (state)
                        ids.push(appId);
                    this._setPreference(key, ids);
                });
            } else {
                this._setPreference(key, state);
            }
        });
        item.connect('key-focus-in', () => this._revealSettingsItem(item));
        item.connect('destroy', () => this._settingsSwitches.delete(item));
        container.add_child(item);
        return item;
    }

    _addSettingsMenu(menu) {
        return menu.addAction(`${this._extension.metadata.name} Settings`, () => {
            menu.close({animate: false});
            this._later(() => this._openSettings());
        });
    }

    _openSettings() {
        this._hideTooltip();
        for (const bar of this._bars.values())
            bar.closeContext();
        if (this._settingsDialog) {
            this._settingsDialog.open();
            return;
        }
        const dialog = new ModalDialog.ModalDialog({styleClass: 'universal-tabs-settings-dialog',
            shouldFadeIn: false, shouldFadeOut: false});
        this._settingsDialog = dialog;
        const area = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        dialog.contentLayout.set_width(Math.min(600, Math.max(280, area.width / scale - 80)));
        dialog.contentLayout.add_child(new St.Label({text: `${this._extension.metadata.name} Settings`,
            style_class: 'universal-tabs-settings-title'}));
        const scroll = new St.ScrollView({height: Math.min(460, Math.max(160, area.height / scale - 240)),
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this._settingsScroll = scroll;
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'universal-tabs-settings-content', x_expand: true});
        scroll.set_child(content);
        dialog.contentLayout.add_child(scroll);
        for (const [label, key] of [['Hide move bar', 'hideMoveBar'],
            ['Hide native window buttons', 'hideNativeButtons'],
            ['Disable maximize/restore animations', 'disableAnimations'],
            ['Scroll wheel switches tabs', 'scrollSwitchesTabs']])
            this._settingsSwitch(content, label, key);
        const widths = new St.BoxLayout({style_class: 'universal-tabs-settings-width', x_expand: true});
        widths.add_child(new St.Label({text: 'Preferred tab width', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const choices = [72, 120, 180, 240, 300, 360, 480];
        const widthButton = (label, name, direction) => {
            const button = new St.Button({label, style_class: 'button', can_focus: true, accessible_name: name});
            button.connect('clicked', () => {
                const current = this._preferences.preferredTabWidth;
                const next = direction < 0 ? choices.filter(width => width < current).at(-1)
                    : choices.find(width => width > current);
                if (next !== undefined)
                    this._setPreference('preferredTabWidth', next);
            });
            button.connect('key-focus-in', () => this._revealSettingsItem(button));
            return button;
        };
        this._settingsWidthDecrease = widthButton('−', 'Decrease preferred tab width', -1);
        this._settingsWidthIncrease = widthButton('+', 'Increase preferred tab width', 1);
        this._settingsWidthLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, width: 72,
            x_align: Clutter.ActorAlign.CENTER});
        widths.add_child(this._settingsWidthDecrease);
        widths.add_child(this._settingsWidthLabel);
        widths.add_child(this._settingsWidthIncrease);
        content.add_child(widths);
        content.add_child(new St.Label({text: 'Excluded applications', style_class: 'universal-tabs-section-heading'}));
        this._settingsSearch = new St.Entry({hint_text: 'Search applications…', can_focus: true, x_expand: true,
            style_class: 'search-entry universal-tabs-settings-search', accessible_name: 'Search excluded applications'});
        content.add_child(this._settingsSearch);
        this._settingsAppList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        content.add_child(this._settingsAppList);
        this._settingsSearch.clutter_text.connect('text-changed', () => this._fillSettingsApps());
        this._settingsSearch.connect('key-focus-in', () => this._revealSettingsItem(this._settingsSearch));
        dialog.setButtons([{label: 'Done', action: () => this._closeSettings(), key: Clutter.KEY_Escape}]);
        dialog.setInitialKeyFocus([...this._settingsSwitches][0]);
        dialog.connect('destroy', () => {
            if (this._settingsDialog !== dialog)
                return;
            this._settingsDialog = null;
            this._settingsScroll = null;
            this._settingsSearch = null;
            this._settingsAppList = null;
            this._settingsWidthLabel = null;
            this._settingsWidthDecrease = null;
            this._settingsWidthIncrease = null;
        });
        this._fillSettingsApps();
        this._syncSettingsMenus();
        if (!dialog.open())
            dialog.destroy();
    }

    _closeSettings() {
        this._settingsDialog?.close();
    }

    _syncSettingsAppearance() {
        const layout = this._settingsDialog?.contentLayout.get_parent();
        if (!layout)
            return;
        const dark = this._appearance.get_string('color-scheme') === 'prefer-dark';
        layout.remove_style_class_name(dark ? 'light' : 'dark');
        layout.add_style_class_name(dark ? 'dark' : 'light');
    }

    _revealSettingsItem(item) {
        const scroll = this._settingsScroll;
        if (!scroll?.mapped || !item?.mapped)
            return;
        const [, y] = item.get_transformed_position();
        const [, top] = scroll.get_transformed_position();
        const adjustment = scroll.vadjustment;
        if (y < top)
            adjustment.value += y - top;
        else if (y + item.height > top + scroll.height)
            adjustment.value += y + item.height - top - scroll.height;
    }

    _fillSettingsApps() {
        if (!this._settingsAppList)
            return;
        this._settingsAppList.destroy_all_children();
        const apps = new Map(this._appSystem.get_installed().filter(info => info.should_show())
            .map(info => [info.get_id(), info.get_name()]));
        for (const id of this._preferences.excludedApps) {
            if (!apps.has(id))
                apps.set(id, id);
        }
        const query = this._settingsSearch.text.trim().toLocaleLowerCase();
        const matches = [...apps].filter(([id, name]) => `${name} ${id}`.toLocaleLowerCase().includes(query))
            .sort((a, b) => Number(this._preferences.excludedApps.includes(b[0])) -
                Number(this._preferences.excludedApps.includes(a[0])) || a[1].localeCompare(b[1]));
        for (const [id, name] of matches.slice(0, 10))
            this._settingsSwitch(this._settingsAppList, name, 'excludedApps', id);
        if (!matches.length || matches.length > 10)
            this._settingsAppList.add_child(new St.Label({text: matches.length
                ? 'Search to find more applications' : 'No applications found', style_class: 'universal-tabs-page-status'}));
    }

    _readNativeControls() {
        this._controlsSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._controlsBackup ??= this._extension.dir.get_child('window-controls-backup.json');
        const current = this._controlsSettings.get_string('button-layout');
        const userValue = this._controlsSettings.get_user_value('button-layout')?.deepUnpack() ?? null;
        let saved = null;
        if (this._controlsBackup.query_exists(null)) {
            const contents = this._controlsBackup.load_contents(null)[1];
            saved = JSON.parse(new TextDecoder().decode(contents));
            if (saved.version !== 1 || typeof saved.applied !== 'string' ||
                (saved.previousUser !== null && typeof saved.previousUser !== 'string'))
                throw new Error('Invalid window-button recovery file; restore the saved layout before updating');
        }
        return {current, userValue, saved};
    }

    _hideNativeControls() {
        const {current, userValue, saved} = this._readNativeControls();
        if (saved && current === saved.applied && userValue === saved.applied) {
            // A previous Shell process may have exited before disable(). Keep
            // its original preference rather than backing up the hidden layout.
            this._controlsState = saved;
            return;
        }
        const controls = new Set(['close', 'minimize', 'maximize']);
        const hidden = current.split(':').map(side => side.split(',')
            .filter(button => !controls.has(button.trim())).join(',')).join(':');
        if (hidden === current) {
            if (saved)
                this._controlsBackup.delete(null);
            return;
        }
        if (!this._controlsSettings.is_writable('button-layout'))
            throw new Error('GNOME window-button layout is locked by system policy');
        const state = {version: 1, previousUser: userValue, applied: hidden};
        // Persist the recovery value before changing this desktop-wide setting.
        this._controlsBackup.replace_contents(JSON.stringify(state), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        this._controlsState = state;
        if (!this._controlsSettings.set_string('button-layout', hidden))
            throw new Error('Could not hide GNOME window buttons');
        Gio.Settings.sync();
    }

    _restoreNativeControls() {
        if (!this._controlsState) {
            const {current, userValue, saved} = this._readNativeControls();
            if (saved && current === saved.applied && userValue === saved.applied)
                this._controlsState = saved;
            else if (saved)
                this._controlsBackup.delete(null);
        }
        if (!this._controlsState)
            return;
        const {previousUser, applied} = this._controlsState;
        // Another extension or the user may have changed the layout meanwhile.
        // Do not overwrite that newer preference or continuously fight it.
        if (this._controlsSettings.get_string('button-layout') === applied &&
            this._controlsSettings.get_user_value('button-layout')?.deepUnpack() === applied) {
            if (previousUser === null)
                this._controlsSettings.reset('button-layout');
            else if (!this._controlsSettings.set_string('button-layout', previousUser))
                throw new Error('Could not restore GNOME window buttons; the recovery file was retained');
            Gio.Settings.sync();
            const restored = this._controlsSettings.get_user_value('button-layout')?.deepUnpack() ?? null;
            if (restored !== previousUser)
                throw new Error('GNOME window-button restoration failed; the recovery file was retained');
        }
        if (this._controlsBackup.query_exists(null))
            this._controlsBackup.delete(null);
        this._controlsState = null;
    }

    _suppressMaximizeAnimation() {
        const original = Main.wm._prepareAnimationInfo;
        if (typeof original !== 'function')
            throw new Error('This GNOME version has no supported size-animation hook');
        const runtime = this;
        const hook = function (shellwm, actor, oldFrameRect, change) {
            const maximize = change === Meta.SizeChange.MAXIMIZE || change === Meta.SizeChange.UNMAXIMIZE;
            if (runtime._enabled && runtime._preferences.disableAnimations && maximize && runtime._model.windows.has(actor.meta_window)) {
                // Complete the native effect without creating a frozen clone or
                // scaling the window. Finish any older size effect first.
                if (actor.__animationInfo)
                    this._sizeChangeWindowDone(shellwm, actor);
                shellwm.completed_size_change(actor);
                return;
            }
            return original.call(this, shellwm, actor, oldFrameRect, change);
        };
        this._animationOriginal = original;
        this._animationHook = hook;
        Main.wm._prepareAnimationInfo = hook;
    }

    _restoreMaximizeAnimation() {
        // If another extension wrapped our hook later, leave its wrapper in
        // place. Our disabled hook becomes a pass-through to its original.
        if (this._animationHook && Main.wm._prepareAnimationInfo === this._animationHook)
            Main.wm._prepareAnimationInfo = this._animationOriginal;
        this._animationHook = null;
        this._animationOriginal = null;
    }

    _suppressRestoreAnimations() {
        this._restoreSizeChanges = new WeakSet();
        const managed = actor => this._enabled && this._model.windows.has(actor.meta_window);
        // GNOME bound its native handlers before extensions were loaded. Run
        // after them and complete a restore before any animated frame is drawn.
        // This also catches size effects if a later extension replaces the
        // preparation hook, without replacing that extension's own hook.
        this._connect(global.window_manager, 'size-change', (wm, actor, change) => {
            if (managed(actor) && this._preferences.disableAnimations &&
                (change === Meta.SizeChange.MAXIMIZE || change === Meta.SizeChange.UNMAXIMIZE)) {
                this._restoreSizeChanges.add(actor);
                Main.wm._sizeChangeWindowDone(wm, actor);
            } else {
                this._restoreSizeChanges.delete(actor);
            }
        });
        this._connect(global.window_manager, 'size-changed', (wm, actor) => {
            if (this._restoreSizeChanges.delete(actor) && managed(actor))
                Main.wm._sizeChangeWindowDone(wm, actor);
        });
        this._connect(global.window_manager, 'unminimize', (wm, actor) => {
            const tabRestore = this._instantRestores.delete(actor.meta_window);
            if (managed(actor) && (this._preferences.disableAnimations || tabRestore))
                this._finishUnminimize(wm, actor);
        });
        this._connect(global.window_manager, 'minimize', (wm, actor) => {
            const window = actor.meta_window;
            // Only suppress minimization used to hide an inactive tab. An
            // explicit minimize of the selected window keeps GNOME's effect.
            if (managed(actor) && this._hidden.has(window) &&
                this._model.windows.get(window).group.active !== window)
                Main.wm._minimizeWindowDone(wm, actor);
        });
    }

    _finishUnminimize(wm, actor) {
        if (!Main.wm._unminimizing.has(actor))
            return;
        Main.wm._unminimizeWindowDone(wm, actor);
        // The native effect initially moves the actor to its dock icon.
        // Completing the effect resets scale/opacity but not that position.
        const rect = actor.meta_window.get_buffer_rect();
        actor.set_position(rect.x, rect.y);
    }

    _connect(object, signal, callback, list = this._signals) {
        list.push([object, object.connect(signal, callback)]);
    }

    _disconnect(list) {
        for (const [object, id] of list)
            object.disconnect(id);
    }

    _later(callback) {
        if (!this._enabled)
            return 0;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._sources.delete(id);
            try {
                callback();
            } catch (error) {
                console.error(`[Universal Tabs] ${error.stack ?? error}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _addTooltip(actor, text) {
        actor.track_hover = true;
        const sync = () => {
            if (actor.hover || actor.has_key_focus())
                this._scheduleTooltip(actor, text);
            else
                this._hideTooltip(actor);
        };
        actor.connect('notify::hover', sync);
        actor.connect('key-focus-in', sync);
        actor.connect('key-focus-out', sync);
        actor.connect('notify::mapped', () => {
            if (!actor.mapped)
                this._hideTooltip(actor);
        });
        actor.connect('destroy', () => this._hideTooltip(actor));
        if (actor instanceof St.Button)
            actor.connect('clicked', () => this._hideTooltip(actor));
    }

    _scheduleTooltip(actor, text) {
        if (!this._enabled || this._tooltipSource === actor)
            return;
        this._hideTooltip();
        this._tooltipSource = actor;
        this._tooltipText = typeof text === 'function' ? text : () => text;
        this._tooltipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._sources.delete(this._tooltipTimer);
            this._tooltipTimer = 0;
            this._syncTooltip();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(this._tooltipTimer);
    }

    _hideTooltip(actor = null) {
        if (actor && actor !== this._tooltipSource)
            return;
        if (this._tooltipTimer && this._sources.delete(this._tooltipTimer))
            GLib.source_remove(this._tooltipTimer);
        this._tooltipTimer = 0;
        this._tooltipSource = null;
        this._tooltipText = null;
        this._tooltipActor?.hide();
    }

    _syncTooltip() {
        const source = this._tooltipSource;
        if (!source || this._tooltipTimer)
            return;
        if (!this._enabled || !source.mapped || this._drag || Main.overview.visible ||
            !Main.sessionMode.hasWindows || Main.modalCount > 0) {
            this._hideTooltip();
            return;
        }
        const text = this._tooltipText();
        if (!text) {
            this._hideTooltip();
            return;
        }
        if (!this._tooltipActor) {
            this._tooltipActor = new St.Label({reactive: false});
            this._tooltipActor.clutter_text.line_wrap = true;
            this._tooltipActor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            Main.uiGroup.add_child(this._tooltipActor);
        }
        const label = this._tooltipActor;
        const dark = this._appearance.get_string('color-scheme') === 'prefer-dark';
        label.set_style_class_name(`universal-tabs-tooltip ${dark ? 'dark' : 'light'}`);
        const monitor = Main.layoutManager.findMonitorForActor(source) ?? Main.layoutManager.primaryMonitor;
        label.set_style(`max-width: ${Math.min(420, monitor.width - 16)}px;`);
        label.text = text;
        label.set_size(-1, -1);
        const [, , width, height] = label.get_preferred_size();
        label.set_size(width, height);
        const [sx, sy] = source.get_transformed_position();
        const [sw, sh] = source.get_transformed_size();
        const x = Math.max(monitor.x + 4, Math.min(sx + (sw - width) / 2, monitor.x + monitor.width - width - 4));
        const below = sy + sh + 6;
        const y = below + height <= monitor.y + monitor.height - 4 ? below : sy - height - 6;
        label.set_position(Math.round(x), Math.round(Math.max(monitor.y + 4, y)));
        label.show();
    }

    _eligible(window) {
        return window && !this._closing.has(window) && window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.is_override_redirect() && !window.is_skip_taskbar() &&
            !window.get_transient_for() && !this._isExcluded(window);
    }

    _isExcluded(window) {
        const appId = this._tracker.get_window_app(window)?.get_id();
        const gtkId = window.get_gtk_application_id();
        return this._preferences.excludedApps.includes(appId) ||
            (gtkId && this._preferences.excludedApps.includes(`${gtkId}.desktop`));
    }

    _scan() {
        for (const window of [...this._model.windows.keys()]) {
            if (this._eligible(window))
                continue;
            const hidden = this._hidden.has(window);
            window.remove_external_constraint(this._constraint);
            this._forget(window);
            if (window.is_maximized()) {
                const frame = window.get_frame_rect();
                window.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
            }
            if (hidden)
                window.unminimize();
        }
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this._focusChanged();
        this._queueRender();
    }

    _track(window) {
        if (!this._eligible(window) || this._model.windows.has(window))
            return;
        const record = this._model.add(window, window.get_frame_rect());
        const actor = window.get_compositor_private();
        if (actor && this._preferences.disableAnimations)
            this._finishUnminimize(global.window_manager, actor);
        record.group.maximized = window.is_maximized();
        record.group.monitor = window.get_monitor();
        record.normalKnown = !window.is_maximized();
        record.group.normalKnown = record.normalKnown;
        window.add_external_constraint(this._constraint);
        if (window.is_maximized()) {
            const frame = window.get_frame_rect();
            window.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
        }
        const signals = [];
        this._windowSignals.set(window, signals);
        const geometry = () => {
            this._remember(window);
            this._queueRender();
        };
        this._connect(window, 'position-changed', geometry, signals);
        this._connect(window, 'size-changed', geometry, signals);
        for (const signal of ['notify::maximized-horizontally', 'notify::maximized-vertically']) {
            this._connect(window, signal, () => {
                const current = this._model.windows.get(window);
                if (current?.group.active === window)
                    current.group.maximized = window.is_maximized();
                this._queueRender();
            }, signals);
        }
        for (const signal of ['notify::title', 'notify::minimized',
            'notify::fullscreen', 'workspace-changed', 'notify::above', 'notify::mapped'])
            this._connect(window, signal, () => this._queueRender(), signals);
        this._connect(window, 'unmanaging', () => {
            // Capture the active viewport before Mutter changes focus or tears
            // down the closing window's maximized geometry and monitor state.
            this._remember(window);
            this._closing.add(window);
            window.remove_external_constraint(this._constraint);
            this._forget(window);
        }, signals);
    }

    _forget(window) {
        if (this._drag?.window === window) {
            this._drag = null;
            this._dragActor?.destroy();
        }
        this._disconnect(this._windowSignals.get(window) ?? []);
        this._windowSignals.delete(window);
        this._hidden.delete(window);
        this._instantRestores.delete(window);
        this._model.remove(window);
        this._reconcile();
    }

    _remember(window) {
        const record = this._model.windows.get(window);
        if (!record || record.group.active !== window || this._closing.has(window))
            return;
        const monitor = window.get_monitor();
        if (monitor >= 0)
            record.group.monitor = monitor;
        if (!window.is_maximized() && !window.is_fullscreen()) {
            this._model.remember(window, window.get_frame_rect());
            const group = this._model.windows.get(window)?.group;
            if (group?.active === window && !group.maximized) {
                for (const member of group.members) {
                    if (member === window || member.is_maximized() || member.is_fullscreen() || !member.allows_move())
                        continue;
                    const frame = member.get_frame_rect();
                    if (frame.x !== group.x || frame.y !== group.y)
                        member.move_frame(true, group.x, group.y);
                }
            }
        }
    }

    _focusChanged() {
        const window = global.display.focus_window;
        // Transient/modal focus is deliberately outside the tab model.
        if (this._model.windows.has(window)) {
            const group = this._model.windows.get(window).group;
            if (group.active !== window)
                this._select(window, false);
        }
        this._queueRender();
    }

    _select(window, focus = true) {
        this._hideTooltip();
        const record = this._model.windows.get(window);
        if (!record)
            return;
        this._closeNewTab(this._bars.get(record.group));
        const previous = record.group.active;
        if (previous !== window && this._model.windows.has(previous))
            this._remember(previous);
        this._model.activate(window);
        this._hidden.delete(window);
        this._place(window);
        this._unminimizeTab(window);
        if (focus)
            window.activate(global.get_current_time());
        this._reconcile();
    }

    _place(window) {
        if (window.is_fullscreen())
            return;
        const record = this._model.windows.get(window);
        if (record.group.maximized) {
            if (window.can_maximize()) {
                const monitor = record.group.monitor;
                if (Number.isInteger(monitor) && monitor >= 0 && monitor < global.display.get_n_monitors() &&
                    window.get_monitor() !== monitor)
                    window.move_to_monitor(monitor);
                if (!window.is_maximized())
                    window.maximize();
                return;
            }
            record.group.maximized = false;
        }
        const rect = this._model.rect(window);
        const normalKnown = record.group.normalKnown;
        if (window.is_maximized()) {
            window.unmaximize();
            // Windows already maximized before tracking retain Mutter's own
            // saved restore rectangle instead of an invented fullscreen size.
            if (!normalKnown)
                return;
        }
        const actual = window.get_frame_rect();
        if (!window.allows_resize()) {
            rect.width = actual.width;
            rect.height = actual.height;
            this._model.remember(window, rect);
        }
        if (actual.x !== rect.x || actual.y !== rect.y ||
            actual.width !== rect.width || actual.height !== rect.height)
            window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    }

    _unminimizeTab(window) {
        if (!window.minimized)
            return;
        this._instantRestores.add(window);
        window.unminimize();
        this._later(() => this._instantRestores.delete(window));
    }

    _reconcile() {
        for (const [window, record] of this._model.windows) {
            if (record.group.active === window) {
                // Reveal only windows hidden by this extension. User-minimized
                // groups stay minimized until explicitly activated.
                if (this._hidden.delete(window)) {
                    this._place(window);
                    this._unminimizeTab(window);
                }
            } else if (!window.minimized) {
                this._hidden.add(window);
                window.minimize();
            }
        }
        this._queueRender();
    }

    _join(window, target, index) {
        const record = this._model.windows.get(window);
        if (!record || !this._model.groups.has(target))
            return;
        // Capture source geometry before adopting the target group's viewport.
        this._remember(window);
        const workspace = target.active.get_workspace();
        if (window.get_workspace() !== workspace && !window.is_on_all_workspaces())
            window.change_workspace(workspace);
        this._model.move(window, target, index);
        this._select(window);
    }

    _detach(window, x, y) {
        if (!this._model.windows.has(window))
            return;
        this._remember(window);
        const area = window.get_work_area_current_monitor();
        const size = this._model.rect(window);
        x = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - Math.min(size.width, area.width))));
        y = Math.round(Math.max(area.y + TAB_HEIGHT, Math.min(y, area.y + area.height - Math.min(size.height, area.height - TAB_HEIGHT))));
        this._model.detach(window, x, y);
        this._select(window);
    }

    _toggleMaximized(group) {
        this._hideTooltip();
        if (group.active.is_maximized())
            group.active.unmaximize();
        else if (group.active.can_maximize())
            group.active.maximize();
    }

    _doubleClick(actor, callback) {
        const gesture = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY,
            n_clicks_required: 2});
        // Keep single-click selection immediate while recognizing a double
        // click on the same button. Motion still lets the DND gesture win.
        for (const action of actor.get_actions() ?? []) {
            if (action instanceof Clutter.ClickGesture) {
                gesture.can_not_cancel(action);
                action.can_not_cancel(gesture);
            }
        }
        gesture.connect('recognize', callback);
        actor.add_action(gesture);
    }

    _moveGroup(group, event = null) {
        this._hideTooltip();
        const window = group.active;
        if (window.is_maximized() || window.is_fullscreen() || !window.allows_move())
            return;
        if (this._bars.get(group)?.page)
            window.activate(global.get_current_time());
        else
            this._select(window);
        const sprite = event ? global.stage.context.get_backend().get_sprite(global.stage, event) : null;
        window.begin_grab_op(event ? Meta.GrabOp.MOVING : Meta.GrabOp.KEYBOARD_MOVING,
            sprite, event?.get_time() ?? global.get_current_time(), null);
    }

    _queueRender() {
        if (this._renderSource)
            return;
        this._renderSource = this._later(() => {
            this._renderSource = 0;
            if (!this._drag)
                this._render();
        });
    }

    _title(window) {
        const app = this._tracker.get_window_app(window);
        return window.get_title() || app?.get_name() || 'Window';
    }

    _render() {
        this._matchLaunches();
        for (const [group, bar] of this._bars) {
            if (!this._model.groups.has(group)) {
                bar.destroy();
                this._bars.delete(group);
            }
        }
        const workspace = global.workspace_manager.get_active_workspace();
        for (const group of this._model.groups) {
            let bar = this._bars.get(group);
            if (!bar) {
                bar = this._createBar(group);
                this._bars.set(group, bar);
            }
            const window = group.active;
            const visible = Main.sessionMode.hasWindows && !Main.overview.visible &&
                !Main.layoutManager._startingUp && !window.minimized &&
                !window.is_fullscreen() && window.located_on_workspace(workspace);
            bar.actor.visible = visible;
            if (bar.page)
                bar.page.actor.visible = visible;
            if (!visible)
                continue;
            const frame = window.get_frame_rect();
            const inset = window.is_maximized() ? 0
                : Math.min(FLOATING_TAB_INSET, Math.max(0, (frame.width - 120) / 2));
            const width = Math.max(120, frame.width - inset * 2);
            const y = frame.y - TAB_HEIGHT;
            if (window.is_maximized())
                bar.actor.add_style_class_name('maximized');
            else
                bar.actor.remove_style_class_name('maximized');
            // Inset floating tabs past the application's rounded top corners.
            // Follow the frame even off-screen; never clamp the strip separately.
            bar.actor.set_position(frame.x + inset, y);
            bar.actor.set_size(width, TAB_HEIGHT);
            const dark = this._appearance.get_string('color-scheme') === 'prefer-dark';
            bar.actor.remove_style_class_name(dark ? 'light' : 'dark');
            bar.actor.add_style_class_name(dark ? 'dark' : 'light');
            if (bar.page) {
                bar.page.actor.set_style_class_name(`universal-tabs-page ${dark ? 'dark' : 'light'}`);
                bar.page.actor.set_position(frame.x, frame.y);
                bar.page.actor.set_size(frame.width, frame.height);
                this._fillNewTab(bar, group);
            }
            bar.moveHandle.visible = !this._preferences.hideMoveBar && !window.is_maximized() && window.allows_move();
            bar.freeSpace.reactive = window.is_maximized();
            // Share the row like browser tabs: stay wide with a few windows,
            // then shrink equally. At the minimum, keep the rest scrollable.
            const available = Math.max(16, width - CONTROLS_WIDTH - PLUS_WIDTH);
            const slots = group.members.length + (bar.page ? 1 : 0) + (bar.moveHandle.visible ? MOVE_HANDLE_RATIO : 0);
            bar.tabWidth = Math.min(this._preferences.preferredTabWidth, Math.max(MIN_TAB_WIDTH, available / slots));
            const pageWidth = bar.page
                ? Math.min(bar.tabWidth, Math.max(16, available - MIN_TAB_WIDTH - (bar.moveHandle.visible ? 24 : 0))) : 0;
            const handleWidth = bar.moveHandle.visible
                ? Math.min(bar.tabWidth * MOVE_HANDLE_RATIO, Math.max(24, available - pageWidth - MIN_TAB_WIDTH)) : 0;
            bar.moveHandle.set_width(handleWidth);
            bar.page?.tab.set_width(pageWidth);
            bar.scroll.set_width(Math.max(16, Math.min(available - handleWidth - pageWidth,
                group.members.length * bar.tabWidth)));
            bar.minimize.reactive = window.can_minimize();
            this._updateTabs(bar, group);
            const actor = window.get_compositor_private();
            if (actor?.get_parent() === global.window_group) {
                if (bar.page)
                    global.window_group.set_child_above_sibling(bar.page.actor, actor);
                global.window_group.set_child_above_sibling(bar.actor, bar.page?.actor ?? actor);
            }
        }
        this._syncTooltip();
    }

    _createBar(group) {
        const actor = new St.BoxLayout({style_class: 'universal-tabs-strip', reactive: true});
        const controls = new St.BoxLayout({style_class: 'universal-tabs-controls', width: CONTROLS_WIDTH,
            y_align: Clutter.ActorAlign.END});
        const minimize = new St.Button({style_class: 'universal-tabs-window-control minimize',
            child: new St.Icon({icon_name: 'window-minimize-symbolic', icon_size: 14}),
            can_focus: true, accessible_name: 'Minimize window group'});
        minimize.connect('clicked', () => group.active.minimize());
        this._addTooltip(minimize, 'Minimize window group');
        controls.add_child(minimize);
        actor.add_child(controls);
        const tabs = new St.BoxLayout();
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false, enable_touch_scrolling: false,
        });
        scroll.set_child(tabs);
        actor.add_child(scroll);
        const plus = new St.Button({
            style_class: 'universal-tabs-tab universal-tabs-plus',
            label: '+', width: PLUS_WIDTH, can_focus: true, accessible_name: 'New tab',
        });
        actor.add_child(plus);
        this._addTooltip(plus, 'New tab');
        const freeSpace = new St.Widget({reactive: true, x_expand: true,
            accessible_name: 'Double-click to restore window'});
        this._doubleClick(freeSpace, () => {
            if (group.active.is_maximized())
                this._toggleMaximized(group);
        });
        actor.add_child(freeSpace);
        this._addTooltip(freeSpace, 'Double-click to restore window');
        const moveHandle = new St.Button({style_class: 'universal-tabs-window-control universal-tabs-move',
            width: this._preferences.preferredTabWidth * MOVE_HANDLE_RATIO, y_align: Clutter.ActorAlign.FILL, can_focus: true,
            accessible_name: 'Move window group',
            child: new St.Icon({icon_name: 'view-more-horizontal-symbolic', icon_size: 16})});
        moveHandle.set_cursor_type(Clutter.CursorType.MOVE);
        this._addTooltip(moveHandle, 'Drag to move the whole group\nEnter or Space to move with the keyboard');
        const movePress = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY,
            recognize_on_press: true});
        movePress.connect('recognize', () => {
            const point = movePress.get_points()[0];
            this._moveGroup(group, movePress.get_point_event(point));
        });
        moveHandle.add_action(movePress);
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_space) {
                this._moveGroup(group);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        moveHandle.add_action(keys);
        actor.add_child(moveHandle);
        actor._universalTabsGroup = group;
        actor._delegate = {
            handleDragOver: source => source?.universalTabs === this
                ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE,
            acceptDrop: source => source?.universalTabs === this,
        };
        global.window_group.add_child(actor);
        Main.layoutManager.trackChrome(actor);
        const menuManager = new PopupMenu.PopupMenuManager(plus);
        const bar = {actor, tabs, scroll, plus, minimize, freeSpace, moveHandle,
            menuManager, keys: [], buttons: []};
        scroll.connect('scroll-event', (_actor, event) => this._scrollTabs(bar, group, event));
        scroll.hadjustment.connect('changed', () => this._revealActiveTab(bar, group));
        bar.closeContext = () => {
            const context = bar.contextMenu;
            bar.contextMenu = null;
            bar.contextWindow = null;
            if (context) {
                context.close({animate: false});
                context.destroy();
            }
        };
        let actorAlive = true;
        actor.connect('destroy', () => { actorAlive = false; });
        plus.connect('clicked', () => this._openNewTab(bar, group));
        bar.destroy = () => {
            bar.closeContext();
            this._closeNewTab(bar);
            if (actorAlive) {
                Main.layoutManager.untrackChrome(actor);
                actor.destroy();
            }
        };
        return bar;
    }

    _updateTabs(bar, group) {
        const changed = bar.keys.length !== group.members.length ||
            bar.keys.some((key, i) => key !== group.members[i]);
        if (changed) {
            bar.closeContext();
            bar.tabs.destroy_all_children();
            bar.keys = [...group.members];
            bar.buttons = group.members.map(window => {
                const container = new St.BoxLayout({style_class: 'universal-tabs-tab'});
                const button = new St.Button({
                    style_class: 'universal-tabs-select', can_focus: true, x_expand: true,
                    accessible_name: window.get_title() ?? this._title(window),
                });
                const content = new St.BoxLayout({style_class: 'universal-tabs-label', x_expand: true,
                    x_align: Clutter.ActorAlign.FILL});
                const app = this._tracker.get_window_app(window);
                const icon = app?.create_icon_texture(16) ?? new St.Icon({
                    icon_name: 'application-x-executable-symbolic', icon_size: 16});
                icon.y_align = Clutter.ActorAlign.CENTER;
                const label = new St.Label({text: this._title(window), x_expand: true,
                    x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.clutter_text.set_line_alignment(Pango.Alignment.LEFT);
                content.add_child(icon);
                content.add_child(label);
                button.set_child(content);
                button.connect('clicked', () => this._select(window));
                this._addTooltip(button, () => `${window.get_title() ?? this._title(window)}\nDouble-click to maximize or restore; right-click for options${this._preferences.scrollSwitchesTabs ? '\nMouse wheel switches tabs' : ''}`);
                const contextClick = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY,
                    recognize_on_press: true});
                contextClick.connect('recognize', () => this._showTabMenu(window, button, bar));
                button.add_action(contextClick);
                const contextKeys = new Clutter.KeyController();
                contextKeys.connect('key-press', () => {
                    const [, symbol] = contextKeys.get_key();
                    if (symbol === Clutter.KEY_Menu || (symbol === Clutter.KEY_F10 &&
                        (contextKeys.get_state() & Clutter.ModifierType.SHIFT_MASK))) {
                        this._showTabMenu(window, button, bar);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                button.add_action(contextKeys);
                this._doubleClick(button, () => {
                    const record = this._model.windows.get(window);
                    if (!record)
                        return;
                    this._select(window);
                    this._toggleMaximized(record.group);
                });
                const close = new St.Button({
                    style_class: 'universal-tabs-close', can_focus: true,
                    accessible_name: `Close ${this._title(window)}`,
                    child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 10}),
                });
                close.connect('clicked', () => window.delete(global.get_current_time()));
                this._addTooltip(close, () => `Close ${this._title(window)}`);
                container.add_child(button);
                container.add_child(close);
                button._delegate = {
                    universalTabs: this,
                    getDragActor: () => {
                        const dark = this._appearance.get_string('color-scheme') === 'prefer-dark';
                        const clone = new St.BoxLayout({style_class: `universal-tabs-strip ${dark ? 'dark' : 'light'}`});
                        clone.add_child(new St.Label({
                            text: this._title(window),
                            style: `max-width: ${this._preferences.preferredTabWidth}px;`,
                            style_class: 'universal-tabs-tab universal-tabs-drag',
                        }));
                        this._dragActor = clone;
                        clone.connect('destroy', () => {
                            if (this._dragActor === clone)
                                this._dragActor = null;
                        });
                        return clone;
                    },
                    getDragActorSource: () => button,
                };
                const drag = DND.makeDraggable(button);
                drag.connect('drag-begin', () => {
                    this._hideTooltip();
                    this._drag = {window, drop: null};
                });
                drag.connect('drag-end', () => {
                    const pending = this._drag;
                    this._drag = null;
                    this._later(() => {
                        if (pending?.drop && this._model.windows.has(pending.window)) {
                            const {x, y, group: target, index} = pending.drop;
                            if (target)
                                this._join(pending.window, target, index);
                            else
                                this._detach(pending.window, x - 40, y + TAB_HEIGHT);
                        }
                        this._reconcile();
                    });
                });
                bar.tabs.add_child(container);
                return {button, label, close, container, content, icon, app, window};
            });
        }
        for (const item of bar.buttons) {
            const {button, label, close, container, window} = item;
            const app = this._tracker.get_window_app(window);
            if (app !== item.app) {
                item.icon.destroy();
                item.icon = app?.create_icon_texture(16) ?? new St.Icon({
                    icon_name: 'application-x-executable-symbolic', icon_size: 16});
                item.icon.y_align = Clutter.ActorAlign.CENTER;
                item.content.insert_child_at_index(item.icon, 0);
                item.app = app;
            }
            label.text = this._title(window);
            button.accessible_name = window.get_title() ?? label.text;
            close.accessible_name = `Close ${label.text}`;
            close.reactive = window.can_close();
            container.set_width(bar.tabWidth);
            if (window === group.active && !bar.page)
                container.add_style_class_name('active');
            else
                container.remove_style_class_name('active');
        }
        if (changed || bar.lastActive !== group.active || bar.lastTabWidth !== bar.tabWidth || bar.lastPage !== !!bar.page)
            this._revealActiveTab(bar, group);
        bar.lastActive = group.active;
        bar.lastTabWidth = bar.tabWidth;
        bar.lastPage = !!bar.page;
        bar.actor.set_style_pseudo_class(null);
    }

    _revealActiveTab(bar, group) {
        if (!this._enabled || bar.page || !bar.tabWidth || !this._model.groups.has(group))
            return;
        const adjustment = bar.scroll.hadjustment;
        const start = group.members.indexOf(group.active) * bar.tabWidth;
        const end = start + bar.tabWidth;
        if (start < adjustment.value)
            adjustment.value = start;
        else if (end > adjustment.value + adjustment.page_size)
            adjustment.value = end - adjustment.page_size;
    }

    _scrollTabs(bar, group, event) {
        if (!this._enabled || !this._preferences.scrollSwitchesTabs || this._drag || !this._model.groups.has(group))
            return Clutter.EVENT_PROPAGATE;
        if (event.is_pointer_emulated())
            return Clutter.EVENT_STOP;
        let step;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            const now = GLib.get_monotonic_time() / 1000;
            if (!delta) {
                bar.wheelDelta = 0;
                return Clutter.EVENT_STOP;
            }
            if (now - (bar.wheelTime ?? 0) > 250 || Math.sign(delta) !== Math.sign(bar.wheelDelta ?? 0))
                bar.wheelDelta = 0;
            bar.wheelTime = now;
            bar.wheelDelta = (bar.wheelDelta ?? 0) + delta;
            if (Math.abs(bar.wheelDelta) < 1)
                return Clutter.EVENT_STOP;
            step = Math.sign(bar.wheelDelta);
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        bar.wheelDelta = 0;
        this._hideTooltip();
        // Selecting a real tab dismisses New tab. Defer that destruction until
        // scroll dispatch ends, and resolve the current tab for every notch.
        this._later(() => {
            if (!this._preferences.scrollSwitchesTabs || !this._model.groups.has(group) || this._bars.get(group) !== bar || this._drag)
                return;
            if (bar.page && step > 0)
                return;
            const current = bar.page ? group.members.length : group.members.indexOf(group.active);
            const next = Math.max(0, Math.min(group.members.length - 1, current + step));
            if (bar.page || next !== current)
                this._select(group.members[next]);
        });
        return Clutter.EVENT_STOP;
    }

    _targetGroup(actor) {
        for (let current = actor; current; current = current.get_parent()) {
            if (current._universalTabsGroup && this._bars.has(current._universalTabsGroup))
                return current._universalTabsGroup;
        }
        return null;
    }

    _dropIndex(group, x) {
        const bar = this._bars.get(group);
        if (!bar)
            return 0;
        for (let i = 0; i < bar.buttons.length; i++) {
            const {container} = bar.buttons[i];
            const [left] = container.get_transformed_position();
            if (x < left + container.width / 2)
                return i;
        }
        return group.members.length;
    }

    _openNewTab(bar, group) {
        this._hideTooltip();
        bar.closeContext();
        if (bar.page) {
            bar.page.search.grab_key_focus();
            return;
        }
        const actor = new St.BoxLayout({style_class: 'universal-tabs-page',
            orientation: Clutter.Orientation.VERTICAL, reactive: true, clip_to_allocation: true});
        const header = new St.BoxLayout({style_class: 'universal-tabs-page-header'});
        const heading = new St.Label({text: 'New tab', style_class: 'universal-tabs-page-heading'});
        header.add_child(heading);
        actor.add_child(header);
        const search = new St.Entry({hint_text: 'Search windows and applications…', can_focus: true,
            style_class: 'search-entry universal-tabs-search', x_expand: true});
        actor.add_child(search);
        const status = new St.Label({text: '', style_class: 'universal-tabs-page-status',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true, can_focus: true});
        status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        status.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);
        status.visible = false;
        status.connect('notify::text', () => { status.visible = !!status.text; });
        this._addTooltip(status, () => status.text);
        header.add_child(status);
        const scroll = new St.ScrollView({x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        const results = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'universal-tabs-page-results', x_expand: true});
        scroll.set_child(results);
        actor.add_child(scroll);
        const settingsLink = new St.Button({label: 'Settings',
            style_class: 'universal-tabs-settings-link', can_focus: true,
            x_align: Clutter.ActorAlign.START, accessible_name: `${this._extension.metadata.name} Settings`});
        settingsLink.connect('clicked', () => {
            this._openSettings();
        });
        this._addTooltip(settingsLink, `Open ${this._extension.metadata.name} Settings`);
        actor.add_child(settingsLink);
        const tab = new St.BoxLayout({style_class: 'universal-tabs-tab active', width: 112, reactive: true});
        const select = new St.Button({label: 'New tab', style_class: 'universal-tabs-select',
            can_focus: true, x_expand: true});
        select.connect('clicked', () => search.grab_key_focus());
        this._doubleClick(select, () => this._toggleMaximized(group));
        this._addTooltip(select, 'New tab\nDouble-click to maximize or restore');
        const close = new St.Button({style_class: 'universal-tabs-close', can_focus: true,
            accessible_name: 'Close new tab', child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 10})});
        close.connect('clicked', () => this._later(() => {
            this._closeNewTab(bar);
            group.active.activate(global.get_current_time());
        }));
        this._addTooltip(close, 'Close new tab');
        tab.add_child(select);
        tab.add_child(close);
        tab.connect('scroll-event', (_actor, event) => this._scrollTabs(bar, group, event));
        bar.actor.insert_child_below(tab, bar.plus);
        const page = {actor, tab, search, status, settingsLink, results, scroll, signature: null, items: [], rows: []};
        bar.page = page;
        search.clutter_text.connect('text-changed', () => this._queueRender());
        actor.connect('captured-event', (_actor, event) => this._newTabKey(bar, group, page, event));
        page.adjustmentSignal = scroll.vadjustment.connect('changed', () => {
            if (bar.page !== page)
                return;
            const focus = global.stage.get_key_focus();
            const item = page.items.find(entry => entry.button === focus || (focus && entry.button.contains(focus)));
            if (item)
                this._revealPageItem(page, item.button);
        });
        global.window_group.add_child(actor);
        Main.layoutManager.trackChrome(actor);
        // The parent window stays behind the page as its geometry anchor. No
        // application window is reparented or represented by a fake Meta.Window.
        group.active.activate(global.get_current_time());
        this._queueRender();
        this._later(() => { if (bar.page === page) search.grab_key_focus(); });
    }

    _newTabKey(bar, group, page, event) {
        if (bar.page !== page || event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        if (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const focus = global.stage.get_key_focus();
        const search = focus === page.search || (focus && page.search.contains(focus));
        const items = page.items.filter(item => item.button.reactive && item.button.can_focus);
        const index = items.findIndex(item => item.button === focus || (focus && item.button.contains(focus)));
        if (symbol === Clutter.KEY_Escape) {
            this._later(() => {
                if (bar.page === page) {
                    this._closeNewTab(bar);
                    group.active.activate(global.get_current_time());
                }
            });
        } else if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const chain = [page.search, ...items.map(item => item.button)];
            if (page.status.visible)
                chain.push(page.status);
            chain.push(page.settingsLink);
            const current = search ? 0 : index >= 0 ? index + 1 : chain.indexOf(focus);
            const step = symbol === Clutter.KEY_ISO_Left_Tab || (state & Clutter.ModifierType.SHIFT_MASK) ? -1 : 1;
            chain[(Math.max(0, current) + step + chain.length) % chain.length].grab_key_focus();
        } else if ([Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right].includes(symbol)) {
            // Left/right retain normal cursor editing in the search entry.
            if (search && (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right ||
                (state & Clutter.ModifierType.SHIFT_MASK)))
                return Clutter.EVENT_PROPAGATE;
            if (!items.length)
                return Clutter.EVENT_STOP;
            if (search || index < 0) {
                items[symbol === Clutter.KEY_Up ? items.length - 1 : 0].button.grab_key_focus();
            } else if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
                items[Math.max(0, Math.min(items.length - 1, index + (symbol === Clutter.KEY_Left ? -1 : 1)))].button.grab_key_focus();
            } else {
                const item = items[index];
                const row = item.row + (symbol === Clutter.KEY_Up ? -1 : 1);
                if (row < 0)
                    page.search.grab_key_focus();
                else if (row < page.rows.length) {
                    const target = page.rows[row][Math.min(item.column, page.rows[row].length - 1)];
                    if (target.button.reactive)
                        target.button.grab_key_focus();
                }
            }
        } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (index >= 0)
                items[index].activate();
            else if (search && page.search.text.trim() && items.length)
                items[0].activate();
            else
                return Clutter.EVENT_PROPAGATE;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _revealPageItem(page, button) {
        if (!button.mapped || !page.scroll.mapped)
            return;
        const [, y] = button.get_transformed_position();
        const [, top] = page.scroll.get_transformed_position();
        const [, height] = button.get_transformed_size();
        const adjustment = page.scroll.vadjustment;
        if (button === page.items[0]?.button && y - top + height + adjustment.value <= page.scroll.height)
            adjustment.value = 0;
        else if (y < top)
            adjustment.value += y - top;
        else if (y + height > top + page.scroll.height)
            adjustment.value += y + height - top - page.scroll.height;
    }

    _closeNewTab(bar) {
        const page = bar?.page;
        if (!page)
            return;
        bar.page = null;
        if (page.pending && this._sources.delete(page.pending.timer)) {
            GLib.source_remove(page.pending.timer);
        }
        page.scroll.vadjustment.disconnect(page.adjustmentSignal);
        Main.layoutManager.untrackChrome(page.actor);
        page.actor.destroy();
        page.tab.destroy();
        this._queueRender();
    }

    _fillNewTab(bar, group) {
        const page = bar.page;
        const query = page.search.text.trim().toLocaleLowerCase();
        const columns = Math.max(1, Math.min(MAX_APP_COLUMNS,
            Math.floor((group.active.get_frame_rect().width - 48) / 112)));
        const windows = [...this._model.windows.keys()].filter(window =>
            this._model.windows.get(window).group !== group && !window.is_fullscreen());
        const signature = JSON.stringify([query, columns, this._appsGeneration,
            !!page.pending, windows.map(window => [window.get_stable_sequence(), this._title(window)])]);
        if (signature === page.signature)
            return;
        const focus = global.stage.get_key_focus();
        const focusedItem = page.items.find(item => item.button === focus || (focus && item.button.contains(focus)));
        page.signature = signature;
        page.items = [];
        page.rows = [];
        page.results.destroy_all_children();
        const apps = this._appSystem.get_installed().filter(info => info.should_show())
            .map(info => this._appSystem.lookup_app(info.get_id())).filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        for (const [kind, heading, entries] of [['windows', 'Open windows', windows], ['apps', 'New window', apps]]) {
            const isApp = kind === 'apps';
            const section = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'universal-tabs-page-section', x_expand: true});
            page[kind + 'Section'] = section;
            section.add_child(new St.Label({text: heading, style_class: 'universal-tabs-section-heading'}));
            page.results.add_child(section);
            const grid = isApp ? new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style_class: 'universal-tabs-app-grid', x_align: Clutter.ActorAlign.CENTER}) : null;
            if (grid) {
                page.appsGrid = grid;
                section.add_child(grid);
            }
            let row;
            let count = 0;
            for (const entry of entries) {
                const app = isApp ? entry : this._tracker.get_window_app(entry);
                const title = isApp ? app.get_name() : this._title(entry);
                const info = app?.get_app_info();
                const haystack = [title, app?.get_name(), app?.get_id(),
                    info?.get_description(), ...(info?.get_keywords() ?? [])].join(' ').toLocaleLowerCase();
                if (query && !haystack.includes(query))
                    continue;
                const content = new St.BoxLayout({orientation: isApp
                    ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
                    style_class: 'universal-tabs-page-item-content', x_expand: true});
                const icon = app?.create_icon_texture(isApp ? 48 : 32) ??
                    new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 32});
                icon.x_align = Clutter.ActorAlign.CENTER;
                icon.y_align = Clutter.ActorAlign.CENTER;
                content.add_child(icon);
                const label = new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER,
                    x_align: isApp ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    x_expand: true});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                content.add_child(label);
                const button = new St.Button({style_class: 'universal-tabs-page-item', child: content,
                    can_focus: !page.pending, reactive: !page.pending, accessible_name: title,
                    x_expand: !isApp, width: isApp ? 104 : -1});
                this._addTooltip(button, isApp
                    ? `Open ${title}${info?.get_description() ? '\n' + info.get_description() : ''}`
                    : `Add ${title} to this group`);
                // Defer changes that destroy the clicked actor until dispatch ends.
                const activate = () => this._later(() => {
                    if (bar.page !== page || !this._model.groups.has(group) || page.pending)
                        return;
                    if (isApp)
                        this._launchApp(bar, group, app);
                    else if (this._model.windows.has(entry))
                        this._join(entry, group);
                });
                button.connect('clicked', activate);
                button.connect('key-focus-in', () => this._revealPageItem(page, button));
                if (isApp) {
                    if (count % columns === 0) {
                        row = new St.BoxLayout({style_class: 'universal-tabs-app-row'});
                        grid.add_child(row);
                        page.rows.push([]);
                    }
                    row.add_child(button);
                } else {
                    section.add_child(button);
                    page.rows.push([]);
                }
                count++;
                const item = {button, app, window: isApp ? null : entry, activate,
                    row: page.rows.length - 1, column: page.rows.at(-1).length};
                page.rows.at(-1).push(item);
                page.items.push(item);
            }
            if (!count) {
                const text = query ? 'No matches in this section.'
                    : isApp ? 'No applications found.' : 'No other open windows.';
                section.add_child(new St.Label({text, style_class: 'universal-tabs-page-status'}));
            }
        }
        if (!page.pending)
            page.status.text = !page.items.length && query ? 'No matches found.' : '';
        if (focusedItem) {
            const replacement = page.items.find(item => item.window === focusedItem.window &&
                (item.window || item.app.get_id() === focusedItem.app.get_id()));
            this._later(() => {
                if (bar.page === page)
                    (replacement?.button.reactive ? replacement.button : page.search).grab_key_focus();
            });
        }
    }

    _launchApp(bar, group, app) {
        const page = bar.page;
        if (!page || page.pending)
            return;
        const existing = app.get_windows().filter(window => this._model.windows.has(window));
        if (!app.can_open_new_window() && existing.length) {
            if (group.members.includes(existing[0]))
                this._select(existing[0]);
            else
                this._join(existing[0], group);
            return;
        }
        const info = app.get_app_info?.();
        const pending = {appId: app.get_id(), name: app.get_name(),
            before: new Set(global.get_window_actors().map(actor => actor.meta_window)),
            beforeSequences: new Set((this._tracker.get_startup_sequences() ?? []).map(sequence => sequence.get_id())),
            startupIds: new Set(), wmClass: info?.get_startup_wm_class()?.toLowerCase(),
            // Simple legacy app names can identify a backend such as
            // Ventoy2Disk.gtk3 after VentoyGUI hands the launch off.
            families: [app.get_name(), app.get_id().replace(/\.desktop$/, '')]
                .filter(name => /^[a-z0-9][a-z0-9_-]{3,}$/i.test(name)).map(name => name.toLowerCase())};
        pending.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
            this._sources.delete(pending.timer);
            if (bar.page === page && page.pending === pending) {
                page.pending = null;
                // Keep the explanatory message when the buttons are re-enabled.
                page.signature = null;
                this._fillNewTab(bar, group);
                page.status.text = `Could not identify ${app.get_name()}'s window. It may have opened separately; check Open windows.`;
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(pending.timer);
        page.pending = pending;
        page.status.text = `Opening ${app.get_name()}…`;
        this._queueRender();
        try {
            app.open_new_window(group.active.get_workspace().index());
        } catch (error) {
            GLib.source_remove(pending.timer);
            this._sources.delete(pending.timer);
            page.pending = null;
            this._fillNewTab(bar, group);
            page.status.text = `Could not open ${app.get_name()}: ${error.message}`;
        }
    }

    _matchLaunches() {
        const windows = global.get_window_actors().map(actor => actor.meta_window);
        for (const [group, bar] of this._bars) {
            const pending = bar.page?.pending;
            if (!pending || !this._model.groups.has(group))
                continue;
            for (const window of windows) {
                // Window-created precedes initial Wayland placement and size
                // negotiation. Joining before mapping loses the shared size.
                if (!window.mapped || !window.get_compositor_private()?.mapped ||
                    pending.before.has(window) || window.is_override_redirect() ||
                    ![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
                        Meta.WindowType.UTILITY].includes(window.get_window_type()))
                    continue;
                const direct = this._tracker.get_window_app(window)?.get_id() === pending.appId;
                // A startup token or an unambiguous legacy class is sufficient
                // to acknowledge a separate window, never to force it into a group.
                const separate = !direct && this._matchesSeparateLaunch(pending, window) &&
                    [...this._bars.values()].filter(other => other.page?.pending &&
                        !other.page.pending.before.has(window) &&
                        this._matchesSeparateLaunch(other.page.pending, window)).length === 1;
                if (!direct && !separate)
                    continue;
                // Concurrent requests must never adopt the same mapped window,
                // including on a later render after the first request finishes.
                for (const other of this._bars.values())
                    other.page?.pending?.before.add(window);
                if (direct && this._model.windows.has(window) && !window.is_fullscreen()) {
                    this._join(window, group);
                } else {
                    this._closeNewTab(bar);
                    Main.notify(`${pending.name} opened separately`,
                        'Its window is outside this tab group.');
                }
                break;
            }
        }
    }

    _matchesSeparateLaunch(pending, window) {
        if (pending.startupIds.has(window.get_startup_id()))
            return true;
        const app = this._tracker.get_window_app(window);
        if (app && !app.is_window_backed())
            return false;
        // Do not infer a launch from titles, timing alone, or an unrelated
        // registered app. Legacy fallback applies only to normal app windows.
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        const ids = [window.get_wm_class(), window.get_wm_class_instance(), window.get_gtk_application_id()]
            .filter(Boolean).map(id => id.toLowerCase());
        if (pending.wmClass && ids.includes(pending.wmClass))
            return true;
        return ids.some(id => id.split('.').some(part => pending.families.some(name =>
            part === name || (part.startsWith(name) && /^[0-9_-]/.test(part.slice(name.length))))));
    }

    _showTabMenu(window, button, bar) {
        this._hideTooltip();
        const record = this._model.windows.get(window);
        if (!record || this._drag)
            return;
        bar.closeContext();
        const {group} = record;
        const index = group.members.indexOf(window);
        const menu = new PopupMenu.PopupMenu(button, 0, St.Side.TOP);
        bar.contextMenu = menu;
        bar.contextWindow = window;
        menu.actor.connect('destroy', () => {
            if (bar.contextMenu === menu) {
                bar.contextMenu = null;
                bar.contextWindow = null;
            }
        });
        bar.menuManager.addMenu(menu);
        Main.layoutManager.addChrome(menu.actor);
        const monitor = Main.layoutManager.findMonitorForActor(button) ?? Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        menu.actor.set_style(`max-height: ${Math.max(120, area.height / scale - 16)}px;`);
        menu.actor.hide();
        const action = (label, callback, sensitive = true) => {
            const item = menu.addAction(label, () => {
                menu.close({animate: false});
                // Changing membership destroys tab actors. Wait until PopupMenu
                // has finished dispatching activation before mutating the group.
                this._later(() => {
                    if (this._model.windows.has(window))
                        callback(this._model.windows.get(window).group);
                });
            });
            item.setSensitive(sensitive);
        };
        action('Detach tab', current => {
            if (current.members.length > 1) {
                const rect = current.active.get_frame_rect();
                this._detach(window, rect.x + 40, rect.y + 40);
            }
        }, group.members.length > 1);
        const reorder = direction => current => {
            const active = current.active;
            const from = current.members.indexOf(window);
            this._model.move(window, current, direction < 0 ? from - 1 : from + 2);
            this._model.activate(active);
            this._reconcile();
        };
        action('Move tab left', reorder(-1), index > 0);
        action('Move tab right', reorder(1), index < group.members.length - 1);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        action(group.active.is_maximized() ? 'Restore group' : 'Maximize group', current => {
            this._select(window);
            this._toggleMaximized(current);
        }, window.can_maximize() || window.is_maximized());
        action('Minimize group', current => current.active.minimize(), group.active.can_minimize());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addSettingsMenu(menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        action('Ungroup all windows', () => {
            for (const current of [...this._model.groups]) {
                for (const [offset, member] of [...current.members].entries())
                    this._model.detach(member, current.x + offset * 32, current.y + offset * 32);
            }
            this._reconcile();
        });
        menu.addAction(`Disable ${this._extension.metadata.name}`, () => {
            menu.close({animate: false});
            this._later(() => Main.extensionManager.disableExtension(this.uuid));
        });
        menu.open();
    }

    disable() {
        if (!this._enabled)
            return;
        if (Main.sessionMode.isLocked && this._model) {
            this._extension._universalTabsLockSnapshot = JSON.stringify(
                this._model.snapshot(window => window.get_stable_sequence()));
        } else if (!this._extension._enabled) {
            // Explicit disable resets groups. Runtime swaps keep the lock
            // recovery data available in case an unlock-time update fails.
            delete this._extension._universalTabsLockSnapshot;
        }
        this._enabled = false;
        this._closeSettings();
        this._hideTooltip();
        this._tooltipActor?.destroy();
        this._tooltipActor = null;
        this._restoreMaximizeAnimation();
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._drag = null;
        // Destroying the clone lets Shell's DND release its modal input grab.
        this._dragActor?.destroy();
        this._dragActor = null;
        for (const id of this._sources ?? [])
            GLib.source_remove(id);
        this._sources?.clear();
        this._renderSource = 0;
        this._disconnect(this._signals ?? []);
        for (const signals of this._windowSignals?.values() ?? [])
            this._disconnect(signals);
        for (const window of this._windowSignals?.keys() ?? []) {
            window.remove_external_constraint(this._constraint);
            if (window.is_maximized()) {
                const frame = window.get_frame_rect();
                window.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
            }
        }
        this._windowSignals?.clear();
        this._constraint = null;
        for (const bar of this._bars?.values() ?? [])
            bar.destroy();
        this._bars?.clear();
        // Never unminimize a window the user had minimized independently.
        for (const window of this._hidden ?? []) {
            try {
                window.unminimize();
            } catch (error) {
                console.error(`[Universal Tabs] Restoring window: ${error}`);
            }
        }
        this._hidden?.clear();
        this._instantRestores?.clear();
        this._settingsSwitches?.clear();
        this._preferencesFile = null;
        this._preferences = null;
        try {
            this._restoreNativeControls();
        } catch (error) {
            console.error(`[Universal Tabs] Window button recovery: ${error}`);
        }
        this._controlsSettings = null;
        this._controlsBackup = null;
        this._tracker = null;
        this._appSystem = null;
        this._appearance = null;
        this._model = null;
        this._extension = null;
        this._signals = [];
    }
}

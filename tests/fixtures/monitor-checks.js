import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Run only on the private two-output compositor (--monitors-only).
export async function runMonitorChecks({bootstrap, large, small, manual, windowActions, pointer,
    checks, assert, until, delay, clickTab, screenshot}) {
    let ext = bootstrap.runtime;
    await until(() => Main.layoutManager.monitors.length === 2, 'two virtual monitors configured');
    const outputs = Main.layoutManager.monitors.map(monitor => monitor.index);
    const other = index => outputs.find(candidate => candidate !== index);
    const sameRect = (actual, expected) => ['x', 'y', 'width', 'height']
        .every(key => Math.abs(actual[key] - expected[key]) <= 1);
    const settled = async (window, description) => {
        // Native monitor moves intentionally retain GNOME's animation. Logical
        // monitor ownership can change before the clone/effect has finished.
        await delay(100);
        let previous;
        let stableFrames = 0;
        await until(() => {
            const actor = window.get_compositor_private();
            const rect = window.get_frame_rect();
            let complete = actor && !actor.__animationInfo && !Main.wm._resizing.has(actor) &&
                !Main.wm._resizePending.has(actor) && !Main.wm._minimizing.has(actor) &&
                !Main.wm._unminimizing.has(actor);
            if (window.is_maximized()) {
                const area = window.get_work_area_for_monitor(window.get_monitor());
                complete &&= sameRect(rect, {x: area.x, y: area.y + 30,
                    width: area.width, height: area.height - 30});
            }
            stableFrames = complete && previous && sameRect(rect, previous) ? stableFrames + 1 : 0;
            previous = rect;
            return stableFrames >= 2;
        }, description);
    };
    const stable = async (window, expected, monitor, maximized, description) => {
        for (let i = 0; i < 12; i++) {
            const rect = window.get_frame_rect();
            assert(window.get_monitor() === monitor && window.is_maximized() === maximized && sameRect(rect, expected),
                `${description}: monitor=${window.get_monitor()}, expectedMonitor=${monitor}, maximized=${window.is_maximized()}, frame=${JSON.stringify(rect)}, expected=${JSON.stringify(expected)}`);
            const group = ext._model.windows.get(window)?.group;
            const bar = ext._bars.get(group);
            const inset = maximized ? 0 : Math.min(12, Math.max(0, (rect.width - 120) / 2));
            if (bar?.actor.visible)
                assert(Math.abs(bar.actor.x - rect.x - inset) <= 1 && Math.abs(bar.actor.y + 30 - rect.y) <= 1,
                    `${description}: surviving strip must remain attached to its window`);
            await delay(40);
        }
    };
    const moveTo = async (window, monitor) => {
        window.move_to_monitor(monitor);
        await until(() => window.get_monitor() === monitor, 'native window moved to requested monitor');
        await settled(window, 'native monitor move animation and geometry settled');
    };
    const maximizeOn = async (window, monitor) => {
        await moveTo(window, monitor);
        window.maximize();
        await until(() => window.is_maximized() && window.get_monitor() === monitor,
            'window maximized on its source monitor');
        await settled(window, 'maximized native geometry settled');
    };
    const createExtra = async monitor => {
        const previous = new Set(ext._model.windows.keys());
        windowActions.activate_action('extra', null);
        await until(() => [...ext._model.windows.keys()].some(window => !previous.has(window) && window.mapped),
            'extra native window mapped for monitor regression');
        const window = [...ext._model.windows.keys()].find(candidate => !previous.has(candidate));
        await until(() => window.get_compositor_private()?.mapped, 'extra native actor mapped');
        await moveTo(window, monitor);
        return window;
    };
    const closeTab = async window => {
        const group = ext._model.windows.get(window).group;
        await settled(group.active, 'active native actor settled before pointer close');
        await until(() => {
            const bar = ext._bars.get(group);
            const rect = group.active.get_frame_rect();
            const close = bar?.buttons.find(item => item.window === window)?.close;
            const inset = group.active.is_maximized() ? 0 : Math.min(12, Math.max(0, (rect.width - 120) / 2));
            return close?.mapped && close.width > 0 && close.height > 0 && bar.actor.visible &&
                Math.abs(bar.actor.x - rect.x - inset) <= 1 && Math.abs(bar.actor.y + 30 - rect.y) <= 1;
        }, 'close target tab mapped and allocated on the current monitor');
        const tab = ext._bars.get(group).buttons.find(item => item.window === window);
        const [x, y] = tab.close.get_transformed_position();
        const frame = group.active.get_frame_rect();
        assert(x >= frame.x && x + tab.close.width <= frame.x + frame.width &&
            y >= frame.y - 30 && y + tab.close.height <= frame.y,
            `real close button must lie within the active window tab strip: button=${x},${y},${tab.close.width},${tab.close.height}, frame=${JSON.stringify(frame)}`);
        const px = Math.round(x + tab.close.width / 2);
        const py = Math.round(y + tab.close.height / 2);
        for (let i = 0; i < 2; i++) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), px, py);
            await delay(100);
        }
        const [pointerX, pointerY] = global.get_pointer();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, pointerX, pointerY);
        const pickPath = actor => {
            const path = [];
            for (let current = actor; current && path.length < 6; current = current.get_parent())
                path.push(`${current.constructor.name}:${current.get_name() ?? ''}:${current.get_style_class_name?.() ?? ''}`);
            return path;
        };
        assert(Math.abs(pointerX - px) <= 1 && Math.abs(pointerY - py) <= 1,
            `virtual pointer must reach close button after crossing outputs: target=${px},${py}, actual=${pointerX},${pointerY}, picked=${JSON.stringify(pickPath(picked))}`);
        assert(picked === tab.close || (picked && tab.close.contains(picked)),
            `close button must receive native pointer picking: target=${px},${py}, picked=${JSON.stringify(pickPath(picked))}`);
        await screenshot();
        let clicked = false;
        let alive = true;
        const clickedSignal = tab.close.connect('clicked', () => { clicked = true; });
        const destroyedSignal = tab.close.connect('destroy', () => { alive = false; });
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await delay(100);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await delay(100);
        const afterPointer = global.get_pointer();
        const afterPick = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, afterPointer[0], afterPointer[1]);
        console.log(`[Universal Tabs monitor test] real tab X: ${JSON.stringify({title: window.get_title(),
            clicked, alive, target: [px, py], pointer: afterPointer.slice(0, 2), picked: pickPath(afterPick)})}`);
        if (alive) {
            tab.close.disconnect(clickedSignal);
            tab.close.disconnect(destroyedSignal);
        }
        assert(clicked, `real tab X must emit clicked before native close: pointer=${afterPointer.slice(0, 2)}, picked=${JSON.stringify(pickPath(afterPick))}`);
        await delay(500);
        await until(() => !ext._model.windows.has(window), 'real tab X closes its native window');
    };
    const closeNative = async window => {
        await settled(window, 'native close target geometry and effects settled');
        window.activate(global.get_current_time());
        await until(() => global.display.focus_window === window, 'native close target focused');
        const keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        for (const [key, state] of [[Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED],
            [Clutter.KEY_F4, Clutter.KeyState.PRESSED], [Clutter.KEY_F4, Clutter.KeyState.RELEASED],
            [Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED]]) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, state);
            await delay(30);
        }
        await until(() => !ext._model.windows.has(window), 'native Alt+F4 closes its focused window');
    };

    // Both apps retain native maximize state while hidden. An active window
    // can move to another output without moving its minimized maximized peer.
    await maximizeOn(large, outputs[0]);
    await maximizeOn(small, outputs[1]);
    let group = ext._model.windows.get(large).group;
    ext._join(small, group);
    await settled(small, 'initial incoming maximized tab settles before switching back');
    ext._select(large);
    await settled(large, 'initial active maximized tab settles after switching');
    const target = other(small.get_monitor());
    await moveTo(large, target);
    await until(() => large.is_maximized() && small.is_maximized() && small.minimized,
        'cross-monitor maximized pair prepared');
    assert(large.get_monitor() !== small.get_monitor(), 'reproduction must leave the hidden maximized peer on another output');
    const maximizedRect = large.get_frame_rect();
    const workArea = large.get_work_area_for_monitor(target);
    assert(maximizedRect.y === workArea.y + 30 && maximizedRect.height === workArea.height - 30,
        'source maximized viewport must reserve exactly one tab strip');
    await closeTab(large);
    await until(() => !small.minimized, 'surviving maximized member revealed');
    await stable(small, maximizedRect, target, true, 'closing active tab preserves the group monitor and maximized viewport');
    checks.push('real active-tab close keeps a maximized survivor on the group monitor even when its native hidden window remained on another output');

    // Closing an inactive app must not change the active window or its monitor.
    let background = await createExtra(other(small.get_monitor()));
    await maximizeOn(background, background.get_monitor());
    group = ext._model.windows.get(small).group;
    ext._join(background, group);
    await settled(background, 'incoming maximized background tab settles before selecting counterpart');
    ext._select(small);
    await settled(small, 'selected maximized counterpart settles before monitor move');
    const activeMonitor = other(background.get_monitor());
    await moveTo(small, activeMonitor);
    const beforeInactiveClose = small.get_frame_rect();
    await closeTab(background);
    assert(ext._model.windows.get(small).group.active === small && !small.minimized,
        'closing an inactive tab must retain the selected native window');
    await stable(small, beforeInactiveClose, activeMonitor, true, 'closing inactive tab preserves active maximized window');
    checks.push('closing an inactive tab cannot move or restore the selected maximized group');

    // Repeat after GNOME's real mode-driven teardown, not a fabricated model
    // restore, so the monitor anchor must survive lock/unlock snapshots too.
    background = await createExtra(other(small.get_monitor()));
    await maximizeOn(background, background.get_monitor());
    group = ext._model.windows.get(small).group;
    ext._join(background, group);
    await settled(background, 'incoming lock-test tab settles before selecting counterpart');
    ext._select(small);
    await settled(small, 'selected lock-test tab settles before monitor move');
    const lockMonitor = other(background.get_monitor());
    await moveTo(small, lockMonitor);
    const beforeLock = small.get_frame_rect();
    const normalSize = {...ext._model.rect(small)};
    const retired = ext;
    Main.sessionMode.pushMode('unlock-dialog');
    await until(() => !bootstrap.runtime && !retired._model, 'monitor regression locks extension');
    Main.sessionMode.popMode('unlock-dialog');
    await until(() => bootstrap.runtime?._model, 'monitor regression unlocks extension');
    ext = bootstrap.runtime;
    group = ext._model.windows.get(small).group;
    await until(() => ext._bars.has(group), 'restored monitor group strip');
    assert(ext._model.windows.get(background).group === group && group.active === small &&
        group.width === normalSize.width && group.height === normalSize.height,
        'lock recovery must retain grouped windows, active tab, and normal viewport dimensions');
    await delay();
    await stable(small, beforeLock, lockMonitor, true, 'lock recovery preserves the maximized monitor');
    await closeNative(small);
    await until(() => !background.minimized, 'native close reveals saved-monitor peer');
    await stable(background, beforeLock, lockMonitor, true, 'native close after lock recovery preserves group monitor');
    checks.push('monitor state survives lock recovery and native Alt+F4 closes without moving the maximized survivor');

    // Floating windows must preserve the shared absolute rectangle as well.
    // The eventual survivor originates on the other output before joining.
    background.unmaximize();
    await until(() => !background.is_maximized(), 'floating regression anchor restored');
    const floatingMonitor = background.get_monitor();
    const floatingArea = background.get_work_area_for_monitor(floatingMonitor);
    background.move_resize_frame(true, floatingArea.x + 80, floatingArea.y + 120, 760, 420);
    await until(() => background.get_frame_rect().width === 760 && background.get_frame_rect().height === 420,
        'floating regression viewport configured');
    const floatingPeer = await createExtra(other(floatingMonitor));
    group = ext._model.windows.get(background).group;
    ext._join(floatingPeer, group);
    await until(() => floatingPeer.get_frame_rect().width === 760, 'floating peer adopts shared viewport');
    ext._select(background);
    await delay();
    const floatingRect = background.get_frame_rect();
    await closeNative(background);
    await until(() => !floatingPeer.minimized, 'floating survivor revealed after native close');
    await stable(floatingPeer, floatingRect, floatingMonitor, false, 'native floating close preserves shared viewport');
    checks.push('native floating close preserves the group rectangle when the last surviving tab originated on another display');
    assert(manual.minimized && !ext._hidden.has(manual), 'monitor-close recovery must not reveal an independently minimized window');
}

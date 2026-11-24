import {Groups} from '../groups.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

const model = new Groups();
const big = model.add('big', {x: 100, y: 100, width: 900, height: 600});
model.add('small', {x: 600, y: 300, width: 320, height: 200});
model.move('small', big.group);
assert(model.groups.size === 1, 'Joining should consume the empty source group');
assert(model.rect('small').width === 900, 'Joining must adopt the target group viewport');
assert(model.rect('small').x === 100, 'Joining should adopt the group position');
model.remember('small', {x: 250, y: 140, width: 350, height: 220});
model.activate('big');
assert(model.rect('big').width === 350, 'Switching must retain the current group viewport');
assert(model.rect('big').x === 250, 'Moving the small window should move the group anchor');
model.remember('small', {x: 999, y: 999, width: 1, height: 1});
assert(model.rect('big').x === 250, 'Inactive configure events must not move the group');
assert(model.rect('small').width === 350, 'Inactive configure events must not overwrite remembered size');
big.group.maximized = true;
model.remember('big', {x: 0, y: 32, width: 1920, height: 1048});
assert(model.rect('big').width === 350 && model.rect('big').x === 250,
    'Maximized geometry must not replace normal size or position');
big.group.maximized = false;

model.add('third', {x: 0, y: 0, width: 500, height: 400});
model.move('third', big.group, 0);
model.move('big', big.group, 3);
assert(big.group.members.join(',') === 'third,small,big', 'Reordering should preserve every member exactly once');
model.detach('big', 400, 250);
assert(model.groups.size === 2, 'Detach should create an independent window');
assert(big.group.active === 'big', 'Detached window should be selected in its own group');
const remaining = model.windows.get('small').group;
assert(remaining.active === 'small', 'Detaching the active tab should select a surviving neighbor');
model.remove('small');
assert(remaining.active === 'third', 'Closing an active tab should preserve a reachable neighbor');
model.remove('third');
model.remove('big');
assert(model.windows.size === 0 && model.groups.size === 0, 'Closing all windows must leave no stale groups');

const old = new Groups();
old.add('one', {x: 10, y: 20, width: 900, height: 600});
old.add('two', {x: 50, y: 60, width: 320, height: 240});
old.move('two', old.windows.get('one').group);
const fresh = new Groups();
fresh.add('one', {x: 0, y: 0, width: 1, height: 1});
fresh.add('two', {x: 0, y: 0, width: 1, height: 1});
fresh.add('new', {x: 0, y: 0, width: 500, height: 400});
fresh.restore(old.snapshot());
assert(fresh.groups.size === 2, 'Reload should retain new windows outside restored groups');
assert(fresh.windows.get('one').group === fresh.windows.get('two').group, 'Reload must preserve membership');
assert(fresh.windows.get('two').group.active === 'two', 'Reload must preserve active tab');
assert(fresh.rect('two').width === 900 && fresh.rect('one').width === 900, 'Reload must preserve the shared viewport');
old.windows.get('two').group.maximized = true;
fresh.restore(old.snapshot());
assert(fresh.windows.get('two').group.maximized, 'Reload must preserve group maximize state');
fresh.remove('two');
fresh.restore(old.snapshot());
assert(!fresh.windows.has('two'), 'Reload must not resurrect a closed window');
const migrated = new Groups();
migrated.add('large', {x: 0, y: 0, width: 1, height: 1});
migrated.add('small', {x: 0, y: 0, width: 1, height: 1});
migrated.restore([{x: 100, y: 200, active: 'small', members: [
    {key: 'large', width: 900, height: 600}, {key: 'small', width: 320, height: 240}]}]);
assert(migrated.rect('large').width === 320 && migrated.rect('small').width === 320,
    'Upgrading older snapshots must use the active tab size as the shared viewport');
print('PASS: shared viewport, movement, reordering, detach, close recovery, snapshots, and old-state migration');

// Lock recovery stores stable IDs, never native window references, and resolves
// them against the windows that are still open at unlock time.
const firstWindow = {id: 1};
const secondWindow = {id: 2};
const thirdWindow = {id: 3};
const beforeLock = new Groups();
for (const window of [firstWindow, secondWindow, thirdWindow])
    beforeLock.add(window, {x: 60, y: 120, width: 800, height: 500});
beforeLock.move(secondWindow, beforeLock.windows.get(firstWindow).group);
beforeLock.move(thirdWindow, beforeLock.windows.get(firstWindow).group);
const lockState = JSON.stringify(beforeLock.snapshot(window => window.id));
const liveFirst = {id: 1};
const liveSecond = {id: 2};
const liveNew = {id: 4};
const liveWindows = new Map([[1, liveFirst], [2, liveSecond], [4, liveNew]]);
const afterLock = new Groups();
for (const window of liveWindows.values())
    afterLock.add(window, {x: 0, y: 0, width: 400, height: 300});
afterLock.restore(JSON.parse(lockState), id => liveWindows.get(id));
const resumed = afterLock.windows.get(liveFirst).group;
assert(resumed === afterLock.windows.get(liveSecond).group && resumed.members.length === 2,
    'Lock recovery must resolve surviving windows and omit closed members');
assert(resumed.active === liveFirst && resumed.width === 800 && resumed.x === 60,
    'Closing the active window while locked must select a survivor and retain the viewport');
assert(afterLock.windows.get(liveNew).group !== resumed,
    'Windows opened while locked must keep their independent groups');
print('PASS: serialized lock recovery, closed active window, and windows opened during lock');

const displays = new Groups();
displays.add('left', {x: 100, y: 120, width: 800, height: 500}).group.monitor = 0;
displays.add('right', {x: 1400, y: 120, width: 800, height: 500}).group.monitor = 1;
const leftGroup = displays.windows.get('left').group;
displays.move('right', leftGroup);
leftGroup.maximized = true;
leftGroup.monitor = 1;
const displayState = JSON.parse(JSON.stringify(displays.snapshot()));
const restoredDisplays = new Groups();
restoredDisplays.add('left', {x: 0, y: 0, width: 1, height: 1}).group.monitor = 0;
restoredDisplays.add('right', {x: 0, y: 0, width: 1, height: 1}).group.monitor = 0;
restoredDisplays.restore(displayState);
const resumedDisplay = restoredDisplays.windows.get('right').group;
assert(resumedDisplay.monitor === 1 && resumedDisplay.x === 100 && resumedDisplay.maximized,
    'Reload must retain the maximized monitor separately from the normal restore rectangle');
restoredDisplays.remove('right');
assert(resumedDisplay.active === 'left' && resumedDisplay.monitor === 1,
    'Closing the active tab must retain the group monitor for its survivor');
const legacyDisplays = new Groups();
legacyDisplays.add('left', {x: 0, y: 0, width: 1, height: 1}).group.monitor = 0;
legacyDisplays.add('right', {x: 1400, y: 0, width: 1, height: 1}).group.monitor = 1;
delete displayState[0].monitor;
legacyDisplays.restore(displayState);
assert(legacyDisplays.windows.get('left').group.monitor === 1,
    'Old snapshots must use their saved active window monitor rather than the first member monitor');
print('PASS: monitor ownership survives close/reload and old snapshots retain the active display');

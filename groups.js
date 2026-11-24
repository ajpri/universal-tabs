// Window-independent group state. A group owns one position and viewport size.
export class Groups {
    constructor() {
        this.windows = new Map();
        this.groups = new Set();
    }

    add(key, rect) {
        if (this.windows.has(key))
            return this.windows.get(key);
        const group = {members: [key], active: key, x: rect.x, y: rect.y,
            width: rect.width, height: rect.height, normalKnown: true, maximized: false, monitor: null};
        const record = {group, width: rect.width, height: rect.height, normalKnown: true};
        this.groups.add(group);
        this.windows.set(key, record);
        return record;
    }

    remember(key, rect) {
        const record = this.windows.get(key);
        if (!record || record.group.active !== key || record.group.maximized)
            return;
        record.width = rect.width;
        record.height = rect.height;
        record.group.x = rect.x;
        record.group.y = rect.y;
        record.group.width = rect.width;
        record.group.height = rect.height;
        record.group.normalKnown = true;
        record.normalKnown = true;
    }

    rect(key) {
        const record = this.windows.get(key);
        return {x: record.group.x, y: record.group.y,
            width: record.group.width, height: record.group.height};
    }

    activate(key) {
        const record = this.windows.get(key);
        if (record)
            record.group.active = key;
    }

    move(key, target, index = target.members.length) {
        const record = this.windows.get(key);
        if (!record || !this.groups.has(target))
            return;
        const source = record.group;
        const oldIndex = source.members.indexOf(key);
        source.members.splice(oldIndex, 1);
        if (source === target && oldIndex < index)
            index--;
        if (source.active === key)
            source.active = source.members[Math.min(oldIndex, source.members.length - 1)];
        if (!source.members.length && source !== target)
            this.groups.delete(source);
        target.members.splice(Math.max(0, Math.min(index, target.members.length)), 0, key);
        target.active = key;
        record.group = target;
    }

    detach(key, x, y) {
        const record = this.windows.get(key);
        if (!record)
            return;
        const target = {members: [], active: null, x, y, maximized: false,
            width: record.group.width, height: record.group.height, normalKnown: record.group.normalKnown,
            monitor: record.group.monitor};
        this.groups.add(target);
        this.move(key, target);
        return target;
    }

    remove(key) {
        const record = this.windows.get(key);
        if (!record)
            return;
        const {group} = record;
        const index = group.members.indexOf(key);
        group.members.splice(index, 1);
        if (group.active === key)
            group.active = group.members[Math.min(index, group.members.length - 1)];
        if (!group.members.length)
            this.groups.delete(group);
        this.windows.delete(key);
    }

    snapshot(keyFor = key => key) {
        return [...this.groups].map(group => ({
            x: group.x, y: group.y, active: keyFor(group.active), maximized: group.maximized, monitor: group.monitor,
            width: group.width, height: group.height, normalKnown: group.normalKnown,
            members: group.members.map(key => ({key: keyFor(key),
                width: this.windows.get(key).width,
                height: this.windows.get(key).height,
                normalKnown: this.windows.get(key).normalKnown})),
        }));
    }

    restore(snapshot, resolveKey = key => key) {
        // Windows opened during an update keep their singleton groups.
        for (const entry of snapshot) {
            const saved = {...entry, active: resolveKey(entry.active),
                members: entry.members.map(member => ({...member, key: resolveKey(member.key)}))};
            const members = saved.members.filter(member => this.windows.has(member.key));
            if (!members.length)
                continue;
            const maximized = saved.maximized ?? this.windows.get(saved.active)?.group.maximized ?? false;
            const active = members.find(member => member.key === saved.active) ?? members[0];
            const monitor = Number.isInteger(saved.monitor) && saved.monitor >= 0 ? saved.monitor
                : this.windows.get(active.key).group.monitor;
            const width = saved.width ?? active.width ?? this.windows.get(active.key).width;
            const height = saved.height ?? active.height ?? this.windows.get(active.key).height;
            const normalKnown = saved.normalKnown ?? active.normalKnown ?? this.windows.get(active.key).normalKnown;
            const target = this.windows.get(members[0].key).group;
            for (const member of members) {
                this.move(member.key, target);
                Object.assign(this.windows.get(member.key), {width: member.width, height: member.height});
                if (member.normalKnown !== undefined)
                    this.windows.get(member.key).normalKnown = member.normalKnown;
            }
            target.x = saved.x;
            target.y = saved.y;
            target.active = target.members.includes(saved.active) ? saved.active : target.members[0];
            target.maximized = maximized;
            target.monitor = monitor;
            target.width = width;
            target.height = height;
            target.normalKnown = normalKnown;
        }
    }
}

// Fictional GTK applications used only by --screenshots-only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

const kind = ARGV[0] ?? 'Browser';
const app = new Gtk.Application({application_id: `org.gnome.Extensions.UniversalTabsDemo.${kind}`});
const label = (text, css = '', extra = {}) => new Gtk.Label({label: text, xalign: 0,
    css_classes: css ? [css] : [], ...extra});
const box = (orientation = Gtk.Orientation.VERTICAL, spacing = 12, css = '') =>
    new Gtk.Box({orientation, spacing, css_classes: css ? [css] : []});
const pill = (text, css = '') => label(text, css || 'pill');
const card = (title, detail, tag) => {
    const item = box(Gtk.Orientation.VERTICAL, 12, 'card');
    item.append(label(title, 'card-title', {wrap: true}));
    item.append(label(detail, 'muted', {wrap: true}));
    if (tag)
        item.append(pill(tag));
    return item;
};

app.connect('activate', () => {
    const css = new Gtk.CssProvider();
    css.load_from_string(`
        window.demo { background: #f6f7f9; color: #202832; }
        window.demo.dark { background: #20242a; color: #f0f3f7; }
        .page { padding: 28px 34px; }
        .heading { font-size: 25px; font-weight: 700; }
        .section { font-size: 15px; font-weight: 700; }
        .muted { color: #667484; font-size: 13px; }
        .dark .muted { color: #b3bfcd; }
        .eyebrow { color: #3478bd; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
        .dark .eyebrow { color: #83b7ef; }
        .card { background: #ffffff; border: 1px solid #dce2e9; border-radius: 12px; padding: 18px; }
        .dark .card { background: #2b313a; border-color: #424b58; }
        .card-title { font-size: 15px; font-weight: 600; }
        .pill { background: #e6effa; color: #315e8b; border-radius: 6px; padding: 5px 8px; font-size: 11px; }
        .dark .pill { background: #344962; color: #c7e0fd; }
        .toolbar { padding: 12px 18px; background: #edf0f4; border-bottom: 1px solid #d9e0e8; }
        .dark .toolbar { background: #292f37; border-color: #424b58; }
        .address { background: #ffffff; color: #5b6978; padding: 8px 16px; border-radius: 9px; }
        .dark .address { background: #1b2027; color: #b8c5d4; }
        .column { padding-top: 10px; }
        .sidebar { background: #edf0f4; padding: 26px 20px; }
        .dark .sidebar { background: #292f37; }
        .sidebar-item { padding: 10px 12px; border-radius: 8px; }
        .selected { background: #dce9f8; color: #285e96; }
        .dark .selected { background: #344962; color: #d6e9ff; }
        .folder { background: #ffffff; padding: 24px 18px; border-radius: 12px; border: 1px solid #dce2e9; }
        .dark .folder { background: #2b313a; border-color: #424b58; }
        .note { font-size: 17px; }
        .check { color: #3478bd; font-size: 17px; }
        .dark .check { color: #83b7ef; }
    `);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    const window = new Gtk.ApplicationWindow({application: app, title: kind,
        default_width: 1000, default_height: 520, css_classes: ['demo']});
    window.set_titlebar(new Gtk.HeaderBar({title_widget: label(kind, 'section')}));
    const content = box(Gtk.Orientation.VERTICAL, 0);
    window.set_child(content);

    if (kind === 'Browser') {
        const toolbar = box(Gtk.Orientation.HORIZONTAL, 18, 'toolbar');
        toolbar.append(label('‹   ›   ↻', 'section'));
        toolbar.append(label('workspace.example / project', 'address', {hexpand: true}));
        content.append(toolbar);
        const page = box(Gtk.Orientation.VERTICAL, 12, 'page');
        page.append(label('TEAM WORKSPACE', 'eyebrow'));
        page.append(label('A little less window switching.', 'heading'));
        page.append(label('Keep the browser, notes, and files for one project together.', 'muted'));
        const board = box(Gtk.Orientation.HORIZONTAL, 18);
        board.set_margin_top(12);
        for (const [heading, title, detail, tag] of [
            ['Ideas', 'Collect the essentials', 'A small space for the next useful idea.', '3 notes'],
            ['In progress', 'Shape the workspace', 'Bring related tools into the same group.', 'Today'],
            ['Ready', 'Share the draft', 'A clear starting point for the next review.', 'Complete']]) {
            const column = box(Gtk.Orientation.VERTICAL, 14, 'column');
            column.set_hexpand(true);
            column.set_homogeneous(false);
            column.append(label(heading, 'section'));
            column.append(card(title, detail, tag));
            board.append(column);
        }
        board.set_homogeneous(true);
        page.append(board);
        content.append(page);
    } else if (kind === 'Files') {
        const row = box(Gtk.Orientation.HORIZONTAL, 0);
        const sidebar = box(Gtk.Orientation.VERTICAL, 8, 'sidebar');
        sidebar.set_size_request(170, -1);
        sidebar.append(label('Places', 'section'));
        for (const title of ['Home', 'Projects', 'Downloads', 'Archive']) {
            const item = label(title, 'sidebar-item');
            if (title === 'Projects')
                item.add_css_class('selected');
            sidebar.append(item);
        }
        row.append(sidebar);
        const page = box(Gtk.Orientation.VERTICAL, 18, 'page');
        page.set_hexpand(true);
        page.append(label('Projects', 'heading'));
        page.append(label('Everything for the current workspace.', 'muted'));
        const folders = box(Gtk.Orientation.HORIZONTAL, 16);
        for (const name of ['Design', 'Documents', 'References']) {
            const folder = box(Gtk.Orientation.VERTICAL, 12, 'folder');
            folder.set_hexpand(true);
            folder.append(new Gtk.Image({icon_name: 'folder-symbolic', pixel_size: 48}));
            folder.append(label(name, 'section', {xalign: 0.5}));
            folders.append(folder);
        }
        folders.set_homogeneous(true);
        page.append(folders);
        row.append(page);
        content.append(row);
    } else {
        const page = box(Gtk.Orientation.VERTICAL, 18, 'page');
        page.append(label(kind === 'Notes' ? 'PROJECT NOTES' : 'REFERENCE', 'eyebrow'));
        page.append(label(kind === 'Notes' ? 'One workspace. Three apps.' : 'A useful reference, nearby.', 'heading'));
        page.append(label('A fictional project for exploring grouped windows.', 'muted'));
        const row = box(Gtk.Orientation.HORIZONTAL, 24);
        row.set_margin_top(12);
        const notes = box(Gtk.Orientation.VERTICAL, 18, 'card');
        notes.set_hexpand(true);
        notes.append(label('Keep the context', 'section'));
        for (const text of ['Read the project board in Browser.', 'Capture decisions in Notes.', 'Find the supporting documents in Files.'])
            notes.append(label(`•  ${text}`, 'note', {wrap: true}));
        const next = box(Gtk.Orientation.VERTICAL, 18, 'card');
        next.append(label('Next steps', 'section'));
        for (const text of ['Gather references', 'Review the draft', 'Make room to focus'])
            next.append(label(`✓  ${text}`, 'check'));
        row.append(notes);
        row.append(next);
        page.append(row);
        content.append(page);
    }

    const appearance = new Gio.SimpleAction({name: 'dark', parameter_type: new GLib.VariantType('b')});
    appearance.connect('activate', (_action, parameter) => {
        const dark = parameter.deepUnpack();
        Gtk.Settings.get_default().gtk_application_prefer_dark_theme = dark;
        if (dark)
            window.add_css_class('dark');
        else
            window.remove_css_class('dark');
    });
    app.add_action(appearance);
    window.present();
});
app.run([]);

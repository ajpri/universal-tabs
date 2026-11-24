import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({application_id: 'org.gnome.Extensions.UniversalTabsTest'});
app.connect('activate', () => {
    const large = new Gtk.ApplicationWindow({application: app, title: 'UT Large', default_width: 800, default_height: 500});
    large.set_child(new Gtk.Label({label: 'Large test window'}));
    large.present();
    const small = new Gtk.ApplicationWindow({application: app, title: 'UT Small', default_width: 360, default_height: 240});
    small.set_child(new Gtk.Label({label: 'Small test window'}));
    small.present();
    const manual = new Gtk.ApplicationWindow({application: app, title: 'UT Manual', default_width: 400, default_height: 280});
    manual.set_child(new Gtk.Label({label: 'User-minimized test window'}));
    manual.present();
    const action = new Gio.SimpleAction({name: 'dialog'});
    action.connect('activate', () => {
        const dialog = new Gtk.Window({application: app, title: 'UT Dialog', transient_for: large,
            modal: true, default_width: 220, default_height: 120});
        dialog.set_child(new Gtk.Label({label: 'Independent modal'}));
        dialog.present();
    });
    app.add_action(action);
    const extra = new Gio.SimpleAction({name: 'extra'});
    extra.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({application: app, title: 'UT Extra',
            default_width: 420, default_height: 280});
        window.set_child(new Gtk.Label({label: 'Disposable close-button test window'}));
        window.present();
    });
    app.add_action(extra);
    const unrelated = new Gio.SimpleAction({name: 'unrelated'});
    unrelated.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({application: app, title: 'UniversalTabsLegacy2Disk',
            default_width: 420, default_height: 280});
        window.present();
    });
    app.add_action(unrelated);
    const inspect = new Gio.SimpleAction({name: 'inspect-controls'});
    inspect.connect('activate', () => {
        const buttons = [];
        const visit = widget => {
            if (widget instanceof Gtk.Button && widget.get_mapped()) {
                for (const control of ['close', 'minimize', 'maximize']) {
                    if (widget.has_css_class(control))
                        buttons.push(control);
                }
            }
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
                visit(child);
        };
        visit(large);
        GLib.file_set_contents(GLib.getenv('UT_TEST_CONTROLS'), JSON.stringify({
            layout: Gtk.Settings.get_default().gtk_decoration_layout, buttons}));
    });
    app.add_action(inspect);
    const fixed = new Gio.SimpleAction({name: 'fixed'});
    fixed.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({application: app, title: 'UT Fixed',
            default_width: 420, default_height: 260, resizable: false});
        window.set_child(new Gtk.Label({label: 'Window with a fixed maximum size'}));
        window.present();
    });
    app.add_action(fixed);
});
app.run([]);

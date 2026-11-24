import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const legacy = ARGV.includes('--legacy');
const fullscreen = ARGV.includes('--fullscreen');
if (legacy) {
    GLib.unsetenv('DESKTOP_STARTUP_ID');
    GLib.unsetenv('XDG_ACTIVATION_TOKEN');
}
const app = new Gtk.Application({application_id: legacy ? 'org.gnome.Extensions.UniversalTabsLegacy2Disk'
    : fullscreen ? 'org.gnome.Extensions.UniversalTabsFullscreenTest' : 'org.gnome.Extensions.UniversalTabsLaunchTest'});
app.connect('activate', () => {
    app.hold();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, legacy ? 1600 : 900, () => {
        const window = new Gtk.ApplicationWindow({application: app,
            title: legacy ? 'UT Separate' : fullscreen ? 'UT Fullscreen' : 'UT Launched',
            default_width: 420, default_height: 280});
        window.set_child(new Gtk.Label({label: 'Launched from the new tab application grid'}));
        if (fullscreen)
            window.fullscreen();
        window.present();
        app.release();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([]);

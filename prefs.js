import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseColor} from './color.js';
import {OWN_MOTION, REBOUND_CURVES} from './geometry.js';
import {HighlightPreview} from './preview.js';

const DEFAULT_HIGHLIGHT = '#3584e4';

function rgbaToHex(rgba) {
    return `#${[rgba.red, rgba.green, rgba.blue]
        .map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

export default class AltTabGlidePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 820);

        const spin = (group, key, title, min, max, step, subtitle = null) => {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.title = title;
            row.subtitle = subtitle;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        // A row with a slider for an integer key. `mark` puts a tick under
        // a value, such as the default.
        const slider = (group, key, title, min, max, subtitle = null, mark = null) => {
            const row = new Adw.ActionRow({title, subtitle});
            const scale = new Gtk.Scale({
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 10}),
                digits: 0,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                width_request: 220,
                valign: Gtk.Align.CENTER,
            });
            if (mark !== null)
                scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);
            const sync = () => {
                if (Math.round(scale.get_value()) !== settings.get_int(key))
                    scale.set_value(settings.get_int(key));
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            scale.connect('value-changed', () => {
                const value = Math.round(scale.get_value());
                if (value !== settings.get_int(key))
                    settings.set_int(key, value);
            });
            row.add_suffix(scale);
            group.add(row);
            return row;
        };
        // ComboRow for a string key with <choices>; options is [[value, label], ...].
        const choice = (group, key, title, options, subtitle = null) => {
            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: Gtk.StringList.new(options.map(([, label]) => label)),
            });
            const values = options.map(([value]) => value);
            const sync = () => {
                row.selected = Math.max(values.indexOf(settings.get_string(key)), 0);
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            row.connect('notify::selected', () => {
                if (settings.get_string(key) !== values[row.selected])
                    settings.set_string(key, values[row.selected]);
            });
            group.add(row);
            return row;
        };
        const previewGroup = page => {
            const group = new Adw.PreferencesGroup({
                title: _('Preview'),
                description: _('Moves like the real switcher, with the settings below.'),
            });
            group.add(new HighlightPreview(settings));
            page.add(group);
        };

        // Appearance
        const appearancePage = new Adw.PreferencesPage({
            name: 'appearance',
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);
        previewGroup(appearancePage);

        const highlightGroup = new Adw.PreferencesGroup({
            title: _('Highlight'),
            description: _('Changes apply the next time the switcher opens.'),
        });
        appearancePage.add(highlightGroup);

        const colorRow = new Adw.ActionRow({
            title: _('Custom color'),
            subtitle: _('Use this color instead of the system accent color'),
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const colorSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
        colorRow.add_suffix(colorButton);
        colorRow.add_suffix(colorSwitch);
        colorRow.activatable_widget = colorSwitch;
        highlightGroup.add(colorRow);

        // Writing the setting fires changed::, which would sync the widgets
        // that are being written from; the flag breaks that loop.
        let syncing = false;
        const syncColor = () => {
            syncing = true;
            const color = parseColor(settings.get_string('highlight-color'));
            const rgba = new Gdk.RGBA();
            rgba.parse(color ?? DEFAULT_HIGHLIGHT);
            colorButton.rgba = rgba;
            colorButton.sensitive = color !== null;
            colorSwitch.active = color !== null;
            syncing = false;
        };
        settings.connect('changed::highlight-color', syncColor);
        syncColor();
        const saveColor = () => {
            if (syncing)
                return;
            settings.set_string('highlight-color',
                colorSwitch.active ? rgbaToHex(colorButton.rgba) : '');
        };
        colorSwitch.connect('notify::active', saveColor);
        colorButton.connect('notify::rgba', saveColor);

        slider(highlightGroup, 'highlight-opacity', _('Opacity (%)'), 20, 100,
            _('Lower values let the icons behind show through'));
        spin(highlightGroup, 'corner-radius', _('Corner radius (px)'), 0, 48, 2);
        spin(highlightGroup, 'border-width', _('Border width (px)'), 0, 6, 1,
            _('0 draws no border'));
        spin(highlightGroup, 'focus-scale', _('Selected item size (%)'), 100, 115, 1,
            _('100 turns the growth off'));

        // Animation
        const animationPage = new Adw.PreferencesPage({
            name: 'animation',
            title: _('Animation'),
            icon_name: 'media-playback-start-symbolic',
        });
        window.add(animationPage);
        previewGroup(animationPage);

        const motionGroup = new Adw.PreferencesGroup({
            title: _('Transition'),
            description: _('How the highlight moves when another item is selected. It follows GNOME\'s Animations setting: with animations off, it jumps.'),
        });
        animationPage.add(motionGroup);
        const styleRow = choice(motionGroup, 'animation', _('Style'), [
            ['slide', _('Slide')],
            ['stretch', _('Stretch')],
            ['liquid', _('Liquid')],
            ['jelly', _('Jelly')],
            ['pop', _('Pop')],
            ['fade', _('Fade')],
            ['none', _('None')],
        ]);
        const durationRow = spin(motionGroup, 'animation-duration', _('Duration (ms)'), 50, 1000, 10);
        const curveRow = choice(motionGroup, 'animation-curve', _('Curve'), [
            ['smooth', _('Smooth')],
            ['overshoot', _('Overshoot')],
            ['bounce', _('Bounce')],
            ['elastic', _('Elastic')],
            ['linear', _('Linear')],
        ]);
        const reboundRow = slider(motionGroup, 'curve-rebound', _('Rebound (%)'), 0, 100,
            _('How far the curve goes past the item, or how high it bounces'), 50);

        // Options of the chosen style only; the group hides for the others.
        const tuneGroup = new Adw.PreferencesGroup({title: _('Fine-tuning')});
        animationPage.add(tuneGroup);
        const tuneRows = {
            stretch: [slider(tuneGroup, 'stretch-reach', _('Time stretched over both items (%)'), 20, 70, null, 40)],
            liquid: [slider(tuneGroup, 'liquid-viscosity', _('How liquid (%)'), 0, 100,
                _('Higher pulls the drop longer, with a thinner tail and neck'), 50)],
            jelly: [
                slider(tuneGroup, 'jelly-bounce', _('Bounce (%)'), 0, 100,
                    _('How far it springs past the item'), 50),
                spin(tuneGroup, 'jelly-wobbles', _('Wobbles'), 1, 4, 1,
                    _('How many times it swings before it settles')),
                slider(tuneGroup, 'jelly-stretch', _('Stretch (%)'), 0, 60,
                    _('How much it stretches while moving fast'), 30),
            ],
            pop: [slider(tuneGroup, 'pop-size', _('Shrinks to (%)'), 0, 80,
                _('Size between the two items, relative to an item'), 30)],
        };

        const descriptions = {
            slide: _('Moves to the next item in one motion'),
            stretch: _('Reaches over both items, then lets go'),
            liquid: _('Flows like a drop, with a thin neck'),
            jelly: _('Springs past the item and wobbles back'),
            pop: _('Shrinks, then grows out of the next item'),
            fade: _('Fades out and back in on the next item'),
            none: _('Jumps to the next item'),
        };
        const syncStyle = () => {
            const style = settings.get_string('animation');
            const curve = settings.get_string('animation-curve');
            styleRow.subtitle = descriptions[style] ?? '';
            durationRow.sensitive = style !== 'none';
            // Liquid and jelly have their own motion; none has no motion.
            const curved = !OWN_MOTION.includes(style);
            curveRow.sensitive = curved;
            curveRow.subtitle = curved ? '' : _('Not used by this style');
            reboundRow.sensitive = curved && REBOUND_CURVES.includes(curve);
            tuneGroup.visible = style in tuneRows;
            for (const [name, rows] of Object.entries(tuneRows))
                rows.forEach(row => (row.visible = name === style));
        };
        settings.connect('changed::animation', syncStyle);
        settings.connect('changed::animation-curve', syncStyle);
        syncStyle();

        const resetGroup = new Adw.PreferencesGroup();
        animationPage.add(resetGroup);
        const resetRow = new Adw.ButtonRow({title: _('Reset All Settings')});
        resetRow.add_css_class('destructive-action');
        resetRow.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset all settings?'),
                body: _('Every option goes back to its default.'),
                default_response: 'cancel',
                close_response: 'cancel',
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'reset')
                    settings.settings_schema.list_keys().forEach(key => settings.reset(key));
            });
            dialog.present(window);
        });
        resetGroup.add(resetRow);

        // Lets tests/smoke.sh screenshot every page.
        const page = GLib.getenv('ALTTAB_GLIDE_PREFS_PAGE');
        if (page)
            window.visible_page_name = page;
    }
}

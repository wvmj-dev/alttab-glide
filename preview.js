import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {hexToRgb, parseColor} from './color.js';
import {boxShape, paintShape} from './drawing.js';
import {growBox, makeTransition, readMotion} from './geometry.js';

const ITEMS = 4;
const ITEM_SIZE = 72;
const SPACING = 12;
const PADDING = 12;
// Item the highlight goes to next, in turn: neighbours both ways and long
// jumps, so every style shows how it handles short and long moves.
const SEQUENCE = [1, 2, 3, 1, 0, 3, 2, 0];
// Pause on each item after a transition, in milliseconds.
const PAUSE = 650;
const DEFAULT_ACCENT = [0x35 / 255, 0x84 / 255, 0xe4 / 255];
// GNOME's switcher colors: the panel and the shapes standing in for icons.
const PANEL = [0x2e / 255, 0x2e / 255, 0x33 / 255];
const ICON = [0x5e / 255, 0x5c / 255, 0x64 / 255];

/**
 * A small switcher in the preferences, with the highlight moving between
 * its items in a loop, so the settings can be tuned while watching them.
 * It moves through geometry.js and paints through drawing.js, like the
 * extension, so it moves exactly like the real switcher.
 */
export const HighlightPreview = GObject.registerClass(
class HighlightPreview extends Gtk.DrawingArea {
    _init(settings) {
        const width = 2 * PADDING + ITEMS * ITEM_SIZE + (ITEMS - 1) * SPACING;
        super._init({
            content_width: width,
            content_height: 2 * PADDING + ITEM_SIZE,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        this._settings = settings;
        this._step = 0;
        this._selected = 0;
        this._previous = 0;
        this._box = this._itemBox(0);
        this._transition = null;
        // Frame clock time, in microseconds, when the current move started.
        this._start = 0;
        this._now = 0;
        this._readSettings();

        // Any change starts a new move on the next frame, to show it at once.
        // (connectObject() only exists in the shell, not in the preferences.)
        const settingsId = settings.connect('changed', () => {
            this._readSettings();
            this._start = 0;
        });
        const style = Adw.StyleManager.get_default();
        const accentId = style.connect('notify::accent-color', () => this.queue_draw());
        this.connect('destroy', () => {
            settings.disconnect(settingsId);
            style.disconnect(accentId);
        });

        this.set_draw_func((_area, cr) => this._draw(cr));
        // Tick callbacks only run while the preview is on screen.
        this.add_tick_callback((_widget, clock) => this._tick(clock.get_frame_time()));
    }

    _readSettings() {
        const s = this._settings;
        this._config = {
            animation: s.get_string('animation'),
            duration: s.get_int('animation-duration'),
            curve: s.get_string('animation-curve'),
            motion: readMotion(s),
            color: parseColor(s.get_string('highlight-color')),
            opacity: s.get_int('highlight-opacity') / 100,
            radius: s.get_int('corner-radius'),
            borderWidth: s.get_int('border-width'),
            scale: s.get_int('focus-scale') / 100,
        };
    }

    _itemBox(index) {
        return {x: PADDING + index * (ITEM_SIZE + SPACING), y: PADDING, width: ITEM_SIZE, height: ITEM_SIZE};
    }

    _targetBox(index) {
        return growBox(this._itemBox(index), this._config.scale);
    }

    _tick(now) {
        this._now = now;
        const elapsed = (now - this._start) / 1000;
        if (!this._start || elapsed >= this._config.duration + PAUSE) {
            // Next move, from wherever the highlight is.
            this._previous = this._selected;
            this._selected = SEQUENCE[this._step++ % SEQUENCE.length];
            const from = this._frame()?.box ?? this._targetBox(this._previous);
            this._transition = makeTransition(this._config.animation, from, this._targetBox(this._selected), {
                curve: this._config.curve,
                motion: this._config.motion,
            });
            this._start = now;
        }
        this.queue_draw();
        return GLib.SOURCE_CONTINUE;
    }

    // Progress of the current move, 0 to 1; 1 with animations off.
    _progress() {
        const animations = Gtk.Settings.get_default().gtk_enable_animations;
        if (!this._transition || this._transition.instant || !animations)
            return 1;
        return Math.min((this._now - this._start) / 1000 / this._config.duration, 1);
    }

    _frame() {
        return this._transition?.at(this._progress()) ?? null;
    }

    _draw(cr) {
        const width = this.get_width();
        const height = this.get_height();
        const panel = {x: 0, y: 0, width, height};
        paintShape(cr, boxShape(panel), {fill: [...PANEL, 1], border: [0, 0, 0, 0], borderWidth: 0, radius: 28});

        const config = this._config;
        const t = this._progress();
        const frame = this._frame() ?? {box: this._targetBox(this._selected), opacity: 1, shape: null};
        const [r, g, b] = config.color ? hexToRgb(config.color).map(c => c / 255) : this._accent();
        paintShape(cr, frame.shape ?? boxShape(frame.box), {
            fill: [r, g, b, config.opacity],
            border: [1, 1, 1, 0.65],
            borderWidth: config.borderWidth,
            radius: config.radius,
        }, frame.opacity);

        // The items, in front of the highlight. The selected one grows and
        // the previous one shrinks back, as in the shell.
        const grow = 1 - (1 - t) ** 3;
        for (let i = 0; i < ITEMS; i++) {
            let scale = 1;
            if (i === this._selected)
                scale = 1 + (config.scale - 1) * grow;
            else if (i === this._previous)
                scale = config.scale - (config.scale - 1) * grow;
            const icon = growBox(growBox(this._itemBox(i), 0.6), scale);
            paintShape(cr, boxShape(icon), {fill: [...ICON, 1], border: [0, 0, 0, 0], borderWidth: 0,
                radius: icon.width * (0.2 + 0.1 * i)});
        }
    }

    _accent() {
        const style = Adw.StyleManager.get_default();
        const accent = style.get_accent_color_rgba?.();
        return accent ? [accent.red, accent.green, accent.blue] : DEFAULT_ACCENT;
    }
});

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {hexToRgb} from './color.js';
import {paintShape} from './drawing.js';
import {growBox, makeTransition, sameBox} from './geometry.js';

// Lays out the wrapper: the row of items fills it, and the highlight (and
// the liquid drop) sit at their own position and size. Only the row is
// measured; if the highlight, which is larger than an item when it grows,
// counted too, the row would grow with it, then the highlight with the row,
// without end.
const WrapperLayout = GObject.registerClass(
class WrapperLayout extends Clutter.LayoutManager {
    _init(row, overlays) {
        super._init();
        this._row = row;
        this._overlays = overlays;
    }

    vfunc_get_preferred_width(_container, forHeight) {
        return this._row.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(_container, forWidth) {
        return this._row.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        // The grown first and last items reach past the edges. Clip only
        // when the row scrolls, or the hidden items would show outside.
        container.clip_to_view = box.get_width() > container.allocation.get_width() + 0.5;
        this._row.allocate(box);
        for (const overlay of this._overlays)
            overlay.allocate_preferred_size(overlay.fixed_x, overlay.fixed_y);
    }
});

/**
 * Draws one highlight behind the selected item of a switcher list (the
 * Alt+Tab apps, their window thumbnails, the window switcher...) and
 * animates it from item to item.
 */
export class Highlighter {
    /**
     * @param {SwitcherPopup.SwitcherList} list list to decorate
     * @param {object} config options read from the settings when the list
     *   appears, see AltTabGlideExtension._readConfig()
     * @param {Function} onDestroyed called when the list is destroyed
     */
    constructor(list, config, onDestroyed) {
        this._list = list;
        this._config = config;
        this._item = null;
        this._outlined = false;
        // Where the highlight goes, in the coordinates of the wrapper.
        this._box = null;
        // Opacity of the highlight as the transition sets it, 0 to 1, even
        // while the drop stands in for it.
        this._opacity = 0;
        // Runs the current transition, frame by frame.
        this._timeline = null;
        // The accent color as the stylesheet resolves it, read once.
        this._accent = null;
        this._laterId = 0;

        // The row of items moves into a viewport that holds the highlight
        // behind it. The viewport becomes the scroll view's child, so the
        // highlight scrolls with the items when they do not fit the screen.
        this._row = list._list;
        this._highlight = new St.Widget({style_class: 'atg-highlight', opacity: 0});
        // Stands in for the highlight while the liquid style runs, because a
        // drop is not a rounded box. The highlight keeps its place, hidden,
        // so any other transition can take over from there.
        this._drop = new St.DrawingArea({visible: false});
        this._drop.connect('repaint', () => this._drawDrop());
        this._shape = null;
        this._wrapper = new St.Viewport({
            layout_manager: new WrapperLayout(this._row, [this._highlight, this._drop]),
            x_expand: true,
            y_expand: true,
        });
        list._scrollView.child = null;
        this._wrapper.add_child(this._highlight);
        this._wrapper.add_child(this._drop);
        this._wrapper.add_child(this._row);
        list._scrollView.child = this._wrapper;
        // The wrapper clips now, when it scrolls; the row no longer scrolls.
        this._row.clip_to_view = false;
        list.add_style_class_name('atg-list');

        list.connectObject('destroy', () => {
            // Everything inside the list goes with it; only drop references.
            this._stop();
            this._cancelSync();
            this._item = null;
            onDestroyed();
        }, this);
    }

    /**
     * Moves the highlight to an item. Called after SwitcherList.highlight().
     *
     * @param {number} index item to highlight, or -1 for none
     * @param {boolean} outlined the item only gets an outline, because the
     *   keyboard is on the window thumbnails below it
     */
    update(index, outlined) {
        const item = this._list._items[index] ?? null;
        if (item !== this._item) {
            this._setFocused(this._item, false);
            this._item?.disconnectObject(this);
            this._item = item;
            // Items move when one is removed and change size when the
            // thumbnails get their window clones: follow them. A removed
            // item is forgotten, so nothing touches it after it is gone.
            item?.connectObject(
                'notify::allocation', () => this._queueSync(),
                'destroy', () => {
                    this._item = null;
                }, this);
        }
        this._outlined = outlined;
        this._applyStyle();

        if (!item) {
            this._hide();
            return;
        }
        this._setFocused(item, true);
        this._sync(true);
    }

    /** Puts the list back as GNOME built it. Used when the extension is disabled. */
    restore() {
        const list = this._list;
        this._stop();
        this._cancelSync();
        if (this._item) {
            this._item.disconnectObject(this);
            this._item.remove_all_transitions();
            this._item.set_scale(1, 1);
            this._item.set_style(null);
            this._item = null;
        }
        list.disconnectObject(this);
        list.remove_style_class_name('atg-list');
        list._scrollView.child = null;
        this._wrapper.remove_child(this._row);
        this._row.clip_to_view = true;
        list._scrollView.child = this._row;
        this._wrapper.destroy();
    }

    /**
     * @param {boolean} selectionChanged true when a new item was selected;
     *   false when the selected item only moved or changed size
     */
    _sync(selectionChanged) {
        if (!this._item)
            return;
        const box = this._targetBox();
        if (!box || sameBox(box, this._box))
            return;

        const highlight = this._highlight;
        let animation = this._config.animation;
        // A relayout snaps the highlight into place, unless it is moving.
        if (!selectionChanged)
            animation = this._timeline ? 'slide' : 'none';
        // Start from where the highlight is on screen, even mid-transition.
        const from = this._box && {x: highlight.x, y: highlight.y,
            width: highlight.width, height: highlight.height};
        this._box = box;
        this._animate(makeTransition(animation, from, box, {
            curve: this._config.curve,
            motion: this._config.motion,
            fromOpacity: this._opacity,
        }));
    }

    _targetBox() {
        const item = this._item.allocation;
        const row = this._row.allocation;
        if (item.get_width() <= 0 || item.get_height() <= 0)
            return null;
        const box = growBox({
            x: row.x1 + item.x1,
            y: row.y1 + item.y1,
            width: item.get_width(),
            height: item.get_height(),
        }, this._outlined ? 1 : this._config.scale);
        // Whole pixels keep the border sharp once the transition ends.
        return {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
        };
    }

    // Runs a transition from geometry.js: a timeline applies its box,
    // opacity and drop shape on every frame. Every style goes through the
    // same path, with the easing curves of geometry.js, so their rebound can
    // be tuned and the preferences preview moves exactly the same way.
    _animate(transition) {
        this._stop();
        // ease() would follow GNOME's Animations setting by itself; a
        // timeline does not, so check it here.
        if (transition.instant || !St.Settings.get().enable_animations) {
            this._apply(transition.at(1));
            return;
        }
        const timeline = new Clutter.Timeline({actor: this._highlight, duration: this._config.duration});
        timeline.connect('new-frame', () => this._apply(transition.at(timeline.get_progress())));
        timeline.connect('completed', () => {
            if (this._timeline !== timeline)
                return;
            this._timeline = null;
            this._apply(transition.at(1));
        });
        this._timeline = timeline;
        this._apply(transition.at(0));
        timeline.start();
    }

    _apply({box, opacity, shape}) {
        const highlight = this._highlight;
        Object.assign(highlight, {x: box.x, y: box.y, width: box.width, height: box.height});
        this._opacity = opacity;
        if (shape) {
            // The drop covers whole pixels around the shape, which it paints
            // relative to that corner.
            const x = Math.floor(shape.bounds.x);
            const y = Math.floor(shape.bounds.y);
            Object.assign(this._drop, {
                x,
                y,
                width: Math.ceil(shape.bounds.x + shape.bounds.width) - x,
                height: Math.ceil(shape.bounds.y + shape.bounds.height) - y,
            });
            this._shape = shape;
            this._drop.show();
            this._drop.queue_repaint();
            highlight.opacity = 0;
        } else {
            this._shape = null;
            this._drop.hide();
            highlight.opacity = Math.round(opacity * 255);
        }
    }

    // Stops the running transition where the highlight is now.
    _stop() {
        this._timeline?.stop();
        this._timeline = null;
        this._highlight.remove_all_transitions();
    }

    // Fades the highlight out where it is, when no item is selected.
    _hide() {
        this._stop();
        if (this._shape)
            this._apply({box: this._shape.bounds, opacity: this._opacity, shape: null});
        this._box = null;
        this._opacity = 0;
        this._highlight.ease({
            opacity: 0,
            duration: this._config.duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Paints the liquid drop with the highlight's own style, so it looks
    // the same: accent or custom color, opacity, border, outline.
    _drawDrop() {
        const shape = this._shape;
        if (!shape)
            return;
        const node = this._highlight.get_theme_node();
        const rgba = c => [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const ox = this._drop.x;
        const oy = this._drop.y;
        const move = b => ({x: b.x - ox, y: b.y - oy, width: b.width, height: b.height});
        const cr = this._drop.get_context();
        paintShape(cr, {head: move(shape.head), tail: move(shape.tail), neck: shape.neck}, {
            fill: rgba(node.get_background_color()),
            border: rgba(node.get_border_color(St.Side.TOP)),
            borderWidth: node.get_border_width(St.Side.TOP),
            radius: this._config.radius * scale,
        }, this._opacity);
        cr.$dispose();
    }

    _setFocused(item, focused) {
        if (!item)
            return;
        const grow = focused && !this._outlined;
        const scale = grow ? this._config.scale : 1;
        item.set_pivot_point(0.5, 0.5);
        item.ease({
            scale_x: scale,
            scale_y: scale,
            duration: this._config.duration,
            mode: grow ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        // Readable text on a custom color; with the accent color the
        // stylesheet already uses the accent's own text color.
        item.set_style(grow && this._config.textColor ? `color: ${this._config.textColor};` : null);
    }

    // The highlight's colors and border, as an inline style on top of the
    // stylesheet: the color (custom, or the accent the stylesheet resolves)
    // with the chosen opacity, the border width and the corner radius.
    _applyStyle() {
        const {radius, opacity, borderWidth} = this._config;
        const [r, g, b] = this._baseColor();
        let style = `border-radius: ${radius}px;`;
        if (this._outlined) {
            // An outline needs a border, even when the highlight has none.
            style += ` background-color: transparent; border: ${Math.max(borderWidth, 2)}px solid rgb(${r}, ${g}, ${b});`;
            this._highlight.add_style_pseudo_class('outlined');
        } else {
            style += ` background-color: rgba(${r}, ${g}, ${b}, ${opacity}); border-width: ${borderWidth}px;`;
            this._highlight.remove_style_pseudo_class('outlined');
        }
        this._highlight.set_style(style);
    }

    _baseColor() {
        // color passed parseColor(), so it is exactly #rrggbb.
        if (this._config.color)
            return hexToRgb(this._config.color);
        if (!this._accent) {
            this._highlight.set_style(null);
            this._highlight.remove_style_pseudo_class('outlined');
            const c = this._highlight.get_theme_node().get_background_color();
            this._accent = [c.red, c.green, c.blue];
        }
        return this._accent;
    }

    _queueSync() {
        if (this._laterId)
            return;
        // Allocation is being computed right now; move the highlight just
        // before the next frame is drawn instead.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSync() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }
}

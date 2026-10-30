import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';

import {contrastColor, parseColor} from './color.js';
import {readMotion} from './geometry.js';
import {Highlighter} from './highlight.js';

export default class AltTabGlideExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Switcher list -> its Highlighter, while the list is alive.
        this._highlighters = new Map();
        this._injections = new InjectionManager();

        // Every switcher (Alt+Tab, its thumbnails, the window switcher,
        // Ctrl+Alt+Tab and the input source switcher) selects its items
        // through SwitcherList.highlight(), so one injection covers them all.
        const extension = this;
        this._injections.overrideMethod(SwitcherPopup.SwitcherList.prototype, 'highlight',
            original => function (index, justOutline) {
                original.call(this, index, justOutline);
                // A bug here must never break the switcher itself.
                try {
                    extension._highlighterFor(this).update(index, Boolean(justOutline));
                } catch (e) {
                    console.error(`[${extension.uuid}] ${e}\n${e.stack}`);
                }
            });
    }

    disable() {
        this._injections.clear();
        this._injections = null;
        for (const highlighter of this._highlighters.values())
            highlighter.restore();
        this._highlighters = null;
        this._settings = null;
    }

    _highlighterFor(list) {
        let highlighter = this._highlighters.get(list);
        if (!highlighter) {
            highlighter = new Highlighter(list, this._readConfig(),
                () => this._highlighters?.delete(list));
            this._highlighters.set(list, highlighter);
        }
        return highlighter;
    }

    // Read once per list: a switcher lives for a second or two, so changed
    // settings apply the next time it opens.
    _readConfig() {
        const settings = this._settings;
        const color = parseColor(settings.get_string('highlight-color'));
        return {
            animation: settings.get_string('animation'),
            duration: settings.get_int('animation-duration'),
            curve: settings.get_string('animation-curve'),
            motion: readMotion(settings),
            color,
            textColor: color && contrastColor(color),
            opacity: settings.get_int('highlight-opacity') / 100,
            radius: settings.get_int('corner-radius'),
            borderWidth: settings.get_int('border-width'),
            scale: settings.get_int('focus-scale') / 100,
        };
    }
}

// Unit tests for the pure modules. Run with: gjs -m tests/unit.js
// (or ./build.sh unit). No GNOME Shell needed.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {contrastColor, hexToRgb, parseColor} from '../color.js';
import {boxShape, paintShape} from '../drawing.js';
import {
    ANIMATIONS, CURVES, DEFAULT_MOTION, DEFAULT_TUNING, FADE_OUT, JELLY_RAMP, OWN_MOTION, POP_OUT,
    REBOUND_CURVES, TUNING_KEYS, easing, growBox, liquidShape, makeTransition, motionFromSettings,
    readMotion, sameBox, springPosition, springSpeed, unionBox,
} from '../geometry.js';

let failures = 0;
let count = 0;
function check(name, condition, detail = '') {
    count++;
    if (!condition) {
        failures++;
        print(`FAIL ${name} ${detail}`);
    }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const samples = (n = 400) => Array.from({length: n + 1}, (_, i) => i / n);
const right = b => b.x + b.width;
const centerX = b => b.x + b.width / 2;

const A = {x: 0, y: 0, width: 100, height: 120};
const B = {x: 112, y: 0, width: 100, height: 120};
const C = {x: 224, y: 10, width: 80, height: 100};

// --- growBox, unionBox, sameBox ---------------------------------------------
check('scale 1 keeps the box', same(growBox(A, 1), A));
const grown = growBox(A, 1.1);
check('grows the size', close(grown.width, 110) && close(grown.height, 132));
check('keeps the center', close(grown.x + grown.width / 2, 50) && close(grown.y + grown.height / 2, 60));
check('shrinks below 1', growBox(A, 0.5).width === 50 && growBox(A, 0.5).x === 25);
check('union of neighbours', same(unionBox(A, B), {x: 0, y: 0, width: 212, height: 120}));
check('union is symmetric', same(unionBox(B, A), unionBox(A, B)));
check('union holds different heights', same(unionBox(A, C), {x: 0, y: 0, width: 304, height: 120}));
check('same box', sameBox(A, {...A}));
check('half a pixel apart is the same', sameBox(A, {...A, x: 0.4}));
check('a pixel apart differs', !sameBox(A, {...A, x: 1}));
check('null is never the same', !sameBox(null, A) && !sameBox(A, null) && !sameBox(null, null));

// --- easing curves ----------------------------------------------------------
const REBOUNDS = [0, 0.25, 0.5, 0.75, 1];
const peak = f => Math.max(...samples().map(f));
for (const curve of [...CURVES, 'unknown']) {
    for (const rebound of REBOUNDS) {
        const f = easing(curve, rebound);
        check(`${curve} ${rebound}: starts at 0 and ends at exactly 1`, close(f(0), 0) && f(1) === 1);
        check(`${curve} ${rebound}: stays in a sane range`, samples().every(t => f(t) > -0.01 && f(t) < 1.7));
    }
}
check('linear is the identity', samples().every(t => easing('linear')(t) === t));
check('unknown curves are smooth', samples().every(t => easing('nonsense')(t) === easing('smooth')(t)));
check('smooth never passes the target', peak(easing('smooth')) <= 1);
check('overshoot at 50% matches EASE_OUT_BACK', close(peak(easing('overshoot', 0.5)), 1.1, 0.005),
    `${peak(easing('overshoot', 0.5))}`);
check('overshoot at 0% does not overshoot', peak(easing('overshoot', 0)) <= 1 + 1e-9);
check('elastic swings past the target', peak(easing('elastic', 0.5)) > 1.05);
const lowest = f => {
    // Deepest point after the first hit, where the curve first turns back.
    const ts = samples(2000);
    const hit = ts.findIndex((t, i) => i + 1 < ts.length && f(ts[i + 1]) < f(t));
    return hit < 0 ? 1 : Math.min(...ts.slice(hit).map(f));
};
check('bounce never passes the target', peak(easing('bounce', 1)) <= 1 + 1e-9);
check('bounce at 50% bounces back a quarter', close(lowest(easing('bounce', 0.5)), 0.75, 0.01),
    `${lowest(easing('bounce', 0.5))}`);
for (const curve of REBOUND_CURVES) {
    const amount = curve === 'bounce' ? f => 1 - lowest(f) : f => peak(f) - 1;
    const amounts = REBOUNDS.map(r => amount(easing(curve, r)));
    check(`${curve}: more rebound goes further`, amounts.every((a, i) => i === 0 || a > amounts[i - 1]),
        amounts.map(a => a.toFixed(3)).join(' '));
}

// --- motion settings --------------------------------------------------------
check('default motion is the original drop', close(DEFAULT_MOTION.liquidLead, 0.55) &&
    close(DEFAULT_MOTION.liquidTrail, 0.2) && close(DEFAULT_MOTION.liquidTail, 0.25) &&
    close(DEFAULT_MOTION.liquidNeck, 0.6));
check('default motion is the original spring', close(DEFAULT_MOTION.jellyDamping, 5) &&
    close(DEFAULT_MOTION.jellyFrequency, 2.5 * Math.PI) && close(DEFAULT_MOTION.jellyStretch, 0.3));
check('default stretch and pop', close(DEFAULT_MOTION.stretchReach, 0.4) && close(DEFAULT_MOTION.popSize, 0.3));
check('out-of-range wobbles are clamped', close(motionFromSettings({jellyWobbles: 9}).jellyFrequency, 4.5 * Math.PI) &&
    close(motionFromSettings({jellyWobbles: 0}).jellyFrequency, 1.5 * Math.PI));
const fakeSettings = {get_int: key => ({'curve-rebound': 80, 'jelly-wobbles': 3})[key] ??
    DEFAULT_TUNING[Object.keys(TUNING_KEYS).find(k => TUNING_KEYS[k] === key)]};
const read = readMotion(fakeSettings);
check('readMotion reads every key', close(read.rebound, 0.8) && close(read.jellyFrequency, 3.5 * Math.PI) &&
    close(read.liquidNeck, DEFAULT_MOTION.liquidNeck));

// --- transitions: what every style must do ----------------------------------
const MOTIONS = [
    DEFAULT_MOTION,
    motionFromSettings({rebound: 100, stretchReach: 70, liquidViscosity: 100, jellyBounce: 100,
        jellyWobbles: 4, jellyStretch: 60, popSize: 0}),
    motionFromSettings({rebound: 0, stretchReach: 20, liquidViscosity: 0, jellyBounce: 0,
        jellyWobbles: 1, jellyStretch: 0, popSize: 80}),
];
for (const animation of [...ANIMATIONS, 'unknown']) {
    const first = makeTransition(animation, null, B);
    check(`${animation}: first placement appears at once`, first.instant &&
        same(first.at(1), {box: B, opacity: 1, shape: null}));
    let ok = true;
    let detail = '';
    for (const curve of CURVES) {
        for (const motion of MOTIONS) {
            const tr = makeTransition(animation, A, C, {curve, motion});
            const end = tr.at(1);
            if (!same(end, {box: C, opacity: 1, shape: null}) || !same(tr.at(5), end)) {
                ok = false;
                detail = `${curve}: wrong end`;
            }
            if (!tr.instant && !(sameBox(tr.at(0).box, A) && close(tr.at(0).opacity, 1))) {
                ok = false;
                detail = `${curve}: wrong start`;
            }
            for (const t of samples(200)) {
                const {box, opacity} = tr.at(t);
                if (!(box.width >= 1 && box.height >= 1 && opacity >= 0 && opacity <= 1)) {
                    ok = false;
                    detail = `${curve} t=${t}: ${JSON.stringify(box)} ${opacity}`;
                }
            }
        }
    }
    check(`${animation}: starts on the old item, ends on the new, never inside out`, ok, detail);
    check(`${animation}: instant only when it does not move`,
        makeTransition(animation, A, C).instant === (animation === 'none'));
    if (animation !== 'none') {
        const back = makeTransition(animation, A, C, {fromOpacity: 0});
        check(`${animation}: an interrupted fade does not flash`, back.at(0).opacity < 0.05 && back.at(1).opacity === 1);
    }
}
check('own-motion styles are real styles', OWN_MOTION.every(a => ANIMATIONS.includes(a)));
check('rebound curves are real curves', REBOUND_CURVES.every(c => CURVES.includes(c)));
check('the curve shapes a slide', !sameBox(makeTransition('slide', A, C, {curve: 'linear'}).at(0.3).box,
    makeTransition('slide', A, C, {curve: 'overshoot'}).at(0.3).box));
check('overshoot slides past the item', Math.max(...samples().map(t =>
    makeTransition('slide', A, C, {curve: 'overshoot'}).at(t).box.x)) > C.x + 5);

const reach = motionFromSettings({stretchReach: 60}).stretchReach;
const stretch = makeTransition('stretch', A, C, {motion: motionFromSettings({stretchReach: 60})});
check('stretch covers both items at its reach', sameBox(stretch.at(reach).box, unionBox(A, C)));

const fade = makeTransition('fade', A, B);
check('fade goes out on the old item', sameBox(fade.at(FADE_OUT * 0.99).box, A) && fade.at(FADE_OUT * 0.99).opacity < 0.01);
check('fade comes back on the new item', sameBox(fade.at(FADE_OUT + 0.01).box, B) && fade.at(0.7).opacity > 0.5);

for (const popSize of [0, 30, 80]) {
    const motion = motionFromSettings({popSize});
    const pop = makeTransition('pop', A, B, {motion});
    const smallest = pop.at(POP_OUT - 1e-6);
    check(`pop ${popSize}%: shrinks into the old item`, close(smallest.box.width, Math.max(A.width * popSize / 100, 1), 0.5) &&
        close(centerX(smallest.box), centerX(A), 0.5) && smallest.opacity < 0.01);
    check(`pop ${popSize}%: grows out of the new item`, close(centerX(pop.at(POP_OUT + 1e-6).box), centerX(B), 0.5));
}
check('pop on the same box does not shrink', samples().every(t => makeTransition('pop', A, A).at(t).box.width === A.width));
check('fade on the same box does not blink', samples().every(t => makeTransition('fade', A, A).at(t).opacity === 1));

// --- liquid -----------------------------------------------------------------
const shapes = (from, to, motion = DEFAULT_MOTION) => samples(200).map(t => liquidShape(from, to, t, motion));
const liquid = shapes(A, C);
const progress = (box, from, to) => (centerX(box) - centerX(from)) / (centerX(to) - centerX(from));
check('liquid: the head leads the tail', liquid.every(s => progress(s.head, A, C) >= progress(s.tail, A, C) - 1e-9));
const lt = makeTransition('liquid', A, C);
check('liquid: the transition carries the drop', lt.at(0.4).shape && sameBox(lt.at(0.4).box, lt.at(0.4).shape.bounds) &&
    sameBox(lt.at(0.4).box, unionBox(lt.at(0.4).shape.head, lt.at(0.4).shape.tail)));
check('liquid: no drop once it is over', lt.at(1).shape === null);
check('liquid: stretched over both items early on', liquid[60].bounds.x < A.x + 10 && right(liquid[60].bounds) > C.x);
check('liquid: the neck thins while stretched', liquid[60].neck < 0.7 * Math.min(A.height, C.height));
check('liquid: the tail thins on the way', liquid[100].tail.height < A.height * 0.9);
check('liquid: whole at both ends', liquid[0].neck === A.height && sameBox(liquid[0].tail, A) &&
    close(liquid[200].neck, C.height) && sameBox(liquid[200].head, C) && sameBox(liquid[200].tail, C));
check('liquid: the head never goes back', liquid.every((s, i) => i === 0 || s.head.x >= liquid[i - 1].head.x - 1e-9));
const back = shapes(C, A);
check('liquid: leads going left too', back.every(s => progress(s.head, C, A) >= progress(s.tail, C, A) - 1e-9) &&
    back[60].head.x < back[60].tail.x);
check('liquid: same box stays put', shapes(A, A).every(s => sameBox(s.bounds, A) && s.neck === A.height));
const thin = shapes(A, C, motionFromSettings({liquidViscosity: 100}));
const thick = shapes(A, C, motionFromSettings({liquidViscosity: 0}));
check('liquid: more viscous, thinner neck', Math.min(...thin.map(s => s.neck)) < Math.min(...liquid.map(s => s.neck)) &&
    Math.min(...liquid.map(s => s.neck)) < Math.min(...thick.map(s => s.neck)));
const gap = list => Math.max(...list.map(s => centerX(s.head) - centerX(s.tail)));
check('liquid: more viscous, longer drop', gap(thin) > gap(liquid) && gap(liquid) > gap(thick));
// In the first thousandth of the time, nothing moves more than 2% of the way.
for (const animation of ['liquid', 'jelly']) {
    const early = makeTransition(animation, A, C).at(0.001).box;
    check(`${animation}: no jump on the first frame`,
        [early.x - A.x, right(early) - right(A), early.y - A.y, early.height - A.height]
            .every(d => Math.abs(d) < 0.02 * (C.x - A.x)));
}

// --- jelly ------------------------------------------------------------------
const jellyFrames = (motion = DEFAULT_MOTION) => samples(400).map(t => makeTransition('jelly', A, B, {motion}).at(t).box);
const jelly = jellyFrames();
const overshoot = frames => Math.max(...frames.map(centerX)) - centerX(B);
check('spring starts at 0 and ends at 1', springPosition(0) === 0 && close(springPosition(1), 1, 1e-12));
check('spring overshoots', overshoot(jelly) > 2);
check('spring is fastest at the start', springSpeed(0) === 1 && springSpeed(0.5) < 1);
for (const jellyWobbles of [1, 2, 3, 4]) {
    const motion = motionFromSettings({jellyWobbles});
    check(`spring with ${jellyWobbles} wobbles stops at the end`, springSpeed(1, motion) < 1e-9 &&
        close(springPosition(1, motion), 1, 1e-12));
}
check('jelly stretches along the movement', jelly[40].width > B.width && jelly[40].height < B.height);
check('jelly stretches across a vertical movement',
    makeTransition('jelly', A, {...A, y: 300}).at(0.1).box.height > A.height);
check('jelly settles unstretched', sameBox(jelly[400], B) && Math.abs(jelly[390].width - B.width) < 1);
check('jelly: more bounce, further past', overshoot(jellyFrames(motionFromSettings({jellyBounce: 100}))) >
    overshoot(jelly) && overshoot(jelly) > overshoot(jellyFrames(motionFromSettings({jellyBounce: 0}))));
// Times the center turns around: each wobble adds turns.
const turns = frames => frames.map(centerX).reduce((n, x, i, xs) =>
    n + (i > 1 && Math.sign(x - xs[i - 1]) !== Math.sign(xs[i - 1] - xs[i - 2]) &&
        Math.abs(x - xs[i - 1]) > 1e-6 ? 1 : 0), 0);
check('jelly: more wobbles, more turns', turns(jellyFrames(motionFromSettings({jellyWobbles: 4}))) >
    turns(jellyFrames(motionFromSettings({jellyWobbles: 1}))));
check('jelly: no stretch at 0%', jellyFrames(motionFromSettings({jellyStretch: 0}))
    .every(b => close(b.width, B.width) || b.width <= Math.max(A.width, B.width)));
check('jelly: stretch eases in', JELLY_RAMP > 0 && close(jelly[1].height, A.height, 1));

// --- options match the schema -----------------------------------------------
const schemaPath = `${GLib.path_get_dirname(import.meta.url.replace('file://', ''))}/../schemas/org.gnome.shell.extensions.alttab-glide.gschema.xml`;
const schema = new TextDecoder().decode(GLib.file_get_contents(schemaPath)[1]);
const keyBlock = key => schema.split(`<key name="${key}"`)[1]?.split('</key>')[0] ?? '';
const choicesOf = key => [...keyBlock(key).matchAll(/<choice value="([^"]+)"/g)].map(m => m[1]);
check('animations match the schema', same(choicesOf('animation'), ANIMATIONS));
check('curves match the schema', same(choicesOf('animation-curve'), CURVES));
for (const [name, key] of Object.entries(TUNING_KEYS)) {
    const block = keyBlock(key);
    const def = Number(block.match(/<default>(-?\d+)<\/default>/)?.[1]);
    check(`${key} is in the schema with the default of ${name}`, block.includes('type="i"') && def === DEFAULT_TUNING[name],
        `${def}`);
}

// --- drawing ----------------------------------------------------------------
// Paints into an image and reads pixels back through a PNG and GdkPixbuf.
function render(paint, width, height) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    paint(cr);
    cr.$dispose();
    const dir = GLib.dir_make_tmp('alttab-glide-XXXXXX');
    const file = `${dir}/shape.png`;
    surface.writeToPNG(file);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
    GLib.unlink(file);
    GLib.rmdir(dir);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    return (x, y) => Array.from(pixels.slice(y * stride + x * 4, y * stride + x * 4 + 4));
}
const style = {fill: [0, 0, 1, 1], border: [1, 1, 1, 0.5], borderWidth: 2, radius: 10};
const drop = liquidShape({x: 0, y: 0, width: 100, height: 100}, {x: 300, y: 0, width: 100, height: 100}, 0.35);
const at = render(cr => paintShape(cr, drop, style), 400, 100);
const neckX = Math.round((centerX(drop.head) + centerX(drop.tail)) / 2);
check('drop: the neck is filled', same(at(neckX, 50), [0, 0, 255, 255]), `${at(neckX, 50)}`);
check('drop: above the neck is empty', at(neckX, 2)[3] === 0, `${at(neckX, 2)}`);
check('drop: the head is filled', same(at(Math.round(centerX(drop.head)), 50), [0, 0, 255, 255]));
const edge = at(Math.round(centerX(drop.head)), 0);
check('drop: the border is half-transparent white', edge[0] === 255 && edge[2] === 255 && Math.abs(edge[3] - 128) < 3,
    `${edge}`);
const faded = render(cr => paintShape(cr, boxShape({x: 0, y: 0, width: 40, height: 40}), style, 0.5), 40, 40);
check('opacity applies to the whole highlight', Math.abs(faded(20, 20)[3] - 128) < 3, `${faded(20, 20)}`);
const outline = render(cr => paintShape(cr, boxShape({x: 0, y: 0, width: 40, height: 40}),
    {...style, fill: [0, 0, 1, 0]}), 40, 40);
check('a transparent fill paints only the border', outline(20, 20)[3] === 0 && outline(20, 0)[3] > 0);

// --- colors -----------------------------------------------------------------
check('accepts #rrggbb', parseColor('#3584E4') === '#3584e4');
for (const bad of ['', '3584e4', '#fff', '#3584e4ff', '#3584e4; color: red', 'red', '#12345g'])
    check(`rejects ${JSON.stringify(bad)}`, parseColor(bad) === null);
check('reads red, green and blue', same(hexToRgb('#3584e4'), [0x35, 0x84, 0xe4]));
check('dark text on a light color', contrastColor('#f6d32d') === '#000000');
check('light text on a dark color', contrastColor('#1c71d8') === '#ffffff');

print(`${count - failures}/${count} checks passed`);
if (failures > 0)
    imports.system.exit(1);

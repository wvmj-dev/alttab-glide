#!/usr/bin/env bash
# Smoke test: runs the extension in a throwaway headless GNOME Shell with a
# few test windows, opens the switchers through a few scenarios, checks that
# the highlight lands on the selected item, saves screenshots and fails on any
# JavaScript error. Nothing touches the real session: the shell gets its own
# D-Bus session bus, dconf database and XDG_DATA_HOME, and no display.
#
#   tests/smoke.sh <output dir>     (normally run through ./build.sh test)
#
# The extension is staged from the working tree into a temporary directory,
# so the copy installed in ~/.local is neither used nor changed.
set -euo pipefail

if [ -z "${ATG_SMOKE_INNER:-}" ]; then
    root=$(cd "$(dirname "$0")/.." && pwd)
    out=$(mkdir -p "${1:-$root/tests/output}" && cd "${1:-$root/tests/output}" && pwd)
    uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$root/metadata.json")
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT

    ext="$work/share/gnome-shell/extensions"
    mkdir -p "$ext" "$work/share/applications"
    "$root/build.sh" stage "$ext"
    cp -r "$root/tests/devtools" "$ext/alttab-glide-devtools@local"
    # One script plays four apps, so the switcher has four icons.
    while read -r id name icon; do
        sed -e "s|@APP@|$root/tests/app/testapp.js|" -e "s|@ID@|$id|" \
            -e "s|@NAME@|$name|g" -e "s|@ICON@|$icon|" \
            "$root/tests/app/template.desktop" >"$work/share/applications/$id.desktop"
    done <<'EOF'
org.alttabglide.Files Files system-file-manager
org.alttabglide.Editor Editor accessories-text-editor
org.alttabglide.Terminal Terminal utilities-terminal
org.alttabglide.Settings Settings preferences-system
EOF
    rm -f "$out"/*.png "$out"/*.log

    echo "user-db:alttab_glide_test" >"$work/dconf-profile"
    export DCONF_PROFILE="$work/dconf-profile"
    # Wipes the whole test database, so refuse unless it really is the test one.
    reset_test_db() {
        [ "$DCONF_PROFILE" = "$work/dconf-profile" ] &&
            grep -qx "user-db:alttab_glide_test" "$DCONF_PROFILE" || {
            echo "refusing to reset dconf: unexpected profile"
            exit 1
        }
        dconf reset -f /
    }
    reset_test_db
    dconf write /org/gnome/shell/enabled-extensions "['$uuid', 'alttab-glide-devtools@local']"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"

    export ATG_SMOKE_INNER=1 ATG_UUID=$uuid ATG_OUT=$out ATG_WORK=$work
    status=0
    # Services on the private bus are chatty; keep their output in a file.
    dbus-run-session -- "$0" 2>"$out/session.log" || status=$?
    reset_test_db
    exit $status
fi

# --- Inside the private session bus ---------------------------------------
P=/org/gnome/shell/extensions/alttab-glide/
log="$ATG_OUT/shell.log"

XDG_DATA_HOME="$ATG_WORK/share" \
    gnome-shell --headless --virtual-monitor 1280x800 >"$log" 2>&1 &
shell=$!
trap 'kill $shell 2>/dev/null; wait $shell 2>/dev/null' EXIT

js() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1) || { echo "$reply"; return 1; }
    [[ $reply == "(true,"* ]] || { echo "Eval failed: $1 -> $reply"; return 1; }
    echo "$reply"
}
# Runs an expression for its side effects; any failure stops the test.
run() {
    local reply
    reply=$(js "$1") || { echo "$reply"; exit 1; }
}
# True only when the expression evaluates to true. Eval replies
# "(true, '<result>')", where the first true just means the call worked.
is_true() { [[ $(js "$1" 2>/dev/null) == "(true, 'true')" ]]; }
expect() { is_true "$1" || { echo "FAILED: $2"; js "$1" || true; exit 1; }; }
shot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$ATG_OUT/$1.png" >/dev/null
    echo "  screenshot: $ATG_OUT/$1.png"
}
pause() { sleep "${1:-0.6}"; }

EXT="Main.extensionManager.lookup('$ATG_UUID')"
POPUP="global._atgPopup"
LIST="$POPUP._switcherList"
THUMBS="$POPUP._thumbnails"
APPS="imports.gi.Shell.AppSystem.get_default()"
hl() { echo "$EXT.stateObj._highlighters.get($1)"; }
# Opens a switcher like Alt+Tab does, but keeps it open without a held
# modifier: the test cannot hold Alt, and the popup closes when none is.
open() {
    run "(() => { $POPUP?.destroy(); const p = new global._atgAltTab.$1();
        p._resetNoModsTimeout = () => {}; global._atgPopup = p;
        p.show(false, '${2:-switch-applications}', 0); p._showImmediately(); })(); 1"
    pause 1
}
close() { run "$POPUP?.destroy(); global._atgPopup = null; 1"; pause 0.3; }
pick() { run "$POPUP._select($1); 1"; }
# The highlight covers the selected item of a list, as the item appears on
# screen (scaled up when selected), within a pixel and a half.
aligned() {
    echo "(() => { const l = $1; const h = $EXT.stateObj._highlighters.get(l);
        const item = l._items[l._highlighted]; if (!h || !item) return false;
        const a = h._highlight.get_transformed_extents(), b = item.get_transformed_extents();
        return h._highlight.opacity === 255 &&
            [['get_x'], ['get_y'], ['get_width'], ['get_height']].every(([f]) => Math.abs(a[f]() - b[f]()) <= 1.5); })()"
}
moving() { echo "$(hl "$1")._timeline?.is_playing()"; }

for _ in $(seq 1 60); do
    is_true "$EXT?.state === 1 && global.context.unsafe_mode" && break
    sleep 0.5
done
expect "$EXT.state === 1" "extension did not start"
run "Main.overview.hide(); import('resource:///org/gnome/shell/ui/altTab.js').then(m => { global._atgAltTab = m; }); 1"
pause 1

echo "0. test windows: four apps, Files with two windows"
TEST_WINDOWS="global.display.list_all_windows().filter(w =>
    imports.gi.Shell.WindowTracker.get_default().get_window_app(w)?.get_id().startsWith('org.alttabglide'))"
for id in Files Editor Terminal Settings; do
    run "$APPS.lookup_app('org.alttabglide.$id.desktop').activate(); 1"
    pause 0.8
done
# activate() only focuses an app that is already running.
run "$APPS.lookup_app('org.alttabglide.Files.desktop').open_new_window(-1); 1"
for _ in $(seq 1 40); do
    is_true "$TEST_WINDOWS.length === 5" && break
    sleep 0.25
done
expect "$TEST_WINDOWS.length === 5" "the test apps did not open five windows"
# Spread the windows so the screenshots show them.
run "$TEST_WINDOWS.forEach((w, i) => w.move_frame(true, 60 + i * 150, 80 + i * 70)); 1"
pause 1

if [ -n "${ATG_BENCH:-}" ]; then
    # --- ./build.sh bench: CPU and memory of the shell, not a test ----------
    hz=$(getconf CLK_TCK)
    # CPU time of the shell process so far (user + system), in clock ticks.
    ticks() { awk '{print $14 + $15}' "/proc/$shell/stat"; }
    rss() { awk '/VmRSS/ {print $2}' "/proc/$shell/status"; }
    moves=40
    # Moves the selection back and forth $moves times, a long move each time
    # (first app to last), with time for each animation to finish.
    measure() {
        open AppSwitcherPopup
        local start end t0 t1
        start=$(ticks)
        t0=$(date +%s.%N)
        for i in $(seq 1 $moves); do
            pick $((i % 2 ? 3 : 0))
            sleep 0.3
        done
        end=$(ticks)
        t1=$(date +%s.%N)
        close
        awk -v a="$start" -v b="$end" -v t0="$t0" -v t1="$t1" -v hz="$hz" -v m=$moves -v l="$1" \
            'BEGIN { cpu = (b - a) / hz; printf "  %-34s %5.1f%% of a core   %5.1f ms per move\n", l, 100 * cpu / (t1 - t0), 1000 * cpu / m }'
    }
    duration=$(dconf read ${P}animation-duration)
    echo "CPU while switching ($moves moves, 0.3 s apart, ${duration:-220} ms animations)"
    run "Main.extensionManager.disableExtension('$ATG_UUID'); 1"; pause 1
    measure "GNOME's switcher, no extension"
    run "Main.extensionManager.enableExtension('$ATG_UUID'); 1"; pause 1
    for style in none slide stretch liquid jelly pop fade; do
        dconf write ${P}animation "'$style'"
        measure "extension, $style"
    done
    # The selected item's growth is an animation of its own.
    dconf write ${P}focus-scale 100
    for style in none slide liquid; do
        dconf write ${P}animation "'$style'"
        measure "extension, $style, no growth"
    done
    dconf reset ${P}focus-scale
    dconf reset ${P}animation

    echo "Memory (resident size of gnome-shell, garbage collected)"
    dconf write ${P}animation "'liquid'"
    # Opens and closes 100 switchers, moving the selection in each, and
    # prints how much the shell grew. A leak grows again in every round;
    # caches and the JavaScript heap settling in grow only at first.
    cycles() {
        run "imports.system.gc(); 1"; pause 1
        local before after
        before=$(rss)
        for _ in $(seq 1 100); do
            run "(() => { $POPUP?.destroy(); const p = new global._atgAltTab.AppSwitcherPopup();
                p._resetNoModsTimeout = () => {}; global._atgPopup = p;
                p.show(false, 'switch-applications', 0); p._showImmediately(); p._select(3); p._select(0); })(); 1"
        done
        close
        run "imports.system.gc(); 1"; pause 2
        after=$(rss)
        printf "  %-34s %4d MiB -> %4d MiB  (%+d KiB)\n" "$1" $((before / 1024)) $((after / 1024)) $((after - before))
    }
    run "Main.extensionManager.disableExtension('$ATG_UUID'); 1"; pause 1
    cycles "100 switchers, no extension"
    cycles "100 more, no extension"
    run "Main.extensionManager.enableExtension('$ATG_UUID'); 1"; pause 1
    cycles "100 switchers, extension (liquid)"
    cycles "100 more, extension"
    cycles "100 more, extension"
    dconf reset ${P}animation
    expect "$EXT.stateObj._highlighters.size === 0" "highlighters left behind by closed switchers"
    echo "  highlighters alive after closing them all: 0"
    exit 0
fi

echo "1. app switcher, default look"
open AppSwitcherPopup
expect "$LIST.has_style_class_name('atg-list') && $LIST._scrollView.child !== $LIST._list" "list not decorated"
expect "$(aligned "$LIST")" "highlight not on the selected app"
expect "$LIST._items[$LIST._highlighted].scale_x > 1.04" "selected app did not grow"
# The preferences preview draws the border as white at 65%; it must match.
expect "(c => c.red === 255 && Math.abs(c.alpha - 166) <= 2)($(hl "$LIST")._highlight.get_theme_node().get_border_color(imports.gi.St.Side.TOP))" \
    "border is not white at 65%, as the preview draws it"
shot 01-default

echo "2. slide, caught halfway"
dconf write ${P}animation-duration 900
open AppSwitcherPopup
run "global._atgX = $(hl "$LIST")._highlight.x; 1"
pick 3; pause 0.3
expect "$(moving "$LIST")" "highlight is not moving"
expect "(() => { const x = $(hl "$LIST")._highlight.x; return x > global._atgX + 4; })()" "highlight did not leave the old app"
shot 02-slide-moving
pause 1.2
expect "$(aligned "$LIST")" "highlight did not reach the new app"
expect "$LIST._items[1].scale_x === 1" "previous app did not shrink back"
shot 03-slide-done

echo "3. stretch: reaches over both apps first"
dconf write ${P}animation "'stretch'"
open AppSwitcherPopup
pick 3; pause 0.3
expect "$(hl "$LIST")._highlight.width > $LIST._items[1].width * 2" "highlight did not stretch"
shot 04-stretch
pause 1.2
expect "$(aligned "$LIST")" "stretch did not end on the app"

echo "4. fade: dims out and back in"
dconf write ${P}animation "'fade'"
open AppSwitcherPopup
pick 2; pause 0.2
expect "$(hl "$LIST")._highlight.opacity < 200" "highlight did not fade"
pause 1.2
expect "$(aligned "$LIST")" "fade did not end on the app"

# Stage box of the highlight and of an item, as [x, y, width, height].
extents() { echo "(a => { const r = a.get_transformed_extents(); return [r.get_x(), r.get_y(), r.get_width(), r.get_height()]; })($1)"; }
HLBOX="$(extents "$(hl "$LIST")._highlight")"

echo "4b. liquid: a drop over both apps with a thin neck, then the highlight again"
dconf write ${P}animation "'liquid'"
open AppSwitcherPopup
pick 3; pause 0.3
expect "$(hl "$LIST")._timeline?.is_playing()" "liquid is not running"
expect "$(hl "$LIST")._drop.visible && $(hl "$LIST")._highlight.opacity === 0" "the drop does not stand in for the highlight"
expect "(([x, y, w, h]) => w > $LIST._items[1].width * 2)($(extents "$(hl "$LIST")._drop"))" "the drop is not stretched"
expect "$(hl "$LIST")._shape.neck < $LIST._items[1].height * 0.8" "the drop has no neck"
shot 04b-liquid
pause 1.2
expect "$(aligned "$LIST") && $(hl "$LIST")._timeline === null && !$(hl "$LIST")._drop.visible" \
    "liquid did not settle on the app"
# A new selection halfway takes over from where the drop is, with no gap.
pick 1; pause 0.25
pick 2; pause 0.05
expect "$(hl "$LIST")._drop.visible && $(hl "$LIST")._highlight.opacity === 0" "interrupted liquid lost its drop"
pause 1.3
expect "$(aligned "$LIST") && $(hl "$LIST")._timeline === null" "interrupted liquid did not settle on the new app"
# Another style taking over from a drop shows the highlight where the drop was.
dconf write ${P}animation "'slide'"
open AppSwitcherPopup
# Switch the style of this open list directly, mid-animation.
run "$(hl "$LIST")._config.animation = 'liquid'; 1"
pick 3; pause 0.25
run "$(hl "$LIST")._config.animation = 'slide'; 1"
pick 2; pause 0.05
expect "!$(hl "$LIST")._drop.visible && $(hl "$LIST")._highlight.opacity === 255" "slide after liquid left the drop or a hidden highlight"
pause 1.3
expect "$(aligned "$LIST")" "slide after liquid did not settle on the app"

echo "4c. jelly: springs past the app, then settles"
dconf write ${P}animation "'jelly'"
open AppSwitcherPopup
pick 3; pause 0.3
expect "(([x, y, w, h]) => { const [ix, , iw] = $(extents "$LIST._items[3]"); return x + w / 2 > ix + iw / 2 + 4; })($HLBOX)" \
    "jelly did not overshoot"
shot 04c-jelly
pause 1.2
expect "$(aligned "$LIST")" "jelly did not settle on the app"

echo "4d. pop: shrinks on the old app, grows out of the new one"
dconf write ${P}animation "'pop'"
open AppSwitcherPopup
pick 3; pause 0.15
expect "$(hl "$LIST")._highlight.width < $LIST._items[1].width * 0.8 && $(hl "$LIST")._highlight.opacity < 255" \
    "pop did not shrink"
pause 1.2
expect "$(aligned "$LIST")" "pop did not end on the app"

echo "4e. animations off: liquid jumps"
dconf write ${P}animation "'liquid'"
dconf write /org/gnome/desktop/interface/enable-animations false
pause 0.5
expect "!imports.gi.St.Settings.get().enable_animations" "animations still on"
open AppSwitcherPopup
pick 3; pause 0.1
expect "$(aligned "$LIST") && $(hl "$LIST")._timeline === null" "liquid animated with animations off"
dconf reset /org/gnome/desktop/interface/enable-animations
dconf reset ${P}animation
dconf reset ${P}animation-duration

echo "5. window thumbnails: outline on the app, highlight on the window"
open AppSwitcherPopup
run "global._atgFiles = $POPUP._items.findIndex(i => i.cachedWindows.length === 2); 1"
expect "global._atgFiles >= 0" "no app with two windows"
pick "global._atgFiles, 0"; pause 1.2
expect "$THUMBS && $(aligned "$THUMBS")" "highlight not on the first thumbnail"
expect "$(hl "$LIST")._highlight.has_style_pseudo_class('outlined')" "app is not outlined"
expect "$(aligned "$LIST")" "outline not on the app"
pick "global._atgFiles, 1"; pause 0.8
expect "$(aligned "$THUMBS")" "highlight did not follow to the second thumbnail"
shot 05-thumbnails
pick "global._atgFiles"; pause 0.8
expect "!$(hl "$LIST")._highlight.has_style_pseudo_class('outlined')" "outline did not turn back into a highlight"

echo "6. custom color, square corners, no border, larger growth"
NODE="$(hl "$LIST")._highlight.get_theme_node()"
dconf write ${P}highlight-color "'#f6d32d'"
dconf write ${P}corner-radius 6
dconf write ${P}border-width 0
dconf write ${P}focus-scale 110
open AppSwitcherPopup
expect "(c => c.red === 0xf6 && c.green === 0xd3 && c.blue === 0x2d && c.alpha === 255)($NODE.get_background_color())" \
    "custom color not applied"
expect "$NODE.get_border_width(imports.gi.St.Side.TOP) === 0" "border still drawn"
expect "$LIST._items[$LIST._highlighted].get_style() === 'color: #000000;'" "text not readable on a light color"
expect "$LIST._items[$LIST._highlighted].scale_x > 1.09" "selected app did not grow to 110%"
expect "$(aligned "$LIST")" "highlight not on the grown app"
shot 06-custom
for key in highlight-color corner-radius border-width focus-scale; do dconf reset ${P}$key; done

echo "6b. translucent accent, thick border"
dconf write ${P}highlight-opacity 50
dconf write ${P}border-width 5
open AppSwitcherPopup
# The accent color comes from the stylesheet, at half opacity.
expect "(c => Math.abs(c.alpha - 128) <= 1 && c.blue > c.red)($NODE.get_background_color())" "fill is not a translucent accent"
expect "$NODE.get_border_width(imports.gi.St.Side.TOP) === 5" "border is not 5 pixels"
shot 06b-translucent
# The app's outline keeps a border of its own, opaque, whatever the fill.
pick "global._atgFiles, 0"; pause 1
expect "(c => c.alpha === 0)($NODE.get_background_color()) && $NODE.get_border_width(imports.gi.St.Side.TOP) === 5" \
    "outline has a fill or lost its border"
dconf write ${P}border-width 0
open AppSwitcherPopup
pick "global._atgFiles, 0"; pause 1
expect "$NODE.get_border_width(imports.gi.St.Side.TOP) === 2" "outline without border"
for key in highlight-opacity border-width; do dconf reset ${P}$key; done

echo "6c. curves and tuning reach the switcher"
for curve in bounce elastic overshoot; do
    dconf write ${P}animation-curve "'$curve'"
    dconf write ${P}curve-rebound 90
    open AppSwitcherPopup
    pick 3; pause 1
    expect "$(hl "$LIST")._config.curve === '$curve' && $(hl "$LIST")._config.motion.rebound === 0.9 && $(aligned "$LIST")" \
        "$curve did not end on the app"
done
dconf write ${P}animation "'liquid'"
dconf write ${P}liquid-viscosity 100
dconf write ${P}jelly-wobbles 4
open AppSwitcherPopup
expect "Math.abs($(hl "$LIST")._config.motion.liquidNeck - 0.9) < 1e-9 && Math.abs($(hl "$LIST")._config.motion.jellyFrequency - 4.5 * Math.PI) < 1e-9" \
    "tuning not read from the settings"
for key in animation animation-curve curve-rebound liquid-viscosity jelly-wobbles; do dconf reset ${P}$key; done

echo "7. window switcher; the highlight follows when a window closes"
open WindowSwitcherPopup switch-windows
pick 3; pause 0.8
expect "$(aligned "$LIST")" "highlight not on the selected window"
shot 07-window-switcher
run "global._atgCount = $LIST._items.length; $POPUP._items[0].window.delete(global.get_current_time()); 1"
for _ in $(seq 1 20); do is_true "$LIST._items.length === global._atgCount - 1" && break; sleep 0.25; done
expect "$LIST._items.length === global._atgCount - 1" "window did not close"
pause 0.8
expect "$(aligned "$LIST")" "highlight did not follow the items after a window closed"

echo "8. disabling while the switcher is open puts GNOME's list back"
open AppSwitcherPopup
run "Main.extensionManager.disableExtension('$ATG_UUID'); 1"; pause 0.5
expect "!$LIST.has_style_class_name('atg-list') && $LIST._scrollView.child === $LIST._list" "list not restored"
expect "$LIST._items.every(i => i.scale_x === 1 && !i.get_style())" "items keep the extension's scale or style"
pick 2; pause 0.3
expect "$LIST._items[2].has_style_pseudo_class('selected')" "GNOME's own selection broke"
shot 08-disabled
run "Main.extensionManager.enableExtension('$ATG_UUID'); 1"; pause 0.5
open AppSwitcherPopup
expect "$(aligned "$LIST")" "highlight missing after enabling again"
close

echo "9. HiDPI: scale factor 2"
# Headless Wayland ignores the scaling-factor key; set the UI scale directly.
run "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2; 1"
pause 2
open AppSwitcherPopup
pick 2; pause 0.8
expect "$(aligned "$LIST")" "highlight not on the app at scale 2"
shot 09-hidpi
close
run "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; 1"
pause 2

echo "10. preferences window"
n=10
# Page and transition style: each style shows its own fine-tuning options.
for view in appearance:slide animation:liquid animation:jelly; do
    page=${view%:*}
    dconf write ${P}animation "'${view#*:}'"
    # The prefs app is D-Bus activated: pass the page through the activation
    # environment and restart only the instance on this private bus.
    dbus-update-activation-environment ALTTAB_GLIDE_PREFS_PAGE=$page
    pid=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null |
        grep -o '[0-9]\+' | tail -1 || true)
    [ -n "$pid" ] && kill "$pid" && pause 1
    gnome-extensions prefs "$ATG_UUID" >/dev/null 2>&1 || true
    pause 4
    shot "$n-preferences-${view/:/-}"
    n=$((n + 1))
done
# The preview loops: a move and a pause take under 0.9 s, so over 1.2 s
# at least one screenshot must differ from the first.
moved=false
for i in 1 2 3 4; do
    pause 0.3
    shot "preview-$i" >/dev/null
    cmp -s "$ATG_OUT/preview-$i.png" "$ATG_OUT/$((n - 1))-preferences-animation-jelly.png" || moved=true
    rm -f "$ATG_OUT/preview-$i.png"
done
$moved || { echo "FAILED: the preferences preview does not move"; exit 1; }
dconf reset ${P}animation

# The shell logs to shell.log; the preferences, a separate process on this
# bus, to session.log.
errors=$(grep -E "JS ERROR|JS WARNING|$ATG_UUID.*(rror|Exception)|Gjs-CRITICAL" "$log" "$ATG_OUT/session.log" || true)
if [ -n "$errors" ]; then
    echo "FAILED: errors in $log"
    echo "$errors"
    exit 1
fi
echo "OK: no JavaScript errors (log: $log)"

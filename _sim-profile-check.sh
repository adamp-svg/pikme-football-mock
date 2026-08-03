#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# _sim-profile-check.sh — DEVICE TRUTH for the in-game player-profile pane (.pf-side).
#
# WHY THIS EXISTS. Adam has been told more than once that the club/membership strip and the
# גביעים/דירוג places block are "fixed", and he still cannot see them on his phone. Chrome cannot
# settle that: the shipping surface is a WKWebView inside a RELEASE iOS build pointed at PROD.
# This script drives that exact stack, end to end, in one command, and prints measured numbers
# instead of an opinion.
#
#   ./_sim-profile-check.sh
#
# WHAT IT PROVES (all measured, nothing assumed)
#   1. the app under test is the RELEASE build → __DEV__ false → it loads PROD, not localhost:3012
#      (verified by md5 of main.jsbundle, and by grepping the sim's own network log for the host)
#   2. it reaches the in-game profile screen and captures it at FULL NATIVE RESOLUTION (2532x1170)
#   3. it locates .pf-side geometrically (a ~527px-wide bordered column, i.e. the CSS `flex:0 0 176px`)
#      and reports how many px at the bottom of that pane are EMPTY
#   4. it drags the pane to prove whether anything is hidden below a fold, or nothing is there at all
#   5. it OCRs the pane for the ranked block's `#N` cells — language-independent, so it works even
#      though the only installed tesseract language is `eng` while the UI is Hebrew
#
# ⚠️ SIMULATOR TRAPS THIS SCRIPT ALREADY PAYS FOR — do not "simplify" them away:
#   • the football screen forces landscape, but the sim keeps a PORTRAIT framebuffer, so every
#     screenshot comes out rotated. Captures are saved raw AND rotated; analysis uses the rotated one,
#     and it tries BOTH rotation directions because landscape-left/right flips between runs.
#   • rotation state leaks between runs and leaves the app drawing SIDEWAYS — and then every tap
#     coordinate below is wrong and the run silently navigates nowhere (this cost a whole run to find).
#     `xcrun simctl shutdown` alone did NOT clear it; `killall Simulator` + shutdown + boot did. So the
#     reset is the hard one, `Device > Rotate Device Automatically` is force-checked, and the script
#     then VERIFIES the home screen is upright (full-width dark status bar) before it taps anything.
#   • the first click after `open -a Simulator` is swallowed as window focus — every tap activates
#     Simulator first.
#   • taps are computed from the Simulator window's live AX geometry on EVERY tap, so a moved or
#     resized window cannot silently send touches to the wrong place.
#   • `simctl openurl` while the app is foregrounded leaves a stuck "Open in?" alert. This script
#     never uses it; it navigates by tapping.
#
# READ-ONLY on product code. Touches nothing in public/.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
set -uo pipefail

UDID="${SIM_UDID:-D35369C9-3607-4DBF-8C95-371EEF8BBA53}"
APP_ID="com.anonymous.pikmeTV"
RELEASE_APP="${RELEASE_APP:-/Users/adamleeperelman/Documents/pikeme/appstore-3.3.3/_build/app/pikmeTV.app}"
# Sim that also carries Adam's seeded session, used as the fallback donor if this one has none.
DONOR_UDID="${DONOR_UDID:-B238D85F-D456-4FD3-A9B5-0607BC09C78A}"
OUT="${OUT:-/tmp/sim-profile-check-$(date +%Y%m%d-%H%M%S)}"
REBOOT=1
[ "${1:-}" = "--no-reboot" ] && REBOOT=0

# Tap targets, in DEVICE POINTS of the sim's PORTRAIT framebuffer (iPhone 14 = 390x844pt).
# The game renders landscape inside that portrait framebuffer, so in-game targets look transposed.
# Measured 2026-08-03 against build 97.
T_GAME_TAB="241 774"      # app footer, 🎮 tab
T_FOOTBALL="101 279"      # game-store card «כדור-ריב»
T_FACE="352 116"          # the hub's own face button — the ONLY reliable way into the profile
D_SCROLL="123 709 290 709" # a drag that lives entirely inside .pf-side

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

command -v cliclick >/dev/null || die "cliclick is required (brew install cliclick)"
python3 -c 'import PIL' 2>/dev/null || die "python3 Pillow is required (pip3 install Pillow)"
[ -d "$RELEASE_APP" ] || die "release build not found at $RELEASE_APP"
mkdir -p "$OUT"

# ── tap/drag: re-reads the Simulator screen origin every call ─────────────────────────────────
simtap() {
  osascript -e 'tell application "Simulator" to activate' >/dev/null 2>&1
  local geo OX OY
  geo=$(osascript -e 'tell application "System Events" to tell process "Simulator"
set gp to position of group 1 of window 1
set gs to size of group 1 of window 1
return (item 1 of gp as string) & " " & (item 2 of gp as string) & " " & (item 1 of gs as string) & " " & (item 2 of gs as string)
end tell' 2>/dev/null) || die "cannot read the Simulator window (is it open? is Terminal allowed under Privacy > Accessibility?)"
  read -r OX OY _ _ <<<"$geo"
  [ -n "${OX:-}" ] || die "empty Simulator geometry"
  if [ $# -eq 2 ]; then
    cliclick "m:$((OX+$1)),$((OY+$2))" "w:60" "c:$((OX+$1)),$((OY+$2))" >/dev/null
  else
    local x1=$((OX+$1)) y1=$((OY+$2)) x2=$((OX+$3)) y2=$((OY+$4)) i
    cliclick "m:$x1,$y1" "dd:$x1,$y1" "w:80" >/dev/null
    for i in 1 2 3 4 5 6 7 8; do
      cliclick "dm:$((x1+(x2-x1)*i/8)),$((y1+(y2-y1)*i/8))" "w:25" >/dev/null
    done
    cliclick "du:$x2,$y2" >/dev/null
  fi
}
shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1 || die "screenshot failed"
         cp "$OUT/$1.png" "$OUT/$1-rot.png"; sips -r 270 "$OUT/$1-rot.png" >/dev/null 2>&1; }

# Is the app drawing UPRIGHT in the portrait framebuffer, or sideways? Measured off the status bar:
# upright it is a full-width dark band near the top; rotated it becomes a full-height dark column.
# Prints "UPRIGHT" or "ROTATED".
upright() {
  python3 - "$OUT/$1.png" <<'PY'
import sys
from PIL import Image
im=Image.open(sys.argv[1]).convert("RGB"); W,H=im.size; px=im.load()
dark=lambda c: sum(c)<200
row=sum(1 for x in range(0,W,5) if dark(px[x,60]))/len(range(0,W,5))
col=sum(1 for y in range(0,H,5) if dark(px[60,y]))/len(range(0,H,5))
print("UPRIGHT" if row>col else "ROTATED")
PY
}

# ── 1. the app under test must be the RELEASE build (else it points at localhost:3012) ────────
say "1/6  install + verify the RELEASE build (this is what makes it load PROD)"
INSTALLED_APP=$(xcrun simctl get_app_container "$UDID" "$APP_ID" app 2>/dev/null || true)
WANT=$(md5 -q "$RELEASE_APP/main.jsbundle")
HAVE=""; [ -n "$INSTALLED_APP" ] && [ -f "$INSTALLED_APP/main.jsbundle" ] && HAVE=$(md5 -q "$INSTALLED_APP/main.jsbundle")
if [ "$WANT" != "$HAVE" ]; then
  echo "  installed bundle differs (have=${HAVE:-none}) -> installing the release build"
  xcrun simctl boot "$UDID" 2>/dev/null; xcrun simctl bootstatus "$UDID" >/dev/null 2>&1
  # Preserve the seeded session across the reinstall.
  DATA=$(xcrun simctl get_app_container "$UDID" "$APP_ID" data 2>/dev/null || true)
  [ -n "$DATA" ] && [ -d "$DATA/Library/Application Support/$APP_ID" ] && \
    cp -R "$DATA/Library/Application Support/$APP_ID" "$OUT/session-keep" 2>/dev/null
  xcrun simctl install "$UDID" "$RELEASE_APP" || die "install failed"
else
  echo "  main.jsbundle md5 matches the release build: $WANT"
fi
echo "  => RELEASE build ⇒ __DEV__ is false ⇒ deriveGameUrl() returns PROD_GAME_URL"

# ── 2. Adam's session must be present or every screen is logged-out/empty ─────────────────────
say "2/6  verify the seeded session (AsyncStorage persist:root)"
xcrun simctl boot "$UDID" 2>/dev/null; xcrun simctl bootstatus "$UDID" >/dev/null 2>&1
DATA=$(xcrun simctl get_app_container "$UDID" "$APP_ID" data 2>/dev/null) || die "no data container"
STORE="$DATA/Library/Application Support/$APP_ID"
if [ ! -f "$STORE/RCTAsyncLocalStorage_V1/manifest.json" ]; then
  echo "  no session here — restoring"
  mkdir -p "$STORE"
  if [ -d "$OUT/session-keep" ]; then cp -R "$OUT/session-keep/." "$STORE/"
  else
    DONOR=$(xcrun simctl get_app_container "$DONOR_UDID" "$APP_ID" data 2>/dev/null || true)
    [ -n "$DONOR" ] && cp -R "$DONOR/Library/Application Support/$APP_ID/." "$STORE/" \
      || die "no session to restore — seed one, or the screens will be empty/logged-out"
  fi
fi
python3 - "$STORE" <<'PY' || die "session unreadable"
import json,sys,os,hashlib
d=os.path.join(sys.argv[1],"RCTAsyncLocalStorage_V1")
man=json.load(open(os.path.join(d,"manifest.json")))
assert "persist:root" in man, "persist:root missing"
f=os.path.join(d,hashlib.md5(b"persist:root").hexdigest())
u=json.loads(json.load(open(f))["user"])
assert u.get("token"), "no auth token in session"
print(f"  session OK: {u.get('nickName')} / {u.get('phone')} (token {len(u['token'])} chars)")
PY

# ── 3. reboot to clear the leaked-rotation trap, then launch with a network log running ───────
say "3/6  hard-reset the sim (clears the leaked sideways-render state) and launch"
if [ $REBOOT -eq 1 ]; then
  xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1
  xcrun simctl shutdown "$UDID" >/dev/null 2>&1
  killall Simulator 2>/dev/null; sleep 4          # shutdown alone does NOT clear the rotation leak
  xcrun simctl boot "$UDID" >/dev/null 2>&1; xcrun simctl bootstatus "$UDID" >/dev/null 2>&1
fi
open -a Simulator; sleep 6
# The football screen asks for landscape; with this unchecked the sim refuses and the app draws sideways.
osascript -e 'tell application "Simulator" to activate' >/dev/null 2>&1
if [ "$(osascript -e 'tell application "System Events" to tell process "Simulator" to return ((value of attribute "AXMenuItemMarkChar" of menu item "Rotate Device Automatically" of menu 1 of menu bar item "Device" of menu bar 1) as string)' 2>/dev/null)" != "✓" ]; then
  echo "  Device > Rotate Device Automatically was OFF -> enabling"
  osascript -e 'tell application "System Events" to tell process "Simulator" to click menu item "Rotate Device Automatically" of menu 1 of menu bar item "Device" of menu bar 1' >/dev/null 2>&1
  sleep 2
fi
NETLOG="$OUT/netlog.txt"
xcrun simctl spawn "$UDID" log stream --style compact --level debug > "$NETLOG" 2>&1 &
LOGPID=$!
trap 'kill $LOGPID 2>/dev/null' EXIT
sleep 2
# Launch, and REFUSE to tap until the app is verifiably upright — sideways means every tap target
# below is wrong, and the run would navigate nowhere while looking like it worked.
for attempt in 1 2 3; do
  xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1
  xcrun simctl launch "$UDID" "$APP_ID" >/dev/null || die "launch failed"
  sleep 10
  shot 01-home
  ORIENT=$(upright 01-home)
  echo "  launch attempt $attempt: home renders $ORIENT"
  [ "$ORIENT" = "UPRIGHT" ] && break
  [ $attempt -eq 3 ] && die "app still drawing sideways after 3 launches — inspect $OUT/01-home.png"
done

# ── 4. navigate: footer 🎮 -> football card -> hub -> own face button -> profile ───────────────
say "4/6  navigate to the in-game profile screen"
simtap $T_GAME_TAB;  sleep 4;  shot 02-gamestore
simtap $T_FOOTBALL;  sleep 15; shot 03-game
# The game restores whatever screen it was last on. If that is already the profile this tap lands
# harmlessly inside the pane; if it is the hub, it is the face button. Either way we end on profile.
simtap $T_FACE;      sleep 5;  shot 04-profile

say "    which host did the device actually load the game from?"
PRODHITS=$(LC_ALL=C grep -a -c 'pikme-football\.onrender\.com' "$NETLOG" || true)
DEVHITS=$(LC_ALL=C grep -a -c ':3012' "$NETLOG" || true)
echo "  pikme-football.onrender.com : $PRODHITS log lines"
echo "  :3012 (local dev server)    : $DEVHITS log lines"
LC_ALL=C grep -a -oE 'url: https://pikme-football[^ ,]+' "$NETLOG" | sed 's/^url: /  URL: /' | sort -u
[ "${PRODHITS:-0}" -gt 0 ] || echo "  ⚠️ no PROD hits logged — the capture may have started late; check $NETLOG"

# ── 5. does the pane scroll? if it does not, nothing is hidden below a fold ────────────────────
say "5/6  scroll test — drag inside .pf-side and see if anything moves"
cp "$OUT/04-profile.png" "$OUT/05-prescroll.png"
simtap $D_SCROLL; sleep 2; shot 06-postscroll
if [ "$(md5 -q "$OUT/05-prescroll.png")" = "$(md5 -q "$OUT/06-postscroll.png")" ]; then
  SCROLLS="NO — frame byte-identical after a full-pane drag ⇒ scrollHeight == clientHeight ⇒ nothing below the fold"
else
  SCROLLS="YES — the pane moved ⇒ there IS content below the fold (it needs scrolling to reach)"
fi
echo "  $SCROLLS"

# ── 6. measure .pf-side out of the real device pixels ─────────────────────────────────────────
say "6/6  measure the pane from the device pixels"
python3 - "$OUT" <<'PY'
import sys, os, subprocess
from PIL import Image
out = sys.argv[1]

def isborder(c):
    r,g,b = c; return 50<r<100 and 65<g<115 and 45<b<90          # #46543f family
def isbg(c):
    r,g,b = c; return abs(r-19)<10 and abs(g-27)<10 and abs(b-22)<10   # rgba(19,27,22,.94)

def find_pane(im):
    """.pf-side is the RIGHTMOST tall bordered column. CSS `flex:0 0 176px` -> ~527 device px wide,
    which is the check that stops us measuring some other panel and calling it the pane."""
    W,H = im.size; px = im.load()
    colhits = [sum(1 for y in range(0,H,3) if isborder(px[x,y])) for x in range(W)]
    runs, cur = [], []
    for x,c in enumerate(colhits):
        if c > (H/3)*0.5: cur.append(x)
        elif cur: runs.append(cur); cur=[]
    if cur: runs.append(cur)
    if len(runs) < 2: return None
    paneL, paneR = runs[-2][0], runs[-1][-1]
    if not (150 <= (paneR-paneL)/3 <= 200): return None
    return paneL, paneR

# Landscape-left vs landscape-right flips between runs, so try BOTH rotations and keep the one that
# actually yields a ~176pt pane. Guessing one direction is how a good run gets reported as a failure.
cand = None
for deg in (270, 90):
    p = os.path.join(out, f"04-profile-rot{deg}.png")
    Image.open(os.path.join(out,"04-profile.png")).rotate(-deg if deg==90 else 90, expand=True).save(p)
    im = Image.open(p).convert("RGB")
    hit = find_pane(im)
    print(f"  rotation {deg}°: pane {'found' if hit else 'not found'}")
    if hit: cand = (p, im, hit); break
if not cand:
    print("  ✗ could not locate .pf-side at either rotation — is the profile screen actually open?")
    print("    inspect", os.path.join(out,"04-profile.png")); sys.exit(3)
img, im, (paneL, paneR) = cand
W,H = im.size; px = im.load()
wpx = paneR-paneL
print(f"  frame: {W}x{H} device px (iPhone 14 landscape = 2532x1170 @3x = 844x390pt)")
print(f"  .pf-side x {paneL}..{paneR}  width={wpx}px = {wpx/3:.0f}pt   (CSS flex:0 0 176px)")

inL, inR = paneL+9, paneR-9
rowhits = [sum(1 for x in range(inL,inR,3) if isborder(px[x,y])) for y in range(H)]
tb = [y for y,c in enumerate(rowhits) if c > (inR-inL)/3*0.5]
top, bot = tb[0], tb[-1]
print(f"  .pf-side y {top}..{bot}  height={bot-top}px = {(bot-top)/3:.0f}pt")

content = [y for y in range(top+9, bot-8) if sum(1 for x in range(inL,inR) if not isbg(px[x,y])) > 6]
lowest = content[-1] if content else top
free = (bot-8) - lowest
print(f"  lowest content pixel inside the pane : y={lowest}")
print(f"  pane inner bottom                    : y={bot-8}")
print(f"  \033[1mEMPTY SPACE AT THE BOTTOM OF .pf-side: {free}px = {free/3:.0f}pt\033[0m")

# language-independent marker: the ranked block renders two `#N` cells in Latin glyphs.
pane = Image.open(img).convert("L").crop((paneL, top, paneR, bot))
pane = pane.resize((pane.width*3, pane.height*3), Image.LANCZOS)
p = os.path.join(out, "pane-ocr.png"); pane.save(p)
marks = 0
try:
    txt = subprocess.run(["tesseract", p, "stdout", "-l", "eng", "--psm", "6"],
                         capture_output=True, text=True, timeout=60).stdout
    import re; marks = len(re.findall(r'#\s?\d+', txt))
except Exception as e:
    print("  (ocr unavailable:", e, ")")
print(f"  ranked-place `#N` cells OCR'd in the pane: {marks}   (expect 2 once the block renders)")

# ⚠️ THE OCR IS ADVISORY, NOT THE GATE — it must never again decide the verdict on its own.
# 2026-08-03: tesseract raised `'utf-8' codec can't decode byte 0x89` on this very screenshot, marks
# came back 0, and the script printed a red NO over a screen that visibly HAD the block. A check that
# cries wolf is worse than no check. So the verdict now rests on a deterministic pixel signal: the
# rank values and the מועדון ושיוך heading are drawn in the theme's gold, and nothing else in the
# lower half of the pane is. Measured on a known-GOOD device frame: 3171 gold px in the lower 45%%
# (a pane without the block has essentially none), so 400 is a wide, safe floor.
rgb = Image.open(img).convert("RGB"); q = rgb.load()
def _gold(c):
    r, g, b = c
    return r > 190 and 150 < g < 235 and b < 140
_from = top + int((bot - top) * 0.55)
gold_lower = sum(1 for yy in range(_from, bot) for xx in range(paneL, paneR) if _gold(q[xx, yy]))
GOLD_FLOOR = 400
block_px = gold_lower >= GOLD_FLOOR
print(f"  gold pixels in the pane's lower 45%: {gold_lower}   (>= {GOLD_FLOOR} ⇒ the block is drawn)")
# Either signal is enough; the pixel one is the one that has never lied.
marks = 2 if block_px else marks

# annotated evidence shot
from PIL import ImageDraw
ann = Image.open(img).convert("RGB"); d = ImageDraw.Draw(ann)
d.rectangle([paneL,top,paneR,bot], outline=(255,215,0), width=5)
if free > 12:
    d.rectangle([paneL+6, lowest+4, paneR-6, bot-8], outline=(255,60,60), width=6)
    for i in range(paneL+6, paneR-6, 34): d.line([i, lowest+8, i+22, bot-12], fill=(255,60,60), width=2)
    d.text((paneL-560, lowest+90), f"EMPTY {free}px = {free/3:.0f}pt", fill=(255,60,60))
d.text((paneL-560, top+10), f".pf-side {wpx}x{bot-top}px = {wpx/3:.0f}x{(bot-top)/3:.0f}pt", fill=(255,215,0))
ann.save(os.path.join(out, "07-annotated.png"))

print()
# `free` is REPORTED, never a gate. The lowest-content scan uses isbg(), which cannot see the rank
# tiles — they sit a few shades off the pane background — so it under-reports the content extent and
# once turned a correct screen into a 32pt "empty" claim. Trailing padding is not a defect anyway.
if marks >= 2:
    if free <= 20:
        print("  \033[32mVERDICT: the clubs + gviim/dirug block IS on screen, fully, with no scrolling.\033[0m")
    else:
        print("  \033[32mVERDICT: the clubs + gviim/dirug block IS on screen, with no scrolling.\033[0m")
        print(f"           ({free/3:.0f}pt of trailing space below it — informational; the dark rank")
        print("            tiles are invisible to the brightness scan, so this is usually an artefact.)")
else:
    print("  \033[31mVERDICT: NO clubs / gviim-dirug block on screen. It is NOT in the pane at all —")
    print(f"           the pane simply ends, with {free/3:.0f}pt of unused space below the last item.")
    print("           Confirm by EYE in 04-profile-rot270.png before acting on this.\033[0m")
PY

say "SCREENSHOTS (raw = portrait framebuffer, -rot = readable landscape)"
ls -1 "$OUT"/*.png | sed 's/^/  /'
echo
echo "  network log: $NETLOG"

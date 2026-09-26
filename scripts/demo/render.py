"""Render a verified PawBrowse recording (scripts/demo/record.mjs) at 1x speed into
assets/demo.mp4 and assets/demo.gif.

Every browser frame is the original screencast frame at its original timestamp; nothing on the
page is redrawn. Overlays: the element being acted on (green box + its ref), the command the agent
sent, and the element-table rows that came back.

    python3 scripts/demo/render.py <recording-dir>
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
src = Path(sys.argv[1]).resolve()
state = json.loads((src / "state.json").read_text())
assert state["verification"] and state["verification"]["passed"], "refusing to render an unverified run"
assert not state["errors"], state["errors"]

END = state["elapsed_ms"]
HOLD = 1600  # linger on the result
FPS = 30
W, H = 1536, 1000
VW, VH = state["viewport"]

frames = [(-1, Image.open(src / "frames/start.jpg").convert("RGB"))]
frames += sorted((f["ms"], Image.open(src / "frames" / f["file"]).convert("RGB")) for f in state["frames"])

# --- look: the PawBrowse hero palette -----------------------------------------------------------
BG, PANEL, EDGE = "#0b1119", "#111a26", "#1f2a38"
INK, MUTED, DIM = "#f1f5f9", "#8b98a9", "#4b5a6d"
GREEN, GREEN_DIM = "#22c55e", "#123d24"


def font(n, bold=False):
    for p in (["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else []) + [
        "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"]:
        if Path(p).exists():
            return ImageFont.truetype(p, n)
    return ImageFont.load_default(n)


def mono(n):
    p = "/System/Library/Fonts/Menlo.ttc"
    return ImageFont.truetype(p, n) if Path(p).exists() else ImageFont.load_default(n)


paw = Image.open(ROOT / "extension/icons/icon-128.png").convert("RGBA").resize((34, 34), Image.LANCZOS)
steps = []
for s in state["steps"]:
    steps.append(s)
actions = state["actions"]
n_actions = len(actions)

# browser panel geometry
PX, PY = 36, 186
BAR = 34
S = (1156 - PX) / VW  # scale CSS px -> panel px
PW, PH = round(VW * S), round(VH * S)


def url_at(t):
    stepnames = {s["name"]: s for s in steps}
    if "Open cheapest" in stepnames and t >= stepnames["Open cheapest"]["end"]:
        return "google.com/travel/flights/booking"
    if "Search" in stepnames and t >= stepnames["Search"]["end"]:
        return "google.com/travel/flights/search"
    return "google.com/travel/flights"


def fit(d, text, f, width):
    while d.textlength(text, font=f) > width and len(text) > 4:
        text = text[:-2]
        if not text.endswith("…"):
            text = text.rstrip() + "…"
    return text


def command(a):
    if a["op"] == "type":
        return f'type {a["ref"]} "{a["text"]}"'
    return f'{a["op"]} {a["ref"]}'


out = src / "video-frames"
if out.exists():
    shutil.rmtree(out)
out.mkdir()
total = round((END + HOLD) * FPS / 1000)
for i in range(total):
    raw = i * 1000 / FPS
    t = min(END, round(raw))
    finale = raw > END + 250
    shot = next(im for ms, im in reversed(frames) if ms <= t)
    c = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(c)

    # header
    c.paste(paw, (36, 24), paw)
    d.text((80, 27), "PawBrowse", font=font(25, True), fill=INK)
    d.text((80 + d.textlength("PawBrowse", font=font(25, True)) + 10, 30), "for Claude Code", font=font(21), fill=MUTED)
    badge = "REAL WEB  ·  1× SPEED"
    bw = d.textlength(badge, font=font(14, True)) + 40
    d.rounded_rectangle((W - 36 - bw, 25, W - 36, 59), radius=17, outline=GREEN, width=2)
    d.text((W - 36 - bw + 20, 34), badge, font=font(14, True), fill=GREEN)
    d.text((36, 78), f"Zürich → London → cheapest flight. {END / 1000:.1f} s.", font=font(41, True), fill=INK)
    d.text((38, 135), f"Live Google Flights · {n_actions} actions · every action returns the page's fresh element table",
           font=font(19), fill=MUTED)

    # browser window with the real frame
    d.rounded_rectangle((PX - 1, PY - 1, PX + PW + 1, PY + BAR + PH + 1), radius=14, fill=PANEL, outline=EDGE)
    for j, col in enumerate(["#ef6b5e", "#f5bf4f", "#61c554"]):
        d.ellipse((PX + 16 + j * 19, PY + 12, PX + 26 + j * 19, PY + 22), fill=col)
    d.text((PX + 90, PY + 9), url_at(t), font=mono(14), fill=MUTED)
    c.paste(shot.resize((PW, PH), Image.LANCZOS), (PX, PY + BAR))

    # live highlight on the element being acted on (hero-style numbered box)
    # Just BEFORE each click/keystroke (the element is still on screen), gone right after: pages
    # react within a frame (a suggestion list closes), so a box after the click frames nothing.
    near = [a for a in actions if a["start"] - 280 <= t <= a["start"] + 30]
    cur = None if finale or not near else max(near, key=lambda a: a["start"])
    if cur and cur.get("rect"):
        x, y, w, h = cur["rect"]
        bx0, by0 = PX + x * S - 4, PY + BAR + y * S - 4
        bx1, by1 = PX + (x + w) * S + 4, PY + BAR + (y + h) * S + 4
        d.rounded_rectangle((bx0, by0, bx1, by1), radius=8, outline=GREEN, width=3)
        chip = cur["ref"]
        cw = d.textlength(chip, font=mono(14)) + 14
        d.rounded_rectangle((bx0 - 2, by0 - 24, bx0 - 2 + cw, by0 - 2), radius=6, fill=GREEN)
        d.text((bx0 + 5, by0 - 22), chip, font=mono(14), fill=BG)

    # right panel
    RX = 1190
    d.text((RX, PY), f"PAWBROWSE {state['version']}", font=font(15, True), fill=GREEN)
    d.text((RX - 2, PY + 26), f"{t / 1000:05.2f}", font=mono(52), fill=INK)
    d.text((RX, PY + 92), "SECONDS", font=font(13, True), fill=MUTED)
    for j, s in enumerate(steps):
        y = PY + 132 + j * 40
        done, active = t >= s["end"], s["start"] <= t < s["end"]
        if done:
            d.ellipse((RX, y, RX + 22, y + 22), fill=GREEN)
            d.line([(RX + 6, y + 11), (RX + 10, y + 15), (RX + 17, y + 7)], fill=BG, width=3)
        else:
            d.ellipse((RX, y, RX + 22, y + 22), outline=GREEN if active else DIM, width=2)
        d.text((RX + 34, y), s["name"], font=font(20, done or active), fill=INK if (done or active) else MUTED)

    last = next((a for a in reversed(actions) if a["start"] <= t), None)
    by = PY + 132 + len(steps) * 40 + 14
    d.text((RX, by), "AGENT SENT", font=font(12, True), fill=MUTED)
    d.rounded_rectangle((RX - 2, by + 20, 1500, by + 58), radius=8, fill=PANEL, outline=EDGE)
    if last:
        d.text((RX + 10, by + 30), fit(d, command(last), mono(15), 290), font=mono(15), fill=GREEN)
    ty = by + 74
    took = f"  ·  {last['end'] - last['start']} ms" if last and t >= last["end"] else ""
    d.text((RX, ty), "TABLE CAME BACK" + took, font=font(12, True), fill=MUTED)
    d.rounded_rectangle((RX - 2, ty + 20, 1500, PY + BAR + PH), radius=8, fill=PANEL, outline=EDGE)
    if finale:
        d.rounded_rectangle((RX - 2, ty + 20, 1500, PY + BAR + PH), radius=8, fill=GREEN_DIM, outline=GREEN)
        d.text((RX + 12, ty + 34), "VERIFIED FROM THE PAGE", font=font(13, True), fill=GREEN)
        labels = {"booking_page": "booking page open", "route": "Zürich → London", "one_way": "one way, 1 passenger",
                  "date": state["steps"][3]["name"], "nonstop": "nonstop flight", "booking_options": "booking options shown"}
        for k, (key, ok) in enumerate(state["verification"]["checks"].items()):
            y = ty + 64 + k * 30
            d.ellipse((RX + 12, y, RX + 30, y + 18), fill=GREEN if ok else "#ef4444")
            d.line([(RX + 16, y + 9), (RX + 20, y + 13), (RX + 26, y + 5)], fill=BG, width=2)
            d.text((RX + 40, y - 1), labels.get(key, key), font=font(17), fill=INK)
    elif last and t >= last["end"]:
        for k, row in enumerate(last["preview"][:5]):
            d.text((RX + 10, ty + 32 + k * 22), fit(d, row, mono(12), 292), font=mono(12), fill=INK if k == 0 else MUTED)
    elif last:
        d.text((RX + 10, ty + 32), "waiting for the page…", font=mono(12), fill=DIM)

    # footer
    d.line((36, 925, 1500, 925), fill=EDGE, width=2)
    d.line((36, 925, 36 + (1500 - 36) * t / END, 925), fill=GREEN, width=3)
    d.text((36, 942), "Scripted plan run by the PawBrowse engine on live Google Flights (headless Chrome), result verified from the page.",
           font=font(14), fill=MUTED)
    d.text((36, 963), "Browser time only: the agent's thinking time is not included. Original timing, waits included.",
           font=font(14), fill=MUTED)
    d.text((1500 - d.textlength("github.com/ItaiZeilig/pawbrowse", font=font(14)), 952),
           "github.com/ItaiZeilig/pawbrowse", font=font(14), fill=MUTED)
    c.save(out / f"{i:05d}.png")

assets = ROOT / "assets"
c.save(assets / "demo-result.png")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(out / "%05d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
                str(assets / "demo.mp4")], check=True)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(assets / "demo.mp4"), "-vf",
                "fps=12,scale=1152:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                "-loop", "0", str(assets / "demo.gif")], check=True)
print(f"Rendered {len(frames)} source frames at original timing: {END} ms (+{HOLD} ms hold) -> assets/demo.mp4, assets/demo.gif")

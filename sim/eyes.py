"""Venus with eyes: the balloon has no GPS, so at night it photographs the ground through the
clouds in infrared and asks Gemini Robotics-ER where that view sits on the Magellan map.

The camera view is a crop of the Magellan TOPOGRAPHY around the TRUE position, blurred the way
cloud scattering blurs the surface, plus noise. Real night-side 1-micron images track surface
temperature, and on Venus higher ground is cooler, so height is the right stand-in. (A first try
with the radar mosaic failed: radar texture is fine-grained and blurs to mush.) Bright = high here;
in a real thermal image highlands would be dark, which is just an inversion.

    uv run --with numpy --with pillow python sim/eyes.py --trials 8     # localization test
"""
import argparse
import base64
import io
import json
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from venus import KM_PER_DEG, gc_km

ROOT = Path(__file__).resolve().parent.parent
MODEL = "gemini-robotics-er-2-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
VIEW_DEG = 12.0          # camera footprint, degrees of latitude (~1270 km)
BLUR_KM = 50.0           # cloud scattering blur
SEARCH_DEG = (40.0, 30.0)  # width x height of the map region shown around the dead-reckoning guess
_MAP = None


def basemap():
    """Magellan topography as a numpy array, columns 0..360 E (the file runs -180..180)."""
    global _MAP
    if _MAP is None:
        img = np.asarray(Image.open(ROOT / "assets" / "venus_topo.jpg").convert("L"))
        _MAP = np.roll(img, img.shape[1] // 2, axis=1)
    return _MAP


def _crop(lat, lon, w_deg, h_deg):
    """Equirectangular crop centred on lat/lon, wrapping in longitude. Returns (array, extent)."""
    m = basemap()
    H, W = m.shape
    ppd = W / 360.0
    x0 = int(round((lon - w_deg / 2) * ppd))
    cols = np.arange(x0, x0 + int(round(w_deg * ppd))) % W
    y0 = int(round((90 - (lat + h_deg / 2)) * ppd))
    rows = np.clip(np.arange(y0, y0 + int(round(h_deg * ppd))), 0, H - 1)
    return m[np.ix_(rows, cols)], (lon - w_deg / 2, lon + w_deg / 2, lat - h_deg / 2, lat + h_deg / 2)


def _blur(a, deg_per_px):
    sigma = BLUR_KM / KM_PER_DEG / deg_per_px
    return np.asarray(Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma)), float)


def night_view_raw(lat, lon, rng):
    """Camera view at map resolution (map pixels, map longitude scale): blurred and noisy."""
    a, _ = _crop(lat, lon, VIEW_DEG, VIEW_DEG)
    ppd = basemap().shape[1] / 360.0
    return np.clip(_blur(a, 1 / ppd) + rng.normal(0, 12, a.shape), 0, 255)


def night_view(raw, px=384):
    """The same view upscaled for a model to look at."""
    return Image.fromarray(raw.astype(np.uint8)).resize((px, px), Image.BILINEAR)


def locate_match(raw, guess_lat, guess_lon, step=2):
    """Benchmark: slide the view over the blurred search region, pick the best correlation."""
    w, h = SEARCH_DEG
    region, (lo0, lo1, la0, la1) = _crop(guess_lat, guess_lon, w, h)
    ppd = basemap().shape[1] / 360.0
    region = _blur(region, 1 / ppd)
    v = raw - raw.mean()
    v /= np.linalg.norm(v) + 1e-9
    win = np.lib.stride_tricks.sliding_window_view(region, v.shape)[::step, ::step]
    wz = win - win.mean(axis=(2, 3), keepdims=True)
    score = (wz * v).sum(axis=(2, 3)) / (np.linalg.norm(wz, axis=(2, 3)) + 1e-9)
    iy, ix = np.unravel_index(np.argmax(score), score.shape)
    cy = iy * step + v.shape[0] / 2
    cx = ix * step + v.shape[1] / 2
    return la1 - cy / ppd, (lo0 + cx / ppd) % 360


def search_map(lat, lon, px=1024):
    """Map region around the dead-reckoning guess, with a labelled 5-degree grid."""
    w, h = SEARCH_DEG
    a, (lo0, lo1, la0, la1) = _crop(lat, lon, w, h)
    img = Image.fromarray(a).convert("RGB").resize((px, int(px * h / w)), Image.BILINEAR)
    d = ImageDraw.Draw(img)
    X = lambda lo: (lo - lo0) / (lo1 - lo0) * img.width
    Y = lambda la: (la1 - la) / (la1 - la0) * img.height
    for lo in np.arange(np.ceil(lo0 / 5) * 5, lo1, 5):
        d.line([(X(lo), 0), (X(lo), img.height)], fill=(255, 220, 0), width=1)
        d.text((X(lo) + 3, 3), f"{lo % 360:.0f}E", fill=(255, 255, 0))
    for la in np.arange(np.ceil(la0 / 5) * 5, la1, 5):
        if la <= la0:
            continue
        d.line([(0, Y(la)), (img.width, Y(la))], fill=(255, 220, 0), width=1)
        d.text((3, Y(la) + 3), f"{la:+.0f}", fill=(255, 255, 0))
    cx, cy = X(lon), Y(lat)
    d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], outline=(255, 60, 60), width=3)
    return img


def _b64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def locate(view, guess_lat, guess_lon, thinking="medium", timeout=90):
    """Ask Gemini where the camera view is. Returns (lat, lon, confidence_km, reason) or None."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    w, h = SEARCH_DEG
    prompt = (
        "You are navigating a balloon in the clouds of Venus with no GPS. Image 1 is a map of the "
        f"region around our best guess (red circle at lat {guess_lat:.1f}, lon {guess_lon % 360:.1f} E). "
        f"It spans {w:.0f} degrees of longitude by {h:.0f} of latitude; the yellow grid lines are "
        "every 5 degrees and are labelled. Image 2 is what our downward night camera sees right now: "
        f"the ground directly below us, north up, {VIEW_DEG:.0f} degrees tall and {VIEW_DEG:.0f} degrees "
        "of longitude wide (so it covers a box 12 x 12 grid degrees on image 1), blurred by the "
        "clouds. Both images show height: bright is high ground, dark is low plains. Our guess can "
        "be off by several hundred km. Find where image 2 matches image 1 by comparing the shapes "
        "of high and low ground, and call "
        "report_position with the latitude and longitude of the CENTRE of image 2."
    )
    body = {
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "image/png", "data": _b64(search_map(guess_lat, guess_lon))}},
            {"inline_data": {"mime_type": "image/png", "data": _b64(view)}},
            {"text": prompt}]}],
        "tools": [{"functionDeclarations": [{
            "name": "report_position",
            "description": "Report the balloon's position, read from the map grid.",
            "parameters": {"type": "object", "properties": {
                "lat": {"type": "number"}, "lon_east": {"type": "number"},
                "confidence_km": {"type": "number", "description": "How far off you might be."},
                "reason": {"type": "string"}},
                "required": ["lat", "lon_east", "confidence_km", "reason"]}}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
        "generationConfig": {"thinkingConfig": {"thinkingLevel": thinking}},
    }
    req = urllib.request.Request(URL, json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            parts = json.load(resp)["candidates"][0]["content"]["parts"]
        a = next(p["functionCall"] for p in parts if "functionCall" in p)["args"]
        return float(a["lat"]), float(a["lon_east"]) % 360, float(a.get("confidence_km", 0)), a.get("reason", "")
    except Exception as e:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=8)
    ap.add_argument("--guess_err_km", type=float, default=600)
    ap.add_argument("--save", default="")
    a = ap.parse_args()
    rng = np.random.default_rng(7)
    rows = []
    for i in range(a.trials):
        lat, lon = rng.uniform(-40, 40), rng.uniform(0, 360)
        ang = rng.uniform(0, 2 * np.pi)
        d = a.guess_err_km / KM_PER_DEG
        glat = lat + d * np.sin(ang)
        glon = lon + d * np.cos(ang) / np.cos(np.radians(lat))
        raw = night_view_raw(lat, lon, rng)
        view = night_view(raw)
        mlat, mlon = locate_match(raw, glat, glon)
        merr = gc_km(lat, lon, mlat, mlon)
        if a.save:
            view.save(f"{a.save}/view{i}.png")
            search_map(glat, glon).save(f"{a.save}/map{i}.png")
        t0 = time.time()
        got = locate(view, glat, glon)
        prior = gc_km(lat, lon, glat, glon)
        err = np.nan if got is None else gc_km(lat, lon, got[0], got[1])
        rows.append((prior, err, merr))
        say = "no answer" if got is None else f"says +/-{got[2]:.0f}"
        print(f"trial {i}: guess off {prior:4.0f} km | Gemini off {err:5.0f} km ({say}, "
              f"{time.time() - t0:.0f}s) | pattern match off {merr:5.0f} km", flush=True)
    r = np.array(rows)
    print(f"median miss: guess {np.nanmedian(r[:, 0]):.0f} km, Gemini {np.nanmedian(r[:, 1]):.0f} km, "
          f"pattern match {np.median(r[:, 2]):.0f} km. Gemini beats the guess in "
          f"{(r[:, 1] < r[:, 0]).sum()}/{len(r)}; pattern match in {(r[:, 2] < r[:, 0]).sum()}/{len(r)}")


if __name__ == "__main__":
    main()


# ---------- multiple choice: which candidate tile matches the camera view? ----------

def candidates(raw, guess_lat, guess_lon, k=6, step=2, min_sep_deg=4.0):
    """The k best-correlating, well-separated spots in the search region (lat, lon) list."""
    w, h = SEARCH_DEG
    region, (lo0, lo1, la0, la1) = _crop(guess_lat, guess_lon, w, h)
    ppd = basemap().shape[1] / 360.0
    region = _blur(region, 1 / ppd)
    v = raw - raw.mean()
    v /= np.linalg.norm(v) + 1e-9
    win = np.lib.stride_tricks.sliding_window_view(region, v.shape)[::step, ::step]
    wz = win - win.mean(axis=(2, 3), keepdims=True)
    score = (wz * v).sum(axis=(2, 3)) / (np.linalg.norm(wz, axis=(2, 3)) + 1e-9)
    out = []
    for idx in np.argsort(score, axis=None)[::-1]:
        iy, ix = np.unravel_index(idx, score.shape)
        lat = la1 - (iy * step + v.shape[0] / 2) / ppd
        lon = (lo0 + (ix * step + v.shape[1] / 2) / ppd) % 360
        if all(gc_km(lat, lon, a, b) > min_sep_deg * KM_PER_DEG for a, b in out):
            out.append((lat, lon))
        if len(out) == k:
            break
    return out


def tile(lat, lon, px=256):
    a, _ = _crop(lat, lon, VIEW_DEG, VIEW_DEG)
    ppd = basemap().shape[1] / 360.0
    return Image.fromarray(_blur(a, 1 / ppd).astype(np.uint8)).resize((px, px), Image.BILINEAR)


def choose_tile(view, tiles, thinking="medium", timeout=90):
    """Ask Gemini which labelled tile matches the camera view. Returns (index, reason) or None."""
    key = os.environ.get("GEMINI_API_KEY")
    labels = "ABCDEFGH"[:len(tiles)]
    sheet = Image.new("L", (3 * 266, ((len(tiles) + 2) // 3) * 290), 20)
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(tiles):
        x, y = (i % 3) * 266, (i // 3) * 290
        sheet.paste(t, (x, y + 28))
        d.text((x + 6, y + 6), labels[i], fill=255)
    body = {
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "image/png", "data": _b64(view)}},
            {"inline_data": {"mime_type": "image/png", "data": _b64(sheet)}},
            {"text": "Image 1 is a blurred, noisy night camera view of the ground below a balloon on "
                     "Venus (bright = high ground). Image 2 shows candidate map tiles labelled "
                     f"{', '.join(labels)}, same scale and orientation, without noise. Exactly one "
                     "is the same place. Compare the large bright and dark shapes and where they sit "
                     "in the frame, then call pick_tile."}]}],
        "tools": [{"functionDeclarations": [{
            "name": "pick_tile", "description": "The tile that matches the camera view.",
            "parameters": {"type": "object", "properties": {
                "label": {"type": "string", "enum": list(labels)}, "reason": {"type": "string"}},
                "required": ["label", "reason"]}}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
        "generationConfig": {"thinkingConfig": {"thinkingLevel": thinking}},
    }
    req = urllib.request.Request(URL, json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            parts = json.load(resp)["candidates"][0]["content"]["parts"]
        a = next(p["functionCall"] for p in parts if "functionCall" in p)["args"]
        return labels.index(a["label"]), a.get("reason", "")
    except Exception:
        return None


def test_choice(trials=10, seed=11):
    rng = np.random.default_rng(seed)
    right = 0
    for i in range(trials):
        lat, lon = rng.uniform(-40, 40), rng.uniform(0, 360)
        ang = rng.uniform(0, 2 * np.pi)
        d = 600 / KM_PER_DEG
        glat, glon = lat + d * np.sin(ang), lon + d * np.cos(ang) / np.cos(np.radians(lat))
        raw = night_view_raw(lat, lon, rng)
        cands = candidates(raw, glat, glon)
        truth = int(np.argmin([gc_km(lat, lon, a, b) for a, b in cands]))
        order = rng.permutation(len(cands))                   # don't let "A" always be the best match
        tiles = [tile(*cands[j]) for j in order]
        true_pos = int(np.flatnonzero(order == truth)[0])
        got = choose_tile(night_view(raw), tiles)
        ok = got is not None and got[0] == true_pos
        right += ok
        print(f"trial {i}: truth {'ABCDEF'[true_pos]}, Gemini {'-' if got is None else 'ABCDEF'[got[0]]} "
              f"{'RIGHT' if ok else 'wrong'}", flush=True)
    print(f"Gemini picked the right tile {right}/{trials} (chance is {trials / 6:.1f})")

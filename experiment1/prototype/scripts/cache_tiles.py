"""
Pre-cache map tiles for the Androscoggin Riverlands State Park area so
the prototype's map works fully offline. Tiles are saved under
vendor/tiles/{z}/{x}/{y}.png in the standard Slippy Map convention.

Tile source: CARTO's dark_all basemap (public, no API key, designed for
embedding). OpenStreetMap's tile.openstreetmap.org rejected our requests
with a 200-status "Access blocked" PNG, which is OSM's defense against
bulk caching even at small scales. CARTO is built on OSM data but hosts
its own tile server with a permissive policy for low-volume use.

Run:
    python scripts/cache_tiles.py

Estimated: ~115 tiles, ~3-5 MB, ~30 seconds at 250ms rate limit.
"""

import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Bounding box covering the park with padding.
# Verified GPX bounds: lat 44.1856-44.2617, lon -70.2229 to -70.1881
# (the trace extends ~8 km south of the start point).
LAT_MIN, LAT_MAX = 44.17, 44.28
LON_MIN, LON_MAX = -70.25, -70.17

# Zoom levels: 11 = regional context, 15 = trail-level detail.
ZOOM_MIN, ZOOM_MAX = 11, 15

# CARTO Voyager basemap — balanced light style with color (water, parks,
# road hierarchy clearly visible). Subdomains a/b/c/d rotate via {s}; we
# pick deterministically below since we're fetching serially with a rate limit.
TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
SUBDOMAINS = ["a", "b", "c", "d"]
USER_AGENT = (
    "Riverlands/0.1 (offline prototype tile cache; "
    "github.com/Nate-BadScienceFiction/Riverlands)"
)
RATE_LIMIT_S = 0.25  # seconds between requests
# CARTO's blocked-access PNG is exactly this size (1×1 transparent or similar);
# any tile that comes back below this threshold is suspicious and won't be saved.
MIN_TILE_BYTES = 200


def deg2num(lat_deg: float, lon_deg: float, zoom: int) -> tuple[int, int]:
    """Convert lat/lon degrees to Slippy Map tile (x, y) at the given zoom."""
    lat_rad = math.radians(lat_deg)
    n = 2 ** zoom
    x = int((lon_deg + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def tile_range(lat_min, lat_max, lon_min, lon_max, zoom):
    """Inclusive (x_min, x_max, y_min, y_max) tile range covering the bbox."""
    x1, y1 = deg2num(lat_max, lon_min, zoom)  # NW corner
    x2, y2 = deg2num(lat_min, lon_max, zoom)  # SE corner
    return min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def main() -> int:
    out_root = Path(__file__).resolve().parent.parent / "vendor" / "tiles"
    out_root.mkdir(parents=True, exist_ok=True)

    # Plan: enumerate every (z, x, y) we need, count, then fetch.
    plan = []
    for z in range(ZOOM_MIN, ZOOM_MAX + 1):
        x_min, x_max, y_min, y_max = tile_range(LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, z)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                plan.append((z, x, y))

    print(f"Bounding box     : lat [{LAT_MIN}, {LAT_MAX}], lon [{LON_MIN}, {LON_MAX}]")
    print(f"Zoom levels      : {ZOOM_MIN}-{ZOOM_MAX}")
    print(f"Tiles to consider: {len(plan)}")
    print(f"Output           : {out_root}")
    print()

    fetched = 0
    skipped = 0
    failed = 0
    bytes_total = 0

    # Detect a "blocked" response by collecting the first few bytes of
    # successfully fetched tiles and bailing if too many duplicates appear
    # (the same canned image keeps coming back).
    seen_hashes = {}
    BLOCK_BAIL_THRESHOLD = 5

    for i, (z, x, y) in enumerate(plan, start=1):
        path = out_root / str(z) / str(x) / f"{y}.png"
        if path.exists() and path.stat().st_size > 0:
            skipped += 1
            continue

        path.parent.mkdir(parents=True, exist_ok=True)
        sub = SUBDOMAINS[i % len(SUBDOMAINS)]
        url = TILE_URL.format(s=sub, z=z, x=x, y=y)
        try:
            data = fetch(url)
            if len(data) < MIN_TILE_BYTES:
                failed += 1
                print(f"  [{i}/{len(plan)}] z={z} x={x} y={y}  REJECTED ({len(data)} bytes — likely a blocked-access response)", file=sys.stderr)
                continue
            # Hash the first 256 bytes; if we see the same fingerprint
            # come back many times, we're probably being served a canned
            # block image instead of real tiles.
            fp = hash(data[:256])
            seen_hashes[fp] = seen_hashes.get(fp, 0) + 1
            if seen_hashes[fp] >= BLOCK_BAIL_THRESHOLD:
                print(f"\nABORT: same tile content returned {seen_hashes[fp]} times — server is rate-limiting us.", file=sys.stderr)
                print(f"       Last URL: {url}", file=sys.stderr)
                return 1
            path.write_bytes(data)
            fetched += 1
            bytes_total += len(data)
            print(f"  [{i}/{len(plan)}] z={z} x={x} y={y}  {len(data)//1024} KB")
            time.sleep(RATE_LIMIT_S)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            failed += 1
            print(f"  [{i}/{len(plan)}] z={z} x={x} y={y}  FAILED: {e}", file=sys.stderr)

    print()
    print(f"Done. fetched={fetched}, skipped={skipped} (already cached), failed={failed}")
    print(f"Total downloaded: {bytes_total/1024:.0f} KB")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

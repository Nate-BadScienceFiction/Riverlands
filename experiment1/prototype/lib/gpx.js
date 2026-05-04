// GPX parser. DOMParser-based; tolerant of missing <ele> or <time>.
// Returns an array of points with per-segment deltas already computed.

export const M_TO_MI = 0.000621371;
export const M_TO_FT = 3.28084;

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function parseGpx(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid GPX: ' + parseError.textContent.trim());

  const trkpts = doc.querySelectorAll('trkpt');
  if (trkpts.length === 0) throw new Error('No <trkpt> elements found in GPX.');

  const trackName = (doc.querySelector('trk > name') || {}).textContent || 'Unnamed track';

  const points = new Array(trkpts.length);
  let hasTime = true;
  let hasEle = true;

  for (let i = 0; i < trkpts.length; i++) {
    const pt = trkpts[i];
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.querySelector('ele');
    const timeEl = pt.querySelector('time');

    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    const time = timeEl ? new Date(timeEl.textContent) : null;

    if (ele === null) hasEle = false;
    if (time === null) hasTime = false;

    points[i] = { lat, lon, ele, time, segDist: 0, segDt: 0, speed: 0 };
  }

  // Per-segment deltas
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    curr.segDist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    curr.segDt = (curr.time && prev.time) ? (curr.time - prev.time) / 1000 : 0;
    curr.speed = curr.segDt > 0 ? curr.segDist / curr.segDt : 0;
  }

  return { points, trackName, hasTime, hasEle };
}

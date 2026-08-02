// Serverless function — proxies place/postal autocomplete to Photon (an
// OpenStreetMap-based geocoder). Keyless: Photon needs no API key, but we
// proxy so we can set a polite User-Agent, bias/shape results, and swap
// providers later without touching the front-end.
//
// The front-end calls: /api/places?q=<text>&kind=city|postal&lat=&lon=
// It always returns HTTP 200 with { results: [...] } — on any upstream
// error it returns an empty list so the autocomplete degrades silently and
// the user can still type freely.

const PHOTON = "https://photon.komoot.io/api/";

export default async function handler(req, res) {
  const q = String((req.query && req.query.q) || "").trim();
  const kind = String((req.query && req.query.kind) || "city");
  const lat = parseFloat((req.query && req.query.lat) || "");
  const lon = parseFloat((req.query && req.query.lon) || "");

  // Too short to be worth a lookup.
  if (q.length < 2) return res.status(200).json({ results: [] });

  const url = new URL(PHOTON);
  url.searchParams.set("q", q);
  url.searchParams.set("lang", "en");
  url.searchParams.set("limit", "6");

  // Bias results toward a point (e.g. the already-chosen city) when given.
  if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
  }

  // For city search, restrict to populated places so we don't surface
  // shops/streets. Postal search stays unfiltered so postcodes come through.
  if (kind === "city") {
    for (const tag of ["place:city", "place:town", "place:village"]) {
      url.searchParams.append("osm_tag", tag);
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Gora Travel (personal trip planner)" },
      signal: ctrl.signal,
    });
    if (!r.ok) return res.status(200).json({ results: [] });
    const data = await r.json();
    const results = shape(data, kind);
    // Cache identical lookups briefly at the edge to ease load on Photon.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=600");
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(200).json({ results: [] });
  } finally {
    clearTimeout(timer);
  }
}

// Turn Photon GeoJSON features into a compact, front-end-friendly shape.
export function shape(data, kind) {
  const feats = (data && data.features) || [];
  const out = [];
  const seen = new Set();

  for (const f of feats) {
    const p = (f && f.properties) || {};
    const coords = (f && f.geometry && f.geometry.coordinates) || [];
    const lon = coords[0];
    const lat = coords[1];
    const country = p.country || "";
    const region = p.state || p.county || "";

    if (kind === "postal") {
      // Only useful if the feature carries a postcode.
      if (!p.postcode) continue;
      const where = [p.name || p.city, region, country].filter(Boolean).join(", ");
      const item = { value: p.postcode, label: p.postcode, sub: where, lat, lon };
      const key = "p:" + item.value + "|" + where;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    } else {
      // City / place.
      const name = p.name || p.city;
      if (!name) continue;
      const sub = [region, country].filter(Boolean).join(", ");
      const item = { value: name, label: name, sub, country, lat, lon };
      const key = "c:" + name + "|" + sub;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.slice(0, 6);
}

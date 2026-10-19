// Realtime data from /api/live plus the calculations that combine it with the timetable.
import { byStop, patternKeys } from "./data.js";
import { bearing, distM, nowSec } from "./util.js";

export class Live {
  constructor(regionId) {
    this.regionId = regionId;
    this.vehicles = new Map(); // "tripId:YYYYMMDD" -> position
    this.trips = new Map(); // "tripId:YYYYMMDD" -> {cancelled, updates}
    this.alerts = [];
    this.time = 0; // server time of the last successful poll
    this.age = {};
    this.errors = {};
    this.failed = false;
    this._headings = new Map(); // vehicle key -> {lat, lon, bearing}
  }

  async poll() {
    try {
      const r = await fetch(`/api/live?region=${this.regionId}`);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      const vehicles = new Map();
      for (const [trip, date, lat, lon, brg, seq, stopId, stopped, ts, label] of d.vehicles) {
        const key = `${trip}:${date}`;
        vehicles.set(key, { lat, lon, bearing: brg ?? this._heading(key, lat, lon), seq, stopId, stopped: !!stopped, ts, label });
      }
      const trips = new Map();
      for (const [trip, date, cancelled, updates] of d.trips) trips.set(`${trip}:${date}`, { cancelled: !!cancelled, updates });
      this.vehicles = vehicles;
      this.trips = trips;
      this.time = d.time;
      this.age = d.age ?? {};
      this.errors = d.errors ?? {};
      this.failed = false;
    } catch {
      this.failed = true;
    }
  }

  async pollAlerts() {
    try {
      const r = await fetch(`/api/alerts?region=${this.regionId}`);
      if (r.ok) this.alerts = (await r.json()).alerts;
    } catch {
      /* keep the last known notices */
    }
  }

  /** OVapi rarely sends a heading, so derive one from movement between polls. */
  _heading(key, lat, lon) {
    const ref = this._headings.get(key);
    if (ref && distM(ref.lat, ref.lon, lat, lon) <= 8) return ref.bearing;
    const b = ref ? bearing(ref.lat, ref.lon, lat, lon) : null;
    this._headings.set(key, { lat, lon, bearing: b });
    return b;
  }
}

/** Predicted times per stop; a delay carries forward until a newer update (GTFS-Realtime semantics). */
export function predict(trip, base, tu) {
  const n = trip.arr.length, p = trip.p;
  const bySeq = new Map(), byStopId = new Map();
  if (tu) for (const u of tu.updates) {
    if (u[0] != null) bySeq.set(u[0], u);
    else if (u[1]) byStopId.set(u[1], u);
  }
  const out = { arr: new Array(n), dep: new Array(n), sarr: new Array(n), sdep: new Array(n),
                skipped: new Array(n).fill(false), live: new Array(n).fill(false) };
  let delay = null;
  for (let i = 0; i < n; i++) {
    const sa = base + trip.arr[i], sd = base + trip.dep[i];
    out.sarr[i] = sa;
    out.sdep[i] = sd;
    const u = bySeq.get(p.seq[i]) ?? byStopId.get(p.stops[i]);
    let pa, pd;
    if (u && u[6]) {
      out.skipped[i] = true;
      pa = sa + (delay ?? 0);
      pd = sd + (delay ?? 0);
    } else if (u) {
      const [, , ta, td, da, dd] = u;
      if (ta != null) delay = ta - sa; else if (da != null) delay = da;
      pa = sa + (delay ?? 0);
      if (td != null) delay = td - sd; else if (dd != null) delay = dd;
      pd = sd + (delay ?? 0);
    } else {
      pa = sa + (delay ?? 0);
      pd = sd + (delay ?? 0);
    }
    out.arr[i] = pa;
    out.dep[i] = Math.max(pa, pd);
    out.live[i] = delay != null;
  }
  return out;
}

export const tripKey = (trip, day) => `${trip.id}:${day.compact}`;

export function stateDelay(s) {
  const i = s.next, pr = s.pr;
  if (!pr.live[i]) return null;
  return s.atStop ? pr.dep[i] - pr.sdep[i] : pr.arr[i] - pr.sarr[i];
}

/** Where a trip is right now, or null if it isn't running. */
export function vehicleState(region, trip, day, live, now = nowSec()) {
  const key = tripKey(trip, day);
  const tu = live.trips.get(key);
  if (tu?.cancelled) return null;
  const pr = predict(trip, day.base, tu);
  const vp = live.vehicles.get(key);
  if (vp) return gpsState(region, trip, day, pr, vp, key);
  return estimatedState(region, trip, day, pr, now, key, !!tu);
}

function gpsState(region, trip, day, pr, vp, key) {
  const p = trip.p, n = p.stops.length;
  let idx = vp.seq != null ? p.seq.indexOf(vp.seq) : -1;
  if (idx < 0 && vp.stopId) idx = p.stops.indexOf(vp.stopId);
  if (idx < 0) {
    let best = Infinity;
    p.stops.forEach((sid, i) => {
      const s = region.stops.get(sid);
      const d = s ? distM(s.lat, s.lon, vp.lat, vp.lon) : Infinity;
      if (d < best) [best, idx] = [d, i];
    });
    idx = Math.max(idx, 0);
  }
  const atStop = vp.stopped || idx === 0;
  let prev = idx, frac = 0;
  if (!atStop) {
    prev = idx - 1;
    const a = region.stops.get(p.stops[prev]), b = region.stops.get(p.stops[idx]);
    if (a && b) {
      const da = distM(a.lat, a.lon, vp.lat, vp.lon), db = distM(vp.lat, vp.lon, b.lat, b.lon);
      frac = da + db > 0 ? da / (da + db) : 0;
    }
  }
  let brg = vp.bearing;
  const toward = region.stops.get(p.stops[Math.min(idx + (atStop ? 1 : 0), n - 1)]);
  if (brg == null && toward && distM(vp.lat, vp.lon, toward.lat, toward.lon) > 10) {
    brg = bearing(vp.lat, vp.lon, toward.lat, toward.lon);
  }
  return { key, trip, day, pr, source: "gps", lat: vp.lat, lon: vp.lon, bearing: brg, prev, next: idx, frac, atStop, vp };
}

function estimatedState(region, trip, day, pr, now, key, hasRealtime) {
  const n = pr.arr.length;
  if (now < pr.dep[0] - 60 || now > pr.arr[n - 1] + 30) return null;
  let i = 0;
  for (let k = 0; k < n; k++) {
    if (pr.skipped[k]) continue;
    if (pr.arr[k] <= now) i = k; else break;
  }
  let prev = i, next = i, frac = 0, atStop = true;
  if (now > pr.dep[i] && i < n - 1) {
    next = i + 1;
    while (next < n - 1 && pr.skipped[next]) next++;
    const span = pr.arr[next] - pr.dep[i];
    frac = span > 0 ? Math.min(Math.max((now - pr.dep[i]) / span, 0), 1) : 1;
    atStop = false;
  }
  const pos = place(region, trip, prev, next, frac);
  if (!pos) return null;
  return { key, trip, day, pr, source: hasRealtime ? "estimated" : "scheduled",
           lat: pos.lat, lon: pos.lon, bearing: pos.bearing, prev, next, frac, atStop, vp: null };
}

/** A point `frac` of the way from stop `prev` to stop `next`, along the route shape when we have it. */
function place(region, trip, prev, next, frac) {
  const p = trip.p;
  const shape = p.shape && p.dist ? region.shapes.get(p.shape) : null;
  if (shape?.dist) return alongShape(shape, p.dist[prev] + frac * (p.dist[next] - p.dist[prev]));
  const a = region.stops.get(p.stops[prev]) ?? region.stops.get(p.stops[next]);
  const b = region.stops.get(p.stops[next]) ?? a;
  if (!a) return null;
  const same = a.lat === b.lat && a.lon === b.lon;
  return { lat: a.lat + frac * (b.lat - a.lat), lon: a.lon + frac * (b.lon - a.lon),
           bearing: same ? null : bearing(a.lat, a.lon, b.lat, b.lon) };
}

function alongShape(shape, d) {
  const dist = shape.dist, n = dist.length;
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid; else hi = mid;
  }
  const t = dist[hi] > dist[lo] ? Math.min(Math.max((d - dist[lo]) / (dist[hi] - dist[lo]), 0), 1) : 0;
  return {
    lat: shape.lat[lo] + t * (shape.lat[hi] - shape.lat[lo]),
    lon: shape.lon[lo] + t * (shape.lon[hi] - shape.lon[lo]),
    bearing: bearing(shape.lat[lo], shape.lon[lo], shape.lat[hi], shape.lon[hi]),
  };
}

/** Every vehicle running now, from the service days given (normally yesterday and today). */
export function currentStates(region, days, live, now = nowSec()) {
  const out = [];
  for (const day of days) {
    if (!day) continue;
    for (const trip of day.trips) {
      if (!trip.p.line) continue;
      const n = trip.arr.length;
      if (now < day.base + trip.dep[0] - 600 || now > day.base + trip.arr[n - 1] + 3600) continue;
      const s = vehicleState(region, trip, day, live, now);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Departures from a set of platforms. With `from`, live predictions are applied and past ones dropped. */
export function departures(region, days, live, stopIds, { from = null, until = null, line = null } = {}) {
  const rows = [];
  for (const day of days) {
    if (!day) continue;
    const index = byStop(day);
    for (const sid of stopIds) {
      for (const [trip, i] of index.get(sid) ?? []) {
        if (!trip.p.line || i === trip.arr.length - 1 || trip.p.nopick.has(i)) continue;
        if (line && trip.p.line.id !== line) continue;
        const sched = day.base + trip.dep[i];
        if (from != null && (sched < from - 3600 || sched > until)) continue;
        const key = tripKey(trip, day);
        const tu = live?.trips.get(key);
        let time = sched, delay = null, isLive = false, skipped = false;
        if (from != null) {
          const pr = predict(trip, day.base, tu);
          time = pr.dep[i];
          isLive = pr.live[i];
          delay = isLive ? pr.dep[i] - pr.sdep[i] : null;
          skipped = pr.skipped[i];
          if (time < from) continue;
        }
        rows.push({
          trip, day, i, sid, time, sched, delay, live: isLive, skipped,
          cancelled: !!tu?.cancelled, gps: live?.vehicles.has(key) ?? false,
          head: trip.p.sh?.[i] || trip.head,
        });
      }
    }
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/** Backbone index for each stop of a pattern (monotonic, so loop lines work). */
export function alignToDiagram(region, pattern, dir) {
  const cacheKey = `_align${dir.dir}`;
  if (pattern[cacheKey]) return pattern[cacheKey];
  const keys = patternKeys(region, pattern);
  const backbone = dir.stops.map((s) => s.key);
  const out = [];
  let cursor = 0;
  for (const k of keys) {
    const j = backbone.indexOf(k, cursor);
    if (j >= 0) cursor = j;
    out.push(j >= 0 ? j : null);
  }
  pattern[cacheKey] = out;
  return out;
}

/** Fractional position of a vehicle along a direction's stop list. */
export function diagramPosition(region, state, dir) {
  const al = alignToDiagram(region, state.trip.p, dir);
  const near = (i, step) => {
    for (; i >= 0 && i < al.length; i += step) if (al[i] != null) return al[i];
    return null;
  };
  let a = near(state.prev, -1), b = near(state.next, +1);
  if (a == null && b == null) return null;
  a ??= b;
  b ??= a;
  return a + state.frac * (b - a);
}

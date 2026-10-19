// Loads the static timetable files written by the pipeline (see pipeline/export.py for the format).
import { compact, decodePolyline } from "./util.js";

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
}

export async function loadManifest() {
  // Changes daily; bust caches once a minute.
  return getJSON(`/data/manifest.json?m=${Math.floor(Date.now() / 60000)}`);
}

export const stopKey = (s) => (s.town ? `${s.town}, ${s.name}` : s.name).toLowerCase();

export class Region {
  static async load(manifest, id) {
    const meta = await getJSON(`/data/regions/${id}.json?b=${manifest.build}`);
    return new Region(manifest, meta);
  }

  constructor(manifest, meta) {
    this.manifest = manifest;
    this.id = meta.id;
    this.name = meta.name;
    this.build = meta.build;
    this.info = manifest.regions.find((r) => r.id === meta.id);
    this.days = meta.days;
    this.available = new Set(meta.available);
    this.lines = meta.lines;
    this.lineById = new Map(this.lines.map((l) => [l.id, l]));
    this.routeToLine = new Map();
    for (const l of this.lines) for (const r of l.routes) this.routeToLine.set(r, l);

    this.stops = new Map();
    this.groups = new Map();
    for (const [id, [name, town, lat, lon, platform, group]] of Object.entries(meta.stops)) {
      const s = { id, name, town, lat, lon, platform, group };
      s.key = stopKey(s);
      this.stops.set(id, s);
      if (!this.groups.has(group)) this.groups.set(group, []);
      this.groups.get(group).push(id);
    }
    this.mapStops = meta.map
      .filter(([id]) => this.stops.has(id))
      .map(([id, lineIdx]) => ({ ...this.stops.get(id), lines: lineIdx.map((i) => this.lines[i]) }));
    this._days = new Map();
    this._shapes = null;
    this.shapes = new Map();
  }

  /** Platforms of the same station as `stopId`. */
  station(stopId) {
    const s = this.stops.get(stopId);
    return s ? this.groups.get(s.group) : [stopId];
  }

  day(iso) {
    if (!this.available.has(iso)) return Promise.resolve(null);
    if (!this._days.has(iso)) {
      const p = getJSON(`/data/regions/${this.id}/${iso}.json?b=${this.build}`).then((raw) => this._decodeDay(raw));
      p.catch(() => this._days.delete(iso));
      this._days.set(iso, p);
    }
    return this._days.get(iso);
  }

  loadShapes() {
    this._shapes ??= getJSON(`/data/regions/${this.id}/shapes.json?b=${this.build}`).then((raw) => {
      for (const [id, { p, d }] of Object.entries(raw)) {
        const { lat, lon } = decodePolyline(p);
        let dist = null;
        if (d) {
          dist = new Float64Array(d.length);
          let acc = 0;
          d.forEach((v, i) => (dist[i] = acc += v));
        }
        this.shapes.set(id, { lat, lon, dist });
      }
      return this.shapes;
    });
    return this._shapes;
  }

  _decodeDay(raw) {
    const patterns = raw.patterns.map((p) => ({
      line: this.lineById.get(p.line) ?? null,
      dir: p.dir,
      stops: p.stops,
      seq: p.seq,
      nopick: new Set(p.nopick ?? []),
      shape: p.shape,
      dist: p.dist ?? null,
      sh: p.sh ?? null,
      _keys: null,
    }));
    const trips = raw.trips.map(([id, pi, hi, times]) => {
      const n = times.length / 2;
      const arr = new Int32Array(n), dep = new Int32Array(n);
      let t = 0;
      for (let i = 0; i < n; i++) {
        arr[i] = t + times[2 * i];
        dep[i] = arr[i] + times[2 * i + 1];
        t = dep[i];
      }
      return { id, p: patterns[pi], head: raw.heads[hi], arr, dep };
    });
    return { date: raw.date, compact: compact(raw.date), base: raw.base, trips, _byStop: null };
  }
}

/** stop_id -> [[trip, index], ...] for one day, built on first use. */
export function byStop(day) {
  if (!day._byStop) {
    const m = new Map();
    for (const trip of day.trips) {
      trip.p.stops.forEach((sid, i) => {
        let a = m.get(sid);
        if (!a) m.set(sid, (a = []));
        a.push([trip, i]);
      });
    }
    day._byStop = m;
  }
  return day._byStop;
}

/** Station keys of a pattern's stops, for lining it up with a line diagram. */
export function patternKeys(region, p) {
  p._keys ??= p.stops.map((sid) => region.stops.get(sid)?.key ?? sid);
  return p._keys;
}

"""Turn the timetable database into the small static files the web app loads.

Output (app/generated/data/ is served at /data):
  data/manifest.json                  build info, the days covered, regions
  data/regions/<id>.json              lines (per-day summaries, stop diagrams) and stops
  data/regions/<id>/<YYYY-MM-DD>.json every trip of the region's lines on that service day
  data/regions/<id>/shapes.json       simplified route geometry
  regions.json                        route/stop ids per region, used to filter the live feeds
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb
import httpx

from app.config import DEFAULT_REGION, REGIONS, SHOWN_ROUTE_TYPES, TZ, USER_AGENT, Region

from .diagram import Pattern, align, build_directions
from .geo import dist_m, encode_polyline, simplify

log = logging.getLogger("ovlive.export")

FORMAT = 1
DAYS_BACK, DAYS_AHEAD = 1, 7
MODES = {0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry"}
# Fallback colours for operators that don't publish line colours (e.g. GVB).
PALETTE = ["#1f6feb", "#d1242f", "#1a7f37", "#8250df", "#bf3989", "#c4432b", "#0a7ea4", "#6639ba", "#9a6700", "#116329"]
TOWN_ALIASES = {"'s-Gravenhage": "Den Haag", "'s-Hertogenbosch": "Den Bosch"}
GENERIC_NAME = re.compile(r"^\s*(lijn|line|bus|tram|metro)?\s*\w{0,6}\s*$", re.IGNORECASE)


def service_base(d: date) -> int:
    """Unix time that GTFS stop times on service day `d` count from ("noon minus 12h")."""
    return int(datetime(d.year, d.month, d.day, 12, tzinfo=TZ).timestamp()) - 43200


def service_today(ts: float) -> date:
    """The operating day passengers think of as 'today': it runs until ~4am."""
    return (datetime.fromtimestamp(ts, TZ) - timedelta(hours=4)).date()


def hhmm(secs: int | None) -> str | None:
    if secs is None:
        return None
    return f"{(secs // 3600) % 24:02d}:{(secs // 60) % 60:02d}"


@dataclass(slots=True, frozen=True)
class Stop:
    id: str
    short: str
    town: str | None
    lat: float
    lon: float
    parent: str | None
    platform: str | None

    @property
    def key(self) -> str:
        """Station identity used to line up platforms and directions."""
        return f"{self.town}, {self.short}".lower() if self.town else self.short.lower()


@dataclass(slots=True, frozen=True)
class Line:
    id: str
    agency: str
    operator: str
    route_type: int
    short_name: str
    long_name: str
    color: str
    text_color: str
    route_ids: tuple[str, ...]

    @property
    def label(self) -> str:
        """What fits on a badge: '19', 'N5', 'A' — and 'NS' for "Snelbus ipv trein"-style names."""
        if len(self.short_name) <= 5:
            return self.short_name
        return "NS" if self.agency.startswith("IFF:NS") else self.short_name[:4]


def line_sort_key(line: Line) -> tuple:
    """Trams first, then metro, buses, ferries; numbers in natural order."""
    num = "".join(c for c in line.short_name if c.isdigit())
    rank = SHOWN_ROUTE_TYPES.index(line.route_type) if line.route_type in SHOWN_ROUTE_TYPES else 9
    return (rank, int(num) if num else 9999, line.short_name, line.agency)


@dataclass(slots=True)
class TripRec:
    trip_id: int
    line_id: str
    route_id: str | None
    direction_id: int | None
    headsign: str
    shape_id: str | None
    sids: tuple[str, ...]
    seqs: tuple[int, ...]
    arrs: tuple[int, ...]
    deps: tuple[int, ...]
    picks: tuple[int, ...]
    dists: tuple[float | None, ...]
    sheads: tuple[str | None, ...]
    dates: set[date]


def encode_times(arrs, deps) -> list[int]:
    """[arr0, dwell0, travel1, dwell1, ...]: small numbers that compress well."""
    out, prev = [], 0
    for a, d in zip(arrs, deps):
        out += [a - prev, d - a]
        prev = d
    return out


def decode_times(flat: list[int]) -> tuple[list[int], list[int]]:
    arrs, deps, t = [], [], 0
    for i in range(0, len(flat), 2):
        a = t + flat[i]
        d = a + flat[i + 1]
        arrs.append(a)
        deps.append(d)
        t = d
    return arrs, deps


class Carry:
    """Day files from the previous build, for days the new timetable no longer covers (yesterday)."""

    def __init__(self, local_dir: Path, remote_base: str | None) -> None:
        self.local_dir = local_dir
        self.remote_base = remote_base.rstrip("/") if remote_base else None

    def load(self, rid: str, d: date) -> dict | None:
        rel = f"regions/{rid}/{d.isoformat()}.json"
        data = None
        try:
            if (p := self.local_dir / rel).exists():
                data = json.loads(p.read_text())
            elif self.remote_base:
                r = httpx.get(f"{self.remote_base}/data/{rel}", headers={"User-Agent": USER_AGENT}, timeout=30)
                if r.status_code == 200:
                    data = r.json()
        except (OSError, ValueError, httpx.HTTPError) as e:
            log.warning("Could not reuse %s from the previous build: %s", rel, e)
        if data and data.get("format") == FORMAT and data.get("date") == d.isoformat():
            return data
        return None


class Exporter:
    def __init__(self, db_path: Path, now: float | None = None) -> None:
        self.con = duckdb.connect(str(db_path), read_only=True)
        self.con.execute("set enable_progress_bar = false")
        meta = dict(self.q("select key, value from meta"))
        self.feed_version = meta.get("feed_version")
        self.feed_from = datetime.strptime(meta["feed_start_date"], "%Y%m%d").date()
        self.feed_to = datetime.strptime(meta["feed_end_date"], "%Y%m%d").date()
        now = time.time() if now is None else now
        self.generated = int(now)
        self.build = datetime.fromtimestamp(now, TZ).strftime("%Y%m%d-%H%M")
        self.today = service_today(now)
        self.days = [self.today + timedelta(days=i) for i in range(-DAYS_BACK, DAYS_AHEAD + 1)]
        self.day_index = {d: i for i, d in enumerate(self.days)}
        self.in_feed = [d for d in self.days if self.feed_from <= d <= self.feed_to]
        self.stops = self._load_stops()
        self.lines = self._load_lines()

    def q(self, sql: str, params: list | None = None) -> list[tuple]:
        return self.con.execute(sql, params or []).fetchall()

    # -- loading -------------------------------------------------------------

    def _load_stops(self) -> dict[str, Stop]:
        out = {}
        for sid, name, lat, lon, parent, platform in self.q(
            "select stop_id, name, lat, lon, parent_station, platform_code from stops where location_type = 0"
        ):
            town, sep, short = (name or "").partition(", ")
            if not sep:
                town, short = None, name or sid
            out[sid] = Stop(sid, short, TOWN_ALIASES.get(town, town), lat, lon, parent, platform)
        return out

    def _load_lines(self) -> dict[str, Line]:
        operators = dict(self.q("select agency_id, agency_name from agency"))
        out = {}
        for lid, agency, rtype, short, long_name, color, text, route_ids in self.q(
            "select line_id, agency_id, route_type, short_name, long_name, color, text_color, route_ids from lines"
        ):
            if color:
                c, tc = "#" + color.lstrip("#").lower(), "#" + (text or "ffffff").lstrip("#").lower()
            else:
                c, tc = PALETTE[int(hashlib.md5(lid.encode()).hexdigest(), 16) % len(PALETTE)], "#ffffff"
            out[lid] = Line(lid, agency, operators.get(agency, agency), rtype, short, long_name or "", c, tc, tuple(route_ids))
        return out

    def _key(self, sid: str) -> str:
        s = self.stops.get(sid)
        return s.key if s else sid

    def _region_lines(self, r: Region) -> tuple[list[str], dict[str, list[str]]]:
        min_lon, min_lat, max_lon, max_lat = r.bbox
        rows = self.q(
            """
            select sl.stop_id, list(distinct sl.line_id) from stop_lines sl
            join stops s using (stop_id) join lines l using (line_id)
            where s.lon between ? and ? and s.lat between ? and ? and l.route_type in (select unnest(?::INTEGER[]))
            group by 1
            """,
            [min_lon, max_lon, min_lat, max_lat, list(SHOWN_ROUTE_TYPES)],
        )
        map_stops = {sid: lids for sid, lids in rows if sid in self.stops}
        line_ids = sorted({lid for lids in map_stops.values() for lid in lids}, key=lambda x: line_sort_key(self.lines[x]))
        return line_ids, map_stops

    def _load_trips(self, line_ids: list[str]) -> list[TripRec]:
        if not self.in_feed:
            return []
        rows = self.q(
            """
            with tw as (
                select t.trip_id, list(distinct sd.date) as dates
                from trips t join service_dates sd using (service_id)
                where t.line_id in (select unnest(?::VARCHAR[])) and sd.date between ? and ?
                group by 1
            )
            select t.trip_id, any_value(tw.dates), any_value(t.line_id), any_value(t.route_id),
                   any_value(t.direction_id), any_value(coalesce(t.headsign, '')), any_value(t.shape_id),
                   list(s.stop_id order by s.seq), list(s.seq order by s.seq),
                   list(s.arr order by s.seq), list(s.dep order by s.seq), list(s.pickup order by s.seq),
                   list(s.dist order by s.seq), list(s.stop_headsign order by s.seq)
            from tw join trips t using (trip_id) join stop_times s using (trip_id)
            group by t.trip_id
            """,
            [line_ids, self.in_feed[0], self.in_feed[-1]],
        )
        return [
            TripRec(tid, lid, rid, did, head, shape, tuple(sids), tuple(seqs), tuple(arrs), tuple(deps),
                    tuple(picks), tuple(dists), tuple(sheads), set(dates))
            for tid, dates, lid, rid, did, head, shape, sids, seqs, arrs, deps, picks, dists, sheads in rows
        ]

    def _decode_day(self, data: dict, d: date) -> list[TripRec]:
        heads, pats = data["heads"], data["patterns"]
        out = []
        for tid, pi, hi, times in data["trips"]:
            p = pats[pi]
            arrs, deps = decode_times(times)
            n = len(p["stops"])
            nopick = set(p.get("nopick", []))
            out.append(TripRec(
                tid, p["line"], None, p.get("dir"), heads[hi], p.get("shape"), tuple(p["stops"]), tuple(p["seq"]),
                tuple(arrs), tuple(deps), tuple(1 if i in nopick else 0 for i in range(n)),
                tuple(p["dist"]) if p.get("dist") else (None,) * n,
                tuple(p["sh"]) if p.get("sh") else (None,) * n, {d},
            ))
        return out

    def _missing(self, line_ids: list[str]) -> dict[tuple[str, date], list[str]]:
        """Stations a line normally serves (on at least half its service days around that date) but not then.

        This is what flags e.g. tram 19 skipping the TU Delft campus on weekends.
        """
        lo, hi = self.days[0] - timedelta(days=3), self.days[-1] + timedelta(days=3)
        served: dict[str, dict[date, set[str]]] = defaultdict(lambda: defaultdict(set))
        names: dict[str, str] = {}
        for lid, sid, dt in self.q(
            """
            select line_id, stop_id, date from line_stop_day
            where line_id in (select unnest(?::VARCHAR[])) and date between ? and ? and trips > 0
            """,
            [line_ids, lo, hi],
        ):
            if (s := self.stops.get(sid)) is not None:
                served[lid][dt].add(s.key)
                names[s.key] = s.short
        out = {}
        for lid, by_date in served.items():
            for d in self.days:
                that_day = by_date.get(d)
                if not that_day:
                    continue
                window = [x for x in by_date if abs((x - d).days) <= 3]
                counts = Counter(k for x in window for k in by_date[x])
                gone = [k for k, c in counts.items() if k not in that_day and c >= max(2, len(window) / 2)]
                if gone:
                    out[(lid, d)] = list(dict.fromkeys(names[k] for k in sorted(gone, key=lambda k: (-counts[k], k))))
        return out

    def _next_service(self, line_ids: list[str]) -> dict[str, date]:
        return dict(self.q(
            "select line_id, min(date) from line_day where line_id in (select unnest(?::VARCHAR[])) and date >= ? and trips > 0 group by 1",
            [line_ids, self.today],
        ))

    # -- building ------------------------------------------------------------

    def _headsign(self, t: TripRec) -> str:
        if t.headsign:
            return t.headsign
        s = self.stops.get(t.sids[-1])
        return s.short if s else ""

    def _line_json(self, line: Line, trips: list[TripRec], missing, next_service) -> tuple[dict, dict]:
        n_days = len(self.days)
        days_json = []
        for i, d in enumerate(self.days):
            run = [t for t in trips if d in t.dates]
            if not run:
                days_json.append({"n": 0} if d in self.in_feed else None)
                continue
            heads = Counter(self._headsign(t) for t in run)
            days_json.append({
                "n": len(run),
                "first": hhmm(min(t.deps[0] for t in run)),
                "last": hhmm(max(t.arrs[-1] for t in run)),
                "heads": [[h, c] for h, c in heads.most_common(6)],
                "missing": missing.get((line.id, d), []),
            })

        patterns: dict[tuple[str, ...], Pattern] = {}
        for t in trips:
            keys = tuple(self._key(s) for s in t.sids)
            p = patterns.get(keys)
            if p is None:
                p = patterns[keys] = Pattern(keys, t.sids)
            for d in t.dates:
                if d in self.day_index:
                    p.days[self.day_index[d]] += 1
            p.heads[self._headsign(t)] += len(t.dates)
            p.route_dir[(t.route_id, t.direction_id)] += 1
        dirs, pattern_dir = build_directions(list(patterns.values()))

        dirs_json = []
        for di, dd in enumerate(dirs):
            if not dd.backbone:
                continue
            nodes = [{"n": [0] * n_days, "e": [0] * n_days, "s": [0] * n_days, "ids": Counter()} for _ in dd.backbone]
            heads = Counter()
            for p in dd.patterns:
                al = align(p.keys, dd.backbone)
                heads.update(p.heads)
                seen = set()
                for i, j in enumerate(al):
                    if j is None or j in seen:
                        continue
                    seen.add(j)
                    nodes[j]["ids"][p.stop_ids[i]] += p.total
                    for day, c in p.days.items():
                        nodes[j]["n"][day] += c
                for end, field_ in ((al[-1] if al else None, "e"), (al[0] if al else None, "s")):
                    if end is not None:
                        for day, c in p.days.items():
                            nodes[end][field_][day] += c
            stops_json = []
            for key, node in zip(dd.backbone, nodes):
                if not node["ids"]:
                    continue
                sid = node["ids"].most_common(1)[0][0]
                s = self.stops.get(sid)
                stops_json.append({
                    "id": sid, "key": key, "name": s.short if s else sid, "town": s.town if s else None,
                    "n": node["n"], "e": node["e"], "s": node["s"],
                })
            dirs_json.append({"dir": di, "to": [h for h, _ in heads.most_common(3) if h], "stops": stops_json})

        shapes = Counter()
        for t in trips:
            if t.shape_id:
                shapes[t.shape_id] += len(t.dates)
        nxt = next_service.get(line.id)
        name = line.long_name
        if GENERIC_NAME.match(name or "") or name == line.short_name:
            # e.g. GVB calls its lines just "Lijn 2"; the two ends say much more.
            ends = [d["to"][0] for d in dirs_json if d["to"]]
            name = " ↔ ".join(dict.fromkeys(ends)) or name
        return {
            "id": line.id, "short": line.label, "name": name, "operator": line.operator,
            "mode": MODES.get(line.route_type, "other"), "color": line.color, "text": line.text_color,
            "routes": list(line.route_ids),
            "next": nxt.isoformat() if nxt else None,
            "days": days_json,
            "dirs": dirs_json,
            "shapes": [s for s, _ in shapes.most_common(8)],
        }, pattern_dir

    def _day_json(self, d: date, trips: list[TripRec], pattern_dirs: dict[str, dict]) -> dict:
        patterns, pidx, heads, hidx, out = [], {}, [], {}, []
        for t in sorted(trips, key=lambda t: (t.deps[0], t.trip_id)):
            nopick = tuple(i for i, p in enumerate(t.picks) if p == 1)
            pkey = (t.line_id, t.sids, t.seqs, nopick, t.shape_id, t.sheads)
            if pkey not in pidx:
                keys = tuple(self._key(s) for s in t.sids)
                pat = {
                    "line": t.line_id, "dir": pattern_dirs.get(t.line_id, {}).get(keys, t.direction_id or 0),
                    "stops": list(t.sids), "seq": list(t.seqs), "shape": t.shape_id,
                }
                if nopick:
                    pat["nopick"] = list(nopick)
                if t.shape_id and all(x is not None for x in t.dists):
                    pat["dist"] = [round(x) for x in t.dists]
                if any(t.sheads):
                    pat["sh"] = list(t.sheads)
                pidx[pkey] = len(patterns)
                patterns.append(pat)
            h = self._headsign(t)
            if h not in hidx:
                hidx[h] = len(heads)
                heads.append(h)
            out.append([t.trip_id, pidx[pkey], hidx[h], encode_times(t.arrs, t.deps)])
        return {"format": FORMAT, "date": d.isoformat(), "base": service_base(d),
                "heads": heads, "patterns": patterns, "trips": out}

    def _stops_json(self, ids: set[str]) -> dict[str, list]:
        """Stop table; the last field groups platforms into stations (same stop area, or same name within 300 m)."""
        ids = [i for i in sorted(ids) if i in self.stops]
        root = {i: i for i in ids}

        def find(x):
            while root[x] != x:
                root[x] = root[root[x]]
                x = root[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                root[max(ra, rb)] = min(ra, rb)

        buckets: dict[str, list[Stop]] = defaultdict(list)
        by_parent: dict[str, str] = {}
        for i in ids:
            s = self.stops[i]
            if s.parent:
                if s.parent in by_parent:
                    union(i, by_parent[s.parent])
                else:
                    by_parent[s.parent] = i
            buckets[s.short.lower()].append(s)
        for group in buckets.values():
            for a in range(len(group)):
                for b in range(a + 1, len(group)):
                    x, y = group[a], group[b]
                    if dist_m(x.lat, x.lon, y.lat, y.lon) < 300:
                        union(x.id, y.id)
        gid: dict[str, int] = {}
        out = {}
        for i in ids:
            s = self.stops[i]
            g = gid.setdefault(find(i), len(gid))
            out[i] = [s.short, s.town or "", round(s.lat, 6), round(s.lon, 6), s.platform or "", g]
        return out

    def _shapes_json(self, shape_ids: set[str]) -> dict[str, dict]:
        out = {}
        if not shape_ids:
            return out
        for sid, lons, lats, dists in self.q(
            "select shape_id, lons, lats, dists from shapes where shape_id in (select unnest(?::VARCHAR[]))",
            [sorted(shape_ids)],
        ):
            keep = simplify(lats, lons, 3.0)
            entry = {"p": encode_polyline([lats[i] for i in keep], [lons[i] for i in keep])}
            if dists and all(dists[i] is not None for i in keep):
                kept = [round(dists[i]) for i in keep]
                entry["d"] = [kept[0]] + [b - a for a, b in zip(kept, kept[1:])]
            out[sid] = entry
        return out

    def export_region(self, r: Region, out: Path, carry: Carry) -> dict:
        t0 = time.monotonic()
        line_ids, map_stops = self._region_lines(r)
        trips = self._load_trips(line_ids)
        carried_days = []
        for d in self.days:
            if d not in self.in_feed and (data := carry.load(r.id, d)) is not None:
                trips.extend(t for t in self._decode_day(data, d) if t.line_id in self.lines)
                carried_days.append(d.isoformat())
        known = set(line_ids)
        by_line: dict[str, list[TripRec]] = defaultdict(list)
        for t in trips:
            if t.line_id in known:
                by_line[t.line_id].append(t)

        missing = self._missing(line_ids)
        next_service = self._next_service(line_ids)
        lines_json, pattern_dirs = [], {}
        for lid in line_ids:
            lj, pdir = self._line_json(self.lines[lid], by_line.get(lid, []), missing, next_service)
            lines_json.append(lj)
            pattern_dirs[lid] = pdir
        line_pos = {lid: i for i, lid in enumerate(line_ids)}

        region_dir = out / "regions" / r.id
        region_dir.mkdir(parents=True, exist_ok=True)
        stop_ids = set(map_stops)
        shape_ids = set()
        days_written = []
        for d in self.days:
            run = [t for t in trips if d in t.dates and t.line_id in known]
            if not run and d not in self.in_feed:
                continue
            day = self._day_json(d, run, pattern_dirs)
            for p in day["patterns"]:
                stop_ids.update(p["stops"])
                if p["shape"]:
                    shape_ids.add(p["shape"])
            _write(region_dir / f"{d.isoformat()}.json", day)
            days_written.append(d.isoformat())
        for lj in lines_json:
            for dj in lj["dirs"]:
                stop_ids.update(s["id"] for s in dj["stops"])
        _write(region_dir / "shapes.json", self._shapes_json(shape_ids))

        meta = {
            "format": FORMAT, "id": r.id, "name": r.name, "build": self.build,
            "days": [d.isoformat() for d in self.days], "available": days_written, "carried": carried_days,
            "lines": lines_json,
            "stops": self._stops_json(stop_ids),
            "map": [[sid, sorted(line_pos[x] for x in lids if x in line_pos)] for sid, lids in sorted(map_stops.items())],
        }
        _write(out / "regions" / f"{r.id}.json", meta)
        log.info("  %-10s %3d lines, %6d trips, %d days (%s carried over) in %.1fs",
                 r.name, len(line_ids), len(trips), len(days_written), len(carried_days), time.monotonic() - t0)
        return {"routes": sorted({rid for lid in line_ids for rid in self.lines[lid].route_ids}),
                "stops": sorted(map_stops)}

    def export(self, data_dir: Path, generated_path: Path, carry_remote: str | None = None) -> dict:
        """Write a complete new data/ directory next to the old one, then swap it in."""
        new = data_dir.with_name(data_dir.name + ".new")
        shutil.rmtree(new, ignore_errors=True)
        new.mkdir(parents=True)
        carry = Carry(data_dir, carry_remote)
        log.info("Exporting %s → %s (feed %s, %s..%s)", self.build, data_dir, self.feed_version,
                 self.days[0], self.days[-1])
        generated = {}
        for r in REGIONS.values():
            generated[r.id] = self.export_region(r, new, carry)
        manifest = {
            "format": FORMAT, "build": self.build, "generated": self.generated,
            "feed": {"version": self.feed_version, "from": self.feed_from.isoformat(), "to": self.feed_to.isoformat()},
            "today": self.today.isoformat(), "days": [d.isoformat() for d in self.days],
            "default": DEFAULT_REGION,
            "regions": [{"id": r.id, "name": r.name, "bbox": r.bbox, "center": r.center, "zoom": r.zoom}
                        for r in REGIONS.values()],
        }
        _write(new / "manifest.json", manifest)

        old = data_dir.with_name(data_dir.name + ".old")
        shutil.rmtree(old, ignore_errors=True)
        if data_dir.exists():
            data_dir.rename(old)
        new.rename(data_dir)
        shutil.rmtree(old, ignore_errors=True)
        generated_path.parent.mkdir(parents=True, exist_ok=True)
        _write(generated_path, {"build": self.build, "regions": generated})
        return manifest


def _write(path: Path, data) -> None:
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))


def previous_site() -> str | None:
    """Where the live site is, so a fresh build can reuse yesterday's files from it."""
    if url := os.environ.get("OVLIVE_PREVIOUS_SITE"):
        return url
    if host := os.environ.get("VERCEL_PROJECT_PRODUCTION_URL"):
        return f"https://{host}"
    return None

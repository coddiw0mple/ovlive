"""Fetches OVapi's GTFS-Realtime feeds on demand and filters them down to one region.

This runs as a serverless function, so nothing here relies on running continuously:
a decoded feed is reused while it is fresh (Vercel keeps warm instances around),
and the CDN caches each response for a few seconds on top of that.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta

import httpx
from google.transit import gtfs_realtime_pb2 as pb

from .config import RT_FEEDS, TZ, USER_AGENT

STOPPED_AT = pb.VehiclePosition.STOPPED_AT
SKIPPED = pb.TripUpdate.StopTimeUpdate.SKIPPED
CANCELLED = (pb.TripDescriptor.CANCELED, 7)  # 7 = DELETED in newer spec versions
GPS_STALE = 900  # drop vehicle positions older than this many seconds

CAUSES = {
    1: "unknown", 2: "other", 3: "technical problem", 4: "strike", 5: "demonstration", 6: "accident",
    7: "holiday", 8: "weather", 9: "maintenance", 10: "construction", 11: "police activity", 12: "medical emergency",
}
EFFECTS = {
    1: "no service", 2: "reduced service", 3: "significant delays", 4: "detour", 5: "additional service",
    6: "modified service", 7: "other", 8: "unknown", 9: "stop moved", 10: "no effect", 11: "accessibility issue",
}


class Feeds:
    def __init__(self) -> None:
        self._client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)
        self._msgs: dict[str, pb.FeedMessage] = {}
        self._fetched: dict[str, float] = {}
        self._etags: dict[str, str] = {}
        self._locks = {name: threading.Lock() for name in RT_FEEDS}
        self.errors: dict[str, str] = {}
        self._derived: dict[tuple, tuple[int, object]] = {}

    def get(self, name: str) -> pb.FeedMessage | None:
        """The feed, refetched if older than its freshness window. Falls back to the last good copy."""
        url, ttl = RT_FEEDS[name]
        if name in self._msgs and time.time() - self._fetched.get(name, 0) < ttl:
            return self._msgs[name]
        with self._locks[name]:
            if name in self._msgs and time.time() - self._fetched.get(name, 0) < ttl:
                return self._msgs[name]
            try:
                headers = {"If-None-Match": self._etags[name]} if name in self._etags and name in self._msgs else {}
                r = self._client.get(url, headers=headers)
                if r.status_code != 304:
                    r.raise_for_status()
                    msg = pb.FeedMessage()
                    msg.ParseFromString(r.content)
                    self._msgs[name] = msg
                    if etag := r.headers.get("etag"):
                        self._etags[name] = etag
                self._fetched[name] = time.time()
                self.errors.pop(name, None)
            except (httpx.HTTPError, ValueError) as e:
                self.errors[name] = str(e) or type(e).__name__
        return self._msgs.get(name)

    def age(self, name: str) -> int | None:
        msg = self._msgs.get(name)
        return int(time.time() - msg.header.timestamp) if msg is not None and msg.header.timestamp else None

    def derived(self, key: tuple, msg: pb.FeedMessage, fn):
        """Memoise a filtered view of `msg`, so concurrent requests don't redo the work."""
        hit = self._derived.get(key)
        if hit is not None and hit[0] == id(msg):
            return hit[1]
        value = fn()
        self._derived[key] = (id(msg), value)
        return value


def vehicles_for(msg: pb.FeedMessage, routes: frozenset[str]) -> list[list]:
    """[trip_id, service_date, lat, lon, bearing, stop_seq, stop_id, stopped, timestamp, vehicle_label]"""
    now = time.time()
    out = []
    for e in msg.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        td = v.trip
        if td.route_id not in routes or not td.trip_id.isdigit() or not v.HasField("position"):
            continue
        ts = v.timestamp or msg.header.timestamp
        if now - ts > GPS_STALE:
            continue
        p = v.position
        out.append([
            int(td.trip_id), td.start_date, round(p.latitude, 6), round(p.longitude, 6),
            round(p.bearing) if p.HasField("bearing") else None,
            v.current_stop_sequence if v.HasField("current_stop_sequence") else None,
            v.stop_id or None, 1 if v.current_status == STOPPED_AT else 0, ts, v.vehicle.label or v.vehicle.id,
        ])
    return out


def _live_dates() -> frozenset[str]:
    """Service dates that can have trips running now: yesterday (after midnight), today, tomorrow."""
    today = datetime.now(TZ).date()
    return frozenset((today + timedelta(days=i)).strftime("%Y%m%d") for i in (-1, 0, 1))


def trips_for(msg: pb.FeedMessage, routes: frozenset[str]) -> list[list]:
    """[trip_id, service_date, cancelled, [[seq, stop_id, arr, dep, arr_delay, dep_delay, skipped], ...]]"""
    dates = _live_dates()
    out = []
    for e in msg.entity:
        if not e.HasField("trip_update"):
            continue
        tu = e.trip_update
        td = tu.trip
        if td.route_id not in routes or not td.trip_id.isdigit() or td.start_date not in dates:
            continue
        cancelled = td.schedule_relationship in CANCELLED
        updates = []
        for s in [] if cancelled else tu.stop_time_update:
            a = s.arrival if s.HasField("arrival") else None
            d = s.departure if s.HasField("departure") else None
            updates.append([
                s.stop_sequence if s.HasField("stop_sequence") else None,
                s.stop_id or None,
                a.time if a is not None and a.HasField("time") else None,
                d.time if d is not None and d.HasField("time") else None,
                a.delay if a is not None and a.HasField("delay") else None,
                d.delay if d is not None and d.HasField("delay") else None,
                1 if s.schedule_relationship == SKIPPED else 0,
            ])
        out.append([int(td.trip_id), td.start_date, 1 if cancelled else 0, updates])
    return out


def _text(ts: pb.TranslatedString) -> str:
    for t in ts.translation:
        if t.language.lower() == "en":
            return t.text.strip()
    return ts.translation[0].text.strip() if ts.translation else ""


def alerts_for(msg: pb.FeedMessage, routes: frozenset[str], stops: frozenset[str], days_ahead: int = 9) -> list[dict]:
    """Operator notices touching the region that are active now or start within `days_ahead` days."""
    now = time.time()
    horizon = now + days_ahead * 86400
    out = []
    for e in msg.entity:
        if not e.HasField("alert"):
            continue
        a = e.alert
        periods = [[p.start or None, p.end or None] for p in a.active_period]
        if periods and not any((s or 0) <= horizon and (e_ is None or e_ >= now - 86400) for s, e_ in periods):
            continue
        r_ids = {ie.route_id for ie in a.informed_entity if ie.route_id}
        s_ids = {ie.stop_id for ie in a.informed_entity if ie.stop_id}
        line_wide = {ie.route_id for ie in a.informed_entity if ie.route_id and not ie.stop_id}
        if not (s_ids & stops or line_wide & routes or (r_ids & routes and not s_ids)):
            continue
        description = _text(a.description_text)
        header = _text(a.header_text)
        if description.replace(" ", "").startswith(header.replace(" ", "")):
            description = ""
        out.append({
            "id": e.id, "header": header, "description": description, "url": _text(a.url),
            "cause": CAUSES.get(a.cause, "unknown"), "effect": EFFECTS.get(a.effect, "unknown"),
            "periods": periods, "routes": sorted(r_ids & routes), "stops": sorted(s_ids),
        })
    return out

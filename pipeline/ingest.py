"""Download the national GTFS timetable from OVapi and load it into a DuckDB file in data/."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
import zipfile
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path

import duckdb
import httpx

from app.config import DATA_DIR, GTFS_URL, USER_AGENT

log = logging.getLogger("ovlive.ingest")

ZIP_PATH = DATA_DIR / "gtfs-nl.zip"
# Each build gets its own file name: DuckDB caches open databases per path, so a
# rebuilt file must never reuse the path of the one the server has open.
DB_GLOB = "gtfs-*.duckdb"
FILES = ["agency", "routes", "stops", "trips", "stop_times", "calendar_dates", "shapes", "feed_info"]


def download(force: bool = False) -> bool:
    """Fetch the GTFS zip if OVapi has a newer one. Returns True when a new file arrived."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": USER_AGENT}
    if ZIP_PATH.exists() and not force:
        headers["If-Modified-Since"] = formatdate(ZIP_PATH.stat().st_mtime, usegmt=True)
    elif (db := latest_db()) and not force:
        # The zip is deleted after a successful build; compare against the DB instead.
        headers["If-Modified-Since"] = formatdate(db.stat().st_mtime, usegmt=True)

    with httpx.stream("GET", GTFS_URL, headers=headers, timeout=httpx.Timeout(30, read=300), follow_redirects=True) as r:
        if r.status_code == 304:
            return False
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        log.info("Downloading timetable (%.0f MB)…", total / 1e6)
        part = ZIP_PATH.with_suffix(".part")
        with open(part, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
        part.replace(ZIP_PATH)
        if lm := r.headers.get("last-modified"):
            ts = parsedate_to_datetime(lm).timestamp()
            os.utime(ZIP_PATH, (ts, ts))
    return True


def _csv(path: Path) -> str:
    p = path.as_posix().replace("'", "''")
    return f"""read_csv('{p}', header=true, all_varchar=true, delim=',', quote='"', escape='"', strict_mode=false)"""


def latest_db() -> Path | None:
    dbs = sorted(DATA_DIR.glob(DB_GLOB))
    return dbs[-1] if dbs else None


def cleanup(keep: Path) -> None:
    """Remove superseded databases (open handles keep working on POSIX)."""
    for p in DATA_DIR.glob(DB_GLOB):
        if p != keep:
            p.unlink(missing_ok=True)


def build() -> Path:
    """Build a fresh DuckDB file from the zip and return its path."""
    t0 = time.monotonic()
    tmp = Path(tempfile.mkdtemp(dir=DATA_DIR, prefix="extract-"))
    final = DATA_DIR / f"gtfs-{int(time.time())}.duckdb"
    out = final.with_suffix(".building")
    out.unlink(missing_ok=True)
    try:
        with zipfile.ZipFile(ZIP_PATH) as z:
            for name in FILES:
                z.extract(f"{name}.txt", tmp)
        log.info("Extracted in %.0fs, building database…", time.monotonic() - t0)
        src = {name: _csv(tmp / f"{name}.txt") for name in FILES}

        con = duckdb.connect(str(out))
        con.execute("set enable_progress_bar = false")
        # Vercel's free build machine has 8 GB; stay well clear of it (DuckDB spills to disk if needed).
        con.execute(f"set memory_limit = '{os.environ.get('OVLIVE_DUCKDB_MEMORY', '4GB')}'")
        steps = _sql(src)
        for label, sql in steps:
            t = time.monotonic()
            con.execute(sql)
            log.debug("  %s (%.1fs)", label, time.monotonic() - t)
        con.execute(
            "insert into meta values ('ingested_at', ?), ('source_mtime', ?)",
            [str(int(time.time())), str(int(ZIP_PATH.stat().st_mtime))],
        )
        con.execute("checkpoint")
        con.close()
        mtime = ZIP_PATH.stat().st_mtime
        out.replace(final)
        os.utime(final, (mtime, mtime))
        log.info("Timetable database ready in %.0fs (%.0f MB)", time.monotonic() - t0, final.stat().st_size / 1e6)
        return final
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        out.unlink(missing_ok=True)


def update(force: bool = False) -> Path | None:
    """Download + build when needed. Returns the new database path, or None if nothing changed."""
    fresh = download(force=force)
    if not fresh and latest_db():
        return None
    path = build()
    ZIP_PATH.unlink(missing_ok=True)
    return path


def _sql(src: dict[str, str]) -> list[tuple[str, str]]:
    return [
        ("macros", """
            create macro secs(t) as case when t is null or t = '' then null else
                cast(split_part(t, ':', 1) as integer) * 3600
                + cast(split_part(t, ':', 2) as integer) * 60
                + cast(split_part(t, ':', 3) as integer) end;
        """),
        ("meta", f"""
            create table meta as
            unpivot (select feed_version, feed_start_date, feed_end_date, feed_publisher_name from {src['feed_info']})
            on columns(*) into name key value value;
        """),
        ("agency", f"create table agency as select agency_id, agency_name from {src['agency']}"),
        ("stops", f"""
            create table stops as
            select stop_id, stop_name as name, cast(stop_lat as double) as lat, cast(stop_lon as double) as lon,
                   coalesce(try_cast(location_type as integer), 0) as location_type,
                   nullif(parent_station, '') as parent_station, nullif(platform_code, '') as platform_code,
                   try_cast(wheelchair_boarding as integer) as wheelchair
            from {src['stops']}
        """),
        ("routes_raw", f"""
            create temp table routes_raw as
            select route_id, agency_id, coalesce(nullif(route_short_name, ''), route_id) as short_name,
                   nullif(route_long_name, '') as long_name, cast(route_type as integer) as route_type,
                   nullif(route_color, '') as color, nullif(route_text_color, '') as text_color
            from {src['routes']}
        """),
        ("trips_raw", f"""
            create temp table trips_raw as
            select cast(trip_id as bigint) as trip_id, route_id, service_id, nullif(trip_headsign, '') as headsign,
                   try_cast(direction_id as integer) as direction_id, nullif(shape_id, '') as shape_id,
                   nullif(realtime_trip_id, '') as realtime_trip_id
            from {src['trips']}
        """),
        ("stop_times_raw", f"""
            create temp table st_raw as
            select cast(trip_id as bigint) as trip_id, cast(stop_sequence as integer) as seq, stop_id,
                   secs(arrival_time) as arr, secs(departure_time) as dep,
                   coalesce(try_cast(pickup_type as tinyint), 0) as pickup,
                   coalesce(try_cast(drop_off_type as tinyint), 0) as dropoff,
                   try_cast(shape_dist_traveled as double) as dist,
                   nullif(stop_headsign, '') as stop_headsign
            from {src['stop_times']}
        """),
        # A "line" is what passengers call a line: same operator, mode and number.
        # One line can span several GTFS routes (e.g. HTM tram 19 has a separate route for the TU Delft section).
        # Free-text "numbers" like NS's "Snelbus ipv trein" are reused nationwide, so those stay one line per route.
        ("route_groups", """
            create temp table route_groups as
            select *, agency_id || '|' || route_type || '|' ||
                      case when length(short_name) > 6 or contains(short_name, ' ') then route_id else short_name end
                      as line_id
            from routes_raw
        """),
        ("lines", """
            create table lines as
            with counts as (select route_id, count(*) as n from trips_raw group by 1)
            select line_id, any_value(agency_id) as agency_id, any_value(route_type) as route_type,
                   any_value(short_name) as short_name,
                   arg_max(long_name, coalesce(n, 0)) as long_name,
                   arg_max(color, coalesce(n, 0)) as color,
                   arg_max(text_color, coalesce(n, 0)) as text_color,
                   list(route_id order by coalesce(n, 0) desc) as route_ids
            from route_groups left join counts using (route_id)
            group by line_id
        """),
        ("routes", "create table routes as select * from route_groups"),
        ("trips", """
            create table trips as
            with span as (
                select trip_id, min(coalesce(dep, arr)) as start_s, max(coalesce(arr, dep)) as end_s,
                       min(seq) as first_seq, max(seq) as last_seq
                from st_raw group by 1
            )
            select t.*, r.line_id, s.start_s, s.end_s, s.first_seq, s.last_seq
            from trips_raw t join routes r using (route_id) join span s using (trip_id)
            order by trip_id
        """),
        ("service_dates", f"""
            create table service_dates as
            select service_id, strptime(date, '%Y%m%d')::date as date from {src['calendar_dates']} where exception_type = '1'
            except
            select service_id, strptime(date, '%Y%m%d')::date as date from {src['calendar_dates']} where exception_type = '2'
        """),
        ("stop_times", """
            create table stop_times as
            select trip_id, seq, stop_id, coalesce(arr, dep) as arr, coalesce(dep, arr) as dep,
                   pickup, dropoff, dist, stop_headsign
            from st_raw order by trip_id, seq
        """),
        ("drop raw", "drop table st_raw; drop table trips_raw; drop table route_groups; drop table routes_raw"),
        # Same rows sorted by stop, so departure boards only touch a few row groups.
        ("st_by_stop", """
            create table st_by_stop as
            select stop_id, trip_id, seq, dep, pickup, stop_headsign from stop_times order by stop_id, dep
        """),
        ("stop_lines", """
            create table stop_lines as
            select distinct st.stop_id, t.line_id from stop_times st join trips t using (trip_id)
        """),
        ("line_day", """
            create table line_day as
            select t.line_id, sd.date, coalesce(t.headsign, '') as headsign,
                   count(*)::integer as trips, min(t.start_s) as first_s, max(t.end_s) as last_s
            from trips t join service_dates sd using (service_id)
            group by all
        """),
        ("line_stop_day", """
            create table line_stop_day as
            with per_service as (
                select t.line_id, st.stop_id, t.service_id, count(*) as n
                from stop_times st join trips t using (trip_id)
                group by all
            )
            select p.line_id, p.stop_id, sd.date, sum(p.n)::integer as trips
            from per_service p join service_dates sd using (service_id)
            group by all
            order by line_id, date
        """),
        ("shapes", f"""
            create table shapes as
            with pts as (
                select shape_id, cast(shape_pt_sequence as integer) as i,
                       cast(shape_pt_lon as double) as lon, cast(shape_pt_lat as double) as lat,
                       try_cast(shape_dist_traveled as double) as dist
                from {src['shapes']}
            )
            select shape_id, list(lon order by i) as lons, list(lat order by i) as lats, list(dist order by i) as dists
            from pts group by shape_id
        """),
    ]

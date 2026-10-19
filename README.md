# OV Live

Live trams and buses in Dutch cities. See where every vehicle is right now, what's coming at your stop,
and which stops a line skips today. For example, tram 19 doesn't serve the TU Delft campus at weekends.

Currently covers Delft, Den Haag, Rotterdam, Amsterdam and Utrecht.

- **Map** of every tram, metro and bus, with live GPS where the operator sends it. Otherwise the position
  is estimated from live delay data, or from the timetable as a last resort (shown faded or dashed).
- **Line view**: every stop in order with the vehicles on it, which stops aren't served on the chosen day,
  where trips turn back early, and a week calendar of trips per destination.
- **Stop view**: live departures with delays, cancellations and skipped stops, or the full timetable of
  any day from yesterday to a week ahead.
- **Disruption notices** from the operators (in Dutch, with a one-tap translate link).

## How it works

```
GitHub ──push──▶ Vercel build: python -m pipeline
                   1. download the national GTFS timetable from OVapi (~230 MB zip)
                   2. load it into DuckDB (≈15 s)
                   3. write small JSON files per city and day (served at /data) ──▶ CDN
                 Vercel function: app/main.py (FastAPI)
                   /api/live, /api/alerts: fetch OVapi's GTFS-Realtime feeds,
                   keep only the chosen city's routes, cache ~10 s at the CDN
Browser: loads the city's files once, polls /api/live every 15 s, and works out
         vehicle positions, delays and departure boards itself.
```

There is no database server. The timetable becomes static files, and the only server code is a small
stateless function. It's needed because browsers aren't allowed to read the OVapi feeds directly (no CORS
headers), and it also cuts a multi-MB national feed down to a few KB per city.

A Vercel cron job redeploys once a day, so the timetable stays current. The previous build's file for
yesterday is reused, because each new timetable starts at the day it's published.

| Path | What |
|---|---|
| `pipeline/ingest.py` | Download the GTFS zip, load it into DuckDB |
| `pipeline/export.py` | DuckDB → `app/generated/data/` (lines, per-day trips, shapes), served at `/data` |
| `pipeline/diagram.py` | Merge a line's stop patterns into one stop list per direction |
| `app/main.py`, `app/realtime.py` | The live API |
| `public/` | The web app (plain JS modules + MapLibre, no build step) |

## Run it locally

Needs [uv](https://docs.astral.sh/uv/).

```bash
uv run python -m pipeline
```

```bash
uv run python -m app
```

Then open http://localhost:8000. The first command downloads the timetable and builds the files (about a minute).
Run it again any time to refresh; it only re-downloads when OVapi has published a new timetable.

## Deploy to Vercel (free plan)

1. Push this repo to GitHub, then **Add New → Project** on vercel.com and import it. No settings needed:
   Vercel picks up `pyproject.toml` (Python, build command) and `vercel.json`.
2. For the daily refresh, go to **Settings → Git → Deploy Hooks**, create a hook for the `main` branch, and add
   two environment variables under **Settings → Environment Variables**:
   - `DEPLOY_HOOK_URL`: the hook URL
   - `CRON_SECRET`: any long random string (Vercel sends it with cron requests; the endpoint rejects others)

   Then redeploy once so the cron job picks them up.

The free plan covers this comfortably for personal use: the build takes a couple of minutes once a day, and
each live request costs a few tens of milliseconds of CPU, shared through the CDN cache.

## Adding a city

Add a `Region` (name and bounding box) to `REGIONS` in [app/config.py](app/config.py). Every line with a stop inside
the box is included.

## Data and credits

- Timetable and realtime data: [OVapi](https://ovapi.nl), from the Dutch [NDOV](https://ndovloket.nl) open data
  (CC0; route shapes ODbL). OVapi is run by volunteers. Please keep the caching in place.
- Map tiles: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, data © OpenStreetMap contributors.
- Map rendering: [MapLibre GL JS](https://maplibre.org).

## License

MIT

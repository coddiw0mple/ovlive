"""The live API. On Vercel this is the one serverless function; public/ is served by the CDN.

Locally (`uv run python -m app`) the same app also serves public/.
"""

from __future__ import annotations

import json
import os
import time
from functools import lru_cache

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse

from .config import GENERATED_DIR, PUBLIC_DIR
from .realtime import Feeds, alerts_for, trips_for, vehicles_for

app = FastAPI(title="OV Live", docs_url=None, redoc_url=None, openapi_url=None)
feeds = Feeds()
REGIONS_FILE = GENERATED_DIR / "regions.json"


@lru_cache(maxsize=4)
def _load_regions(mtime: float) -> dict[str, tuple[frozenset[str], frozenset[str]]]:
    data = json.loads(REGIONS_FILE.read_text())
    return {rid: (frozenset(r["routes"]), frozenset(r["stops"])) for rid, r in data["regions"].items()}


def _region(rid: str) -> tuple[frozenset[str], frozenset[str]]:
    try:
        regions = _load_regions(REGIONS_FILE.stat().st_mtime)
    except FileNotFoundError:
        raise HTTPException(503, "No timetable built yet: run `uv run python -m pipeline`.") from None
    if rid not in regions:
        raise HTTPException(404, f"Unknown region {rid!r}")
    return regions[rid]


def _json(data, cdn_seconds: int) -> JSONResponse:
    # The CDN shares one response between everyone looking at the same region.
    return JSONResponse(data, headers={
        "Cache-Control": f"public, max-age={min(cdn_seconds, 5)}, s-maxage={cdn_seconds}, "
                         f"stale-while-revalidate={cdn_seconds}",
    })


@app.get("/api/live")
def live(region: str):
    routes, _ = _region(region)
    out = {"time": int(time.time()), "vehicles": [], "trips": [], "age": {}, "errors": dict(feeds.errors)}
    if (msg := feeds.get("vehicles")) is not None:
        out["vehicles"] = feeds.derived(("vehicles", region), msg, lambda: vehicles_for(msg, routes))
        out["age"]["vehicles"] = feeds.age("vehicles")
    if (msg := feeds.get("trips")) is not None:
        out["trips"] = feeds.derived(("trips", region), msg, lambda: trips_for(msg, routes))
        out["age"]["trips"] = feeds.age("trips")
    return _json(out, 10)


@app.get("/api/alerts")
def alerts(region: str):
    routes, stops = _region(region)
    msg = feeds.get("alerts")
    items = feeds.derived(("alerts", region), msg, lambda: alerts_for(msg, routes, stops)) if msg is not None else []
    return _json({"time": int(time.time()), "alerts": items, "errors": dict(feeds.errors)}, 60)


@app.get("/api/status")
def status():
    for name in ("vehicles", "trips", "alerts"):
        feeds.get(name)
    built = None
    if REGIONS_FILE.exists():
        built = json.loads(REGIONS_FILE.read_text()).get("build")
    return _json({"build": built, "age": {n: feeds.age(n) for n in ("vehicles", "trips", "alerts")},
                  "errors": dict(feeds.errors)}, 10)


@app.get("/api/cron/rebuild")
def rebuild(authorization: str | None = Header(default=None)):
    """Called once a day by Vercel Cron: redeploying re-runs the pipeline with the newest timetable."""
    secret, hook = os.environ.get("CRON_SECRET"), os.environ.get("DEPLOY_HOOK_URL")
    if not secret or authorization != f"Bearer {secret}":
        raise HTTPException(401, "Not allowed")
    if not hook:
        raise HTTPException(503, "DEPLOY_HOOK_URL is not set")
    r = httpx.post(hook, timeout=20)
    return {"triggered": r.is_success, "status": r.status_code}


@app.get("/", include_in_schema=False)
def index():
    return RedirectResponse("/index.html")


if not os.environ.get("VERCEL"):
    # Local development only; on Vercel the CDN serves public/ directly.
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")

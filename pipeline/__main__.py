"""Build the static timetable files: `uv run python -m pipeline`.

Vercel runs this as the build step of every deployment (see pyproject.toml).
"""

import argparse
import logging
import os
import shutil
import time

from app.config import DATA_DIR, GENERATED_DIR, SITE_DATA_DIR

from . import ingest
from .export import Exporter, previous_site


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m pipeline", description=__doc__)
    parser.add_argument("--offline", action="store_true", help="use the timetable already in data/, don't download")
    parser.add_argument("--force", action="store_true", help="re-download and rebuild the timetable")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    t0 = time.monotonic()
    db = None if args.offline else ingest.update(force=args.force)
    db = db or ingest.latest_db()
    if db is None:
        raise SystemExit("No timetable database found; run without --offline first.")
    ingest.cleanup(keep=db)
    manifest = Exporter(db).export(SITE_DATA_DIR, GENERATED_DIR / "regions.json", carry_remote=previous_site())
    logging.info("Done in %.0fs: build %s covering %s..%s", time.monotonic() - t0,
                 manifest["build"], manifest["days"][0], manifest["days"][-1])
    if os.environ.get("VERCEL"):
        # Scratch files (the ~400 MB database) must not end up in the deployment.
        shutil.rmtree(DATA_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()

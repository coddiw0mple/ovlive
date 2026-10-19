from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"  # build-time scratch space (timetable zip + database), never deployed
PUBLIC_DIR = ROOT / "public"  # the web app (committed files only)
GENERATED_DIR = ROOT / "app" / "generated"  # written by the pipeline during the build
SITE_DATA_DIR = GENERATED_DIR / "data"  # timetable files, served at /data

TZ = ZoneInfo("Europe/Amsterdam")

# OVapi republishes the NDOV open data (CC0, shapes ODbL) as GTFS + GTFS-Realtime.
GTFS_URL = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
# name -> (url, seconds a fetched copy stays fresh)
RT_FEEDS = {
    "vehicles": ("https://gtfs.ovapi.nl/nl/vehiclePositions.pb", 10),
    "trips": ("https://gtfs.ovapi.nl/nl/tripUpdates.pb", 20),
    "alerts": ("https://gtfs.ovapi.nl/nl/alerts.pb", 120),
}
USER_AGENT = "ovlive/0.1 (+https://github.com/coddiw0mple/ovlive)"

# GTFS route_type values shown in the app: tram, metro, bus, ferry.
SHOWN_ROUTE_TYPES = (0, 1, 3, 4)


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    bbox: tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat
    center: tuple[float, float]  # lon, lat
    zoom: float


REGIONS: dict[str, Region] = {
    r.id: r
    for r in [
        Region("delft", "Delft", (4.320, 51.975, 4.400, 52.030), (4.3600, 52.0060), 13.3),
        Region("denhaag", "Den Haag", (4.200, 52.010, 4.420, 52.130), (4.3000, 52.0760), 12.3),
        Region("rotterdam", "Rotterdam", (4.370, 51.860, 4.600, 51.980), (4.4750, 51.9200), 12.2),
        Region("amsterdam", "Amsterdam", (4.750, 52.280, 5.070, 52.430), (4.9000, 52.3700), 12.0),
        Region("utrecht", "Utrecht", (5.000, 52.000, 5.200, 52.130), (5.1100, 52.0850), 12.3),
    ]
}
DEFAULT_REGION = "delft"

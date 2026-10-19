import math

EARTH_R = 6_371_000.0
_RAD = math.pi / 180


def dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Equirectangular distance; accurate to well under 1% at city scale."""
    x = (lon2 - lon1) * _RAD * math.cos((lat1 + lat2) * _RAD / 2)
    y = (lat2 - lat1) * _RAD
    return EARTH_R * math.hypot(x, y)


def simplify(lats: list[float], lons: list[float], tolerance_m: float = 3.0) -> list[int]:
    """Indices of points to keep (Ramer–Douglas–Peucker), always keeping both ends."""
    n = len(lats)
    if n <= 2:
        return list(range(n))
    # Project to local metres so the tolerance means the same thing everywhere.
    k = math.cos(lats[0] * _RAD) * _RAD * EARTH_R
    xs = [lon * k for lon in lons]
    ys = [lat * _RAD * EARTH_R for lat in lats]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay, bx, by = xs[a], ys[a], xs[b], ys[b]
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        best, best_i = 0.0, -1
        for i in range(a + 1, b):
            px, py = xs[i] - ax, ys[i] - ay
            if seg == 0:
                d = math.hypot(px, py)
            else:
                t = max(0.0, min(1.0, (px * dx + py * dy) / seg))
                d = math.hypot(px - t * dx, py - t * dy)
            if d > best:
                best, best_i = d, i
        if best > tolerance_m:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [i for i in range(n) if keep[i]]


def encode_polyline(lats: list[float], lons: list[float]) -> str:
    """Google's encoded polyline format (precision 5, about a metre)."""
    out = []
    prev_lat = prev_lon = 0
    for lat, lon in zip(lats, lons):
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - prev_lat, ilon - prev_lon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)

"""Turn all the stop patterns of a line into one stop list per direction.

A line like tram 19 has several patterns (full route, short-turns at Delft Station,
depot runs...). For the line view we want a single ordered list of stations per
direction that every pattern fits onto, so vehicles of any pattern can be drawn
on it and stations that no trip serves on a given day stand out.

Stations are matched by name ("town, stop"), because the two directions and the
different variants often use different platforms of the same station.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field


def concordance(keys: tuple[str, ...], backbone: list[str]) -> float | None:
    """+1 when `keys` visits shared stations in the backbone's order, -1 when reversed."""
    pos: dict[str, int] = {}
    for i, k in enumerate(backbone):
        pos.setdefault(k, i)
    idx = [pos[k] for k in dict.fromkeys(keys) if k in pos]
    if len(idx) < 2:
        return None
    up = sum(1 for a, b in zip(idx, idx[1:]) if b > a)
    return (2 * up - (len(idx) - 1)) / (len(idx) - 1)


def assign_direction(keys: tuple[str, ...], backbones: list[list[str]], fallback: int) -> int:
    if not backbones[0]:
        return 0
    s0 = concordance(keys, backbones[0])
    s1 = concordance(keys, backbones[1]) if backbones[1] else None
    if s0 is not None and s1 is not None:
        return 0 if s0 >= s1 else 1
    if s0 is not None:
        return 0 if s0 > 0 else 1
    if s1 is not None:
        return 1 if s1 > 0 else 0
    return fallback


def merge(backbone: list[str], keys: tuple[str, ...]) -> list[str]:
    """Insert stations from `keys` that the backbone lacks, keeping their relative order."""
    if not backbone:
        # Consecutive platforms of one station (arrive on one, depart from another) are one node.
        return [k for i, k in enumerate(keys) if i == 0 or keys[i - 1] != k]
    out, cursor = list(backbone), 0
    for k in keys:
        try:
            cursor = out.index(k, cursor) + 1
        except ValueError:
            if k in out:  # seen earlier (loop line): don't duplicate
                continue
            out.insert(cursor, k)
            cursor += 1
    return out


def align(keys: tuple[str, ...], backbone: list[str]) -> list[int | None]:
    """Backbone index for each stop of a pattern, matching monotonically so loops work."""
    out, cursor = [], 0
    for k in keys:
        try:
            cursor = backbone.index(k, cursor)
            out.append(cursor)
        except ValueError:
            out.append(None)
    return out


@dataclass
class Pattern:
    keys: tuple[str, ...]
    stop_ids: tuple[str, ...]
    days: Counter = field(default_factory=Counter)  # day index -> trips
    heads: Counter = field(default_factory=Counter)
    route_dir: Counter = field(default_factory=Counter)  # (route_id, direction_id) -> trips

    @property
    def total(self) -> int:
        return sum(self.days.values())


@dataclass
class Direction:
    backbone: list[str] = field(default_factory=list)
    patterns: list[Pattern] = field(default_factory=list)


def build_directions(patterns: list[Pattern]) -> tuple[list[Direction], dict[tuple[str, ...], int]]:
    """Group patterns into (at most) two directions and build each direction's backbone."""
    dirs = [Direction(), Direction()]
    by_route_dir: dict[tuple, int] = {}
    by_dir_id: dict = {}
    # Start each direction from its longest common pattern so short-turns merge into it cleanly.
    ordered = sorted(patterns, key=lambda p: -p.total)
    top = ordered[0].total if ordered else 0
    ordered.sort(key=lambda p: (p.total < top * 0.2, -len(p.keys), -p.total))
    pattern_dir: dict[tuple[str, ...], int] = {}
    for p in ordered:
        rd = p.route_dir.most_common(1)[0][0] if p.route_dir else (None, None)
        fallback = by_route_dir.get(rd, by_dir_id.get(rd[1], 0))
        di = assign_direction(p.keys, [d.backbone for d in dirs], fallback)
        by_route_dir.setdefault(rd, di)
        by_dir_id.setdefault(rd[1], di)
        dirs[di].backbone = merge(dirs[di].backbone, p.keys)
        dirs[di].patterns.append(p)
        pattern_dir[p.keys] = di
    return dirs, pattern_dir

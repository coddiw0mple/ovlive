import { Region, loadManifest } from "./data.js";
import { Live, currentStates, stateDelay } from "./live.js";
import { MapView } from "./map.js";
import { addDays, ago, amsDate, delayText, esc, nowSec } from "./util.js";
import { homeView, href, lineView, stopView, tripView } from "./views.js";

const POLL_MS = 15000; // live feed
const TICK_MS = 5000; // recompute estimated positions between polls
const ALERTS_MS = 120000;

const app = {
  manifest: null,
  region: null,
  live: null,
  map: null,
  liveDays: [], // service days whose trips can be running now (yesterday + today)
  liveDayIsos: [],
  states: [],
  view: null,
  vehicleFilter: null,
};

const viewEl = document.getElementById("view");
const statusEl = document.getElementById("status");
const regionEl = document.getElementById("region");
const panel = document.getElementById("panel");

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function parseHash() {
  const [path, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = Object.fromEntries(new URLSearchParams(qs));
  return { parts, q };
}

async function ensureRegion(rid) {
  if (app.region?.id === rid) return;
  viewEl.innerHTML = `<p class="empty">Loading ${esc(app.manifest.regions.find((r) => r.id === rid)?.name ?? "")}…</p>`;
  app.region = await Region.load(app.manifest, rid);
  app.live = new Live(rid);
  app.states = [];
  app.liveDayIsos = [];
  regionEl.value = rid;
  storage("ovlive.region", rid);
  // The map keeps this data and draws it once its style has loaded; no need to wait for tiles.
  app.map.setStops(app.region.mapStops);
  const [lon, lat] = app.region.info.center;
  app.map.map.jumpTo({ center: [lon, lat], zoom: app.region.info.zoom });
  await Promise.all([app.live.poll(), app.live.pollAlerts(), loadLiveDays()]);
  app.region.loadShapes().then(() => {
    recompute();
    app.view?.map?.(false);
  });
}

async function loadLiveDays() {
  const today = amsDate();
  const isos = [addDays(today, -1), today];
  if (isos.join() === app.liveDayIsos.join()) return;
  app.liveDayIsos = isos;
  app.liveDays = await Promise.all(isos.map((d) => app.region.day(d)));
}

async function route() {
  const { parts, q } = parseHash();
  const ids = app.manifest.regions.map((r) => r.id);
  const rid = ids.includes(parts[0]) ? parts[0] : (ids.includes(storage("ovlive.region")) ? storage("ovlive.region") : app.manifest.default);
  if (parts[0] !== rid) {
    history.replaceState(null, "", href(rid, parts.slice(ids.includes(parts[0]) ? 1 : 0), q));
  }
  try {
    await ensureRegion(rid);
  } catch (e) {
    viewEl.innerHTML = `<p class="empty">Couldn't load the timetable (${esc(e.message)}). Try reloading.</p>`;
    return;
  }
  const [, kind, a, b] = parts[0] === rid ? parts : [rid, ...parts];
  let view;
  if (kind === "line" && a) view = lineView(app, a, q);
  else if (kind === "stop" && a) view = stopView(app, a, q);
  else if (kind === "trip" && a && b) view = tripView(app, a, b);
  else view = homeView(app, q);

  const sameKind = app.view?.kind === kind && app.view?.key === a;
  app.view = Object.assign(view, { kind, key: a });
  document.title = view.title;
  const scroll = sameKind ? panel.scrollTop : 0;
  viewEl.innerHTML = view.html();
  panel.scrollTop = scroll;
  if (!sameKind) viewEl.focus({ preventScroll: true });
  view.map?.(!sameKind);
  drawVehicles();
  await view.bind?.(viewEl);
}

function recompute() {
  if (!app.region) return;
  app.states = currentStates(app.region, app.liveDays, app.live);
  drawVehicles();
  if (app.view?.refresh) app.view.refresh(viewEl);
  drawStatus();
}

function drawVehicles() {
  const r = app.region;
  const shown = app.vehicleFilter ? app.states.filter(app.vehicleFilter) : app.states;
  app.map.setVehicles(shown.map((s) => {
    const line = s.trip.p.line;
    const d = stateDelay(s);
    const stop = r.stops.get(s.trip.p.stops[s.next])?.name ?? "";
    const how = s.source === "gps" ? "live GPS" : s.source === "estimated" ? "estimated position" : "timetable position";
    return {
      id: s.key, lon: s.lon, lat: s.lat, bearing: s.bearing, color: line.color, text: line.text,
      label: line.short, kind: s.source,
      title: `${line.short} → ${s.trip.head}`,
      detail: `${s.atStop ? "At" : "Next"}: ${stop}${d != null ? ` · ${delayText(d)}` : ""} · ${how}`,
    };
  }));
}

function drawStatus() {
  const live = app.live;
  if (!live) return;
  const gps = app.states.filter((s) => s.source === "gps").length;
  let cls = "live", text;
  if (live.failed || !live.time) {
    cls = "stale";
    text = "Live data unavailable · timetable only";
  } else {
    const age = live.age?.vehicles;
    if (age != null && age > 180) cls = "stale";
    text = `${app.states.length} live · ${ago(live.time)}`;
  }
  statusEl.className = `status ${cls}`;
  statusEl.title = `${app.states.length} vehicles running, ${gps} with live GPS`;
  statusEl.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${esc(text)}</span>`;
}

function every(ms, fn) {
  setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
}

async function boot() {
  app.manifest = await loadManifest();
  regionEl.innerHTML = app.manifest.regions.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  regionEl.addEventListener("change", () => (location.hash = href(regionEl.value)));

  app.map = new MapView(document.getElementById("map"), {
    onVehicle: (key) => {
      const [trip, date] = key.split(":");
      location.hash = href(app.region.id, ["trip", trip, date]);
    },
    onStop: (id) => (location.hash = href(app.region.id, ["stop", id])),
  });

  const handle = document.getElementById("sheet-handle");
  handle.addEventListener("click", () => {
    const open = panel.classList.toggle("expanded");
    handle.setAttribute("aria-expanded", String(open));
  });

  window.addEventListener("hashchange", route);
  await route();
  recompute();

  every(POLL_MS, async () => {
    await app.live.poll();
    await loadLiveDays();
    recompute();
  });
  every(TICK_MS, recompute);
  every(ALERTS_MS, () => app.live.pollAlerts());
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !app.live) return;
    await app.live.poll();
    recompute();
  });
}

boot().catch((e) => {
  viewEl.innerHTML = `<p class="empty">Something went wrong loading OV Live: ${esc(e.message)}</p>`;
  console.error(e);
});

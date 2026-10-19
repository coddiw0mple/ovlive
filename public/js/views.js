// Panel views. Each returns {title, html(), bind(el), refresh(el), map()}; refresh() only touches live parts.
import { departures, diagramPosition, predict, stateDelay, tripKey, vehicleState } from "./live.js";
import {
  TZ, badge, dayName, delayClass, delayText, esc, hm, minutesUntil, nowSec, serviceToday,
  shortDay, translateLink,
} from "./util.js";

// ---- links ------------------------------------------------------------------

export function href(rid, parts = [], query = {}) {
  const path = [rid, ...parts].map(encodeURIComponent).join("/");
  const qs = Object.entries(query).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `#/${path}${qs ? "?" + qs : ""}`;
}

const tripHref = (app, trip, day) => href(app.region.id, ["trip", String(trip.id), day.compact]);
const stopHref = (app, stopId, query = {}) => href(app.region.id, ["stop", stopId], query);
const lineHref = (app, lineId, query = {}) => href(app.region.id, ["line", lineId], query);

// ---- shared bits ------------------------------------------------------------

const whenFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Rough [start, end) of a service day in unix seconds (04:00 to 04:00 Amsterdam time). */
function dayWindow(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d, 2) / 1000; // 04:00 CEST / 03:00 CET: close enough to filter notices
  return [start, start + 86400];
}

function alertsOn(app, iso, { lines = null, stops = null } = {}) {
  const [s, e] = dayWindow(iso);
  return app.live.alerts.filter((a) => {
    const active = !a.periods.length || a.periods.some(([ps, pe]) => (ps ?? 0) < e && (pe == null || pe > s));
    if (!active) return false;
    if (lines) {
      const routes = new Set(lines.flatMap((l) => l.routes));
      if (!a.routes.some((r) => routes.has(r))) return false;
    }
    if (stops && !a.stops.some((x) => stops.includes(x))) return false;
    return true;
  });
}

function alertItem(app, a) {
  const r = app.region;
  const lines = [...new Set(a.routes.map((x) => r.routeToLine.get(x)).filter(Boolean))];
  const names = [...new Set(a.stops.map((x) => r.stops.get(x)?.name).filter(Boolean))];
  const periods = a.periods.filter(([s, e]) => s || e).slice(0, 2).map(([s, e]) =>
    `${s ? whenFmt.format(s * 1000) : "now"} – ${e ? whenFmt.format(e * 1000) : "until further notice"}`);
  const text = [a.header, a.description].filter(Boolean).join("\n\n");
  return `<div class="alert">
    ${lines.length ? `<span class="lines">${lines.slice(0, 6).map((l) => badge(l, "sm")).join("")}</span>` : ""}
    <span lang="nl">${esc(a.header)}</span>
    ${a.description ? `<p lang="nl">${esc(a.description)}</p>` : ""}
    <div class="when">
      ${periods.map((p) => `<span>${esc(p)}</span>`).join("")}
      ${names.length ? `<span>Stops: ${esc(names.slice(0, 5).join(", "))}${names.length > 5 ? ` +${names.length - 5}` : ""}</span>` : ""}
      <a href="${esc(translateLink(text))}" target="_blank" rel="noopener">Translate</a>
      ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">More info</a>` : ""}
    </div>
  </div>`;
}

function alertsBlock(app, alerts, { open = false, label = "notice" } = {}) {
  if (!alerts.length) return "";
  return `<details class="notices"${open ? " open" : ""}>
    <summary>⚠ ${alerts.length} ${label}${alerts.length === 1 ? "" : "s"} from the operators</summary>
    ${alerts.map((a) => alertItem(app, a)).join("")}
  </details>`;
}

function daysNav(app, day, link) {
  const r = app.region, today = serviceToday();
  return `<nav class="days" aria-label="Day">${r.days.map((d) => {
    const has = r.available.has(d);
    return `<a href="${link(d)}" ${d === day ? 'aria-current="date"' : ""} class="${has ? "" : "none"}">${esc(shortDay(d, today))}</a>`;
  }).join("")}</nav>`;
}

function skipNote(names, verb = "Skips") {
  if (!names?.length) return "";
  const shown = names.slice(0, 3).join(", ");
  return `<span class="skip-note">${verb} ${esc(shown)}${names.length > 3 ? ` +${names.length - 3} more` : ""}</span>`;
}

/** Live states grouped by line id. */
function statesByLine(app) {
  const m = new Map();
  for (const s of app.states) {
    const id = s.trip.p.line.id;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(s);
  }
  return m;
}

/** Trips cancelled today, per line id. */
function cancelledByLine(app) {
  const m = new Map();
  for (const day of app.liveDays) {
    if (!day) continue;
    for (const trip of day.trips) {
      if (trip.p.line && app.live.trips.get(tripKey(trip, day))?.cancelled) {
        const id = trip.p.line.id;
        if (!m.has(id)) m.set(id, []);
        m.get(id).push({ trip, day });
      }
    }
  }
  return m;
}

function lineShapes(app, line) {
  return line.shapes.map((id) => app.region.shapes.get(id)).filter(Boolean)
    .map((s) => ({ coords: s.lat.map((la, i) => [s.lon[i], la]), color: line.color }));
}

// ---- home -------------------------------------------------------------------

export function homeView(app, q) {
  const r = app.region, today = serviceToday();
  const day = r.days.includes(q.d) ? q.d : today;
  const di = r.days.indexOf(day);
  const isToday = day === today;

  const liveBits = (line, live, cancelled, alerts) => {
    const n = live.get(line.id)?.length ?? 0;
    const c = cancelled.get(line.id)?.length ?? 0;
    const a = alerts.filter((x) => x.routes.some((rt) => line.routes.includes(rt))).length;
    return [
      isToday && n ? `<span class="live-n">${n} live</span>` : "",
      isToday && c ? `<span class="pill bad">${c} cancelled</span>` : "",
      a ? `<span class="pill warn">${a} notice${a > 1 ? "s" : ""}</span>` : "",
    ].join("");
  };

  const row = (line, live, cancelled, alerts) => {
    const d = di >= 0 ? line.days[di] : null;
    let status;
    if (d == null) status = `<span>No timetable for this day</span>`;
    else if (!d.n) status = `<span>Not running${isToday ? " today" : ""}</span>${line.next && line.next > day ? `<span>next ${esc(dayName(line.next, today))}</span>` : ""}`;
    else status = `<span class="num">${d.n} trips · ${esc(d.first)}–${esc(d.last)}</span>`;
    return `<li data-line="${esc(line.id)}" data-search="${esc((line.short + " " + line.name + " " + line.operator).toLowerCase())}">
      <a class="item${d?.n ? "" : " off"}" href="${lineHref(app, line.id, { d: isToday ? null : day })}">
        ${badge(line)}
        <span class="title">${esc(line.name || line.short)}</span>
        <span class="meta"><span class="live-slot">${liveBits(line, live, cancelled, alerts)}</span>${status}</span>
        ${skipNote(d?.missing)}
      </a></li>`;
  };

  return {
    title: `${r.name} trams & buses · OV Live`,
    html() {
      const live = statesByLine(app), cancelled = cancelledByLine(app), alerts = alertsOn(app, day);
      return `
        ${daysNav(app, day, (d) => href(r.id, [], { d: d === today ? null : d }))}
        <label class="visually-hidden" for="q">Search lines and stops</label>
        <input id="q" class="search" type="search" placeholder="Search a line or stop" autocomplete="off">
        <ul class="list" id="stop-results" aria-label="Matching stops" hidden></ul>
        <div id="alerts-slot">${alertsBlock(app, alerts)}</div>
        <h2 id="lines-h">${isToday ? `Lines in ${esc(r.name)} today` : `Lines · ${esc(dayName(day, today))}`}</h2>
        <ul class="list" id="lines" aria-labelledby="lines-h">${r.lines.map((l) => row(l, live, cancelled, alerts)).join("")}</ul>`;
    },
    bind(el) {
      const input = el.querySelector("#q"), results = el.querySelector("#stop-results");
      input.addEventListener("input", () => {
        const term = input.value.trim().toLowerCase();
        for (const li of el.querySelectorAll("#lines > li")) li.hidden = term && !li.dataset.search.includes(term);
        if (term.length < 2) return (results.hidden = true);
        const seen = new Set(), hits = [];
        for (const s of r.mapStops) {
          if (!s.name.toLowerCase().includes(term) || seen.has(s.group)) continue;
          seen.add(s.group);
          hits.push(s);
          if (hits.length >= 6) break;
        }
        results.hidden = !hits.length;
        results.innerHTML = hits.map((s) => `<li><a class="item" href="${stopHref(app, s.id)}">
          <span class="badge sm" style="--c:var(--surface2);--tc:var(--text)">Stop</span>
          <span class="title">${esc(s.name)}</span><span class="meta">${esc(s.town)}</span></a></li>`).join("");
      });
    },
    refresh(el) {
      const live = statesByLine(app), cancelled = cancelledByLine(app), alerts = alertsOn(app, day);
      for (const li of el.querySelectorAll("#lines > li")) {
        const line = r.lineById.get(li.dataset.line);
        li.querySelector(".live-slot").innerHTML = liveBits(line, live, cancelled, alerts);
      }
      const slot = el.querySelector("#alerts-slot");
      const wasOpen = slot.querySelector("details")?.open;
      slot.innerHTML = alertsBlock(app, alerts, { open: wasOpen });
    },
    map() {
      app.map.setShapes([]);
      app.map.setFocus([]);
      app.vehicleFilter = null;
    },
  };
}

// ---- line -------------------------------------------------------------------

export function lineView(app, lineId, q) {
  const r = app.region, today = serviceToday();
  const line = r.lineById.get(lineId);
  if (!line) return notFound(app, "That line isn't in this city's timetable.");
  const day = r.days.includes(q.d) ? q.d : today;
  const di = r.days.indexOf(day);
  const isToday = day === today;
  let dirIdx = Math.min(Number(q.dir) || 0, Math.max(line.dirs.length - 1, 0));

  const calendar = () => {
    const totals = new Map();
    line.days.forEach((d) => d?.heads?.forEach(([h, n]) => totals.set(h, (totals.get(h) ?? 0) + n)));
    const heads = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a)).slice(0, 6);
    if (!heads.length) return `<p class="empty">No trips in the timetable for these days.</p>`;
    const cell = (d, h, i) => {
      if (d == null) return `<td class="muted${i === di ? " sel" : ""}">?</td>`;
      const n = d.heads?.find(([x]) => x === h)?.[1] ?? 0;
      return `<td class="num${n ? "" : " zero"}${i === di ? " sel" : ""}">${n || "–"}</td>`;
    };
    return `<div class="cal-wrap"><table class="cal">
      <caption>Trips per day, by destination</caption>
      <thead><tr><th scope="col"><span class="visually-hidden">Destination</span></th>${r.days.map((d, i) =>
        `<th scope="col" class="${i === di ? "sel" : ""}"><a href="${lineHref(app, line.id, { d: d === today ? null : d, dir: dirIdx || null })}">${esc(shortDay(d, today))}</a></th>`).join("")}</tr></thead>
      <tbody>${heads.map((h) => `<tr><th scope="row" title="${esc(h)}">${esc(h)}</th>${line.days.map((d, i) => cell(d, h, i)).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
  };

  const vehiclesHtml = () => {
    if (!isToday || !line.dirs[dirIdx]) return "";
    const dir = line.dirs[dirIdx];
    const row = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row")) || 38;
    return (statesByLine(app).get(line.id) ?? []).filter((s) => s.trip.p.dir === dir.dir).map((s) => {
      const pos = diagramPosition(r, s, dir);
      if (pos == null) return "";
      const d = stateDelay(s);
      const next = r.stops.get(s.trip.p.stops[s.next])?.name ?? "";
      const label = `${line.short} to ${s.trip.head}, ${s.atStop ? "at" : "next stop"} ${next}${d != null ? ", " + delayText(d) : ""}`;
      const txt = d == null ? "▼" : `▼ ${Math.round(d / 60) > 0 ? "+" : ""}${Math.round(d / 60)}′`;
      return `<a class="veh ${s.source}" href="${tripHref(app, s.trip, s.day)}" style="top:${(pos + 0.5) * row}px;--c:${line.color};--tc:${line.text}" aria-label="${esc(label)}">${txt}</a>`;
    }).join("");
  };

  const diagram = () => {
    const dir = line.dirs[dirIdx];
    if (!dir) return "";
    const runs = line.days[di]?.n > 0;
    let prevTown = null;
    const items = dir.stops.map((s, i) => {
      const n = s.n[di] ?? 0, ends = s.e[di] ?? 0;
      const off = runs && !n;
      const town = s.town && s.town !== prevTown ? `<span class="town">${esc(s.town)}</span>` : "";
      prevTown = s.town;
      let note = "";
      if (off) note = `<span class="note warn">not served</span>`;
      else if (ends && i < dir.stops.length - 1) note = `<span class="note muted">↩ ${ends} end here</span>`;
      return `<li class="${off ? "off" : ""}"><span></span><span class="track"></span>
        <span class="stop">${town}<a href="${stopHref(app, s.id, { d: isToday ? null : day })}">${esc(s.name)}</a>${note}</span></li>`;
    }).join("");
    return `<div class="diagram" style="--c:${line.color};--tc:${line.text}">
      <ol aria-label="Stops towards ${esc(dir.to.join(" / "))}">${items}</ol>
      <div class="vehicles" id="dvehicles">${vehiclesHtml()}</div>
    </div>`;
  };

  const tabs = () => line.dirs.length > 1 ? `<div class="tabs" role="group" aria-label="Direction">${line.dirs.map((d, i) =>
    `<button type="button" data-dir="${i}" aria-pressed="${i === dirIdx}">→ ${esc(d.to.join(" / ") || "Direction " + (i + 1))}</button>`).join("")}</div>` : "";

  const cancelledHtml = () => {
    if (!isToday) return "";
    const list = (cancelledByLine(app).get(line.id) ?? []).sort((a, b) => a.day.base + a.trip.dep[0] - (b.day.base + b.trip.dep[0]));
    if (!list.length) return "";
    return `<h3>Cancelled today</h3><ul class="list">${list.slice(0, 20).map(({ trip, day }) => {
      const from = r.stops.get(trip.p.stops[0])?.name ?? "";
      const t = day.base + trip.dep[0];
      return `<li><a class="item" href="${tripHref(app, trip, day)}">${badge(line, "sm")}
        <span class="title"><s class="num">${hm(t)}</s> ${esc(from)} → ${esc(trip.head)}</span>
        <span class="meta">${t < nowSec() ? "earlier today" : `would leave in ${esc(minutesUntil(t) || hm(t))}`}</span></a></li>`;
    }).join("")}</ul>`;
  };

  const summary = () => {
    const d = line.days[di];
    if (d == null) return `<p class="sub">No timetable for ${esc(dayName(day, today).toLowerCase())}.</p>`;
    if (!d.n) return `<p class="sub warn">Not running ${esc(dayName(day, today).toLowerCase())}${line.next && line.next > day ? ` · next service ${esc(dayName(line.next, today))}` : ""}.</p>`;
    return `<p class="sub num">${d.n} trips · first ${esc(d.first)} · last ${esc(d.last)}</p>${d.missing?.length ? `<p>${skipNote(d.missing, isToday ? "Today it skips" : "This day it skips")}</p>` : ""}`;
  };

  return {
    title: `${line.mode === "tram" ? "Tram" : line.mode === "metro" ? "Metro" : "Bus"} ${line.short} · ${r.name} · OV Live`,
    html() {
      return `
        <a class="back" href="${href(r.id, [], { d: isToday ? null : day })}">← All lines</a>
        <div class="view-head">${badge(line)}<h2>${esc(line.name || "Line " + line.short)}</h2></div>
        <p class="sub">${esc(line.operator)} · ${esc(line.mode)}</p>
        ${daysNav(app, day, (d) => lineHref(app, line.id, { d: d === today ? null : d, dir: dirIdx || null }))}
        ${summary()}
        <div id="line-alerts">${alertsBlock(app, alertsOn(app, day, { lines: [line] }), { open: true })}</div>
        ${calendar()}
        ${tabs()}
        <div id="diagram-slot">${diagram()}</div>
        <div id="cancelled-slot">${cancelledHtml()}</div>`;
    },
    bind(el) {
      el.querySelectorAll("[data-dir]").forEach((b) => b.addEventListener("click", () => {
        dirIdx = Number(b.dataset.dir);
        el.querySelectorAll("[data-dir]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        el.querySelector("#diagram-slot").innerHTML = diagram();
        history.replaceState(null, "", lineHref(app, line.id, { d: isToday ? null : day, dir: dirIdx || null }));
      }));
    },
    refresh(el) {
      const v = el.querySelector("#dvehicles");
      if (v) v.innerHTML = vehiclesHtml();
      el.querySelector("#cancelled-slot").innerHTML = cancelledHtml();
    },
    map(first) {
      app.vehicleFilter = (s) => s.trip.p.line.id === line.id;
      const shapes = lineShapes(app, line);
      app.map.setShapes(shapes);
      app.map.setFocus([]);
      if (first && shapes.length) app.map.fitTo(shapes.flatMap((s) => s.coords), 14);
    },
  };
}

// ---- stop -------------------------------------------------------------------

export function stopView(app, stopId, q) {
  const r = app.region, today = serviceToday();
  const stop = r.stops.get(stopId);
  if (!stop) return notFound(app, "That stop isn't in this city's timetable.");
  const group = r.station(stopId);
  const groupStops = group.map((id) => r.stops.get(id)).filter(Boolean);
  const day = r.days.includes(q.d) ? q.d : today;
  const isToday = day === today;
  const lineFilter = q.line || null;
  const lines = [...new Set(r.mapStops.filter((s) => group.includes(s.id)).flatMap((s) => s.lines))]
    .sort((a, b) => r.lines.indexOf(a) - r.lines.indexOf(b));
  let dayData = null;

  const rowHtml = (d) => {
    const line = d.trip.p.line;
    const platform = r.stops.get(d.sid)?.platform;
    const delayed = d.delay != null && Math.round(d.delay / 60) !== 0;
    let right = "";
    if (isToday) {
      const status = d.cancelled ? `<span class="bad">cancelled</span>` : d.skipped ? `<span class="bad">skips this stop</span>`
        : d.live ? `<span class="${delayClass(d.delay)}">${esc(delayText(d.delay))}</span>` : `<span class="muted">timetable</span>`;
      right = `<span class="right"><span class="mins">${esc(minutesUntil(d.time))}</span>${status}</span>`;
    }
    return `<li><a class="item${d.cancelled || d.skipped ? " cancelled" : ""}" href="${tripHref(app, d.trip, d.day)}">
      <span class="t num">${hm(d.time)}${delayed ? `<s>${hm(d.sched)}</s>` : ""}</span>
      ${badge(line, "sm")}
      <span class="head">${esc(d.head)}${platform ? ` <span class="pill">${esc(platform)}</span>` : ""}</span>
      ${right}</a></li>`;
  };

  const depsHtml = () => {
    if (isToday) {
      const now = nowSec();
      const rows = departures(r, app.liveDays, app.live, group, { from: now - 30, until: now + 3 * 3600, line: lineFilter }).slice(0, 40);
      return rows.length ? `<ul class="list deps">${rows.map(rowHtml).join("")}</ul>`
        : `<p class="empty">No departures in the next 3 hours.</p>`;
    }
    if (!dayData) return `<p class="empty">${r.available.has(day) ? "Loading…" : "No timetable for this day."}</p>`;
    const rows = departures(r, [dayData], null, group, { line: lineFilter });
    if (!rows.length) return `<p class="empty">Nothing departs from here on ${esc(dayName(day, today))}.</p>`;
    let hour = null, out = "";
    for (const d of rows) {
      const h = hm(d.time).slice(0, 2);
      if (h !== hour) out += `<li class="hour">${h}:00</li>`;
      hour = h;
      out += rowHtml(d);
    }
    return `<ul class="list deps">${out}</ul>`;
  };

  const filterHtml = () => lines.length > 1 ? `<nav class="filter${lineFilter ? "" : " all"}" aria-label="Show one line">${lines.map((l) =>
    `<a href="${stopHref(app, stopId, { d: isToday ? null : day, line: lineFilter === l.id ? null : l.id })}" ${lineFilter === l.id ? 'aria-current="true"' : ""}>${badge(l, "sm")}</a>`).join("")}</nav>` : "";

  return {
    title: `${stop.name} departures · OV Live`,
    html() {
      const platforms = [...new Set(groupStops.map((s) => s.platform).filter(Boolean))].sort();
      return `
        <a class="back" href="${href(r.id, [], { d: isToday ? null : day })}">← All lines</a>
        <div class="view-head"><h2>${esc(stop.name)}</h2></div>
        <p class="sub">${esc(stop.town)}${platforms.length ? ` · platforms ${esc(platforms.join(", "))}` : ""}</p>
        ${daysNav(app, day, (d) => stopHref(app, stopId, { d: d === today ? null : d, line: lineFilter }))}
        ${filterHtml()}
        <div id="stop-alerts">${alertsBlock(app, alertsOn(app, day, { stops: group }), { open: true })}</div>
        <h3>${isToday ? "Departures" : `Timetable · ${esc(dayName(day, today))}`}</h3>
        <div id="deps">${depsHtml()}</div>`;
    },
    async bind(el) {
      if (!isToday) {
        dayData = await r.day(day);
        el.querySelector("#deps").innerHTML = depsHtml();
      }
    },
    refresh(el) {
      if (isToday) el.querySelector("#deps").innerHTML = depsHtml();
    },
    map(first) {
      app.vehicleFilter = null;
      app.map.setShapes([]);
      app.map.setFocus(groupStops);
      if (first) app.map.flyTo(stop.lon, stop.lat, 16);
    },
  };
}

// ---- trip -------------------------------------------------------------------

export function tripView(app, tripId, ymd) {
  const r = app.region, today = serviceToday();
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  let day = null, trip = null;

  const content = () => {
    if (!trip) return `<p class="empty">${day === null ? "Loading…" : "This trip isn't in the timetable (any more)."}</p>`;
    const line = trip.p.line, key = tripKey(trip, day);
    const tu = app.live.trips.get(key);
    const pr = predict(trip, day.base, tu);
    const state = vehicleState(r, trip, day, app.live);
    const now = nowSec();
    const facts = [];
    if (tu?.cancelled) facts.push(`<span class="pill bad">Cancelled</span>`);
    else if (state?.source === "gps") facts.push(`<span class="pill ok">Live GPS${state.vp.label ? ` · vehicle ${esc(state.vp.label)}` : ""}</span>`);
    else if (state?.source === "estimated") facts.push(`<span class="pill">Position estimated from live delays</span>`);
    else if (state) facts.push(`<span class="pill">Timetable only, no live data</span>`);
    if (state && stateDelay(state) != null) facts.push(`<span class="pill ${delayClass(stateDelay(state))}">${esc(delayText(stateDelay(state)))}</span>`);
    if (!state && !tu?.cancelled) facts.push(`<span class="pill">${now < pr.dep[0] ? `Leaves ${esc(dayName(iso, today).toLowerCase())} at ${hm(pr.dep[0])}` : "Finished"}</span>`);

    const rowH = 34;
    const here = state ? `<span class="here" style="top:${(state.prev + state.frac * (state.next - state.prev) + 0.5) * rowH}px" aria-hidden="true"></span>` : "";
    const items = trip.p.stops.map((sid, i) => {
      const s = r.stops.get(sid);
      const t = i === 0 ? pr.dep[i] : pr.arr[i], st = i === 0 ? pr.sdep[i] : pr.sarr[i];
      const passed = state ? i < state.next : t < now;
      const d = pr.live[i] ? t - st : null;
      return `<li class="${passed ? "passed" : ""}${pr.skipped[i] ? " skipped" : ""}" style="height:${rowH}px">
        <span class="time">${hm(t)}</span><span class="track"></span>
        <span class="name"><a href="${stopHref(app, sid)}">${esc(s?.name ?? sid)}</a>${s?.platform ? ` <span class="pill">${esc(s.platform)}</span>` : ""}</span>
        <span class="dl ${delayClass(d)}">${pr.skipped[i] ? "skipped" : d != null && Math.round(d / 60) ? esc(delayText(d)) : ""}</span></li>`;
    }).join("");
    return `<div class="facts">${facts.join("")}</div>
      <div class="trip" style="--c:${line.color}"><ol style="position:relative">${here}${items}</ol></div>`;
  };

  return {
    title: "Trip · OV Live",
    html() {
      return `<a class="back" href="#" data-back>← Back</a><div id="trip-head"></div><div id="trip-body">${content()}</div>`;
    },
    async bind(el) {
      el.querySelector("[data-back]").addEventListener("click", (e) => {
        e.preventDefault();
        if (history.length > 1) history.back(); else location.hash = href(r.id);
      });
      day = (await r.day(iso)) ?? false;
      trip = day ? day.trips.find((t) => String(t.id) === String(tripId)) ?? null : null;
      if (trip) {
        const line = trip.p.line;
        document.title = `${line.short} to ${trip.head} · OV Live`;
        // A trip that's running now needs no date; otherwise say which day it's on.
        const when = vehicleState(r, trip, day, app.live) ? "" : ` · ${esc(dayName(iso, today))}`;
        el.querySelector("#trip-head").innerHTML = `<div class="view-head">${badge(line)}<h2>→ ${esc(trip.head)}</h2></div>
          <p class="sub"><a href="${lineHref(app, line.id)}">${esc(line.name)}</a> · ${esc(line.operator)}${when}</p>`;
      }
      el.querySelector("#trip-body").innerHTML = content();
      this.map(true);
    },
    refresh(el) {
      el.querySelector("#trip-body").innerHTML = content();
    },
    map(first) {
      if (!trip) return;
      const line = trip.p.line;
      app.vehicleFilter = (s) => s.trip === trip;
      const shape = r.shapes.get(trip.p.shape);
      const coords = shape ? shape.lat.map((la, i) => [shape.lon[i], la])
        : trip.p.stops.map((sid) => r.stops.get(sid)).filter(Boolean).map((s) => [s.lon, s.lat]);
      app.map.setShapes([{ coords, color: line.color }]);
      app.map.setFocus([]);
      if (first) {
        const state = vehicleState(r, trip, day, app.live);
        if (state) app.map.flyTo(state.lon, state.lat, 14.5); else app.map.fitTo(coords, 15);
      }
    },
  };
}

function notFound(app, message) {
  return {
    title: "Not found · OV Live",
    html: () => `<a class="back" href="${href(app.region.id)}">← All lines</a><p class="empty">${esc(message)}</p>`,
    map() { app.vehicleFilter = null; app.map.setShapes([]); app.map.setFocus([]); },
  };
}

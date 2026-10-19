// The MapLibre map: stops, route shapes and vehicles.
import { esc } from "./util.js";

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const EMPTY = { type: "FeatureCollection", features: [] };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export class MapView {
  constructor(container, { onVehicle, onStop }) {
    this.onVehicle = onVehicle;
    this.onStop = onStop;
    this.data = { stops: EMPTY, shapes: EMPTY, vehicles: EMPTY, focus: EMPTY };
    this._shown = new Map(); // vehicle id -> [lon, lat] currently drawn
    this._anim = null;
    this.map = new maplibregl.Map({
      container,
      style: darkQuery.matches ? STYLES.dark : STYLES.light,
      center: [4.36, 52.006],
      zoom: 13,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
    this.ready = new Promise((resolve) => this.map.once("load", resolve));
    this.map.on("style.load", () => this._addLayers());
    this.map.on("styleimagemissing", (e) => this._makeIcon(e.id));
    darkQuery.addEventListener("change", () => this.map.setStyle(darkQuery.matches ? STYLES.dark : STYLES.light));
    this._bindEvents();
  }

  _addLayers() {
    const m = this.map;
    for (const name of ["shapes", "stops", "focus", "vehicles"]) {
      if (!m.getSource(name)) m.addSource(name, { type: "geojson", data: this.data[name] });
    }
    const dark = darkQuery.matches;
    m.addLayer({
      id: "shapes-casing", type: "line", source: "shapes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "#0e1116" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 4, 16, 9] },
    });
    m.addLayer({
      id: "shapes", type: "line", source: "shapes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 5] },
    });
    m.addLayer({
      id: "stops", type: "circle", source: "stops", minzoom: 12.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2, 16, 5],
        "circle-color": dark ? "#1e232b" : "#ffffff",
        "circle-stroke-color": dark ? "#9ba4b1" : "#5a6371",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12.5, 1, 16, 1.5],
      },
    });
    m.addLayer({
      id: "stop-labels", type: "symbol", source: "stops", minzoom: 15.5,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11,
                "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": dark ? "#c9d1db" : "#3b4350", "text-halo-color": dark ? "#0e1116" : "#ffffff", "text-halo-width": 1.5 },
    });
    m.addLayer({
      id: "focus", type: "circle", source: "focus",
      paint: { "circle-radius": 9, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3,
               "circle-stroke-color": dark ? "#5b9dff" : "#1f62d6" },
    });
    m.addLayer({
      id: "vehicles", type: "symbol", source: "vehicles",
      layout: {
        "icon-image": ["get", "icon"],
        "icon-rotate": ["coalesce", ["get", "bearing"], 0],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11,
        "text-allow-overlap": true, "text-ignore-placement": true,
        "symbol-sort-key": ["get", "sort"],
      },
      paint: { "text-color": ["get", "tc"] },
    });
  }

  /** Vehicle marker: a disc in the line colour with a nose pointing where it's heading. */
  _makeIcon(id) {
    const m = /^veh:(#[0-9a-f]{6}):(gps|estimated|scheduled):([01])$/i.exec(id);
    if (!m) return;
    const [, color, kind, hasNose] = m;
    const px = 2, size = 34, r = 11, c = size / 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size * px;
    const g = canvas.getContext("2d");
    g.scale(px, px);
    g.beginPath();
    if (hasNose === "1") {
      // Circle with a pointed tip at the top (north = bearing 0).
      g.moveTo(c, c - r - 5);
      g.arc(c, c, r, -Math.PI / 2 + 0.55, -Math.PI / 2 - 0.55 + 2 * Math.PI);
      g.closePath();
    } else {
      g.arc(c, c, r, 0, 2 * Math.PI);
    }
    g.lineWidth = 2;
    if (kind === "scheduled") {
      g.fillStyle = "#ffffff";
      g.fill();
      g.setLineDash([3, 2]);
      g.strokeStyle = color;
      g.lineWidth = 2.5;
      g.stroke();
    } else {
      g.globalAlpha = kind === "estimated" ? 0.72 : 1;
      g.fillStyle = color;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = "#ffffff";
      g.stroke();
    }
    this.map.addImage(id, g.getImageData(0, 0, size * px, size * px), { pixelRatio: px });
  }

  _bindEvents() {
    const m = this.map;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 });
    m.on("mouseenter", "vehicles", (e) => {
      m.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`<div class="pop"><b>${esc(p.title)}</b>${esc(p.detail)}</div>`).addTo(m);
    });
    m.on("mouseleave", "vehicles", () => {
      m.getCanvas().style.cursor = "";
      popup.remove();
    });
    m.on("mouseenter", "stops", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "stops", () => (m.getCanvas().style.cursor = ""));
    m.on("click", (e) => {
      const hits = m.queryRenderedFeatures(e.point, { layers: ["vehicles", "stops"].filter((l) => m.getLayer(l)) });
      const v = hits.find((f) => f.layer.id === "vehicles");
      if (v) return this.onVehicle(v.properties.id);
      const s = hits.find((f) => f.layer.id === "stops");
      if (s) this.onStop(s.properties.id);
    });
  }

  _set(name, data) {
    this.data[name] = data;
    this.map.getSource(name)?.setData(data);
  }

  setStops(stops) {
    this._set("stops", {
      type: "FeatureCollection",
      features: stops.map((s) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { id: s.id, name: s.name },
      })),
    });
  }

  setShapes(lines) {
    this._set("shapes", {
      type: "FeatureCollection",
      features: lines.map(({ coords, color }) => ({
        type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { color },
      })),
    });
  }

  setFocus(points) {
    this._set("focus", {
      type: "FeatureCollection",
      features: points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} })),
    });
  }

  /** Update vehicles, gliding existing ones to their new position. */
  setVehicles(vehicles) {
    const target = new Map(vehicles.map((v) => [v.id, [v.lon, v.lat]]));
    const from = new Map();
    for (const [id, to] of target) from.set(id, this._shown.get(id) ?? to);
    const props = new Map(vehicles.map((v) => [v.id, {
      id: v.id, label: v.label, tc: v.kind === "scheduled" ? "#14171c" : v.text,
      icon: `veh:${v.color}:${v.kind}:${v.bearing == null ? 0 : 1}`, bearing: v.bearing,
      title: v.title, detail: v.detail, sort: v.kind === "gps" ? 2 : v.kind === "estimated" ? 1 : 0,
    }]));
    const draw = (t) => {
      const features = [];
      for (const [id, to] of target) {
        const f = from.get(id);
        const pos = [f[0] + (to[0] - f[0]) * t, f[1] + (to[1] - f[1]) * t];
        this._shown.set(id, pos);
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: pos }, properties: props.get(id) });
      }
      this._set("vehicles", { type: "FeatureCollection", features });
    };
    for (const id of [...this._shown.keys()]) if (!target.has(id)) this._shown.delete(id);
    cancelAnimationFrame(this._anim);
    if (reducedMotion.matches || document.hidden) return draw(1);
    const start = performance.now(), duration = 1200;
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      draw(1 - (1 - t) * (1 - t));
      if (t < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  fitTo(coords, maxZoom = 15) {
    if (!coords.length) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) b.extend(c);
    this.map.fitBounds(b, { padding: this._padding(), maxZoom, duration: reducedMotion.matches ? 0 : 600 });
  }

  flyTo(lon, lat, zoom = 15.5) {
    this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), zoom), padding: this._padding(),
                      duration: reducedMotion.matches ? 0 : 600 });
  }

  _padding() {
    // On phones the bottom sheet covers the lower part of the map.
    const sheet = matchMedia("(max-width: 767px)").matches ? document.getElementById("panel").offsetHeight : 0;
    return { top: 40, left: 30, right: 30, bottom: sheet + 30 };
  }
}

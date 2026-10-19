export const TZ = "Europe/Amsterdam";

const isoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const wdFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });

export const nowSec = () => Date.now() / 1000;

/** Calendar date in Amsterdam, "YYYY-MM-DD". */
export const amsDate = (sec = nowSec()) => isoFmt.format(sec * 1000);

/** The operating day passengers call "today": it runs until about 4am. */
export const serviceToday = (sec = nowSec()) => amsDate(sec - 4 * 3600);

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const compact = (iso) => iso.replaceAll("-", "");
export const hm = (sec) => hmFmt.format(sec * 1000);

export function dayName(iso, today) {
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  if (iso === addDays(today, -1)) return "Yesterday";
  return dayFmt.format(new Date(iso + "T12:00:00Z"));
}

export function shortDay(iso, today) {
  if (iso === today) return "Today";
  const d = new Date(iso + "T12:00:00Z");
  return `${wdFmt.format(d)} ${d.getUTCDate()}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Delay in whole minutes, e.g. "+3", "−1", or "on time". */
export function delayText(sec) {
  if (sec == null) return "";
  const m = Math.round(sec / 60);
  if (m === 0) return "on time";
  return m > 0 ? `+${m}` : `−${-m}`;
}

export function delayClass(sec) {
  if (sec == null) return "muted";
  const m = Math.round(sec / 60);
  return m >= 3 ? "bad" : m <= -1 ? "warn" : "ok";
}

export function minutesUntil(sec, now = nowSec()) {
  const m = Math.floor((sec - now) / 60);
  if (m <= 0) return "now";
  if (m < 60) return `${m} min`;
  return "";
}

export function ago(sec, now = nowSec()) {
  const s = Math.max(0, Math.round(now - sec));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

const R = 6371000;
const RAD = Math.PI / 180;

export function distM(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) * RAD) / 2);
  const y = (lat2 - lat1) * RAD;
  return R * Math.hypot(x, y);
}

export function bearing(lat1, lon1, lat2, lon2) {
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Google encoded polyline (precision 5) -> {lat: [], lon: []}. */
export function decodePolyline(str) {
  const lat = [], lon = [];
  let i = 0, la = 0, lo = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const v = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) la += v; else lo += v;
    }
    lat.push(la / 1e5);
    lon.push(lo / 1e5);
  }
  return { lat, lon };
}

export function badge(line, cls = "") {
  return `<span class="badge ${cls}" style="--c:${esc(line.color)};--tc:${esc(line.text)}">${esc(line.short)}</span>`;
}

export function translateLink(text) {
  return `https://translate.google.com/?sl=nl&tl=en&op=translate&text=${encodeURIComponent(text)}`;
}

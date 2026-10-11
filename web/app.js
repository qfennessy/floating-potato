// Replays precomputed runs (web/data/world<N>.json, made by sim/export_web.py) and flies YOUR
// balloon live in the same world: you set the altitude, the same physics as sim/venus.py moves it.
// No live model calls, so the demo can't crash on stage.

const RUNS = ["best", "vega", "rules", "flash", "agent", "hybrid", "you"];   // draw order: you on top
const COLOR = { agent: "#ffb347", flash: "#34d399", rules: "#a78bfa", hybrid: "#facc15", vega: "#c9c9c9", best: "#7cc4ff", you: "#f472b6" };
const AI = ["agent", "flash", "hybrid"];   // agent = Gemini Robotics-ER 2, flash = Gemini 3.8 Flash, hybrid = rulebook + ER 2
const runsIn = () => RUNS.filter((r) => state.world.runs[r]);
const ais = () => AI.filter((r) => state.world.runs[r]);
const KIND = { rumble: "eruption", so2: "gas plume", lightning: "lightning", major: "major eruption" };

const $ = (id) => document.getElementById(id);
const mapC = $("map"), stripC = $("strip");
const state = { world: null, T: 0, maxT: 0, playing: true, speed: 2, last: 0, logCount: -1, index: null, aim: 56, big: new Set(),
                sel: "hybrid", director: true, heroDone: new Set(), hero: null, frameN: 0 };
const basemap = new Image();
basemap.src = "data/venus_0_360.jpg";

// ---------- helpers ----------
function fit(c) {
  const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  if (c.width !== Math.round(r.width * d) || c.height !== Math.round(r.height * d)) {
    c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return [ctx, r.width, r.height];
}
const xy = (lat, lon, W, H) => [((lon % 360) + 360) % 360 / 360 * W, (90 - lat) / 180 * H];
const hoursToDay = (h) => (h / 24).toFixed(1);
const totalH = () => state.world.days * 24;          // AI flights and scoring end here (day 30)
const endH = () => (state.world.days + 1) * 24;        // the clock stops a day later (day 31)
// Replayed flights end when their precomputed data does (day 30); yours never ends.
const idx = (T) => Math.min(Math.floor(T / state.world.step_h), state.world.runs.agent.track.length - 1);
const idxYou = (T) => Math.floor(T / state.world.step_h);
const runIdx = (r, i) => (r === "you" ? state.world.runs.you.track.length - 1 : i);

function valueOf(target) {
  const ev = state.world.events.find((e) => e.id === target);
  return ev ? ev.value : 1;
}
function pointsBy(run, T) {
  return state.world.runs[run].log.filter((l) => (l.kind === "reached" || l.kind === "you") && l.t_h <= T)
    .reduce((s, l) => s + (l.pts ?? valueOf(l.target)), 0);
}
function reachedBy(run, T) {
  return state.world.runs[run].log.filter((l) => (l.kind === "reached" || l.kind === "you") && l.t_h <= T).map((l) => l.target);
}
function heardBy(T) {
  return new Set(ais().flatMap((r) => state.world.runs[r].log).filter((l) => l.kind === "detect" && l.t_h <= T).map((l) => l.event));
}
const gotBy = (runs, T) => new Set(runs.filter((r) => state.world.runs[r]).flatMap((r) => reachedBy(r, T)));

// After the precomputed days, new events are made up here as the clock runs (same kinds and
// rates as sim/events.py, a different random stream), so a long flight always has something to chase.
const EV = { rumble: { value: 2, life: 72, p: 0.4, text: "low rumble, maybe an eruption" },
             so2: { value: 3, life: 48, p: 0.35, text: "sulfur dioxide spike, a fresh plume" },
             lightning: { value: 1, life: 12, p: 0.25, text: "radio crackle, possible lightning" } };
function rng32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function extendEvents(T) {
  const w = state.world, g = state.gen;
  const names = Object.keys(w.volcanoes || {});          // older data files have no volcano list
  while (g.t < T + 72) {
    const r = g.rand();
    const kind = !names.length ? "lightning" : r < EV.rumble.p ? "rumble" : r < EV.rumble.p + EV.so2.p ? "so2" : "lightning";
    let lat, lon, site = "";
    if (kind === "lightning") { lat = -35 + 70 * g.rand(); lon = 360 * g.rand(); }
    else { site = names[Math.floor(g.rand() * names.length)]; [lat, lon] = w.volcanoes[site]; }
    g.n += 1;
    w.events.push({ id: `L${g.n}`, kind, t_h: g.t, lat, lon, site, value: EV[kind].value, ends_h: g.t + EV[kind].life,
                    sensor: "", text: EV[kind].text });
    g.t += -Math.log(1 - g.rand()) * 10;
  }
}

// ---------- live physics: a port of sim/venus.py (keep the two in step) ----------
const R_KM = 6051.8, KM_PER_DEG = Math.PI * R_KM / 180, STEP_S = 900, ALT_RATE = 0.5;
const CORRIDOR = [50, 62], SOLAR_DAY_H = 116.75 * 24, CAPTURE_KM = 350;
const rad = (d) => d * Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mod = (x, m) => ((x % m) + m) % m;

// Each world has its own real weather (world.weather); the forecast is the same everywhere.
function wind(lat, alt, lt, wx = state.world.weather) {
  const s = (alt - CORRIDOR[0]) / (CORRIDOR[1] - CORRIDOR[0]);
  const d = clamp((alt - wx.flip_km) / 6, -1.25, 1.25);
  const t = lt + wx.tide_phase;
  const u = -(60 + 40 * s) * wx.zonal * Math.cos(rad(lat)) + 4 * Math.cos(2 * Math.PI * t / 24);
  const v = wx.hadley * d * Math.sin(2 * rad(lat)) + 2 * Math.sin(2 * Math.PI * t / 24) * d;
  return [u, v];
}
const localTime = (lon, hours) => mod(12 + (lon - mod(-360 * hours / SOLAR_DAY_H, 360)) / 15, 24);
window.wind = wind; window.localTime = localTime;      // the globe's wind particles use the same physics
function gcKm(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(clamp(a, 0, 1)));
}
// One 15-minute step from [lat, lon, alt] at `hours`, climbing or sinking toward `aim`.
function advance([lat, lon, alt], hours, aim) {
  const action = Math.sign(Math.round((aim - alt) * 1000) / 1000);
  alt = clamp(alt + action * ALT_RATE, ...CORRIDOR);
  const [u, v] = wind(lat, alt, localTime(lon, hours));
  const dlat = v * STEP_S / 1000 / KM_PER_DEG;
  const dlon = u * STEP_S / 1000 / (KM_PER_DEG * Math.max(Math.cos(rad(lat)), 0.05));
  return [clamp(lat + dlat, -85, 85), mod(lon + dlon, 360), alt];
}

// Mission control rules (port of sim/missionctl.py points_for / bonus_targets).
const msgs = () => state.world.messages || [];
// Priority and alert requests are personal: picked 10-12 degrees of latitude from YOU when they
// arrive (as in sim/missionctl.py): reachable if you act on them, too far to pass by luck.
const NEAR_LAT = 10, FAR_LAT = 12;
const bonusLive = (h) => (state.world.runs.you?.msgs || []).filter((m) => m.type === "priority" && m.t_h <= h && h < m.until_h);
function personalize(m, lat, got) {
  const rand = rng32(state.world.seed * 31 + Number(m.id.slice(1)));
  // Same hemisphere and within 55 degrees of the equator, as in sim/missionctl.py.
  const okLat = (la) => Math.abs(la) <= 55 && (lat >= 0 ? la >= 2 : la <= -2);
  const cands = (pts, skip) => { const c = Object.keys(pts).filter((k) => !skip.has(k) && okLat(pts[k][0]));
                                 return c.length ? c : Object.keys(pts).filter((k) => !skip.has(k)); };
  const near = (pts, skip) => cands(pts, skip).filter((k) => Math.abs(pts[k][0] - lat) >= NEAR_LAT
                                                        && Math.abs(pts[k][0] - lat) <= FAR_LAT).sort();
  const off = (pts, k) => Math.abs(Math.abs(pts[k][0] - lat) - (NEAR_LAT + FAR_LAT) / 2);
  const nearest = (pts, skip = new Set()) => cands(pts, skip).sort((a, b) => off(pts, a) - off(pts, b))[0];
  if (m.type === "priority") {
    const pool = near(state.world.targets, got), site = pool.length ? pool[Math.floor(rand() * pool.length)] : nearest(state.world.targets, got);
    const [la, lo] = state.world.targets[site];
    return { ...m, site, lat: la, lon: lo, text: `Priority request: pass over ${site} before day ${Math.round(m.until_h / 24)} for a 10-point bonus.` };
  }
  const pool = near(state.world.volcanoes, new Set()), v = pool.length ? pool[Math.floor(rand() * pool.length)] : nearest(state.world.volcanoes);
  return { ...m, site: v, text: `Seismic alert: ${v} is likely to erupt around day ${Math.round(m.erupt_h / 24)}. A major eruption is worth 5 points.` };
}
function pointsFor(target, h, lat) {
  let base;
  if (target.startsWith("BONUS:")) base = 10;
  else {
    const ev = state.world.events.find((e) => e.id === target);
    base = ev ? ev.value : 1;
    if (ev && ev.kind === "so2" && msgs().some((m) => m.type === "plumes" && m.t_h <= h && h < m.until_h)) base *= 3;
  }
  for (const m of msgs())
    if (m.type === "outage" && m.t_h <= h && h < m.until_h && (lat < 0) === (m.hemi === "south")) return 0;
  return base;
}

// Your flight is stored like a replayed run (track + log), grown or rewound to match the clock.
function newYou() {
  const [lat, lon] = state.world.start;
  return { label: "You", track: [[lat, lon, 56]], log: [], aims: [], msgs: [] };
}
function syncYou() {
  const you = state.world.runs.you, want = idxYou(state.T);
  extendEvents(want * state.world.step_h);
  if (you.track.length - 1 > want) {                           // scrubbed back: rewind
    you.track.length = want + 1;
    you.aims.length = want;
    you.log = you.log.filter((l) => l.t_h <= want * state.world.step_h);
    you.msgs = you.msgs.filter((m) => m.t_h <= want * state.world.step_h);
  }
  while (you.track.length - 1 < want) {
    const k = you.track.length - 1, hours = k * state.world.step_h;
    for (const m of msgs())                                    // your personal requests arrive
      if ((m.type === "priority" || m.type === "tip") && m.t_h <= hours && !you.msgs.some((x) => x.id === m.id)) {
        const pm = personalize(m, you.track[k][0], new Set(you.log.map((l) => l.target)));
        you.msgs.push(pm);
        you.log.push({ t_h: m.t_h, kind: "message", text: pm.text });
        if (pm.type === "tip") {                                  // your alert's eruption (reused after a rewind)
          const [la, lo] = state.world.volcanoes[pm.site];
          const ev = { id: "YOU_TIP", kind: "major", t_h: pm.erupt_h, lat: la, lon: lo, site: pm.site,
                       value: 5, ends_h: pm.erupt_h + 120, sensor: "", text: "major eruption" };
          const old = state.world.events.find((e) => e.id === "YOU_TIP");
          old ? Object.assign(old, ev) : state.world.events.push(ev);
        }
      }
    // "TIP" is ER 2's personal alert eruption (in the shared event list for display); yours is YOU_TIP.
    const active = state.world.events.filter((e) => e.id !== "TIP" && e.t_h <= hours && hours < e.ends_h);
    const next = advance(you.track[k], hours, state.aim);
    you.track.push(next);
    you.aims.push(state.aim);
    const got = new Set(you.log.map((l) => l.target));
    const cands = [...Object.entries(state.world.targets).map(([n, [la, lo]]) => [n, la, lo, n]),
                   ...active.map((e) => [e.id, e.lat, e.lon, `${KIND[e.kind]}${e.site ? " near " + e.site : ""}`]),
                   ...bonusLive(hours).map((m) => [`BONUS:${m.site}`, m.lat, m.lon, `the priority site ${m.site} (bonus)`])];
    const h1 = hours + state.world.step_h;
    for (const [id, la, lo, name] of cands)
      if (!got.has(id) && gcKm(next[0], next[1], la, lo) <= CAPTURE_KM)
        you.log.push({ t_h: h1, kind: "you", target: id, text: `You reached ${name}`, pts: pointsFor(id, h1, next[0]) });
  }
}
function setAim(a) {
  state.aim = clamp(Math.round(a * 2) / 2, ...CORRIDOR);
  $("aim").value = state.aim;
  drawPilot();
}
function drawPilot() {
  const you = state.world?.runs.you;
  if (!you) return;
  const [lat, lon, alt] = you.track[you.track.length - 1];
  const [u, v] = wind(lat, alt, localTime(lon, state.T));
  const ns = Math.abs(v) < 0.5 ? "no north-south drift" : `drifting ${v > 0 ? "north" : "south"} ${Math.abs(v).toFixed(1)} m/s`;
  $("aimval").textContent = `${state.aim.toFixed(1)} km`;
  $("pilotread").textContent = `Now ${alt.toFixed(1)} km at ${lat.toFixed(1)}°, ${lon.toFixed(0)}°E · west ${(-u).toFixed(0)} m/s · ${ns}`;
}

// ---------- map ----------
function drawMap() {
  const [ctx, W, H] = fit(mapC);
  const T = state.T, i0 = idx(T), w = state.world;
  ctx.clearRect(0, 0, W, H);
  if (basemap.complete && basemap.naturalWidth) {
    ctx.filter = "sepia(0.9) saturate(1.6) brightness(0.75)";
    ctx.drawImage(basemap, 0, 0, W, H);
    ctx.filter = "none";
  }
  ctx.fillStyle = "rgba(20,17,15,0.25)";
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  for (let lon = 60; lon < 360; lon += 60) { const [x] = xy(0, lon, W, H); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let lat = -60; lat <= 60; lat += 30) { const [, y] = xy(lat, 0, W, H); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = "rgba(236,228,216,0.55)"; ctx.font = "11px Inter, sans-serif";
  ctx.fillText("← winds carry every balloon west", 10, H - 10);

  const capPx = (w.capture_km / 105.6) / 180 * H;
  const heard = heardBy(T);
  const agentGot = gotBy([...AI, "you"], T);
  const anyGot = gotBy(["vega", "best"], T);

  // events
  for (const e of w.events) {
    if (T < e.t_h || T >= e.ends_h) continue;
    const [x, y] = xy(e.lat, e.lon, W, H);
    const age = (T - e.t_h) / (e.ends_h - e.t_h);
    const pulse = 1 + 0.25 * Math.sin(T * 3 + e.t_h);
    ctx.globalAlpha = 1 - 0.6 * age;
    ctx.lineWidth = 2;
    ctx.strokeStyle = agentGot.has(e.id) ? "#4ade80" : heard.has(e.id) ? "#fde047" : "#f87171";
    ctx.beginPath(); ctx.arc(x, y, capPx * pulse, 0, 7); ctx.stroke();
    if (heard.has(e.id) || agentGot.has(e.id)) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "600 11px Inter, sans-serif";
      ctx.fillText(`${KIND[e.kind]}${e.site ? " · " + e.site : ""} (+${e.value})`, x + capPx + 4, y + 4);
    }
    ctx.globalAlpha = 1;
  }

  // fixed targets
  for (const [name, [lat, lon]] of Object.entries(w.targets)) {
    const [x, y] = xy(lat, lon, W, H);
    star(ctx, x, y, 7, agentGot.has(name) ? "#4ade80" : anyGot.has(name) ? "#7cc4ff" : "#f2e6d0");
    if (state.big.has(name) || agentGot.has(name) || anyGot.has(name)) {
      ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "11px Inter, sans-serif";
      ctx.fillText(name, x + 9, y + 4);
    }
  }

  // tracks
  for (const r of runsIn()) {
    const tr = w.runs[r].track, i = runIdx(r, i0);
    ctx.strokeStyle = COLOR[r]; ctx.lineWidth = r === "agent" || r === "you" ? 2.4 : 1.6;
    ctx.globalAlpha = r === "agent" || r === "you" ? 1 : 0.8;
    ctx.beginPath();
    for (let k = 0; k <= i; k++) {
      const [x, y] = xy(tr[k][0], tr[k][1], W, H);
      if (k === 0 || Math.abs(tr[k][1] - tr[k - 1][1]) > 180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
    if (r === "you") {                                   // glowing tail: last 6 simulated hours
      ctx.save();
      ctx.shadowColor = COLOR.you; ctx.shadowBlur = 12; ctx.lineCap = "round";
      for (let k = Math.max(1, i - 23); k <= i; k++) {
        if (Math.abs(tr[k][1] - tr[k - 1][1]) > 180) continue;
        const f = (k - (i - 24)) / 24;
        ctx.globalAlpha = f; ctx.lineWidth = 2 + 4 * f; ctx.strokeStyle = COLOR.you;
        const [x0, y0] = xy(tr[k - 1][0], tr[k - 1][1], W, H), [x1, y1] = xy(tr[k][0], tr[k][1], W, H);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
    }
    const [bx, by] = xy(tr[i][0], tr[i][1], W, H);
    ctx.fillStyle = COLOR[r]; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(bx, by, r === "agent" || r === "you" ? 6 : 4.5, 0, 7); ctx.fill(); ctx.stroke();
  }
}

function star(ctx, x, y, r, fill) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
}

// ---------- altitude strip ----------
function drawStrip() {
  const [ctx, W, H] = fit(stripC);
  const w = state.world, i0 = idx(state.T), pad = 28, span = endH();
  const [lo, hi] = [48, 64];
  const runs = runsIn(), ROW = 10, rowsTop = H - 16 - runs.length * ROW;   // scoring rows under the plot
  const X = (h) => pad + (h / span) * (W - pad - 8);
  const Y = (a) => 8 + (hi - a) / (hi - lo) * (rowsTop - 14);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(74,222,128,0.12)";
  ctx.fillRect(X(0), Y(w.corridor_km[1]), X(span) - X(0), Y(w.corridor_km[0]) - Y(w.corridor_km[1]));
  ctx.fillStyle = "#a89c8c"; ctx.font = "10px JetBrains Mono, monospace";
  for (const a of [50, 56, 62]) ctx.fillText(a, 4, Y(a) + 3);
  ctx.fillStyle = "#a89c8c";
  for (let d = 0; d <= span / 24; d += 5) ctx.fillText(`d${d}`, X(d * 24) - 6, H - 3);
  const SHORT = { you: "you", agent: "ER", flash: "Fl", rules: "RB", hybrid: "Hy", vega: "54", best: "fix" };
  runs.forEach((r, j) => {                                  // one row per balloon: a tick each time it scored
    const y0 = rowsTop + j * ROW;
    ctx.fillStyle = "rgba(255,255,255,0.04)"; ctx.fillRect(X(0), y0, X(span) - X(0), ROW - 2);
    ctx.fillStyle = COLOR[r]; ctx.font = "9px JetBrains Mono, monospace"; ctx.fillText(SHORT[r] || r, 2, y0 + 7);
    for (const l of w.runs[r].log) {
      if ((l.kind !== "reached" && l.kind !== "you") || l.t_h > state.T) continue;
      const pts = l.pts ?? valueOf(l.target), x = X(l.t_h), fresh = state.T - l.t_h < 8;
      ctx.globalAlpha = pts > 0 ? 1 : 0.35;
      ctx.fillRect(x - (fresh ? 1.5 : 1), y0 + (ROW - 2) * (1 - Math.min(1, 0.35 + pts / 6)), fresh ? 3 : 2,
                   (ROW - 2) * Math.min(1, 0.35 + pts / 6));
      ctx.globalAlpha = 1;
    }
  });
  ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,0.35)";   // scoring finish line
  ctx.beginPath(); ctx.moveTo(X(totalH()), 4); ctx.lineTo(X(totalH()), H - 16); ctx.stroke(); ctx.restore();
  ctx.fillText("finish", X(totalH()) + 3, 12);
  for (const r of runsIn()) {
    const tr = w.runs[r].track, i = runIdx(r, i0);
    ctx.strokeStyle = COLOR[r]; ctx.lineWidth = r === "agent" || r === "you" ? 2 : 1.3;
    ctx.beginPath();
    for (let k = 0; k <= i; k++) {
      const x = X(k * w.step_h), y = Y(tr[k][2]);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  // Points: a dot on each balloon's altitude line where it scored, bigger for more points;
  // a fresh catch (last 8 simulated hours) pulses. Zero-point catches (relay outage) are hollow.
  for (const r of runsIn()) {
    const tr = w.runs[r].track;
    for (const l of w.runs[r].log) {
      if ((l.kind !== "reached" && l.kind !== "you") || l.t_h > state.T) continue;
      const k = Math.min(Math.round(l.t_h / w.step_h), tr.length - 1), pts = l.pts ?? valueOf(l.target);
      const x = X(l.t_h), y = Y(tr[k][2]), rad = 2.5 + Math.min(pts, 10) * 0.7;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 7);
      if (pts > 0) { ctx.fillStyle = COLOR[r]; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke(); }
      else { ctx.strokeStyle = COLOR[r]; ctx.lineWidth = 1; ctx.stroke(); }
      const age = state.T - l.t_h;
      if (age < 8 && pts > 0) {
        const f = age / 8;
        ctx.beginPath(); ctx.arc(x, y, rad + 3 + 10 * f, 0, 7);
        ctx.strokeStyle = COLOR[r]; ctx.globalAlpha = 1 - f; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
        if (pts >= 2) { ctx.fillStyle = COLOR[r]; ctx.font = "600 10px Inter, sans-serif"; ctx.fillText(`+${pts}`, x + rad + 3, y - rad - 2); }
      }
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.beginPath();
  ctx.moveTo(X(state.T), 4); ctx.lineTo(X(state.T), H - 16); ctx.stroke();
}

// ---------- side panels ----------
function drawScore() {
  const cards = [["you", "You"], ["hybrid", "Rules + Gemini"], ["agent", "ER 2"], ["flash", "Flash"], ["rules", "Rulebook"],
                 ["vega", "Vega 54 km"], ["best", "Fixed"]].filter(([r]) => state.world.runs[r]);
  const html = cards.map(([r, name]) => {
    // Everyone is scored to the same finish line: the end of the AI flights (day 30). You can keep
    // flying after that, but those points are shown separately and don't count in the race.
    const pts = pointsBy(r, Math.min(state.T, totalH()));
    const extra = r === "you" && state.T > totalH() ? pointsBy("you", state.T) - pts : 0;
    const note = r === "you" && state.T > totalH() ? `<em>final at day ${state.world.days}${extra ? ` · +${extra} after, not counted` : ""}</em>` : "";
    return `<div class="card ${r}${r === state.sel ? " sel" : ""}" data-run="${r}" title=""><b>${pts}</b><span>${name}</span>${note}</div>`;
  }).join("");
  if (html === state.scoreHtml) return;                 // only touch the DOM when a score changes
  state.scoreHtml = html;
  $("score").innerHTML = html;
  wireHow($("score"));
  $("score").querySelectorAll("[data-run]").forEach((el) => el.onclick = (e) => { e.stopPropagation(); hideHow(); select(el.dataset.run); });
}

function drawLog() {
  const T = state.T, w = state.world;
  const entries = [...ais().flatMap((r) => w.runs[r].log.filter((l) => l.kind !== "message" || l.site).map((l) => ({ ...l, run: r }))),
                   ...w.runs.you.log.map((l) => ({ ...l, run: "you" })),
                   ...msgs().filter((m) => m.text).map((m) => ({ t_h: m.t_h, kind: "message", text: m.text, run: "mc" }))]
    .filter((l) => l.t_h <= T).sort((a, b) => a.t_h - b.t_h);
  if (entries.length === state.logCount) return;
  state.logCount = entries.length;
  const label = { strategy: "strategy", detect: "heard", decision: "decided", reached: "reached", missed: "missed", you: "you",
                  message: "mission control", arrived: "arrived" };
  const who = { agent: "ER 2", flash: "Flash", hybrid: "Hybrid", you: "", mc: "" };
  $("log").innerHTML = entries.slice().reverse().map((l) =>
    `<li class="${l.kind}"><span class="t">day ${hoursToDay(l.t_h)}</span><span class="who" style="color:${COLOR[l.run]}">${who[l.run]}</span><span class="k">${label[l.kind] || l.kind}</span><br>${escapeHtml(l.text)}${l.kind === "reached" || l.kind === "you" ? ` <b>+${l.pts ?? valueOf(l.target)}</b>` : ""}</li>`
  ).join("") || `<li class="t">Listening…</li>`;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function drawTable() {
  const rows = state.index.worlds;
  const tot = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  $("table").innerHTML =
    `<tr><th>World</th><th>Rulebook + Gemini</th><th>Gemini ER 2</th><th>Gemini 3.8 Flash</th><th>Rulebook</th><th>Drifter 54 km</th><th>Average fixed altitude</th><th>Best single fixed altitude</th></tr>` +
    rows.map((r) => `<tr class="${r.seed === state.world.seed ? "current" : ""}" data-seed="${r.seed}" style="cursor:pointer">
      <td>World ${r.seed}</td><td class="${(r.hybrid ?? 0) > (r.rules ?? 0) ? "win" : ""}">${r.hybrid ?? "–"}</td><td class="${r.agent > r.best ? "win" : ""}">${r.agent}</td><td class="${(r.flash ?? 0) > r.best ? "win" : ""}">${r.flash ?? "–"}</td><td>${r.rules ?? "–"}</td>
      <td>${r.vega}</td><td>${r.avg}</td><td>${r.best} <span class="note">(${r.best_alt} km)</span></td></tr>`).join("") +
    `<tr><td><b>Total</b></td><td><b>${tot("hybrid")}</b></td><td><b>${tot("agent")}</b></td><td><b>${tot("flash")}</b></td><td><b>${tot("rules")}</b></td><td><b>${tot("vega")}</b></td><td><b>${Math.round(tot("avg") * 10) / 10}</b></td><td><b>${tot("best")}</b></td></tr>`;
  $("table").querySelectorAll("tr[data-seed]").forEach((tr) => tr.onclick = () => load(+tr.dataset.seed));
}

// ---------- sound: small volcano effects, made in the browser (no audio files) ----------
// Browsers only allow sound after a click or key press, so audio starts on your first interaction.
const audio = { ctx: null, on: true, lastT: 0, lastPlay: 0 };
function audioCtx() {
  if (!audio.ctx) { try { audio.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio.on = false; } }
  if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume();
  return audio.ctx;
}
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => audio.on && audioCtx(), { once: true }));
function noise(ctx, secs) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * secs), ctx.sampleRate), d = buf.getChannelData(0);
  for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf; return src;
}
function playVolcano(kind) {
  const ctx = audio.ctx;
  if (!audio.on || !ctx || ctx.state !== "running") return;
  const now = ctx.currentTime, big = kind === "major", hiss = kind === "so2";
  const secs = big ? 2.2 : hiss ? 0.7 : 1.1;
  const src = noise(ctx, secs), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
  filt.type = hiss ? "bandpass" : "lowpass";
  filt.frequency.value = hiss ? 3200 : big ? 90 : 140;
  filt.Q.value = hiss ? 1.2 : 0.8;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(big ? 0.9 : hiss ? 0.08 : 0.45, now + (hiss ? 0.05 : 0.12));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + secs);
  src.connect(filt).connect(gain).connect(ctx.destination);
  if (!hiss) {                                   // a low thump under the rumble
    const o = ctx.createOscillator(), g2 = ctx.createGain();
    o.frequency.setValueAtTime(big ? 55 : 70, now); o.frequency.exponentialRampToValueAtTime(30, now + secs * 0.8);
    g2.gain.setValueAtTime(big ? 0.5 : 0.25, now); g2.gain.exponentialRampToValueAtTime(0.0001, now + secs * 0.8);
    o.connect(g2).connect(ctx.destination); o.start(now); o.stop(now + secs);
  }
  src.start(now); src.stop(now + secs);
}
function sounds(dt) {
  const T = state.T, prev = audio.lastT;
  audio.lastT = T;
  if (!state.playing || T <= prev || T - prev > 24) return;      // no sound when scrubbing or jumping
  const started = state.world.events.filter((e) => e.kind !== "lightning" && e.t_h > prev && e.t_h <= T);
  const nowMs = performance.now();
  for (const e of started.slice(0, 1)) {
    if (nowMs - audio.lastPlay < 350) break;                      // never a pile-up of sounds
    audio.lastPlay = nowMs;
    playVolcano(e.kind);
  }
}

// ---------- hover windows: how each balloon decides ----------
const MODEL_HOW = (name, id) => `
  <h4>${name}</h4>
  <p class="mono">${id}, thinking level medium</p>
  <p><b>When it decides:</b> every 2 days, and right away when mission control sends a message. Between
  decisions a shared search planner flies the altitude.</p>
  <p><b>What it sees:</b> a map image (volcanoes, visited and unvisited sites, lanes, its own track,
  mission control circles), its position and time left, the last 12 sensor reports, and every mission
  control message. It is <i>not</i> told how many unvisited sites each lane has; it has to read the map.</p>
  <p><b>Prompt, shortened:</b></p>
  <blockquote>You are the strategist for a research balloon in the clouds of Venus… Winds carry the balloon
  west… low is slower and drifts toward the equator; high is faster and drifts toward the poles…
  Holding a lane means cruising with no north-south drift, passing everything in it once a lap…
  Sites score only once, so judge from the map how many unvisited sites each lane still has.
  Roaming lets the planner chase the nearest unvisited sites… You can also name one place to head for.
  Call choose_lane once, with a one-sentence reason.</blockquote>
  <p><b>Tools:</b> <span class="mono">choose_lane(lane | roam, head_for, reason)</span>; when its sensors hear
  an event, <span class="mono">chase_event(reason)</span> or <span class="mono">stay_course(reason)</span>.</p>`;
const HOW = {
  you: () => `<h4>You</h4>
    <p>You set the target altitude (slider, buttons or ↑ ↓). The balloon climbs or sinks 0.5 km per
    15 minutes toward it, and the same winds as everyone else carry it.</p>
    <p><b>Your advantages:</b> you see every eruption on the globe, not just the ones your sensors hear;
    you can change altitude any time; you can rewind. Your score is frozen at day ${state.world.days}, the
    same finish line as the AI flights.</p>`,
  agent: () => MODEL_HOW("Gemini Robotics-ER 2", "gemini-robotics-er-2-preview"),
  flash: () => MODEL_HOW("Gemini 3.8 Flash", "gemini-3.8-flash"),
  hybrid: () => `<h4>Rulebook + Gemini ER 2</h4>
    <p>The rulebook flies by default: lanes, roaming, and which events to chase. Gemini Robotics-ER 2
    is consulted only when something comes up that rules can't read:</p>
    <ul><li>a new mission control message,</li><li>a priority request or volcano alert still open,</li>
    <li>a burst of eruptions (2+ heard from one volcano in 3 days).</li></ul>
    <p>Then it sees the same map and prompt as the other models, plus the autopilot's plan, and can keep
    it, keep it and head for a place, or override it. Log lines show "Autopilot" or "Gemini (why)".</p>`,
  rules: () => `<h4>Rulebook</h4>
    <p>Plain code, no model. Same planner, same check-ins.</p>
    <ol><li>Score each lane: 1 point per unvisited site within reach plus 0.3 per volcano, scaled by the
    share of the mission left after travelling there.</li>
    <li>If the best lane has fewer than 3 unvisited sites, roam.</li>
    <li>Otherwise hold the current lane unless another scores 1.3× better.</li>
    <li>Chase a heard event if the planner can reach it in time and it is worth 2+ points or under
    12 hours away.</li></ol>
    <p><b>Ignores:</b> mission control messages, and which volcanoes have been erupting lately.</p>`,
  vega: () => `<h4>Drifter at 54 km</h4>
    <p>Climbs to 54 km and stays there for the whole flight, like the Soviet-French Vega balloons in 1985.
    No decisions at all; it scores whatever the wind carries it past.</p>`,
  best: () => `<h4>Best single fixed altitude</h4>
    <p>A balloon parked at ${state.world.runs.best.fixed_alt} km for the whole flight. Of the 8 fixed
    altitudes tried, this one scored best across all 20 worlds, so it is the strongest balloon that never
    makes a decision. The fair rival: one altitude, picked before launch.</p>`,
};
function showHow(run, anchor) {
  const tip = $("howtip");
  if (!HOW[run] || !state.world.runs[run]) return;
  tip.innerHTML = HOW[run]();
  tip.style.borderColor = COLOR[run];
  tip.hidden = false;
  const r = anchor.getBoundingClientRect(), w = Math.min(380, innerWidth - 32);
  tip.style.width = `${w}px`;
  tip.style.left = `${Math.max(16, Math.min(r.left, innerWidth - w - 16)) + scrollX}px`;
  tip.style.top = `${r.bottom + 8 + scrollY}px`;
}
const hideHow = () => { $("howtip").hidden = true; };
function wireHow(root) {
  root.querySelectorAll("[data-run]").forEach((el) => {
    el.tabIndex = 0;
    el.onmouseenter = el.onfocus = () => showHow(el.dataset.run, el);
    el.onmouseleave = el.onblur = hideHow;
    el.onclick = (e) => { e.stopPropagation(); $("howtip").hidden ? showHow(el.dataset.run, el) : hideHow(); };
  });
}
document.addEventListener("click", hideHow);

// ---------- globe hookup (globe.js is a module and may load after this script) ----------
const globe = () => window.venusGlobe;
function globeLoad() { if (globe() && state.world) { globe().load(state.world); globe().select(state.sel); } }
document.addEventListener("globe-ready", globeLoad);
document.addEventListener("globe-follow", (e) => {
  $("follow").classList.toggle("on", e.detail);
  $("follow").textContent = e.detail ? "Following" : "Follow";
});
function flatShown() { return !document.querySelector(".mapwrap").hidden; }

// ---------- selection, decision line, forecast, director ----------
function select(run) {
  if (!state.world.runs[run]) return;
  state.sel = run; state.scoreHtml = "";
  if (globe()) { globe().select(run); globe().endHero(); }
  state.hero = null;
}
function selIndex() {
  const tr = state.world.runs[state.sel].track;
  return state.sel === "you" ? tr.length - 1 : Math.min(idx(state.T), tr.length - 1);
}
// Wind panel: what each altitude layer is doing right where the selected balloon is.
const PANEL_LAYERS = [66, 64, 62, 59, 56, 53, 50, 47];
function drawWindPanel() {
  const w = state.world, r = state.sel, [lat, lon, alt] = w.runs[r].track[selIndex()];
  const lt = localTime(lon, state.T), rows = [];
  for (const a of PANEL_LAYERS) {
    const [u, v] = wind(lat, a, lt), here = Math.abs(a - alt) < 1.5;
    const safe = a >= 50 && a <= 62, ns = Math.abs(v) < 0.3 ? "·" : v > 0 ? "▲" : "▼";
    rows.push(`<div class="wrow${here ? " here" : ""}${safe ? "" : " risky"}">
      <span class="alt mono">${a} km</span>
      <span class="bar"><i style="width:${Math.min(100, -u / 1.15)}%"></i></span>
      <span class="spd mono">${(-u).toFixed(0)} west</span>
      <span class="ns ${v > 0.3 ? "n" : v < -0.3 ? "s" : ""}">${ns} ${Math.abs(v).toFixed(1)} ${v > 0.3 ? "north" : v < -0.3 ? "south" : ""}</span></div>`);
  }
  const html = `<div class="wtitle">Winds at ${lat.toFixed(0)}°${lat >= 0 ? "N" : "S"} <span class="note">(m/s)</span></div>${rows.join("")}
    <div class="wnote">▲ pushes north, ▼ pushes south. Pick a layer to pick both your speed and your drift.</div>`;
  const el = $("windpanel");
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
function drawDecision() {
  const r = state.sel, w = state.world, el = $("decision");
  const [lat, , alt] = w.runs[r].track[selIndex()];
  let text;
  if (r === "you") text = `<b style="color:${COLOR.you}">You:</b> aiming for ${state.aim.toFixed(1)} km.`;
  else if (r === "vega" || r === "best") text = `<b style="color:${COLOR[r]}">${r === "vega" ? "Vega drifter" : "Fixed balloon"}:</b> parked at ${alt.toFixed(1)} km, going wherever the wind goes.`;
  else {
    const last = w.runs[r].log.filter((l) => l.kind === "strategy" && l.t_h <= state.T).pop();
    const name = { agent: "ER 2", flash: "Flash", rules: "Rulebook", hybrid: "Rules + Gemini" }[r];
    const one = last ? last.text.replace(/^(Autopilot|Gemini \([^)]*\)): /, "").split(/(?<=[.!?])\s/)[0] : "Launching.";
    text = `<b style="color:${COLOR[r]}">${name}:</b> ${escapeHtml(one)}`;
  }
  if (el.dataset.html !== text) { el.innerHTML = text; el.dataset.html = text; }
}
function forecastSel() {
  // Where the selected balloon goes in the next day if it keeps its current altitude (yours: your aim).
  const tr = state.world.runs[state.sel].track, i = selIndex();
  let p = tr[i].slice(0, 3);
  const aim = state.sel === "you" ? state.aim : p[2], pts = [p];
  for (let k = 0; k < 96; k += 1) { p = advance(p, (i + k) * state.world.step_h, aim); if (k % 2) pts.push(p); }
  return pts;
}
function director() {
  // Before the selected AI balloon catches an eruption: pause, frame the shot, then resume slowly.
  const r = state.sel, w = state.world;
  if (!state.director || r === "you" || !globe()) return;
  if (state.hero) {
    const h = state.hero, now = performance.now();
    if (h.phase === "frame" && now - h.start > 1800 && !state.userPaused) { h.phase = "slow"; state.speed = 0.5; setPlaying(true); }
    if (h.phase === "slow" && state.T > h.t + 2.5) { state.speed = h.speed; $("speed").value = String(h.speed); globe().endHero(); state.hero = null; }
    return;
  }
  if (!state.playing) return;
  const next = w.runs[r].log.find((l) => l.kind === "reached" && l.t_h > state.T && l.t_h - state.T < 5
    && !state.heroDone.has(`${r}:${l.target}`) && w.events.some((e) => e.id === l.target && e.kind !== "lightning"));
  if (!next) return;
  state.heroDone.add(`${r}:${next.target}`);
  const ev = w.events.find((e) => e.id === next.target);
  setPlaying(false);
  globe().frameHero([globe().latLonOf(r), globe().eventPos(ev)]);
  state.hero = { t: next.t_h, phase: "frame", start: performance.now(), speed: state.speed };
}

// ---------- loop ----------
function frame(now) {
  const dt = state.last ? (now - state.last) / 1000 : 0;
  state.last = now;
  if (state.world) {
    if (state.playing) {
      state.T = Math.min(state.T + dt * state.speed, endH());   // the clock stops at day 31
      if (state.T >= endH()) setPlaying(false);
    }
    state.maxT = Math.max(state.maxT, state.T, totalH());
    syncYou(); drawPilot(); sounds(dt); director(); drawDecision();
    if (state.frameN % 10 === 0) drawWindPanel();
    state.frameN += 1;
    if (globe() && state.frameN % 6 === 0) globe().setForecast(forecastSel());
    if (globe()) globe().setFinished(state.T >= totalH());
    const ym = state.world.runs.you.msgs;
    if (globe() && ym.length !== state.markerCount) { state.markerCount = ym.length; globe().setMarkers(ym); }
    $("scrub").value = Math.round(state.T / endH() * 1000);
    $("clock").textContent = `day ${hoursToDay(state.T)} of ${state.world.days + 1}` + (state.T > totalH() ? ` · scoring ended day ${state.world.days}` : "");
    if (flatShown()) drawMap();
    if (globe()) {
      const T = state.T;
      globe().update(T, idx(T), heardBy(T), gotBy([...AI, "you"], T), gotBy(["vega", "best"], T));
    }
    drawStrip(); drawScore(); drawLog();
  }
  requestAnimationFrame(frame);
}

function setPlaying(p) {
  state.playing = p;
  $("play").textContent = p ? "Pause" : state.world && state.T >= endH() ? "Replay" : "Play";
}

async function load(seed) {
  state.world = await (await fetch(`data/world${seed}.json`)).json();
  state.T = 0; state.maxT = 0; state.logCount = -1; audio.lastT = 0; state.markerCount = -1; state.scoreHtml = "";
  state.gen = { t: state.world.days * 24, n: 0, rand: rng32(state.world.seed * 7919 + 17) };
  state.big = new Set(Object.entries(state.world.target_size || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k));
  state.world.runs.you = newYou();
  setAim(56);
  state.heroDone = new Set(); state.hero = null;
  if (!state.world.runs[state.sel]) state.sel = state.world.runs.hybrid ? "hybrid" : "agent";
  $("world").value = seed;
  $("who").textContent = `Commander: ${state.world.commander}. Lines appear as the mission clock passes them.`;
  drawTable(); globeLoad(); setPlaying(true);
}

async function init() {
  state.index = await (await fetch("data/index.json")).json();
  $("world").innerHTML = state.index.worlds.map((w) => `<option value="${w.seed}">World ${w.seed}</option>`).join("");
  $("world").onchange = (e) => load(+e.target.value);
  $("speed").onchange = (e) => state.speed = +e.target.value;
  $("aim").oninput = (e) => setAim(+e.target.value);
  $("up").onclick = () => setAim(state.aim + 1);
  $("down").onclick = () => setAim(state.aim - 1);
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT" && e.target.type !== "range") return;
    if (e.key === "ArrowUp") { setAim(state.aim + 0.5); e.preventDefault(); }
    if (e.key === "ArrowDown") { setAim(state.aim - 0.5); e.preventDefault(); }
    if (e.key === " " && e.target.tagName !== "BUTTON") { $("play").click(); e.preventDefault(); }
  });
  $("play").onclick = () => {
    if (state.hero) {                                   // your click wins over a hero shot
      state.speed = state.hero.speed; $("speed").value = String(state.speed);
      globe() && globe().endHero(); state.hero = null;
    }
    if (state.T >= endH()) state.T = 0;
    setPlaying(!state.playing);
    state.userPaused = !state.playing;
  };
  // Buttons drop focus after a click, so the space bar only ever means play/pause.
  document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => b.blur()));
  $("view").onclick = () => {
    const flat = !flatShown();
    document.querySelector(".mapwrap").hidden = !flat;
    $("globe").hidden = flat;
    $("view").textContent = flat ? "Globe" : "Flat map";
    $("follow").hidden = flat;
  };
  $("follow").onclick = () => globe() && globe().setFollow(!globe().follow);
  $("director").onclick = () => {
    state.director = !state.director;
    $("director").textContent = state.director ? "Director on" : "Director off";
    $("director").classList.toggle("on", state.director);
    if (!state.director && state.hero) { state.speed = state.hero.speed; globe().endHero(); state.hero = null; setPlaying(true); }
  };
  wireHow(document.querySelector(".legend"));
  $("sound").onclick = () => {
    audio.on = !audio.on;
    if (audio.on) audioCtx();
    $("sound").textContent = audio.on ? "Sound on" : "Sound off";
    $("sound").classList.toggle("on", audio.on);
  };
  $("speed").value = String(state.speed);
  $("scrub").oninput = (e) => { state.T = e.target.value / 1000 * endH(); state.logCount = -1; };
  const q = +new URLSearchParams(location.search).get("world");
  await load(state.index.worlds.some((w) => w.seed === q) ? q : 7);   // world 7: the clearest agent win; the table shows all 20
  requestAnimationFrame(frame);
}
init();

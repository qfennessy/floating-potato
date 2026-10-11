// Replays precomputed runs (web/data/world<N>.json, made by sim/export_web.py) and flies YOUR
// balloon live in the same world: you set the altitude, the same physics as sim/venus.py moves it.
// No live model calls, so the demo can't crash on stage.

const RUNS = ["best", "vega", "agent", "you"];        // draw order: you on top
const COLOR = { agent: "#ffb347", vega: "#c9c9c9", best: "#7cc4ff", you: "#f472b6" };
const KIND = { rumble: "eruption", so2: "gas plume", lightning: "lightning" };

const $ = (id) => document.getElementById(id);
const mapC = $("map"), stripC = $("strip");
const state = { world: null, T: 0, playing: true, speed: 2, last: 0, logCount: -1, index: null, aim: 56 };
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
const totalH = () => state.world.days * 24;
const idx = (T) => Math.min(Math.floor(T / state.world.step_h), state.world.runs.agent.track.length - 1);

function valueOf(target) {
  const ev = state.world.events.find((e) => e.id === target);
  return ev ? ev.value : 1;
}
function reachedBy(run, T) {
  return state.world.runs[run].log.filter((l) => (l.kind === "reached" || l.kind === "you") && l.t_h <= T).map((l) => l.target);
}
function heardBy(T) {
  return new Set(state.world.runs.agent.log.filter((l) => l.kind === "detect" && l.t_h <= T).map((l) => l.event));
}

// ---------- live physics: a port of sim/venus.py (keep the two in step) ----------
const R_KM = 6051.8, KM_PER_DEG = Math.PI * R_KM / 180, STEP_S = 900, ALT_RATE = 0.5;
const CORRIDOR = [50, 62], SOLAR_DAY_H = 116.75 * 24, CAPTURE_KM = 350;
const rad = (d) => d * Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mod = (x, m) => ((x % m) + m) % m;

function wind(lat, alt, lt) {
  const s = (alt - CORRIDOR[0]) / (CORRIDOR[1] - CORRIDOR[0]);
  const u = -(60 + 40 * s) * Math.cos(rad(lat)) + 4 * Math.cos(2 * Math.PI * lt / 24);
  const v = 6 * (2 * s - 1) * Math.sin(2 * rad(lat)) + 2 * Math.sin(2 * Math.PI * lt / 24) * (2 * s - 1);
  return [u, v];
}
const localTime = (lon, hours) => mod(12 + (lon - mod(-360 * hours / SOLAR_DAY_H, 360)) / 15, 24);
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

// Your flight is stored like a replayed run (track + log), grown or rewound to match the clock.
function newYou() {
  const [lat, lon] = state.world.runs.agent.track[0];
  return { label: "You", track: [[lat, lon, 56]], log: [], aims: [] };
}
function syncYou() {
  const you = state.world.runs.you, want = idx(state.T);
  if (you.track.length - 1 > want) {                           // scrubbed back: rewind
    you.track.length = want + 1;
    you.aims.length = want;
    you.log = you.log.filter((l) => l.t_h <= want * state.world.step_h);
  }
  while (you.track.length - 1 < want) {
    const k = you.track.length - 1, hours = k * state.world.step_h;
    const active = state.world.events.filter((e) => e.t_h <= hours && hours < e.ends_h);
    const next = advance(you.track[k], hours, state.aim);
    you.track.push(next);
    you.aims.push(state.aim);
    const got = new Set(you.log.map((l) => l.target));
    const cands = [...Object.entries(state.world.targets).map(([n, [la, lo]]) => [n, la, lo, n]),
                   ...active.map((e) => [e.id, e.lat, e.lon, `${KIND[e.kind]}${e.site ? " near " + e.site : ""}`])];
    for (const [id, la, lo, name] of cands)
      if (!got.has(id) && gcKm(next[0], next[1], la, lo) <= CAPTURE_KM)
        you.log.push({ t_h: hours + state.world.step_h, kind: "you", target: id, text: `You reached ${name}` });
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
  const T = state.T, i = idx(T), w = state.world;
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
  const agentGot = new Set(reachedBy("agent", T));
  const anyGot = new Set([...reachedBy("vega", T), ...reachedBy("best", T)]);

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
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "11px Inter, sans-serif";
    ctx.fillText(name, x + 9, y + 4);
  }

  // tracks
  for (const r of RUNS) {
    const tr = w.runs[r].track;
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
  const w = state.world, i = idx(state.T), pad = 28;
  const [lo, hi] = [48, 64];
  const X = (h) => pad + (h / totalH()) * (W - pad - 8);
  const Y = (a) => 8 + (hi - a) / (hi - lo) * (H - 24);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(74,222,128,0.12)";
  ctx.fillRect(X(0), Y(w.corridor_km[1]), X(totalH()) - X(0), Y(w.corridor_km[0]) - Y(w.corridor_km[1]));
  ctx.fillStyle = "#a89c8c"; ctx.font = "10px JetBrains Mono, monospace";
  for (const a of [50, 56, 62]) ctx.fillText(a, 4, Y(a) + 3);
  for (let d = 0; d <= w.days; d += 2) ctx.fillText(`d${d}`, X(d * 24) - 6, H - 3);
  for (const r of RUNS) {
    const tr = w.runs[r].track;
    ctx.strokeStyle = COLOR[r]; ctx.lineWidth = r === "agent" || r === "you" ? 2 : 1.3;
    ctx.beginPath();
    for (let k = 0; k <= i; k++) {
      const x = X(k * w.step_h), y = Y(tr[k][2]);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.beginPath();
  ctx.moveTo(X(state.T), 4); ctx.lineTo(X(state.T), H - 14); ctx.stroke();
}

// ---------- side panels ----------
function drawScore() {
  const cards = [["you", "You"], ["agent", "AI agent"], ["vega", "Vega-style drifter"], ["best", "Best fixed altitude"]];
  $("score").innerHTML = cards.map(([r, name]) => {
    const pts = reachedBy(r, state.T).reduce((s, t) => s + valueOf(t), 0);
    return `<div class="card ${r}"><b>${pts}</b><span>${name} points</span></div>`;
  }).join("");
}

function drawLog() {
  const T = state.T, w = state.world;
  const entries = [...w.runs.agent.log, ...w.runs.you.log].filter((l) => l.t_h <= T).sort((a, b) => a.t_h - b.t_h);
  if (entries.length === state.logCount) return;
  state.logCount = entries.length;
  const label = { strategy: "strategy", detect: "heard", decision: "decided", reached: "AI reached", missed: "missed", you: "you" };
  $("log").innerHTML = entries.slice().reverse().map((l) =>
    `<li class="${l.kind}"><span class="t">day ${hoursToDay(l.t_h)}</span><span class="k">${label[l.kind] || l.kind}</span><br>${escapeHtml(l.text)}${l.kind === "reached" || l.kind === "you" ? ` <b>+${valueOf(l.target)}</b>` : ""}</li>`
  ).join("") || `<li class="t">Listening…</li>`;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function drawTable() {
  const rows = state.index.worlds;
  const tot = (k) => rows.reduce((s, r) => s + r[k], 0);
  $("table").innerHTML =
    `<tr><th>World</th><th>Agent</th><th>Drifter 54 km</th><th>Average fixed altitude</th><th>Best fixed altitude</th></tr>` +
    rows.map((r) => `<tr class="${r.seed === state.world.seed ? "current" : ""}" data-seed="${r.seed}" style="cursor:pointer">
      <td>World ${r.seed}</td><td class="${r.agent > r.vega ? "win" : ""}">${r.agent}</td><td>${r.vega}</td><td>${r.avg}</td>
      <td>${r.best} <span class="note">(${r.best_alt} km)</span></td></tr>`).join("") +
    `<tr><td><b>Total</b></td><td><b>${tot("agent")}</b></td><td><b>${tot("vega")}</b></td><td><b>${Math.round(tot("avg") * 10) / 10}</b></td><td><b>${tot("best")}</b></td></tr>`;
  $("table").querySelectorAll("tr[data-seed]").forEach((tr) => tr.onclick = () => load(+tr.dataset.seed));
}

// ---------- globe hookup (globe.js is a module and may load after this script) ----------
const globe = () => window.venusGlobe;
function globeLoad() { if (globe() && state.world) globe().load(state.world); }
document.addEventListener("globe-ready", globeLoad);
document.addEventListener("globe-follow", (e) => {
  $("follow").classList.toggle("on", e.detail);
  $("follow").textContent = e.detail ? "Following you" : "Follow you";
});
function flatShown() { return !document.querySelector(".mapwrap").hidden; }

// ---------- loop ----------
function frame(now) {
  const dt = state.last ? (now - state.last) / 1000 : 0;
  state.last = now;
  if (state.world) {
    if (state.playing) {
      state.T = Math.min(state.T + dt * state.speed, totalH());
      if (state.T >= totalH()) setPlaying(false);
    }
    syncYou(); drawPilot();
    $("scrub").value = Math.round(state.T / totalH() * 1000);
    $("clock").textContent = `day ${hoursToDay(state.T)} of ${state.world.days}`;
    if (flatShown()) drawMap();
    if (globe()) {
      const T = state.T;
      globe().update(T, idx(T), heardBy(T), new Set([...reachedBy("agent", T), ...reachedBy("you", T)]),
        new Set([...reachedBy("vega", T), ...reachedBy("best", T)]));
    }
    drawStrip(); drawScore(); drawLog();
  }
  requestAnimationFrame(frame);
}

function setPlaying(p) {
  state.playing = p;
  $("play").textContent = p ? "Pause" : state.T >= totalH() ? "Replay" : "Play";
}

async function load(seed) {
  state.world = await (await fetch(`data/world${seed}.json`)).json();
  state.T = 0; state.logCount = -1;
  state.world.runs.you = newYou();
  setAim(56);
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
    if (e.key === " ") { $("play").click(); e.preventDefault(); }
  });
  $("play").onclick = () => {
    if (state.T >= totalH()) state.T = 0;
    setPlaying(!state.playing);
  };
  $("view").onclick = () => {
    const flat = !flatShown();
    document.querySelector(".mapwrap").hidden = !flat;
    $("globe").hidden = flat;
    $("view").textContent = flat ? "Globe" : "Flat map";
    $("follow").hidden = flat;
  };
  $("follow").onclick = () => globe() && globe().setFollow(!globe().follow);
  $("speed").value = String(state.speed);
  $("scrub").oninput = (e) => { state.T = e.target.value / 1000 * totalH(); state.logCount = -1; };
  const q = +new URLSearchParams(location.search).get("world");
  await load(state.index.worlds.some((w) => w.seed === q) ? q : 3);
  requestAnimationFrame(frame);
}
init();

// Venus as a glowing wind machine. The Magellan map on a sphere; a cloud shell with a wedge cut away
// to show the altitude layers; wind "highways" with flowing particles; balloons on exaggerated-height
// tethers; eruption pulses and shrinking sampling halos; a forecast path and capture disc for the
// selected balloon; and a constellation of captured science. app.js drives it via window.venusGlobe.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const COLOR = { agent: 0xffb347, flash: 0x34d399, rules: 0xa78bfa, hybrid: 0xfacc15, vega: 0xd8d8d8, best: 0x7cc4ff, you: 0xf472b6 };
const ALL_RUNS = ["best", "vega", "rules", "flash", "agent", "hybrid", "you"];
const KIND = { rumble: "eruption", so2: "gas plume", lightning: "lightning", major: "major eruption" };
const VOLCANIC = new Set(["rumble", "so2", "major"]);

// Altitude, exaggerated about 30x so the layers separate: 44 km -> 1.03, 68 km -> 1.15 (radius 1 = surface).
export const EXAGGERATION = 30;
const altR = (alt) => 1.03 + (alt - 44) / 24 * 0.12;
const SHELL_R = 1.175;                      // the visible cloud deck, above the highest layer
const LAYERS = [47, 50, 53, 56, 59, 62, 65];
const BAND = 14;                            // wind highways span this many degrees either side of the balloon
const PER_LAYER = 380;
const WEDGE = 1.5;                          // radians of cloud cut away, centred on the selected balloon

// lat/lon (deg, lon 0..360 E) -> point on a sphere, matching three's SphereGeometry UVs.
function toXYZ(lat, lon, r) {
  const phi = lon / 360 * Math.PI * 2, theta = (90 - lat) / 180 * Math.PI;
  return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}
const mod = (x, m) => ((x % m) + m) % m;

const GLOW = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function cloudTexture() {
  // Soft Venus-like streaks: long pale bands, a little brighter toward the equator.
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#e9cf98"; g.fillRect(0, 0, 1024, 512);
  for (let k = 0; k < 900; k++) {
    const y = 512 * (0.5 + 0.5 * (Math.random() - 0.5) * 1.9), x = Math.random() * 1024;
    const w = 60 + Math.random() * 260, h = 3 + Math.random() * 10, light = Math.random() < 0.5;
    g.fillStyle = light ? `rgba(255,244,214,${0.05 + Math.random() * 0.12})` : `rgba(176,128,70,${0.04 + Math.random() * 0.1})`;
    g.beginPath(); g.ellipse(x, y, w, h, (Math.random() - 0.5) * 0.15, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function starField() {
  const n = 5000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 20);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.35 + Math.random() ** 3 * 0.65, warm = Math.random();
    col.set([b, b * (0.9 + 0.1 * warm), b * (0.8 + 0.2 * (1 - warm))], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
}

function atmosphere(r) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 64, 64), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0) * 0.55; gl_FragColor = vec4(1.0, 0.72, 0.35, 1.0) * i; }`,
  }));
}

function circlePts(lat, lon, km, r, n = 64) {
  const pts = [], c = toXYZ(lat, lon, 1).normalize(), ang = km / 6051.8;
  const t1 = new THREE.Vector3(0, 1, 0).cross(c).normalize();
  if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
  const t2 = c.clone().cross(t1).normalize();
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI * 2;
    pts.push(c.clone().multiplyScalar(Math.cos(ang)).add(t1.clone().multiplyScalar(Math.sin(ang) * Math.cos(a)))
      .add(t2.clone().multiplyScalar(Math.sin(ang) * Math.sin(a))).multiplyScalar(r));
  }
  return pts;
}
function ring(lat, lon, km, r) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(lat, lon, km, r)),
    new THREE.LineBasicMaterial({ transparent: true }));
}
function disc(lat, lon, km, r, color, opacity) {
  // A flat-ish cap: triangle fan from the centre to the circle, on the sphere.
  const rim = circlePts(lat, lon, km, r, 48), c = toXYZ(lat, lon, r), pos = [];
  for (let k = 0; k < rim.length - 1; k++) pos.push(c.x, c.y, c.z, rim[k].x, rim[k].y, rim[k].z, rim[k + 1].x, rim[k + 1].y, rim[k + 1].z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
}

function label(text, cls) {
  const el = document.createElement("div");
  el.className = `glabel ${cls || ""}`;
  el.textContent = text;
  return new CSS2DObject(el);
}
function glowSprite(color, size, opacity = 0.9) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size);
  return s;
}

class Globe {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "glabels";
    host.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
    this.camera.position.set(0, 1.0, 4.2);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 9;
    this.controls.addEventListener("start", () => { this.hero = null; this.setFollow(false); });
    this.follow = true;
    this.sel = "agent";
    this.lastMs = performance.now();

    this.scene.add(starField());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xfff1dd, 1.7);
    sun.position.set(5, 2, 4);
    this.scene.add(sun);

    const tex = new THREE.TextureLoader().load("data/venus_globe.jpg");
    tex.colorSpace = THREE.SRGBColorSpace;
    const bump = new THREE.TextureLoader().load("data/venus_topo_0_360.jpg");
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128),
      new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 4, color: 0xffc887, roughness: 0.95 }));
    this.scene.add(this.planet);

    // The cloud deck, with a wedge cut away (centred on phi = 0, rotated to the selected balloon).
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(SHELL_R, 128, 64, WEDGE / 2, Math.PI * 2 - WEDGE),
      new THREE.MeshStandardMaterial({ map: cloudTexture(), color: 0xf3dcae, transparent: true, opacity: 0.38,
        side: THREE.FrontSide, depthWrite: false, roughness: 1 }));
    this.scene.add(this.shell);
    this.scene.add(atmosphere(SHELL_R + 0.06));

    this.dynamic = new THREE.Group();
    this.scene.add(this.dynamic);
    this.buildWind();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  // ---------- wind highways ----------
  buildWind() {
    this.wind = new THREE.Group();          // particles (world coordinates)
    this.ribbons = new THREE.Group();       // ribbons, built around phi = 0 and rotated to the wedge
    this.scene.add(this.wind); this.scene.add(this.ribbons);
    this.layers = LAYERS.map((alt) => {
      const pos = new Float32Array(PER_LAYER * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ map: GLOW, color: 0xffb347, size: 0.022, transparent: true,
        opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
      pts.frustumCulled = false;
      const lat = new Float32Array(PER_LAYER), lon = new Float32Array(PER_LAYER);
      const ribbon = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffa040,
        transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.wind.add(pts); this.ribbons.add(ribbon);
      return { alt, pts, lat, lon, ribbon, center: null, seeded: false };
    });
  }

  ribbonGeometry(alt, center) {
    const lo = Math.max(-80, center - BAND), hi = Math.min(80, center + BAND);
    // Only inside the cut-away wedge: that is where the layers are on show.
    return new THREE.SphereGeometry(altR(alt), 48, 6, -WEDGE / 2, WEDGE, (90 - hi) / 180 * Math.PI, (hi - lo) / 180 * Math.PI);
  }

  stepWind(dtReal) {
    if (!this.world || !window.wind) return;
    const sel = this.selPos();
    if (!sel) return;
    const center = sel.lat, selAlt = sel.alt;
    const half = WEDGE / 2 * 180 / Math.PI;                 // the wedge spans sel.lon +/- half degrees
    const east = sel.lon + half;
    const inWedge = (lon) => Math.abs(((lon - sel.lon + 540) % 360) - 180) <= half;
    for (const L of this.layers) {
      if (L.center === null || Math.abs(L.center - center) > 2) {
        L.center = center;
        L.ribbon.geometry.dispose();
        L.ribbon.geometry = this.ribbonGeometry(L.alt, center);
        if (!L.seeded) {
          for (let k = 0; k < PER_LAYER; k++) { L.lat[k] = center + (Math.random() * 2 - 1) * BAND; L.lon[k] = mod(sel.lon + (Math.random() * 2 - 1) * half, 360); }
          L.seeded = true;
        }
      }
      const near = Math.abs(L.alt - selAlt) < 1.6;
      const dim = this.finished ? 0.15 : 1;
      L.pts.material.opacity = (near ? 1 : 0.5) * dim;
      L.pts.material.size = near ? 0.022 : 0.013;
      const [, vHere] = window.wind(center, L.alt, window.localTime(sel.lon, this.T || 0));
      L.pts.material.color.set(vHere > 0.3 ? (near ? 0xbfe6ff : 0x7cc4ff) : vHere < -0.3 ? (near ? 0xffd27a : 0xff9a3c) : 0xf2e6d0);
      L.ribbon.material.opacity = (near ? 0.16 : 0.045) * dim;
      // Move each particle with this layer's wind: westward speed, and its north-south drift
      // exaggerated so the bending is visible.
      const p = L.pts.geometry.attributes.position.array, r = altR(L.alt), T = this.T || 0;
      for (let k = 0; k < PER_LAYER; k++) {
        const [u, v] = window.wind(L.lat[k], L.alt, window.localTime(L.lon[k], T));
        L.lon[k] = mod(L.lon[k] + u * 0.05 * dtReal / Math.max(Math.cos(L.lat[k] * Math.PI / 180), 0.2), 360);
        L.lat[k] += v * 0.9 * dtReal;
        if (Math.abs(L.lat[k] - center) > BAND || !inWedge(L.lon[k])) {   // re-enter at the wedge's east edge
          L.lat[k] = center + (Math.random() * 2 - 1) * BAND; L.lon[k] = mod(east - Math.random() * 4, 360);
        }
        const q = toXYZ(L.lat[k], L.lon[k], r);
        p[k * 3] = q.x; p[k * 3 + 1] = q.y; p[k * 3 + 2] = q.z;
      }
      L.pts.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ---------- setup per world ----------
  setFollow(on) {
    this.follow = on;
    document.dispatchEvent(new CustomEvent("globe-follow", { detail: on }));
  }

  select(run) {
    this.sel = run;
    for (const r of this.runs || []) {
      const s = r === run;
      this.lines[r].material.linewidth = s ? 4 : r === "you" ? 3 : 2;
      this.lines[r].material.opacity = s ? 1 : 0.55;
      this.balloons[r].scale.setScalar(s ? 1.5 : 1);
      this.tethers[r].material.opacity = s ? 0.8 : 0.25;
    }
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    for (const l of this.allLines()) l.material.resolution.set(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  allLines() { return [...Object.values(this.lines || {}), this.forecast].filter(Boolean); }

  load(world) {
    this.world = world;
    this.dynamic.clear();
    this.lines = {}; this.balloons = {}; this.tethers = {}; this.youLen = -1;
    this.flash = {}; this.pulses = []; this.science = new Map(); this.finished = false; this.hero = null;
    const res = new THREE.Vector2(this.host.clientWidth, this.host.clientHeight);
    this.runs = ALL_RUNS.filter((r) => world.runs[r]);
    for (const r of this.runs) {
      const pos = [];
      world.runs[r].track.forEach(([lat, lon, alt]) => { const p = toXYZ(lat, lon, altR(alt)); pos.push(p.x, p.y, p.z); });
      const g = new LineGeometry();
      g.setPositions(pos.length >= 6 ? pos : [...pos, ...pos]);
      const line = new Line2(g, new LineMaterial({ color: COLOR[r], linewidth: 2, transparent: true, opacity: 0.6, resolution: res }));
      line.frustumCulled = false;
      this.dynamic.add(line);
      this.lines[r] = line;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 16), new THREE.MeshBasicMaterial({ color: COLOR[r] }));
      ball.add(glowSprite(COLOR[r], 0.08));
      this.dynamic.add(ball);
      this.balloons[r] = ball;
      const tg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const tether = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: COLOR[r], transparent: true, opacity: 0.3 }));
      tether.frustumCulled = false;
      this.dynamic.add(tether);
      this.tethers[r] = tether;
    }
    // Sites: small markers on the surface; names for the 12 biggest or once reached.
    this.big = new Set(Object.entries(world.target_size || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k));
    this.targets = Object.entries(world.targets).map(([name, [lat, lon]]) => {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.01), new THREE.MeshBasicMaterial({ color: 0xf2e6d0 }));
      m.position.copy(toXYZ(lat, lon, 1.004));
      const l = label(name, "site"); l.position.set(0, 0.025, 0); m.add(l);
      this.dynamic.add(m);
      return { name, mesh: m, label: l };
    });
    // Layer science: cloud-top samples float above the safe band (cyan), deep-air samples below it (red).
    this.samples = Object.entries(world.samples || {}).map(([id, [lat, lon, lo, hi]]) => {
      const sky = id.startsWith("SKY:");
      const sp = glowSprite(sky ? 0x67e8f9 : 0xf43f5e, 0.07, 0.95);
      sp.position.copy(toXYZ(lat, lon, altR(sky ? 65 : 46.5)));
      const stalk = new THREE.Line(new THREE.BufferGeometry().setFromPoints([toXYZ(lat, lon, 1.0), sp.position]),
        new THREE.LineBasicMaterial({ color: sky ? 0x67e8f9 : 0xf43f5e, transparent: true, opacity: 0.25 }));
      this.dynamic.add(sp); this.dynamic.add(stalk);
      return { id, sp, stalk };
    });
    // Forecast path and capture disc for the selected balloon.
    this.forecast = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffffff, linewidth: 2, dashed: true,
      dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.85, resolution: res }));
    this.forecast.frustumCulled = false; this.forecast.visible = false;
    this.dynamic.add(this.forecast);
    this.captureDisc = null;
    this.events = [];
    this.syncEvents();
    this.markers = [];
    this.select(this.sel in world.runs ? this.sel : "agent");
  }

  setMarkers(msgs) {
    for (const mk of this.markers || []) { this.dynamic.remove(mk.ring); this.dynamic.remove(mk.label); }
    this.markers = msgs.filter((m) => m.site && (m.type === "priority" || m.type === "tip")).map((m) => {
      const [lat, lon] = m.type === "priority" ? [m.lat, m.lon] : this.world.volcanoes[m.site];
      const g = ring(lat, lon, this.world.capture_km * 1.6, SHELL_R + 0.004);
      g.material.color.set(m.type === "priority" ? 0xe879f9 : 0xfb923c);
      const l = label(m.type === "priority" ? `YOUR PRIORITY · ${m.site} (+10)` : `YOUR ALERT · ${m.site}`, "marker");
      l.position.copy(toXYZ(lat, lon, SHELL_R + 0.02));
      g.visible = l.visible = false;
      this.dynamic.add(g); this.dynamic.add(l);
      return { m, ring: g, label: l, until: m.type === "priority" ? m.until_h : m.erupt_h + 120 };
    });
  }

  // Each event: a halo above the clouds that shrinks as its sampling window closes, a ring on the ground,
  // and (for eruptions and plumes) a crimson pulse from the surface into the clouds when it starts.
  syncEvents() {
    const world = this.world;
    for (let k = this.events.length; k < world.events.length; k++) {
      const e = world.events[k];
      const halo = ring(e.lat, e.lon, world.capture_km, SHELL_R + 0.003);
      const ground = ring(e.lat, e.lon, world.capture_km * 0.5, 1.004);
      const l = label(`${KIND[e.kind]}${e.site ? " · " + e.site : ""} (+${e.value})`, "event");
      l.position.copy(toXYZ(e.lat, e.lon, SHELL_R + 0.03));
      halo.visible = ground.visible = l.visible = false;
      this.dynamic.add(halo); this.dynamic.add(ground); this.dynamic.add(l);
      this.events.push({ e, halo, ground, label: l, pulsed: false });
    }
  }

  pulse(e) {
    const a = toXYZ(e.lat, e.lon, 1.0), b = toXYZ(e.lat, e.lon, SHELL_R + 0.02);
    const col = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending }));
    const head = glowSprite(0xff3045, e.kind === "major" ? 0.22 : 0.14, 1);
    head.position.copy(a);
    this.dynamic.add(col); this.dynamic.add(head);
    this.pulses.push({ col, head, a, b, age: 0, big: e.kind === "major" });
  }

  // ---------- per frame ----------
  update(T, i, heard, agentGot, anyGot) {
    if (!this.world) return;
    const forward = this.T !== undefined && T > this.T && T - this.T < 6;
    this.T = T;
    this.syncEvents();
    for (const mk of this.markers || []) mk.ring.visible = mk.label.visible = T >= mk.m.t_h && T < mk.until;
    this.refreshYou();
    for (const r of this.runs) {
      const track = this.world.runs[r].track, j = r === "you" ? track.length - 1 : Math.min(i, track.length - 1);
      this.lines[r].geometry.instanceCount = Math.max(j, 1);
      const [lat, lon, alt] = this.interp(track, r === "you" ? j : T / this.world.step_h);
      this.balloons[r].position.copy(toXYZ(lat, lon, altR(alt)));
      const tp = this.tethers[r].geometry.attributes.position;
      const g0 = toXYZ(lat, lon, 1.0);
      tp.setXYZ(0, g0.x, g0.y, g0.z); tp.setXYZ(1, this.balloons[r].position.x, this.balloons[r].position.y, this.balloons[r].position.z);
      tp.needsUpdate = true;
    }
    for (const t of this.targets) {
      t.mesh.material.color.set(agentGot.has(t.name) ? 0x4ade80 : anyGot.has(t.name) ? 0x7cc4ff : 0xf2e6d0);
      t.label.visible = this.big.has(t.name) || agentGot.has(t.name) || anyGot.has(t.name);
    }
    for (const ev of this.events) {
      const live = T >= ev.e.t_h && T < ev.e.ends_h;
      if (live && !ev.pulsed && forward && VOLCANIC.has(ev.e.kind)) this.pulse(ev.e);
      if (live) ev.pulsed = true; else if (T < ev.e.t_h) ev.pulsed = false;
      ev.halo.visible = ev.ground.visible = live && !this.finished;
      ev.label.visible = live && !this.finished && (heard.has(ev.e.id) || agentGot.has(ev.e.id));
      if (!live) continue;
      const left = 1 - (T - ev.e.t_h) / (ev.e.ends_h - ev.e.t_h);
      ev.halo.scale.setScalar(1);
      const c = toXYZ(ev.e.lat, ev.e.lon, 1).normalize();
      // shrink the halo toward its centre as the window closes
      ev.halo.position.copy(c.clone().multiplyScalar((SHELL_R + 0.003) * (1 - (0.35 + 0.65 * left))));
      ev.halo.scale.setScalar(0.35 + 0.65 * left);
      const got = agentGot.has(ev.e.id);
      ev.halo.material.color.set(got ? 0x4ade80 : VOLCANIC.has(ev.e.kind) ? 0xff3b4a : 0xfde047);
      ev.halo.material.opacity = 0.5 + 0.5 * left;
      ev.ground.material.color.set(0xff3b4a);
      ev.ground.material.opacity = 0.4;
    }
    this.updateScience(T);
    for (const s of this.samples || []) s.sp.visible = s.stalk.visible = !agentGot.has(s.id) && !this.finished;
    for (const r of this.runs) {                     // a lost balloon turns grey
      const lost = this.world.runs[r].lost_h, dead = (lost != null && T >= lost) || (r === "you" && this.world.runs.you.track.at(-1)[6] === 0);
      this.balloons[r].material.color.set(dead ? 0x555555 : COLOR[r]);
    }
  }

  // Position between two 15-minute track points, so balloons glide instead of hopping.
  interp(track, x) {
    const k = Math.max(0, Math.min(Math.floor(x), track.length - 1)), f = Math.min(Math.max(x - k, 0), 1);
    const a = track[k], b = track[Math.min(k + 1, track.length - 1)];
    let dl = b[1] - a[1];
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    return [a[0] + (b[0] - a[0]) * f, mod(a[1] + dl * f, 360), a[2] + (b[2] - a[2]) * f];
  }

  refreshYou() {
    const yt = this.world.runs.you?.track;
    if (!yt || yt.length === this.youLen) return;
    this.youLen = yt.length;
    const pos = [];
    for (let k = 0; k < Math.max(yt.length, 2); k++) {
      const [la, lo, al] = yt[Math.min(k, yt.length - 1)];
      const p = toXYZ(la, lo, altR(al));
      pos.push(p.x, p.y, p.z);
    }
    // Fresh geometry each time: three.js remembers a wide line's segment count when first drawn.
    this.lines.you.geometry.dispose();
    this.lines.you.geometry = new LineGeometry();
    this.lines.you.geometry.setPositions(pos);
  }

  // Science constellation: a glowing point on the surface for each capture, in the balloon's colour.
  updateScience(T) {
    const w = this.world;
    if (this.sciT !== undefined && T >= this.sciT && T - this.sciT < 0.5 && !this.finishedChanged) return;
    this.sciT = T; this.finishedChanged = false;
    const place = (id) => {
      if (id.startsWith("BONUS:")) return w.targets[id.slice(6)];
      if (w.samples && w.samples[id]) return w.samples[id];
      if (w.targets[id]) return w.targets[id];
      const e = w.events.find((x) => x.id === id);
      return e ? [e.lat, e.lon] : null;
    };
    for (const r of this.runs) {
      for (const l of w.runs[r].log) {
        if ((l.kind !== "reached" && l.kind !== "you") || (l.pts ?? 1) <= 0) continue;
        const key = `${r}:${l.target}:${l.t_h}`, on = l.t_h <= T;
        let s = this.science.get(key);
        if (!s && on) {
          const p = place(l.target);
          if (!p) continue;
          s = glowSprite(COLOR[r], 0.05, 0.9);
          s.position.copy(toXYZ(p[0], p[1], 1.008));
          this.dynamic.add(s);
          this.science.set(key, s);
          if (r === this.sel && T - l.t_h < 2) this.flashTrail(r);
        }
        if (s) { s.visible = on; s.scale.setScalar(this.finished ? 0.09 : 0.05); }
      }
    }
  }

  flashTrail(r) { this.flash[r] = 0; }                  // age in ms, advanced only while playing
  setPaused(p) { this.paused = p; }

  // Forecast: where the selected balloon goes in the next day if it keeps its current altitude.
  setForecast(points, captureLatLon) {
    if (!points || points.length < 2 || this.finished) { this.forecast.visible = false; return; }
    const pos = [];
    for (const [la, lo, al] of points) { const p = toXYZ(la, lo, altR(al)); pos.push(p.x, p.y, p.z); }
    this.forecast.geometry.dispose();
    this.forecast.geometry = new LineGeometry();
    this.forecast.geometry.setPositions(pos);
    this.forecast.computeLineDistances();
    this.forecast.material.color.set(COLOR[this.sel]);
    this.forecast.visible = true;
    if (this.captureDisc) { this.dynamic.remove(this.captureDisc); this.captureDisc.geometry.dispose(); }
    const [la, lo, al] = points[0];
    this.captureDisc = disc(la, lo, this.world.capture_km, altR(al), COLOR[this.sel], 0.12);
    this.dynamic.add(this.captureDisc);
  }

  setFinished(on) { if (on !== this.finished) this.finishedChanged = true; this.finished = on; }

  // Hero shot: frame the given points (balloon, volcano) with the layers between them.
  frameHero(points) {
    const c = points.reduce((a, p) => a.add(p.clone()), new THREE.Vector3()).multiplyScalar(1 / points.length);
    const dir = c.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    this.hero = { pos: dir.clone().multiplyScalar(2.15).add(side.multiplyScalar(0.55)).add(new THREE.Vector3(0, 0.25, 0)),
                  target: c.clone().multiplyScalar(0.85) };
    this.setFollow(false);
  }
  endHero() { this.hero = null; this.setFollow(true); }
  latLonOf(run) { const b = this.balloons?.[run]; return b ? b.position.clone() : null; }
  eventPos(e) { return toXYZ(e.lat, e.lon, 1.0); }

  selPos() {
    const r = this.sel, tr = this.world?.runs[r]?.track;
    if (!tr) return null;
    const [lat, lon, alt] = this.interp(tr, r === "you" ? tr.length - 1 : (this.T || 0) / this.world.step_h);
    return { lat, lon, alt };
  }

  render() {
    const now = performance.now(), real = Math.min((now - this.lastMs) / 1000, 0.05);
    this.lastMs = now;
    const dt = this.paused ? 0 : real;                 // paused: the whole scene freezes (the camera still moves)
    if (dt > 0) this.stepWind(dt);
    const sel = this.selPos();
    if (sel) this.shell.rotation.y = this.ribbons.rotation.y = sel.lon / 360 * Math.PI * 2;   // wedge on the selected balloon
    if (this.hero) {
      this.camera.position.lerp(this.hero.pos, 0.05);
      this.controls.target.lerp(this.hero.target, 0.06);
    } else if (this.follow && sel) {
      // Sit a little east of (behind) the balloon and above it, looking at it, so the cut-away
      // wedge, the layers and the balloon are all in frame.
      const b = toXYZ(sel.lat, sel.lon, 1).normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(b).normalize().negate();
      const north = b.clone().cross(east).normalize().negate();
      const want = b.clone().multiplyScalar(1.7).add(east.multiplyScalar(1.45)).add(north.multiplyScalar(0.3));
      this.camera.position.lerp(want, 0.04);
      this.controls.target.lerp(b.clone().multiplyScalar(1.02), 0.06);
    }
    this.controls.update();
    // Eruption pulses rise from the surface into the clouds, then fade.
    for (const p of this.pulses || []) {
      p.age += dt * 1000;
      const f = p.age / (p.big ? 2200 : 1400);
      p.head.position.lerpVectors(p.a, p.b, Math.min(f * 1.4, 1));
      p.col.material.opacity = Math.max(0, 1 - f);
      p.head.material.opacity = Math.max(0, 1 - f * 0.8);
      if (f >= 1) { this.dynamic.remove(p.col); this.dynamic.remove(p.head); p.done = true; }
    }
    if (this.pulses) this.pulses = this.pulses.filter((p) => !p.done);
    // A capture flashes through the whole trail.
    for (const r of Object.keys(this.flash || {})) {
      this.flash[r] += dt * 1000;
      const f = this.flash[r] / 1200, line = this.lines[r];
      if (!line) continue;
      if (f >= 1) { line.material.color.set(COLOR[r]); delete this.flash[r]; continue; }
      line.material.color.set(COLOR[r]).lerp(new THREE.Color(0xffffff), 1 - f);
    }
    const cam = this.camera.position.clone().normalize();
    const facing = (o) => o.getWorldPosition(new THREE.Vector3()).normalize().dot(cam) > 0.15;
    for (const t of this.targets || []) if (t.label.visible) t.label.element.style.opacity = facing(t.label) ? 1 : 0;
    for (const ev of [...(this.events || []), ...(this.markers || [])]) if (ev.label.visible) ev.label.element.style.opacity = facing(ev.label) ? 1 : 0;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

window.venusGlobe = new Globe(document.getElementById("globe"));
document.dispatchEvent(new Event("globe-ready"));

// 3D Venus: the Magellan map on a sphere, balloon paths wrapped around it (altitude shown as
// exaggerated height), event rings, and a star field. app.js drives it via window.venusGlobe.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const COLOR = { agent: 0xffb347, vega: 0xd8d8d8, best: 0x7cc4ff, you: 0xf472b6 };
const RUNS = ["best", "vega", "agent", "you"];
const KIND = { rumble: "eruption", so2: "gas plume", lightning: "lightning" };

// lat/lon (deg, lon 0..360 E) -> point on a sphere, matching three's SphereGeometry UVs so the
// texture (0..360 E, left to right) lines up with our coordinates.
function toXYZ(lat, lon, r) {
  const u = lon / 360, v = (90 - lat) / 180;
  const phi = u * Math.PI * 2, theta = v * Math.PI;
  return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
}
// Altitude 50..62 km -> radius. Real height is under 1% of Venus's radius; exaggerated ~4x so you can see it.
const altR = (alt) => 1.012 + (alt - 50) / 12 * 0.045;
const YOU_LIFT = 0.006;      // your path sits just above the others so it is never hidden
const TAIL = 24;             // glowing tail behind your balloon: last 24 steps = 6 simulated hours
const TAIL_PIECES = 6;

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

function atmosphere() {
  // Soft yellow-orange rim glow: brighter where the view grazes the edge of the planet.
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.09, 64, 64),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vN; void main(){ float i = pow(0.75 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(1.0, 0.72, 0.35, 1.0) * i; }`,
    }));
}

function ring(lat, lon, km, r) {
  const pts = [], c = toXYZ(lat, lon, 1).normalize(), ang = km / 6051.8;
  const t1 = new THREE.Vector3(0, 1, 0).cross(c).normalize();
  if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
  const t2 = c.clone().cross(t1).normalize();
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    pts.push(c.clone().multiplyScalar(Math.cos(ang)).add(t1.clone().multiplyScalar(Math.sin(ang) * Math.cos(a)))
      .add(t2.clone().multiplyScalar(Math.sin(ang) * Math.sin(a))).multiplyScalar(r));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ transparent: true }));
}

const GLOW = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function label(text, cls) {
  const el = document.createElement("div");
  el.className = `glabel ${cls || ""}`;
  el.textContent = text;
  return new CSS2DObject(el);
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
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.camera.position.set(0, 0.9, 3.6);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 8;
    this.controls.addEventListener("start", () => this.setFollow(false));
    this.follow = true;

    this.scene.add(starField());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xfff1dd, 1.8);
    sun.position.set(5, 2, 4);
    this.scene.add(sun);

    const tex = new THREE.TextureLoader().load("data/venus_globe.jpg");
    tex.colorSpace = THREE.SRGBColorSpace;
    const bump = new THREE.TextureLoader().load("data/venus_topo_0_360.jpg");
    this.planet = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 128),
      new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 4, color: 0xffc887, roughness: 0.95 }));
    this.scene.add(this.planet);
    this.scene.add(atmosphere());

    this.dynamic = new THREE.Group();
    this.scene.add(this.dynamic);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  setFollow(on) {
    this.follow = on;
    document.dispatchEvent(new CustomEvent("globe-follow", { detail: on }));
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    for (const l of [...Object.values(this.lines || {}), ...(this.tailPieces || [])]) l.material.resolution.set(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  load(world) {
    this.world = world;
    this.dynamic.clear();
    this.lines = {}; this.balloons = {}; this.youLen = -1;
    for (const r of RUNS) {
      const tr = world.runs[r].track;
      const pos = [];
      tr.forEach(([lat, lon, alt]) => { const p = toXYZ(lat, lon, altR(alt)); pos.push(p.x, p.y, p.z); });
      const g = new LineGeometry();
      g.setPositions(pos);
      const line = new Line2(g, new LineMaterial({
        color: COLOR[r], linewidth: r === "you" ? 4 : r === "agent" ? 3 : 2, transparent: true, opacity: r === "agent" || r === "you" ? 1 : 0.8,
        resolution: new THREE.Vector2(this.host.clientWidth, this.host.clientHeight) }));
      this.dynamic.add(line);
      this.lines[r] = line;
      const big = r === "agent" || r === "you";
      const ball = new THREE.Mesh(new THREE.SphereGeometry(big ? 0.018 : 0.013, 16, 16),
        new THREE.MeshBasicMaterial({ color: COLOR[r] }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: COLOR[r], transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(big ? 0.09 : 0.06);
      ball.add(halo);
      this.dynamic.add(ball);
      this.balloons[r] = ball;
    }
    // Your tail: TAIL_PIECES short wide pink pieces, more see-through toward the back.
    this.tailPieces = [];
    for (let k = 0; k < TAIL_PIECES; k++) {
      const f = (k + 1) / TAIL_PIECES;
      const piece = new Line2(new LineGeometry(), new LineMaterial({
        color: 0xff7ac8, linewidth: 4 + 6 * f, transparent: true, opacity: 0.12 + 0.6 * f ** 1.5, depthWrite: false,
        resolution: new THREE.Vector2(this.host.clientWidth, this.host.clientHeight) }));
      piece.frustumCulled = false;
      piece.visible = false;
      this.dynamic.add(piece);
      this.tailPieces.push(piece);
    }
    this.targets = Object.entries(world.targets).map(([name, [lat, lon]]) => {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.014), new THREE.MeshBasicMaterial({ color: 0xf2e6d0 }));
      m.position.copy(toXYZ(lat, lon, 1.006));
      const l = label(name, "site"); l.position.set(0, 0.03, 0); m.add(l);
      this.dynamic.add(m);
      return { name, mesh: m, label: l };
    });
    this.events = world.events.map((e) => {
      const g = ring(e.lat, e.lon, world.capture_km, 1.004);
      const l = label(`${KIND[e.kind]}${e.site ? " · " + e.site : ""} (+${e.value})`, "event");
      l.position.copy(toXYZ(e.lat, e.lon, 1.02));
      this.dynamic.add(g); this.dynamic.add(l);
      return { e, ring: g, label: l };
    });
  }

  // Called every frame by app.js with the mission clock (hours) and helper sets.
  update(T, i, heard, agentGot, anyGot) {
    if (!this.world) return;
    this.T = T;
    // Your track grows live: refresh its line when it gets longer or is rewound.
    const yt = this.world.runs.you.track;
    if (yt.length !== this.youLen) {
      this.youLen = yt.length;
      const pos = [];
      for (let k = 0; k < this.world.runs.agent.track.length; k++) {
        const [la, lo, al] = yt[Math.min(k, yt.length - 1)];
        const p = toXYZ(la, lo, altR(al) + YOU_LIFT);
        pos.push(p.x, p.y, p.z);
      }
      // Fresh geometry each time: three.js remembers a wide line's segment count the first time it
      // draws it, and your path starts as a single point, so growing it in place never shows up.
      this.lines.you.geometry.dispose();
      this.lines.you.geometry = new LineGeometry();
      this.lines.you.geometry.setPositions(pos);
      this.lines.you.frustumCulled = false;
      // Tail: the last TAIL points split into pieces; the newest piece is the widest and most solid.
      const per = TAIL / TAIL_PIECES, end = yt.length - 1;
      this.tailPieces.forEach((piece, k) => {
        const a = end - (TAIL_PIECES - k) * per, b = a + per;      // piece k covers points a..b
        if (b < 1) { piece.visible = false; return; }
        const pts = [];
        for (let m = Math.max(a, 0); m <= b; m++) {
          const [la, lo, al] = yt[m], p = toXYZ(la, lo, altR(al) + YOU_LIFT * 1.5);
          pts.push(p.x, p.y, p.z);
        }
        piece.visible = pts.length >= 6;
        if (!piece.visible) return;
        piece.geometry.dispose();
        piece.geometry = new LineGeometry();
        piece.geometry.setPositions(pts);
      });
    }
    for (const r of RUNS) {
      const track = this.world.runs[r].track, j = Math.min(i, track.length - 1);
      this.lines[r].geometry.instanceCount = Math.max(j, 1);   // Line2 draws one segment per instance
      const [lat, lon, alt] = track[j];
      this.balloons[r].position.copy(toXYZ(lat, lon, altR(alt) + (r === "you" ? YOU_LIFT : 0)));
    }
    for (const t of this.targets)
      t.mesh.material.color.set(agentGot.has(t.name) ? 0x4ade80 : anyGot.has(t.name) ? 0x7cc4ff : 0xf2e6d0);
    for (const ev of this.events) {
      const live = T >= ev.e.t_h && T < ev.e.ends_h;
      ev.ring.visible = live;
      const shown = live && (heard.has(ev.e.id) || agentGot.has(ev.e.id));
      ev.label.visible = shown;
      if (!live) continue;
      const age = (T - ev.e.t_h) / (ev.e.ends_h - ev.e.t_h);
      ev.ring.material.color.set(agentGot.has(ev.e.id) ? 0x4ade80 : heard.has(ev.e.id) ? 0xfde047 : 0xf87171);
      ev.ring.material.opacity = 1 - 0.6 * age;
    }
  }

  render() {
    if (this.follow && this.balloons && this.balloons.you.position.lengthSq() > 0.5) {
      // Glide the camera to sit above the agent, a little behind it (east, since it flies west).
      const b = this.balloons.you.position.clone().normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(b).normalize().negate();
      const want = b.clone().multiplyScalar(3.3).add(east.multiplyScalar(0.9)).add(new THREE.Vector3(0, 0.5, 0));
      this.camera.position.lerp(want, 0.04);
      this.controls.target.lerp(new THREE.Vector3(), 0.1);
    }
    this.controls.update();
    // Hide labels on the far side of the planet.
    const cam = this.camera.position.clone().normalize();
    const facing = (o) => o.getWorldPosition(new THREE.Vector3()).normalize().dot(cam) > 0.15;
    for (const t of this.targets || []) t.label.element.style.opacity = facing(t.label) ? 1 : 0;
    for (const ev of this.events || []) if (ev.label.visible) ev.label.element.style.opacity = facing(ev.label) ? 1 : 0;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

window.venusGlobe = new Globe(document.getElementById("globe"));
document.dispatchEvent(new Event("globe-ready"));

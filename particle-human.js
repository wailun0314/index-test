/* ============================================================================
   ASYMMETRY PROTOCOL — Particle Human  v3 "fine dust"
   ----------------------------------------------------------------------------
   What changed vs v2, and why:

   1. Grain size is the whole point of this rewrite. v2 drew ~8k points sized in
      world units, so the same particle got physically larger whenever the
      container got larger (worst case: the full-screen entrance). Points also
      had a soft, wide falloff, so once several overlapped they merged into
      blobs. v3 fixes both:
        - gl_PointSize is normalised against a FIXED reference height
          (CONFIG.render.sizeRefHeight), so a grain stays ~1-3 CSS px whether it
          is in the small card or on the full-screen boot. Bigger container =
          bigger body, same fine grain.
        - gl_PointSize is hard-clamped to [minPx, maxPx] device pixels.
        - Sizes follow a cubic distribution: the overwhelming majority sit at
          the minimum, only a few percent are large.
        - Two point profiles in one draw call (aSoft): crisp sand for the mass,
          soft halo for the few bright ones.

   2. Particle count is up (38k desktop / 15k mobile) because fine grain only
      reads as a body if there are enough grains. Generation uses ball-local
      sampling instead of box rejection, so the build stays fast.

   3. Real depth: particles behind the mid-plane are dimmer and smaller.

   4. Entrance ("replay") is done on the GPU with a per-particle scatter
      position and a bottom-up delay. No CPU buffer uploads.

   ----------------------------------------------------------------------------
   Public API on window.ParticleHuman — all of it is safe to call at any time:

     mount(containerEl)     idempotent; call on every render
     destroy()              full teardown
     replay()               re-run the entrance assembly
     setAsymmetry(0..1)     0 = neutral, 1 = maximum lean/drift
     setPalette({...})      change colours (rebuilds the cloud)
     configure({...})       deep-merge into CONFIG (rebuilds if needed)
     getConfig()            live config object, for the tuning lab
     isReady()              boolean
   ============================================================================ */

import * as THREE from 'three';

/* ============================================================================
   CONFIG
   ============================================================================ */
const CONFIG = {
  slotId: 'particle-human-slot',

  colors: {
    deep:  '#2C3646',   // the resting colour of the dim mass
    base:  '#C9D6E8',   // cool white — the main dust colour
    left:  '#7FC8DE',   // left-side tint  (matches --left-strong)
    right: '#E8C37F',   // right-side tint (matches --right-strong)
    spark: '#B9A7FF',   // rare violet highlight, ties to the UI accent
  },

  tint: {
    strength: 0.34,     // 0 = pure white body, 1 = hard blue/gold split
    sparkFraction: 0.07,
  },

  particles: {
    countDesktop: 42000,
    countMobile: 24000,
    brightFraction: 0.05,   // fraction that reads as a foreground light
    shellThickness: 0.075,  // thinner shell = crisper silhouette edge
    coreSparsity: 0.10,     // sampling probability deep inside the body
    metaballBlend: 0.040,
    surfaceBias: 0.62,      // 0..1 — how strongly sampling hugs the surface
  },

  render: {
    sizeMin: 0.0072,        // world units, evaluated at sizeRefHeight
    sizeMax: 0.0260,
    sizeBias: 3.0,          // exponent; higher = more particles at minimum
    sizeRefHeight: 240,     // px — grain size is normalised against this
    minPx: 1.0,             // hard clamp, CSS px
    maxPx: 3.4,
    opacity: 0.74,
    densityRefHeight: 440,  // container height at which the full cloud is drawn
    densityFloor: 0.30,     // never draw fewer than this fraction of the cloud
    depthFade: 0.30,        // alpha multiplier for the furthest particles
    softness: 0.85,         // halo profile strength for bright particles
    dimFloor: 0.15,         // brightness range of the non-highlight mass
    dimCeil: 0.66,
  },

  camera: {
    fov: 32,
    distance: 3.55,
    height: 0.03,
    // On a wide container the figure is pushed off-centre so the left of the
    // card is free for a label. On a narrow (mobile) container it stays
    // centred — the shift fades in with the aspect ratio.
    offsetX: 0.55,
  },

  breathing: { amplitude: 0.016, periodSec: 8.5, chestBias: 0.55 },
  rotation:  { amplitude: 0.13, periodSec: 16 },

  entrance: { durationSec: 2.8, scatterMin: 1.0, scatterMax: 2.4, flatten: 0.5 },

  asymmetry: {
    value: 0,          // driven by setAsymmetry()
    tiltMax: 0.055,    // max lean, world units at the head
    driftMax: 0.5,     // extra idle drift on the loaded side
  },

  mouse: {
    radius: 0.5,
    strength: 0.13,
    positionDamping: 0.055,
    strengthDamping: 0.075,
    edgeMargin: 48,
  },

  noise: { amplitude: 0.0035, speed: 0.5 },

  pixelRatioCap: { desktop: 2, mobile: 2 },
};

/* ============================================================================
   Body definition
   A chain of blended spheres approximating a standing figure at roughly
   8-head proportions. Never rendered — only used to test whether a candidate
   point falls inside the body volume.
   ============================================================================ */
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function buildBodyBalls() {
  const balls = [];
  const add = (x, y, z, r) => balls.push({ x, y, z, r });

  // a tapered chain of spheres between two points — used for limbs and the neck
  const limb = (p0, p1, r0, r1, steps) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      add(lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), lerp(p0[2], p1[2], t), lerp(r0, r1, t));
    }
  };

  // a horizontal row of spheres at one height. The torso is built from these
  // rather than from single large spheres: a sphere wide enough for the chest
  // would also be tall enough to swallow the neck, which is what made earlier
  // versions read as a hooded blob instead of a figure. Width and depth are
  // controlled separately here, which is also anatomically correct — a torso
  // is much wider than it is deep.
  const slab = (y, halfWidth, r, z, steps) => {
    const span = Math.max(halfWidth - r, 0);
    const n = Math.max(steps || 3, 1);
    for (let i = 0; i <= n; i++) add(lerp(-span, span, i / n), y, z, r);
  };

  // very slight contrapposto so the figure does not read as a mannequin
  const sway = 0.010;

  // ---- head: four stacked spheres, tallest through the cranium ----
  add(0, 0.928, -0.004, 0.078);
  add(0, 0.888, 0.002, 0.086);
  add(0, 0.845, 0.010, 0.078);
  add(0, 0.805, 0.018, 0.062);

  // ---- neck ----
  limb([0, 0.766, 0.008], [0, 0.716, 0.004], 0.043, 0.048, 2);

  // ---- trapezius slope down to the shoulder line ----
  limb([0, 0.702, 0.0], [-0.148, 0.664, 0.0], 0.044, 0.048, 3);
  limb([0, 0.702, 0.0], [0.148, 0.664, 0.0], 0.044, 0.048, 3);

  // ---- torso, slice by slice (y, halfWidth, depthRadius, z, steps) ----
  slab(0.648, 0.164, 0.054, 0.006, 4);
  slab(0.606, 0.180, 0.072, 0.012, 4);
  slab(0.556, 0.178, 0.080, 0.016, 4);
  slab(0.502, 0.170, 0.082, 0.014, 4);
  slab(0.448, 0.150, 0.078, 0.008, 3);
  slab(0.392, 0.132, 0.072, 0.002, 3);
  slab(0.336, 0.130 + sway, 0.072, -0.002, 3);
  slab(0.278, 0.146 + sway, 0.078, -0.004, 3);
  slab(0.220, 0.158 + sway, 0.082, -0.006, 3);
  slab(0.162, 0.152 + sway, 0.080, -0.004, 3);
  slab(0.108, 0.132 + sway, 0.074, 0.0, 3);

  // ---- deltoids ----
  add(-0.198, 0.626, 0.006, 0.068);
  add(0.198, 0.626, 0.006, 0.068);

  // ---- arms: slight elbow bend, and a gap at the waist so the silhouette
  //      between arm and torso stays open ----
  limb([-0.218, 0.594, 0.010], [-0.276, 0.396, 0.030], 0.062, 0.048, 4);
  limb([-0.276, 0.396, 0.030], [-0.310, 0.188, 0.010], 0.046, 0.038, 4);
  limb([-0.310, 0.188, 0.010], [-0.316, 0.088, 0.022], 0.038, 0.035, 2);
  add(-0.320, 0.054, 0.026, 0.035);

  limb([0.218, 0.594, 0.010], [0.276, 0.396, 0.030], 0.062, 0.048, 4);
  limb([0.276, 0.396, 0.030], [0.310, 0.188, 0.010], 0.046, 0.038, 4);
  limb([0.310, 0.188, 0.010], [0.316, 0.088, 0.022], 0.038, 0.035, 2);
  add(0.320, 0.054, 0.026, 0.035);

  // ---- legs: thigh -> knee -> calf -> ankle -> foot ----
  limb([-0.086 + sway, 0.096, 0.0], [-0.096, -0.170, 0.008], 0.098, 0.074, 4);
  add(-0.098, -0.296, 0.004, 0.060);
  limb([-0.098, -0.328, 0.006], [-0.096, -0.520, 0.016], 0.058, 0.056, 3);
  limb([-0.096, -0.520, 0.016], [-0.092, -0.836, 0.002], 0.053, 0.034, 4);
  limb([-0.092, -0.878, -0.024], [-0.090, -0.916, 0.098], 0.036, 0.028, 3);

  limb([0.086 + sway, 0.096, 0.0], [0.098, -0.170, 0.008], 0.098, 0.074, 4);
  add(0.100, -0.296, 0.004, 0.060);
  limb([0.100, -0.328, 0.006], [0.098, -0.520, 0.016], 0.058, 0.056, 3);
  limb([0.098, -0.520, 0.016], [0.094, -0.836, 0.002], 0.053, 0.034, 4);
  limb([0.094, -0.878, -0.024], [0.092, -0.916, 0.098], 0.036, 0.028, 3);

  return balls;
}

let BODY = null;
function prepareBody() {
  const balls = buildBodyBalls();
  const n = balls.length;
  const bx = new Float32Array(n), by = new Float32Array(n),
        bz = new Float32Array(n), br = new Float32Array(n);
  const weight = new Float32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    bx[i] = balls[i].x; by[i] = balls[i].y; bz[i] = balls[i].z; br[i] = balls[i].r;
    const w = br[i] * br[i] * br[i];
    total += w;
    weight[i] = total;
  }
  BODY = { n, bx, by, bz, br, weight, total };
}
prepareBody();

/* Signed distance to the smooth union of all body spheres.
   The squared-distance pre-check skips spheres that cannot lower the current
   minimum, which removes most of the sqrt calls. */
function sdBody(x, y, z, k) {
  const { n, bx, by, bz, br } = BODY;
  let d = Infinity;
  const k4 = 4 * k;
  for (let i = 0; i < n; i++) {
    const dx = x - bx[i], dy = y - by[i], dz = z - bz[i];
    const q = dx * dx + dy * dy + dz * dz;
    if (d < Infinity) {
      const cut = br[i] + d + k4;
      if (cut > 0 && q > cut * cut) continue;
    }
    const dist = Math.sqrt(q) - br[i];
    if (d === Infinity) { d = dist; continue; }
    const h = clamp(0.5 + 0.5 * (dist - d) / k, 0, 1);
    d = lerp(dist, d, h) - k * h * (1 - h);
  }
  return d;
}

function pickBall(r) {
  const { weight, n, total } = BODY;
  const target = r * total;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (weight[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ============================================================================
   Shaders
   ============================================================================ */
const VERTEX_SHADER = `
uniform float uTime;
uniform float uBreath;
uniform float uChestBias;
uniform float uRotation;
uniform vec3  uMouse;
uniform float uMouseStrength;
uniform float uMouseRadius;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uNoiseAmp;
uniform float uNoiseSpeed;
uniform float uAssemble;
uniform float uAsym;
uniform float uTilt;
uniform float uDrift;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uOpacity;
uniform float uDepthFade;

attribute vec3  aScatter;
attribute vec3  aColor;
attribute float aSize;
attribute float aRandom;
attribute float aSoft;
attribute float aSide;

varying vec3  vColor;
varying float vAlpha;
varying float vSoft;

void main() {
  float phase = aRandom * 62.831853;

  // ---- entrance: bottom-up assembly from the scattered start position ----
  float delay = clamp((position.y + 1.0) * 0.244 + aRandom * 0.32, 0.0, 0.88);
  float a = clamp((uAssemble - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
  a = a * a * (3.0 - 2.0 * a);
  vec3 pos = mix(aScatter, position, a);

  // ---- idle drift; the loaded side moves marginally more ----
  float amp = uNoiseAmp * (1.0 + uDrift * uAsym * max(aSide, 0.0));
  pos += amp * vec3(
    sin(uTime * uNoiseSpeed + phase),
    cos(uTime * uNoiseSpeed * 0.86 + phase * 1.3),
    sin(uTime * uNoiseSpeed * 0.74 + phase * 0.7)
  );

  // ---- breathing: weighted toward the chest, never a hard pulse ----
  vec3 center = vec3(0.0, 0.02, 0.0);
  float chest = exp(-pow((position.y - 0.55) * 2.6, 2.0));
  vec3 rel = pos - center;
  pos = center + rel * (1.0 + uBreath * (1.0 - uChestBias + uChestBias * 2.0 * chest));

  // ---- asymmetry lean: grows with height, so the head travels furthest ----
  float h = clamp((position.y + 1.0) * 0.5, 0.0, 1.0);
  pos.x += uTilt * uAsym * h * h;

  // ---- slow oscillating rotation about Y (never a full spin) ----
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec3 rp = pos - center;
  pos = center + vec3(rp.x * c + rp.z * s, rp.y, rp.z * c - rp.x * s);

  // ---- soft local mouse field (already eased on the CPU) ----
  vec3 toP = pos - uMouse;
  float md = length(toP);
  float falloff = 1.0 - smoothstep(0.0, uMouseRadius, md);
  pos += (toP / max(md, 0.0001)) * falloff * uMouseStrength;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  // ---- depth: further back means smaller and dimmer ----
  float depth = smoothstep(-0.42, 0.42, pos.z);
  float twinkle = 0.84 + 0.16 * sin(uTime * 0.9 + phase);

  float px = aSize * uSizeScale * uPixelRatio / max(-mv.z, 0.001);
  px *= mix(0.74, 1.0, depth);
  px *= mix(0.55, 1.0, a);
  gl_PointSize = clamp(px, uMinPx * uPixelRatio, uMaxPx * uPixelRatio);

  vColor = aColor;
  vSoft  = aSoft;
  vAlpha = uOpacity * twinkle * mix(uDepthFade, 1.0, depth) * mix(0.30, 1.0, a);
}
`;

const FRAGMENT_SHADER = `
uniform float uSoftness;
varying vec3  vColor;
varying float vAlpha;
varying float vSoft;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;

  // crisp grain for the mass, soft halo for the few bright ones
  float sharp = 1.0 - smoothstep(0.24, 0.48, d);
  float soft  = pow(max(1.0 - d * 2.0, 0.0), 2.2);
  float a = mix(sharp, soft, vSoft * uSoftness) * vAlpha;
  if (a <= 0.003) discard;

  gl_FragColor = vec4(vColor, a);
}
`;

/* ============================================================================
   Cloud generation
   ============================================================================ */
function generateParticleData(count) {
  const P = CONFIG.particles;
  const R = CONFIG.render;
  const E = CONFIG.entrance;
  const k = P.metaballBlend;

  const positions = new Float32Array(count * 3);
  const scatters  = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);
  const sizes     = new Float32Array(count);
  const randoms   = new Float32Array(count);
  const softs     = new Float32Array(count);
  const sides     = new Float32Array(count);

  const cDeep  = new THREE.Color(CONFIG.colors.deep);
  const cBase  = new THREE.Color(CONFIG.colors.base);
  const cLeft  = new THREE.Color(CONFIG.colors.left);
  const cRight = new THREE.Color(CONFIG.colors.right);
  const cSpark = new THREE.Color(CONFIG.colors.spark);
  const hue = new THREE.Color();
  const out = new THREE.Color();

  const { bx, by, bz, br } = BODY;
  const tint = CONFIG.tint.strength;

  // radius exponent: 1/3 samples uniformly through the sphere, small values
  // pull samples toward its surface
  const radExp = lerp(1 / 3, 0.08, clamp(P.surfaceBias, 0, 1));

  let i = 0, tries = 0;
  const maxTries = count * 40;

  while (i < count && tries < maxTries) {
    tries++;

    // sample near a volume-weighted body sphere instead of the whole bounding
    // box — this keeps the accept rate high enough for 38k particles
    const bi = pickBall(Math.random());
    const rad = br[bi] * Math.pow(Math.random(), radExp);
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const sp = Math.sqrt(Math.max(0, 1 - u * u));
    const x = bx[bi] + rad * sp * Math.cos(th);
    const y = by[bi] + rad * sp * Math.sin(th);
    const z = bz[bi] + rad * u;

    const d = sdBody(x, y, z, k);
    if (d >= 0) continue;

    const depthIn = -d;
    const shell = clamp(1 - depthIn / P.shellThickness, P.coreSparsity, 1);
    if (Math.random() > shell) continue;

    const o = i * 3;
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;

    // entrance start: a wide, flattened cloud around the figure
    const su = Math.random() * 2 - 1;
    const sth = Math.random() * Math.PI * 2;
    const ssp = Math.sqrt(Math.max(0, 1 - su * su));
    const srad = E.scatterMin + Math.random() * (E.scatterMax - E.scatterMin);
    scatters[o]     = x * 0.2 + srad * ssp * Math.cos(sth);
    scatters[o + 1] = y * 0.2 + srad * su * E.flatten;
    scatters[o + 2] = z * 0.2 + srad * ssp * Math.sin(sth) * 0.7;

    const r01 = Math.random();
    randoms[i] = r01;

    const isBright = Math.random() < P.brightFraction;
    const b = isBright ? (0.62 + Math.random() * 0.38)
                       : R.dimFloor + Math.pow(Math.random(), 1.7) * (R.dimCeil - R.dimFloor);

    // side tint: strongest at the outer edge of each side, none at the midline
    const sideNorm = clamp(Math.abs(x) / 0.30, 0, 1);
    const side = x < -0.012 ? -1 : (x > 0.012 ? 1 : 0);
    sides[i] = side;

    if (Math.random() < CONFIG.tint.sparkFraction) {
      hue.copy(cSpark);
    } else {
      hue.copy(cBase);
      if (side !== 0) hue.lerp(side < 0 ? cLeft : cRight, tint * sideNorm);
    }

    // brightness scales the colour directly — additive blending means a dim
    // particle is a dim light, not a dark dot pasted on the background
    out.copy(hue).multiplyScalar(b);
    out.r += cDeep.r * 0.12; out.g += cDeep.g * 0.12; out.b += cDeep.b * 0.16;
    colors[o] = out.r; colors[o + 1] = out.g; colors[o + 2] = out.b;

    sizes[i] = lerp(R.sizeMin, R.sizeMax, Math.pow(Math.random(), R.sizeBias)) * (0.8 + b * 0.7);
    softs[i] = isBright ? 1 : (b > 0.18 ? 0.35 : 0);

    i++;
  }

  return {
    count: i,
    positions: positions.subarray(0, i * 3),
    scatters: scatters.subarray(0, i * 3),
    colors: colors.subarray(0, i * 3),
    sizes: sizes.subarray(0, i),
    randoms: randoms.subarray(0, i),
    softs: softs.subarray(0, i),
    sides: sides.subarray(0, i),
  };
}

function buildGeometry(count) {
  const data = generateParticleData(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute('aScatter', new THREE.BufferAttribute(data.scatters, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(data.colors, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(data.sizes, 1));
  geo.setAttribute('aRandom',  new THREE.BufferAttribute(data.randoms, 1));
  geo.setAttribute('aSoft',    new THREE.BufferAttribute(data.softs, 1));
  geo.setAttribute('aSide',    new THREE.BufferAttribute(data.sides, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.6);
  state.liveCount = data.count;
  return geo;
}

/* ============================================================================
   Module state
   ============================================================================ */
const state = {
  initialized: false, running: false, container: null,
  renderer: null, scene: null, camera: null, canvas: null,
  geometry: null, material: null, points: null, clock: null, raf: null,
  isMobile: false, liveCount: 0, dpr: 1,
  reducedMotion: false, reducedMotionMedia: null, reducedMotionHandler: null,
  resizeObserver: null, intersectionObserver: null, visibilityHandler: null,
  raycaster: null, mousePlane: null,
  mouseTarget: null, mouseCur: null,
  mouseStrengthTarget: 0, mouseStrengthCur: 0,
  assemble: 1, assembleStart: -1,
};

const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();

function particleCount() {
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 8;
  let n = state.isMobile ? CONFIG.particles.countMobile : CONFIG.particles.countDesktop;
  if (mem <= 4 || cores <= 4) n = Math.round(n * 0.6);
  return n;
}

function onPointerMove(e) {
  if (!state.container || !state.canvas || !document.contains(state.canvas)) return;
  const rect = state.container.getBoundingClientRect();
  const m = CONFIG.mouse.edgeMargin;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < -m || y < -m || x > rect.width + m || y > rect.height + m) {
    state.mouseStrengthTarget = 0;
    return;
  }
  _ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  state.raycaster.setFromCamera(_ndc, state.camera);
  if (state.raycaster.ray.intersectPlane(state.mousePlane, _hit)) {
    state.mouseTarget.copy(_hit);
    state.mouseStrengthTarget = CONFIG.mouse.strength;
  }
}
function onPointerLeave() { state.mouseStrengthTarget = 0; }

/* Grain size is normalised against a fixed reference height, so it does not
   grow when the container does. This is what keeps the full-screen entrance
   as fine as the small card. */
function sizeScale() {
  return (CONFIG.render.sizeRefHeight * 0.5) /
         Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) * 0.5);
}

/* Grain size is fixed, so a small container would otherwise show the same
   number of particles packed into a much smaller silhouette and blow out to
   white — which is exactly what the earlier version did on the card. Instead,
   the number of particles actually drawn scales with the container, and the
   remaining difference is trimmed with opacity. The cloud itself is built once
   and never regenerated; drawRange just takes a prefix, and because particles
   are generated in random order that prefix is a uniform random subset. */
function applyDensity() {
  if (!state.geometry || !state.material) return;
  const R = CONFIG.render;
  const h = (state.container && state.container.clientHeight) || R.densityRefHeight;
  const ratio = h / R.densityRefHeight;

  const frac = clamp(Math.pow(ratio, 1.35), R.densityFloor, 1);
  state.geometry.setDrawRange(0, Math.max(1200, Math.round(state.liveCount * frac)));

  state.material.uniforms.uOpacity.value =
    R.opacity * clamp(Math.pow(ratio, 0.55), 0.82, 1.6);
}

function applyComposition(w, h) {
  const aspect = w / Math.max(h, 1);
  const t = clamp((aspect - 1.15) / 1.35, 0, 1);
  const x = -CONFIG.camera.offsetX * t;
  state.camera.position.set(x, CONFIG.camera.height, CONFIG.camera.distance);
  state.camera.lookAt(x, CONFIG.camera.height, 0);
}

function syncSize() {
  if (!state.renderer || !state.container) return;
  const w = state.container.clientWidth || 1;
  const h = state.container.clientHeight || 1;
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / Math.max(h, 1);
  applyComposition(w, h);
  state.camera.updateProjectionMatrix();
  state.material.uniforms.uSizeScale.value = sizeScale();
  applyDensity();
  if (state.reducedMotion || !state.running) renderOnce();
}

function renderOnce() {
  if (!state.renderer) return;
  const u = state.material.uniforms;
  u.uAssemble.value = 1;
  u.uBreath.value = 0;
  u.uRotation.value = 0;
  u.uMouseStrength.value = 0;
  state.renderer.render(state.scene, state.camera);
}

function tick() {
  state.raf = requestAnimationFrame(tick);
  const t = state.clock.getElapsedTime();
  const u = state.material.uniforms;

  u.uTime.value = t;
  u.uBreath.value = Math.sin((t / CONFIG.breathing.periodSec) * Math.PI * 2) * CONFIG.breathing.amplitude;
  u.uRotation.value = Math.sin((t / CONFIG.rotation.periodSec) * Math.PI * 2) * CONFIG.rotation.amplitude;

  if (state.assembleStart >= 0) {
    const p = clamp((t - state.assembleStart) / CONFIG.entrance.durationSec, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    u.uAssemble.value = eased;
    if (p >= 1) state.assembleStart = -1;
  }

  state.mouseCur.lerp(state.mouseTarget, CONFIG.mouse.positionDamping);
  state.mouseStrengthCur += (state.mouseStrengthTarget - state.mouseStrengthCur) * CONFIG.mouse.strengthDamping;
  u.uMouse.value.copy(state.mouseCur);
  u.uMouseStrength.value = state.mouseStrengthCur;

  state.renderer.render(state.scene, state.camera);
}

function resume() {
  if (!state.renderer) return;
  if (state.reducedMotion) { renderOnce(); return; }
  if (state.running) return;
  state.running = true;
  state.clock.start();
  tick();
}

function pause() {
  if (state.raf != null) cancelAnimationFrame(state.raf);
  state.raf = null;
  state.running = false;
}

function makeUniforms() {
  const R = CONFIG.render;
  return {
    uTime:          { value: 0 },
    uBreath:        { value: 0 },
    uChestBias:     { value: CONFIG.breathing.chestBias },
    uRotation:      { value: 0 },
    uMouse:         { value: new THREE.Vector3(0, 0.05, 5) },
    uMouseStrength: { value: 0 },
    uMouseRadius:   { value: CONFIG.mouse.radius },
    uPixelRatio:    { value: state.dpr },
    uSizeScale:     { value: sizeScale() },
    uNoiseAmp:      { value: CONFIG.noise.amplitude },
    uNoiseSpeed:    { value: CONFIG.noise.speed },
    uAssemble:      { value: 1 },
    uAsym:          { value: CONFIG.asymmetry.value },
    uTilt:          { value: CONFIG.asymmetry.tiltMax },
    uDrift:         { value: CONFIG.asymmetry.driftMax },
    uMinPx:         { value: R.minPx },
    uMaxPx:         { value: R.maxPx },
    uOpacity:       { value: R.opacity },
    uDepthFade:     { value: R.depthFade },
    uSoftness:      { value: R.softness },
  };
}

function initScene(container) {
  state.container = container;
  state.clock = new THREE.Clock(false);

  state.reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.reducedMotion = state.reducedMotionMedia.matches;
  state.isMobile = window.matchMedia('(max-width: 640px)').matches ||
                   window.matchMedia('(pointer: coarse)').matches;

  const width = container.clientWidth || 320;
  const height = container.clientHeight || 220;

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, width / Math.max(height, 1), 0.1, 12);
  applyComposition(width, height);

  state.renderer = new THREE.WebGLRenderer({
    antialias: false,          // points are 1-3 px; MSAA costs fill rate for nothing
    alpha: true,
    powerPreference: 'high-performance',
  });
  state.renderer.setClearColor(0x000000, 0);
  state.dpr = Math.min(window.devicePixelRatio || 1,
    state.isMobile ? CONFIG.pixelRatioCap.mobile : CONFIG.pixelRatioCap.desktop);
  state.renderer.setPixelRatio(state.dpr);
  state.renderer.setSize(width, height, false);

  state.canvas = state.renderer.domElement;
  state.canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
  container.appendChild(state.canvas);

  state.geometry = buildGeometry(particleCount());

  state.material = new THREE.ShaderMaterial({
    uniforms: makeUniforms(),
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  state.points = new THREE.Points(state.geometry, state.material);
  state.points.frustumCulled = false;
  state.scene.add(state.points);
  applyDensity();

  state.raycaster = new THREE.Raycaster();
  state.mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  state.mouseTarget = new THREE.Vector3(0, 0.05, 5);
  state.mouseCur = new THREE.Vector3(0, 0.05, 5);

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);

  state.reducedMotionHandler = (e) => {
    state.reducedMotion = e.matches;
    if (state.reducedMotion) { pause(); renderOnce(); } else { resume(); }
  };
  if (state.reducedMotionMedia.addEventListener) {
    state.reducedMotionMedia.addEventListener('change', state.reducedMotionHandler);
  } else if (state.reducedMotionMedia.addListener) {
    state.reducedMotionMedia.addListener(state.reducedMotionHandler);
  }

  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => syncSize());
    state.resizeObserver.observe(container);
  }
  if ('IntersectionObserver' in window) {
    state.intersectionObserver = new IntersectionObserver(
      (entries) => entries.forEach((en) => (en.isIntersecting ? resume() : pause())),
      { threshold: 0.01 }
    );
    state.intersectionObserver.observe(state.canvas);
  }
  state.visibilityHandler = () => {
    if (document.hidden) pause();
    else if (document.contains(state.canvas)) resume();
  };
  document.addEventListener('visibilitychange', state.visibilityHandler);
}

/* ============================================================================
   Public API
   ============================================================================ */
function mount(container) {
  if (!container) return;

  if (!state.initialized) {
    try {
      initScene(container);
      state.initialized = true;
      state.container = container;
      syncSize();
      resume();
      replay();
    } catch (err) {
      console.warn('[ParticleHuman] init failed — hiding the visual.', err);
      if (container && container.style) container.style.display = 'none';
    }
    return;
  }

  if (state.canvas.parentElement !== container) container.appendChild(state.canvas);
  state.container = container;
  syncSize();
  resume();
}

function replay() {
  if (!state.initialized || state.reducedMotion) return;
  state.material.uniforms.uAssemble.value = 0;
  state.assembleStart = state.clock.getElapsedTime();
}

function setAsymmetry(v) {
  const n = clamp(Number(v) || 0, 0, 1);
  CONFIG.asymmetry.value = n;
  if (state.initialized) state.material.uniforms.uAsym.value = n;
}

/* `applyDensity` owns uOpacity because the right value depends on how big the
   container is, so CONFIG.render.opacity is a base that it scales. */

/* Push everything in CONFIG that is a shader uniform. Cheap — no geometry
   work — so this is what the tuning lab calls while a slider is being dragged. */
function applyUniforms() {
  if (!state.initialized) return;
  const u = state.material.uniforms;
  const R = CONFIG.render;
  u.uMinPx.value = R.minPx;
  u.uMaxPx.value = R.maxPx;
  u.uDepthFade.value = R.depthFade;
  u.uSoftness.value = R.softness;
  u.uSizeScale.value = sizeScale();
  u.uNoiseAmp.value = CONFIG.noise.amplitude;
  u.uNoiseSpeed.value = CONFIG.noise.speed;
  u.uChestBias.value = CONFIG.breathing.chestBias;
  u.uMouseRadius.value = CONFIG.mouse.radius;
  u.uAsym.value = CONFIG.asymmetry.value;
  u.uTilt.value = CONFIG.asymmetry.tiltMax;
  u.uDrift.value = CONFIG.asymmetry.driftMax;
  applyDensity();          // also sets uOpacity, which depends on container size
  if (!state.running) renderOnce();
}

/* Uniform-only update: safe to call on every input event. */
function tune(patch) {
  if (patch) deepMerge(CONFIG, patch);
  if (!state.initialized) return;
  state.camera.fov = CONFIG.camera.fov;
  applyComposition((state.container && state.container.clientWidth) || 1,
                   (state.container && state.container.clientHeight) || 1);
  state.camera.updateProjectionMatrix();
  applyUniforms();
}

/* Regenerates the point cloud. Needed whenever a value that is baked into a
   buffer changes: count, sizes, colours, shell shape. */
function rebuild() {
  if (!state.initialized) return;
  const old = state.geometry;
  state.geometry = buildGeometry(particleCount());
  state.points.geometry = state.geometry;
  if (old) old.dispose();
  applyUniforms();
}

function setPalette(next) {
  if (!next) return;
  Object.assign(CONFIG.colors, next);
  if (typeof next.tint === 'number') CONFIG.tint.strength = clamp(next.tint, 0, 1);
  rebuild();
}

function deepMerge(target, src) {
  Object.keys(src || {}).forEach((key) => {
    const v = src[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[key] === 'object') {
      deepMerge(target[key], v);
    } else if (v !== undefined) {
      target[key] = v;
    }
  });
}

function configure(patch) {
  deepMerge(CONFIG, patch);
  if (state.initialized) {
    state.camera.fov = CONFIG.camera.fov;
    applyComposition(state.container ? state.container.clientWidth : 1,
                     state.container ? state.container.clientHeight : 1);
    state.camera.updateProjectionMatrix();
    rebuild();
  }
}

function destroy() {
  if (!state.initialized) return;
  pause();
  if (state.resizeObserver) state.resizeObserver.disconnect();
  if (state.intersectionObserver) state.intersectionObserver.disconnect();
  if (state.visibilityHandler) document.removeEventListener('visibilitychange', state.visibilityHandler);
  window.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerleave', onPointerLeave);
  if (state.reducedMotionMedia && state.reducedMotionHandler) {
    if (state.reducedMotionMedia.removeEventListener) {
      state.reducedMotionMedia.removeEventListener('change', state.reducedMotionHandler);
    } else if (state.reducedMotionMedia.removeListener) {
      state.reducedMotionMedia.removeListener(state.reducedMotionHandler);
    }
  }
  if (state.geometry) state.geometry.dispose();
  if (state.material) state.material.dispose();
  if (state.renderer) {
    state.renderer.dispose();
    if (state.renderer.forceContextLoss) state.renderer.forceContextLoss();
  }
  if (state.canvas && state.canvas.parentElement) state.canvas.parentElement.removeChild(state.canvas);

  Object.assign(state, {
    initialized: false, running: false, container: null, renderer: null, scene: null,
    camera: null, canvas: null, geometry: null, material: null, points: null,
    raf: null, resizeObserver: null, intersectionObserver: null, visibilityHandler: null,
    liveCount: 0, assembleStart: -1, assemble: 1,
  });
}

const ParticleHuman = {
  mount, destroy, replay, setAsymmetry, setPalette, configure,
  tune, rebuild,
  getConfig: () => CONFIG,
  getStats: () => ({ count: state.liveCount, dpr: state.dpr, mobile: state.isMobile }),
  isReady: () => state.initialized,
};

if (typeof window !== 'undefined') {
  window.ParticleHuman = ParticleHuman;
  const autoMount = () => {
    const slot = document.getElementById(CONFIG.slotId);
    if (slot) mount(slot);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  } else {
    autoMount();
  }
}

export default ParticleHuman;

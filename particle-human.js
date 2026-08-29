/* ============================================================================
   ASYMMETRY PROTOCOL — Particle Human  v2
   ----------------------------------------------------------------------------
   What changed from v1, and why:

   1. DEPTH.      The shader now dims and shrinks particles by their z position.
                  v1 had no depth cue at all, which is why the figure read as a
                  flat green smear instead of a volume. This is the single
                  biggest visual fix in the file.

   2. COLOUR.     Dropped the imported #42F5A7 neon green. The figure is now
                  built from the site's own left/right language:
                      spine / midline -> cool white
                      left  side      -> --left   #57A0B5
                      right side      -> --right  #D4A04A
                  Hue separation ramps up with |x|, so it reads as one body at
                  two temperatures, not a two-tone collage.

   3. ASYMMETRY.  The figure is no longer mirror-symmetric. A single uniform
                  (uAsym, 0..1) drives a PRI-flavoured offset: pelvis rotates
                  right, thorax counter-rotates left, weight shifts onto the
                  left foot, right shoulder drops and travels forward, and the
                  right side reads slightly denser. Feed it real test data via
                  ParticleHuman.setAsymmetry().

   4. RENDER.     Points are now core + halo (two exponential falloffs) with an
                  overexposed centre on bright particles, instead of a hard
                  linear disc. Twinkle is gated to ~12% of particles instead of
                  all of them.

   5. BREATHING.  Anatomical, not a uniform scale. The ribcage expands mostly
                  front-to-back, the shoulder girdle rides up a little, the legs
                  barely move.

   6. ENTRANCE.   The body assembles from the floor up over ~2.6s. Call
                  ParticleHuman.replay() to run it again (e.g. on date change).

   7. FRAMING.    Camera pulled back so the figure occupies ~72% of the frame
                  height instead of 92%, and offset right of centre on wide
                  containers to leave room for type.

   Public API (v1 compatible):
     ParticleHuman.mount(el)          ParticleHuman.destroy()
     ParticleHuman.replay()           ParticleHuman.setAsymmetry(0..1)
     ParticleHuman.config             ParticleHuman.rebuild()
   ============================================================================ */

import * as THREE from 'three';

/* ============================================================================
   CONFIG — every knob worth turning lives here.
   Values marked [live] take effect immediately; the rest need rebuild().
   ============================================================================ */
const CONFIG = {
  slotId: 'particle-human-slot',

  colors: {
    spine: '#DCE9EC',   // midline / neutral core — cool white   [live]
    left:  '#57A0B5',   // matches --left  in the site's CSS      [live]
    right: '#D4A04A',   // matches --right in the site's CSS      [live]
  },

  tint: 0.46,           // 0 = monochrome body, 1 = full L/R hue split   [live]

  asymmetry: {
    value: 0.55,        // 0 = perfectly symmetric, 1 = maximum          [live]
    easing: 0.03,       // per-frame lerp when setAsymmetry() is called
  },

  particles: {
    countDesktop: 14000,
    countMobile: 4800,
    atmosphereRatio: 0.17,  // extra motes floating around the body
    sizeMin: 0.016,
    sizeMax: 0.050,
    brightFraction: 0.09,   // fewer, but much brighter — wider dynamic range
    dimFalloff: 2.2,        // higher = the dim mass gets dimmer
    coreSparsity: 0.15,
    shellThickness: 0.13,
    metaballBlend: 0.045,
    densityBias: 0.10,      // right side sampled this much more densely
  },

  render: {
    sizeMul: 1.0,         // global particle size multiplier        [live]
    glow: 1.0,            // halo strength on bright particles      [live]
    depthContrast: 0.72,  // 0 = flat, 1 = back of body nearly black [live]
    haze: 1.0,            // overall alpha of the dim particle mass  [live]
  },

  camera: {
    fov: 26,
    distance: 5.4,
    lookY: 0.02,
    offsetXWide: 0.55,    // world units the figure sits right of centre
    offsetAspect: 1.45,   // container aspect above which the offset applies
  },

  breathing: { amplitude: 0.075, periodSec: 8.5 },

  rotation: {             // two detuned sines — never lands on the same pose
    ampA: 0.10, periodA: 17,
    ampB: 0.05, periodB: 29,
    tiltAmp: 0.035, tiltPeriod: 23,
  },

  mouse: {
    radius: 0.42,
    strength: 0.10,
    positionDamping: 0.05,
    strengthDamping: 0.07,
    edgeMargin: 60,
  },

  noise: { amplitude: 0.0035, atmosphereMul: 4.0 },

  entrance: { durationSec: 2.6, spread: 0.55, drop: 0.75 },

  pixelRatioCap: { desktop: 2, mobile: 1.5 },
};

/* ============================================================================
   Body definition
   ----------------------------------------------------------------------------
   Ellipsoid metaballs (per-axis scale), roughly 7.5-head proportions on a
   1.80-unit figure. The ribcage is deliberately wider than it is deep, which a
   sphere-only body can't express and which v1's flat look partly came from.
   Asymmetry is NOT baked in here — it lives in the shader so it stays live.
   ============================================================================ */
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function buildBodyBalls() {
  const balls = [];
  // sx/sy/sz are per-axis radius multipliers (1 = spherical)
  const add = (x, y, z, r, sx, sy, sz) =>
    balls.push({ x, y, z, r, sx: sx || 1, sy: sy || 1, sz: sz || 1 });

  const chain = (p0, p1, r0, r1, steps, sx, sy, sz) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      add(lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), lerp(p0[2], p1[2], t),
          lerp(r0, r1, t), sx, sy, sz);
    }
  };

  // --- head + neck -------------------------------------------------------
  add(0, 0.775, 0.005, 0.105, 0.86, 1.12, 1.0);
  add(0, 0.662, 0.0, 0.042, 1.0, 1.0, 1.0);
  add(0, 0.622, 0.0, 0.040, 1.0, 1.0, 1.0);

  // --- thorax: wide, shallow ---------------------------------------------
  chain([0, 0.575, 0.012], [0, 0.400, 0.018], 0.165, 0.170, 3, 1.22, 1.0, 0.72);
  // --- waist: narrows -----------------------------------------------------
  chain([0, 0.400, 0.018], [0, 0.235, 0.0], 0.170, 0.128, 3, 1.10, 1.0, 0.74);
  // --- pelvis: widens again ----------------------------------------------
  chain([0, 0.235, 0.0], [0, 0.070, 0.0], 0.128, 0.150, 3, 1.14, 1.0, 0.80);

  // --- shoulder girdle ----------------------------------------------------
  add(-0.185, 0.565, 0.008, 0.078, 1.0, 0.86, 0.92);
  add( 0.185, 0.565, 0.008, 0.078, 1.0, 0.86, 0.92);

  // --- arms, relaxed at the sides ----------------------------------------
  for (const s of [-1, 1]) {
    chain([s * 0.205, 0.540, 0.010], [s * 0.268, 0.290, 0.028], 0.072, 0.055, 4, 1, 1, 1);
    chain([s * 0.268, 0.290, 0.028], [s * 0.292, 0.030, 0.018], 0.053, 0.042, 4, 1, 1, 1);
    add(s * 0.298, -0.045, 0.020, 0.044, 0.82, 1.30, 0.62);   // hand
  }

  // --- legs ---------------------------------------------------------------
  for (const s of [-1, 1]) {
    chain([s * 0.082, 0.040, 0.0], [s * 0.098, -0.400, 0.005], 0.096, 0.068, 4, 1, 1, 1);
    chain([s * 0.098, -0.400, 0.005], [s * 0.092, -0.820, -0.005], 0.064, 0.042, 4, 1, 1, 1);
    add(s * 0.090, -0.872, 0.038, 0.044, 0.90, 0.62, 1.55);   // foot
  }

  return balls;
}
const BODY_BALLS = buildBodyBalls();

const BODY_Y_MIN = -0.90;
const BODY_Y_MAX = 0.90;

/* smooth union of the ellipsoid field */
function sdBody(x, y, z, k) {
  let d = Infinity;
  for (let i = 0; i < BODY_BALLS.length; i++) {
    const b = BODY_BALLS[i];
    const dx = (x - b.x) / b.sx;
    const dy = (y - b.y) / b.sy;
    const dz = (z - b.z) / b.sz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
    if (i === 0) { d = dist; continue; }
    const h = clamp(0.5 + 0.5 * (dist - d) / k, 0, 1);
    d = lerp(dist, d, h) - k * h * (1 - h);
  }
  return d;
}

/* ============================================================================
   Shaders
   ============================================================================ */
const VERTEX_SHADER = `
uniform float uTime;
uniform float uBreath;
uniform float uRotY;
uniform float uRotX;
uniform float uAsym;
uniform float uTint;
uniform float uProgress;
uniform vec3  uMouse;
uniform float uMouseStrength;
uniform float uMouseRadius;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uSizeMul;
uniform float uNoiseAmp;
uniform float uNoiseAtmo;
uniform float uDepthContrast;
uniform float uHaze;
uniform vec3  uSpine;
uniform vec3  uLeft;
uniform vec3  uRight;

attribute vec3  aScatter;
attribute float aLum;
attribute float aSide;
attribute float aSize;
attribute float aRandom;
attribute float aDelay;
attribute float aKind;
attribute float aBreath;

varying vec3  vColor;
varying float vAlpha;
varying float vGlow;

const vec3 CENTER = vec3(0.0, 0.02, 0.0);

void main() {
  float phase = aRandom * 62.831853;

  /* ---- entrance: assemble from the floor up ---------------------------- */
  float p = clamp((uProgress - aDelay * 0.5) / 0.5, 0.0, 1.0);
  p = p * p * (3.0 - 2.0 * p);
  vec3 pos = mix(aScatter, position, p);

  /* ---- idle drift (atmosphere drifts more than the body) --------------- */
  float driftAmp = mix(uNoiseAmp, uNoiseAmp * uNoiseAtmo, aKind);
  pos += driftAmp * vec3(
    sin(uTime * 0.31 + phase),
    cos(uTime * 0.23 + phase * 1.7),
    sin(uTime * 0.27 + phase * 1.3)
  );

  /* ---- anatomical breathing: A-P expansion, shoulder ride, quiet legs -- */
  float br = uBreath * aBreath * (1.0 - aKind);
  pos.x += (pos.x - CENTER.x) * br * 0.55;
  pos.z += (pos.z - CENTER.z) * br * 1.50;
  pos.y += br * 0.030;

  /* ---- asymmetry: pelvis right, thorax left, weight onto the left leg -- */
  float zone  = smoothstep(-0.10, 0.55, position.y);
  float twist = uAsym * mix(0.105, -0.085, zone);
  float ct = cos(twist);
  float st = sin(twist);
  float tx = pos.x * ct + pos.z * st;
  float tz = pos.z * ct - pos.x * st;
  pos.x = tx;
  pos.z = tz;

  pos.x -= uAsym * 0.018 * smoothstep(-0.95, 0.85, position.y);

  float rShoulder = smoothstep(0.34, 0.60, position.y) * smoothstep(0.0, 0.13, position.x);
  pos.y -= uAsym * 0.024 * rShoulder;
  pos.z += uAsym * 0.022 * rShoulder;

  /* ---- idle rotation: two detuned sines + a slight tilt ---------------- */
  float rotY = uRotY * mix(1.0, 0.30, aKind);
  float cy = cos(rotY);
  float sy = sin(rotY);
  vec3 rp = pos - CENTER;
  rp = vec3(rp.x * cy + rp.z * sy, rp.y, rp.z * cy - rp.x * sy);

  float cx = cos(uRotX);
  float sx = sin(uRotX);
  rp = vec3(rp.x, rp.y * cx - rp.z * sx, rp.z * cx + rp.y * sx);
  pos = CENTER + rp;

  /* ---- soft local mouse field (squared falloff = tighter, calmer) ------ */
  vec3 toP = pos - uMouse;
  float md = length(toP);
  float fall = 1.0 - smoothstep(0.0, uMouseRadius, md);
  fall *= fall;
  pos += (toP / max(md, 0.0001)) * fall * uMouseStrength;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  /* ---- DEPTH: the fix that turns a flat smear into a volume ------------ */
  float depth = clamp(rp.z / 0.46 * 0.5 + 0.5, 0.0, 1.0);
  float depthDim  = mix(1.0 - uDepthContrast, 1.0, pow(depth, 1.3));
  float depthSize = mix(0.62, 1.06, depth);

  /* ---- twinkle, gated to a small minority ----------------------------- */
  float gate = step(0.88, aRandom);
  float twinkle = 1.0 + gate * 0.55 * sin(uTime * 0.9 + phase);

  float ps = aSize * uSizeMul * depthSize * twinkle * uSizeScale * uPixelRatio / max(-mv.z, 0.001);
  gl_PointSize = max(ps, 1.4);

  /* ---- colour: neutral spine, hue separating outward ------------------- */
  vec3 tint = mix(uLeft, uRight, clamp(aSide * 0.5 + 0.5, 0.0, 1.0));
  // equal-luminance normalisation: the L/R split must read as hue, never as
  // one side simply being brighter than the other
  float ty = dot(tint, vec3(0.2126, 0.7152, 0.0722));
  tint = clamp(tint * (0.55 / max(ty, 0.001)), 0.0, 1.0);
  vec3 base = mix(uSpine, tint, uTint * abs(aSide));

  float lum = aLum * (1.0 + uAsym * 0.20 * aSide);
  vColor = base * lum * depthDim;
  vGlow  = smoothstep(0.35, 0.85, aLum);
  vAlpha = clamp((0.10 + lum * 0.95) * uHaze, 0.0, 1.0)
         * depthDim * mix(1.0, 0.55, aKind) * p;
}
`;

const FRAGMENT_SHADER = `
uniform float uGlow;
varying vec3  vColor;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d2 = dot(uv, uv);
  if (d2 > 0.25) discard;

  float core = exp(-d2 * mix(26.0, 11.0, vGlow));
  float halo = exp(-d2 * 3.2) * (0.08 + 0.55 * vGlow) * uGlow;

  float a = (core + halo) * vAlpha;
  if (a < 0.003) discard;

  // overexposed centre on the bright minority — this is where the "bloom" reads
  vec3 c = vColor * (1.0 + core * vGlow * 1.6);
  gl_FragColor = vec4(c, min(a, 1.0));
}
`;

/* ============================================================================
   Particle generation
   ============================================================================ */
function breathWeight(y) {
  const thorax = Math.exp(-Math.pow((y - 0.44) / 0.22, 2));
  const belly  = Math.exp(-Math.pow((y - 0.17) / 0.15, 2)) * 0.45;
  return Math.min(thorax + belly, 1.0);
}

function sideWeight(x) {
  const a = Math.abs(x);
  const t = clamp((a - 0.03) / (0.12 - 0.03), 0, 1);
  return Math.sign(x) * (t * t * (3 - 2 * t));
}

function generateParticleData(bodyCount) {
  const P = CONFIG.particles;
  const k = P.metaballBlend;
  const atmoCount = Math.round(bodyCount * P.atmosphereRatio);
  const total = bodyCount + atmoCount;

  const positions = new Float32Array(total * 3);
  const scatter   = new Float32Array(total * 3);
  const lums      = new Float32Array(total);
  const sides     = new Float32Array(total);
  const sizes     = new Float32Array(total);
  const randoms   = new Float32Array(total);
  const delays    = new Float32Array(total);
  const kinds     = new Float32Array(total);
  const breaths   = new Float32Array(total);

  let i = 0;

  const writeCommon = (x, y, z, lum, size, kind, breath, sideMul, delay) => {
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

    const yn = clamp((y - BODY_Y_MIN) / (BODY_Y_MAX - BODY_Y_MIN), 0, 1);
    scatter[i * 3]     = x * 1.35 + (Math.random() - 0.5) * CONFIG.entrance.spread;
    scatter[i * 3 + 1] = y - CONFIG.entrance.drop * (0.6 + Math.random() * 0.9);
    scatter[i * 3 + 2] = z * 1.35 + (Math.random() - 0.5) * CONFIG.entrance.spread;

    lums[i]    = lum;
    sides[i]   = sideWeight(x) * sideMul;
    sizes[i]   = size;
    randoms[i] = Math.random();
    delays[i]  = delay !== undefined ? delay : clamp(yn * 0.85 + Math.random() * 0.15, 0, 1);
    kinds[i]   = kind;
    breaths[i] = breath;
    i++;
  };

  /* ---- body ------------------------------------------------------------ */
  let tries = 0;
  const maxTries = bodyCount * 90;
  while (i < bodyCount && tries < maxTries) {
    tries++;
    const x = (Math.random() * 2 - 1) * 0.42;
    const y = BODY_Y_MIN + Math.random() * (BODY_Y_MAX - BODY_Y_MIN);
    const z = (Math.random() * 2 - 1) * 0.26;

    const d = sdBody(x, y, z, k);
    if (d >= 0) continue;

    // denser near the surface, sparse through the core -> volumetric shell
    const shell = clamp(1 + d / P.shellThickness, P.coreSparsity, 1);
    // the strong side reads slightly denser
    const bias = 1 + P.densityBias * Math.sign(x) * Math.min(Math.abs(x) / 0.12, 1);
    if (Math.random() > shell * bias) continue;

    const bright = Math.random() < P.brightFraction;
    const lum = bright
      ? 0.55 + Math.random() * 0.45
      : Math.pow(Math.random(), P.dimFalloff) * 0.30;

    const size = lerp(P.sizeMin, P.sizeMax, Math.random()) * (0.30 + lum * 1.35);
    const bw = breathWeight(y) * (Math.abs(x) > 0.20 ? 0.3 : 1.0);  // arms ride, not pump

    writeCommon(x, y, z, lum, size, 0, bw, 1.0);
  }
  const bodyWritten = i;

  /* ---- atmosphere motes ------------------------------------------------ */
  let aTries = 0;
  const aMax = atmoCount * 40;
  while (i < bodyWritten + atmoCount && aTries < aMax) {
    aTries++;
    const x = (Math.random() * 2 - 1) * 0.95;
    const y = -1.10 + Math.random() * 2.20;
    const z = (Math.random() * 2 - 1) * 0.62;
    if (sdBody(x, y, z, k) < 0.06) continue;   // keep clear of the silhouette

    const lum = Math.pow(Math.random(), 3.5) * 0.24;
    const size = lerp(P.sizeMin * 0.7, P.sizeMax * 0.5, Math.random());
    writeCommon(x, y, z, lum, size, 1, 0, 0.45, Math.random());
  }

  return {
    positions: positions.subarray(0, i * 3),
    scatter:   scatter.subarray(0, i * 3),
    lums:      lums.subarray(0, i),
    sides:     sides.subarray(0, i),
    sizes:     sizes.subarray(0, i),
    randoms:   randoms.subarray(0, i),
    delays:    delays.subarray(0, i),
    kinds:     kinds.subarray(0, i),
    breaths:   breaths.subarray(0, i),
  };
}

function buildGeometry(count) {
  const d = generateParticleData(count);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('aScatter', new THREE.BufferAttribute(d.scatter, 3));
  g.setAttribute('aLum',     new THREE.BufferAttribute(d.lums, 1));
  g.setAttribute('aSide',    new THREE.BufferAttribute(d.sides, 1));
  g.setAttribute('aSize',    new THREE.BufferAttribute(d.sizes, 1));
  g.setAttribute('aRandom',  new THREE.BufferAttribute(d.randoms, 1));
  g.setAttribute('aDelay',   new THREE.BufferAttribute(d.delays, 1));
  g.setAttribute('aKind',    new THREE.BufferAttribute(d.kinds, 1));
  g.setAttribute('aBreath',  new THREE.BufferAttribute(d.breaths, 1));
  return g;
}

/* ============================================================================
   Module state + lifecycle
   ============================================================================ */
const state = {
  initialized: false, running: false, container: null,
  renderer: null, scene: null, camera: null, canvas: null,
  geometry: null, material: null, points: null, clock: null, raf: null,
  isMobile: false, dpr: 1,
  reducedMotion: false, reducedMotionMedia: null, reducedMotionHandler: null,
  resizeObserver: null, intersectionObserver: null, visibilityHandler: null,
  raycaster: null, mousePlane: null,
  mouseTarget: null, mouseCur: null,
  mouseStrengthTarget: 0, mouseStrengthCur: 0,
  entranceStart: 0, entranceT: 0,
  asymCur: CONFIG.asymmetry.value, asymTarget: CONFIG.asymmetry.value,
};

const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();

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

/* Wide containers push the figure right of centre so type can live on the
   left; narrow (mobile) containers keep it centred. */
function composeCamera(w, h) {
  const aspect = w / Math.max(h, 1);
  const t = clamp((aspect - 1.0) / (CONFIG.camera.offsetAspect - 1.0), 0, 1);
  const off = CONFIG.camera.offsetXWide * t * t * (3 - 2 * t);
  state.camera.position.set(-off, CONFIG.camera.lookY, CONFIG.camera.distance);
  state.camera.lookAt(-off, CONFIG.camera.lookY, 0);
}

function syncSize() {
  if (!state.renderer || !state.container) return;
  const w = state.container.clientWidth || 1;
  const h = state.container.clientHeight || 1;
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / Math.max(h, 1);
  composeCamera(w, h);
  state.camera.updateProjectionMatrix();
  state.material.uniforms.uSizeScale.value =
    (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) * 0.5);
  if (state.reducedMotion) renderStill();
}

function applyLiveConfig() {
  if (!state.material) return;
  const u = state.material.uniforms;
  u.uSpine.value.set(CONFIG.colors.spine);
  u.uLeft.value.set(CONFIG.colors.left);
  u.uRight.value.set(CONFIG.colors.right);
  u.uTint.value = CONFIG.tint;
  u.uSizeMul.value = CONFIG.render.sizeMul;
  u.uGlow.value = CONFIG.render.glow;
  u.uDepthContrast.value = CONFIG.render.depthContrast;
  u.uHaze.value = CONFIG.render.haze;
  u.uNoiseAmp.value = CONFIG.noise.amplitude;
  u.uNoiseAtmo.value = CONFIG.noise.atmosphereMul;
  u.uMouseRadius.value = CONFIG.mouse.radius;
}

/* Static frame for prefers-reduced-motion: fully assembled, mid-breath, still. */
function renderStill() {
  if (!state.renderer) return;
  const u = state.material.uniforms;
  u.uTime.value = 0;
  u.uProgress.value = 1;
  u.uBreath.value = 0;
  u.uRotY.value = 0;
  u.uRotX.value = 0;
  u.uMouseStrength.value = 0;
  u.uAsym.value = state.asymTarget;
  state.renderer.render(state.scene, state.camera);
}

function tick() {
  state.raf = requestAnimationFrame(tick);
  const t = state.clock.getElapsedTime();
  const u = state.material.uniforms;
  const R = CONFIG.rotation;

  if (state.entranceT < 1) {
    state.entranceT = clamp((t - state.entranceStart) / CONFIG.entrance.durationSec, 0, 1);
  }
  u.uProgress.value = state.entranceT;

  u.uTime.value = t;
  u.uBreath.value = Math.sin((t / CONFIG.breathing.periodSec) * Math.PI * 2) * CONFIG.breathing.amplitude;
  u.uRotY.value = Math.sin((t / R.periodA) * Math.PI * 2) * R.ampA
                + Math.sin((t / R.periodB) * Math.PI * 2 + 1.3) * R.ampB;
  u.uRotX.value = Math.sin((t / R.tiltPeriod) * Math.PI * 2 + 0.7) * R.tiltAmp;

  state.asymCur += (state.asymTarget - state.asymCur) * CONFIG.asymmetry.easing;
  u.uAsym.value = state.asymCur;

  state.mouseCur.lerp(state.mouseTarget, CONFIG.mouse.positionDamping);
  state.mouseStrengthCur += (state.mouseStrengthTarget - state.mouseStrengthCur) * CONFIG.mouse.strengthDamping;
  u.uMouse.value.copy(state.mouseCur);
  u.uMouseStrength.value = state.mouseStrengthCur;

  state.renderer.render(state.scene, state.camera);
}

function resume() {
  if (!state.renderer) return;
  if (state.reducedMotion) { renderStill(); return; }
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

function initScene(container) {
  state.clock = new THREE.Clock(false);

  state.reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.reducedMotion = state.reducedMotionMedia.matches;
  state.isMobile =
    window.matchMedia('(max-width: 640px)').matches || window.matchMedia('(pointer: coarse)').matches;

  const width = container.clientWidth || 320;
  const height = container.clientHeight || 320;

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, width / Math.max(height, 1), 0.1, 20);
  composeCamera(width, height);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  state.renderer.setClearColor(0x000000, 0);
  state.dpr = Math.min(window.devicePixelRatio || 1,
    state.isMobile ? CONFIG.pixelRatioCap.mobile : CONFIG.pixelRatioCap.desktop);
  state.renderer.setPixelRatio(state.dpr);
  state.renderer.setSize(width, height, false);

  state.canvas = state.renderer.domElement;
  state.canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
  container.appendChild(state.canvas);

  const count = state.isMobile ? CONFIG.particles.countMobile : CONFIG.particles.countDesktop;
  state.geometry = buildGeometry(count);

  state.material = new THREE.ShaderMaterial({
    uniforms: {
      uTime:          { value: 0 },
      uBreath:        { value: 0 },
      uRotY:          { value: 0 },
      uRotX:          { value: 0 },
      uAsym:          { value: CONFIG.asymmetry.value },
      uTint:          { value: CONFIG.tint },
      uProgress:      { value: 0 },
      uMouse:         { value: new THREE.Vector3(0, 0.02, 6) },
      uMouseStrength: { value: 0 },
      uMouseRadius:   { value: CONFIG.mouse.radius },
      uPixelRatio:    { value: state.dpr },
      uSizeScale:     { value: (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) * 0.5) },
      uSizeMul:       { value: CONFIG.render.sizeMul },
      uGlow:          { value: CONFIG.render.glow },
      uDepthContrast: { value: CONFIG.render.depthContrast },
      uHaze:          { value: CONFIG.render.haze },
      uNoiseAmp:      { value: CONFIG.noise.amplitude },
      uNoiseAtmo:     { value: CONFIG.noise.atmosphereMul },
      uSpine:         { value: new THREE.Color(CONFIG.colors.spine) },
      uLeft:          { value: new THREE.Color(CONFIG.colors.left) },
      uRight:         { value: new THREE.Color(CONFIG.colors.right) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  state.points = new THREE.Points(state.geometry, state.material);
  state.points.frustumCulled = false;
  state.scene.add(state.points);

  state.raycaster = new THREE.Raycaster();
  state.mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  state.mouseTarget = new THREE.Vector3(0, 0.02, 6);
  state.mouseCur = new THREE.Vector3(0, 0.02, 6);

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);

  state.reducedMotionHandler = (e) => {
    state.reducedMotion = e.matches;
    if (state.reducedMotion) { pause(); renderStill(); } else { resume(); }
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
function replay() {
  if (!state.initialized) return;
  state.entranceT = 0;
  state.entranceStart = state.clock ? state.clock.getElapsedTime() : 0;
  if (state.reducedMotion) renderStill();
}

/**
 * Drive the figure's asymmetry from real data. 0 = symmetric, 1 = maximum.
 * A reasonable mapping from a left/right strength gap:
 *     setAsymmetry(Math.min(gapPercent / 12, 1))
 * e.g. the 8.3% row gap on 2026-08-03 -> 0.69
 * The change eases in over a couple of seconds rather than snapping.
 */
function setAsymmetry(v) {
  const t = clamp(Number(v) || 0, 0, 1);
  CONFIG.asymmetry.value = t;
  state.asymTarget = t;
  if (state.reducedMotion) renderStill();
}

function rebuild() {
  if (!state.initialized) return;
  const count = state.isMobile ? CONFIG.particles.countMobile : CONFIG.particles.countDesktop;
  const old = state.geometry;
  state.geometry = buildGeometry(count);
  state.points.geometry = state.geometry;
  if (old) old.dispose();
  applyLiveConfig();
  replay();
}

function mount(container) {
  if (!container) return;

  if (!state.initialized) {
    try {
      initScene(container);
      state.initialized = true;
      state.container = container;
      state.entranceT = 0;
      state.entranceStart = 0;
      resume();
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
  });
}

const ParticleHuman = {
  mount, destroy, replay, setAsymmetry, rebuild,
  config: CONFIG,
  applyLiveConfig,
  refresh: syncSize,   // re-apply camera/framing after editing CONFIG.camera
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

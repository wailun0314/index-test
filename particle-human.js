/* ============================================================================
   ASYMMETRY PROTOCOL — Particle Human (Step 1 prototype)
   ----------------------------------------------------------------------------
   A dark, minimal "particle anatomy" visual: a human silhouette built from a
   volumetric point cloud, with a very slow breathing/rotation idle animation
   and a soft, damped mouse-proximity disturbance.

   This file is fully self-contained. The host page (index.html) does not need
   to know anything about Three.js, shaders, or particle generation — it only
   ever calls two functions on `window.ParticleHuman`:

     ParticleHuman.mount(containerEl)   // idempotent — safe to call on every render
     ParticleHuman.destroy()            // full teardown (e.g. on pagehide)

   `mount()` also runs itself automatically once the DOM contains an element
   with id="particle-human-slot", so even the very first page render (before
   the host's own render loop has a chance to call mount()) is covered.
   ============================================================================ */

import * as THREE from 'three';

/* ============================================================================
   CONFIG — every tunable knob for the next iteration pass lives here.
   Nothing below this block should need touching just to restyle the visual.
   ============================================================================ */
const CONFIG = {
  slotId: 'particle-human-slot',

  colors: {
    dim:   '#122320',  // near-black teal — the resting color of most particles
    accent:'#42F5A7',  // primary aurora green accent
    mintA: '#8FF0C7',  // soft mint variant
    mintB: '#7FE0E8',  // pale cyan variant
  },

  particles: {
    countDesktop: 8000,
    countMobile: 3000,
    sizeMin: 0.012,        // world-space point diameter (body is ~2 units tall)
    sizeMax: 0.030,
    brightFraction: 0.10,  // ~10% of particles read as the "glowing" foreground
    coreSparsity: 0.16,    // min sampling probability deep in the body core
    shellThickness: 0.14,  // how "thick" the dense near-surface shell is
    metaballBlend: 0.07,   // smooth-min blend radius between body parts
  },

  camera: { fov: 32, distance: 3.6 },

  breathing: { amplitude: 0.018, periodSec: 7.5 },   // uniform scale, not a pulse
  rotation:  { amplitude: 0.14, periodSec: 14 },     // radians, oscillates — no full spin

  mouse: {
    radius: 0.55,           // world-space influence radius
    strength: 0.16,         // max world-space displacement
    positionDamping: 0.06,  // per-frame lerp toward the raw cursor target (inertia)
    strengthDamping: 0.08,  // per-frame lerp toward on/off influence (fade in/out)
    edgeMargin: 60,         // px outside the container that still counts as "near"
  },

  noise: { amplitude: 0.004, speed: 0.6 }, // per-particle idle jitter, kept tiny

  pixelRatioCap: { desktop: 2, mobile: 1.5 },
};

/* ============================================================================
   Body definition — a set of blended "metaballs" (spheres) approximating a
   relaxed standing figure. No mesh, no outline: this is only ever used to
   decide which candidate points fall inside the body volume when the particle
   cloud is generated.
   ============================================================================ */
function lerp(a, b, t) { return a + (b - a) * t; }

function buildBodyBalls() {
  const balls = [];
  const addBall = (x, y, z, r) => balls.push({ x, y, z, r });
  const addLimb = (p0, p1, r0, r1, steps) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      addBall(lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), lerp(p0[2], p1[2], t), lerp(r0, r1, t));
    }
  };

  // head + neck
  addBall(0, 0.87, 0, 0.115);
  addBall(0, 0.775, 0, 0.05);

  // torso: chest -> waist -> hips (tapered via chained spheres)
  addLimb([0, 0.68, 0.01], [0, 0.50, 0.02], 0.205, 0.185, 3);
  addLimb([0, 0.50, 0.02], [0, 0.30, 0.00], 0.185, 0.135, 3);
  addLimb([0, 0.30, 0.00], [0, 0.10, 0.00], 0.135, 0.165, 3);

  // shoulder joints
  addBall(-0.235, 0.655, 0.01, 0.085);
  addBall(0.235, 0.655, 0.01, 0.085);

  // arms — relaxed at the sides, not a T-pose
  addLimb([-0.245, 0.63, 0.01], [-0.32, 0.36, 0.03], 0.082, 0.062, 4);
  addLimb([-0.32, 0.36, 0.03], [-0.34, 0.10, 0.02], 0.06, 0.05, 4);
  addBall(-0.345, 0.045, 0.02, 0.05);

  addLimb([0.245, 0.63, 0.01], [0.32, 0.36, 0.03], 0.082, 0.062, 4);
  addLimb([0.32, 0.36, 0.03], [0.34, 0.10, 0.02], 0.06, 0.05, 4);
  addBall(0.345, 0.045, 0.02, 0.05);

  // pelvis -> legs
  addLimb([-0.09, 0.06, 0], [-0.11, -0.34, 0.0], 0.10, 0.075, 4);
  addLimb([-0.11, -0.34, 0], [-0.10, -0.78, 0.0], 0.07, 0.05, 4);
  addBall(-0.10, -0.86, 0.03, 0.05);

  addLimb([0.09, 0.06, 0], [0.11, -0.34, 0.0], 0.10, 0.075, 4);
  addLimb([0.11, -0.34, 0], [0.10, -0.78, 0.0], 0.07, 0.05, 4);
  addBall(0.10, -0.86, 0.03, 0.05);

  return balls;
}
const BODY_BALLS = buildBodyBalls();

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// signed distance to the smooth union of all body metaballs
function sdBody(x, y, z, k) {
  let d = Infinity;
  for (let i = 0; i < BODY_BALLS.length; i++) {
    const b = BODY_BALLS[i];
    const dx = x - b.x, dy = y - b.y, dz = z - b.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.r;
    if (i === 0) { d = dist; continue; }
    const h = clamp(0.5 + 0.5 * (dist - d) / k, 0, 1);
    d = lerp(dist, d, h) - k * h * (1 - h);
  }
  return d;
}

/* ============================================================================
   Shaders — all displacement (breathing, oscillating rotation, idle jitter,
   mouse push) happens on the GPU, driven only by a handful of uniforms.
   The CPU never re-uploads the position buffer after the first build.
   ============================================================================ */
const VERTEX_SHADER = `
uniform float uTime;
uniform float uBreath;
uniform float uRotation;
uniform vec3  uMouse;
uniform float uMouseStrength;
uniform float uMouseRadius;
uniform float uPixelRatio;
uniform float uSizeScale;
uniform float uNoiseAmp;

attribute vec3 aColor;
attribute float aSize;
attribute float aRandom;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 pos = position;
  vec3 center = vec3(0.0, 0.05, 0.0);

  float phase = aRandom * 62.831853;
  float n = sin(uTime * 0.6 + phase);
  pos += uNoiseAmp * n * vec3(sin(phase * 1.7), cos(phase * 1.3), sin(phase * 0.9));

  // breathing: uniform scale about the body's center, never a hard pulse
  vec3 rel = pos - center;
  pos = center + rel * (1.0 + uBreath);

  // slow oscillating rotation about Y (never a full spin)
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec3 rp = pos - center;
  pos = center + vec3(rp.x * c + rp.z * s, rp.y, rp.z * c - rp.x * s);

  // soft local mouse force field — damping/inertia is applied on the CPU side
  // (uMouse and uMouseStrength are already eased before they reach here)
  vec3 toP = pos - uMouse;
  float d = length(toP);
  float falloff = 1.0 - smoothstep(0.0, uMouseRadius, d);
  vec3 dir = toP / max(d, 0.0001);
  pos += dir * falloff * uMouseStrength;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float flicker = 0.85 + 0.15 * sin(uTime * 0.8 + phase);
  gl_PointSize = aSize * uSizeScale * uPixelRatio * flicker / max(-mvPosition.z, 0.001);

  vColor = aColor;
  vAlpha = 0.4 + 0.6 * flicker;
}
`;

const FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  float circle = 1.0 - smoothstep(0.0, 0.5, d);
  if (circle <= 0.001) discard;
  gl_FragColor = vec4(vColor, circle * vAlpha);
}
`;

/* ============================================================================
   Particle cloud generation (runs once per mount lifetime, not per frame)
   ============================================================================ */
function generateParticleData(count) {
  const k = CONFIG.particles.metaballBlend;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const randoms = new Float32Array(count);

  const dim = new THREE.Color(CONFIG.colors.dim);
  const accent = new THREE.Color(CONFIG.colors.accent);
  const mintA = new THREE.Color(CONFIG.colors.mintA);
  const mintB = new THREE.Color(CONFIG.colors.mintB);
  const scratch = new THREE.Color();

  let i = 0;
  let tries = 0;
  const maxTries = count * 80;

  while (i < count && tries < maxTries) {
    tries++;
    const x = (Math.random() * 2 - 1) * 0.55;
    const y = -1.0 + Math.random() * 2.05;
    const z = (Math.random() * 2 - 1) * 0.3;

    const d = sdBody(x, y, z, k);
    if (d >= 0) continue;

    const insideDepth = -d;
    const shellFactor = clamp(1 - insideDepth / CONFIG.particles.shellThickness, CONFIG.particles.coreSparsity, 1);
    if (Math.random() > shellFactor) continue;

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    randoms[i] = Math.random();

    const isBright = Math.random() < CONFIG.particles.brightFraction;
    const b = isBright ? (0.55 + Math.random() * 0.45) : Math.pow(Math.random(), 2.4) * 0.35;

    const hueRoll = Math.random();
    const hueColor = hueRoll < 0.55 ? accent : (hueRoll < 0.8 ? mintA : mintB);
    scratch.copy(dim).lerp(hueColor, b);
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;

    sizes[i] = lerp(CONFIG.particles.sizeMin, CONFIG.particles.sizeMax, Math.random()) * (0.6 + b * 0.8);

    i++;
  }

  return {
    positions: positions.subarray(0, i * 3),
    colors: colors.subarray(0, i * 3),
    sizes: sizes.subarray(0, i),
    randoms: randoms.subarray(0, i),
  };
}

function buildGeometry(count) {
  const data = generateParticleData(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(data.colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(data.sizes, 1));
  geo.setAttribute('aRandom', new THREE.BufferAttribute(data.randoms, 1));
  return geo;
}

/* ============================================================================
   Module state + lifecycle
   ============================================================================ */
const state = {
  initialized: false,
  running: false,
  container: null,
  renderer: null,
  scene: null,
  camera: null,
  canvas: null,
  geometry: null,
  material: null,
  points: null,
  clock: null,
  raf: null,
  isMobile: false,
  reducedMotion: false,
  reducedMotionMedia: null,
  reducedMotionHandler: null,
  resizeObserver: null,
  intersectionObserver: null,
  visibilityHandler: null,
  raycaster: null,
  mousePlane: null,
  mouseTarget: null,
  mouseCur: null,
  mouseStrengthTarget: 0,
  mouseStrengthCur: 0,
};

const _ndcScratch = new THREE.Vector2();
const _hitScratch = new THREE.Vector3();

function onPointerMove(e) {
  if (!state.container || !state.canvas || !document.contains(state.canvas)) return;
  const rect = state.container.getBoundingClientRect();
  const margin = CONFIG.mouse.edgeMargin;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < -margin || y < -margin || x > rect.width + margin || y > rect.height + margin) {
    state.mouseStrengthTarget = 0;
    return;
  }
  _ndcScratch.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  state.raycaster.setFromCamera(_ndcScratch, state.camera);
  if (state.raycaster.ray.intersectPlane(state.mousePlane, _hitScratch)) {
    state.mouseTarget.copy(_hitScratch);
    state.mouseStrengthTarget = CONFIG.mouse.strength;
  }
}
function onPointerLeave() { state.mouseStrengthTarget = 0; }

function syncSize() {
  if (!state.renderer || !state.container) return;
  const w = state.container.clientWidth || 1;
  const h = state.container.clientHeight || 1;
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / Math.max(h, 1);
  state.camera.updateProjectionMatrix();
  state.material.uniforms.uSizeScale.value =
    (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) * 0.5);
  if (state.reducedMotion) renderOnce();
}

function renderOnce() {
  if (!state.renderer) return;
  const u = state.material.uniforms;
  u.uTime.value = 0;
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

function initScene(container) {
  state.clock = new THREE.Clock(false);

  state.reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  state.reducedMotion = state.reducedMotionMedia.matches;
  state.isMobile =
    window.matchMedia('(max-width: 640px)').matches || window.matchMedia('(pointer: coarse)').matches;

  const width = container.clientWidth || 320;
  const height = container.clientHeight || 220;

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, width / Math.max(height, 1), 0.1, 10);
  state.camera.position.set(0, 0.05, CONFIG.camera.distance);
  state.camera.lookAt(0, 0.05, 0);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  state.renderer.setClearColor(0x000000, 0);
  const dpr = Math.min(window.devicePixelRatio || 1, state.isMobile ? CONFIG.pixelRatioCap.mobile : CONFIG.pixelRatioCap.desktop);
  state.renderer.setPixelRatio(dpr);
  state.renderer.setSize(width, height, false);

  state.canvas = state.renderer.domElement;
  state.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
  container.appendChild(state.canvas);

  const count = state.isMobile ? CONFIG.particles.countMobile : CONFIG.particles.countDesktop;
  state.geometry = buildGeometry(count);

  state.material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBreath: { value: 0 },
      uRotation: { value: 0 },
      uMouse: { value: new THREE.Vector3(0, 0.05, 5) },
      uMouseStrength: { value: 0 },
      uMouseRadius: { value: CONFIG.mouse.radius },
      uPixelRatio: { value: dpr },
      uSizeScale: { value: (height * 0.5) / Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov) * 0.5) },
      uNoiseAmp: { value: CONFIG.noise.amplitude },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  state.points = new THREE.Points(state.geometry, state.material);
  state.scene.add(state.points);

  state.raycaster = new THREE.Raycaster();
  state.mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  state.mouseTarget = new THREE.Vector3(0, 0.05, 5);
  state.mouseCur = new THREE.Vector3(0, 0.05, 5);
  state.mouseStrengthTarget = 0;
  state.mouseStrengthCur = 0;

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave);

  state.reducedMotionHandler = (e) => {
    state.reducedMotion = e.matches;
    if (state.reducedMotion) { pause(); renderOnce(); } else { resume(); }
  };
  if (state.reducedMotionMedia.addEventListener) {
    state.reducedMotionMedia.addEventListener('change', state.reducedMotionHandler);
  } else if (state.reducedMotionMedia.addListener) {
    state.reducedMotionMedia.addListener(state.reducedMotionHandler); // older Safari
  }

  if ('ResizeObserver' in window) {
    state.resizeObserver = new ResizeObserver(() => syncSize());
    state.resizeObserver.observe(container);
  }

  if ('IntersectionObserver' in window) {
    state.intersectionObserver = new IntersectionObserver(
      (entries) => entries.forEach((entry) => (entry.isIntersecting ? resume() : pause())),
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

function mount(container) {
  if (!container) return;

  if (!state.initialized) {
    try {
      initScene(container);
      state.initialized = true;
      state.container = container;
      resume();
    } catch (err) {
      console.warn('[ParticleHuman] failed to initialize — hiding the visual.', err);
      if (container && container.style) container.style.display = 'none';
    }
    return;
  }

  if (state.canvas.parentElement !== container) {
    container.appendChild(state.canvas);
  }
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

/* ============================================================================
   Public API
   ============================================================================ */
const ParticleHuman = { mount, destroy };

if (typeof window !== 'undefined') {
  window.ParticleHuman = ParticleHuman;

  // Cover the very first paint: if the slot is already in the DOM by the time
  // this module executes, mount immediately so the host doesn't have to worry
  // about script-load ordering relative to its own first render() call.
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

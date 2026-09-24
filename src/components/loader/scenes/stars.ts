import { COMMON_UNIFORM_DECLS, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

const STAR_COUNT = 3200;
const DEPTH = 120;
const TUNNEL_INNER = 1.4;
const TUNNEL_OUTER = 16;
/** World units per second at speed 1. */
const CRUISE = 26;

const STREAK_VERTEX = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uTravel;
uniform float uSpeed;
uniform vec2 uSway;
attribute vec3 aBase;
attribute float aEnd;
attribute float aRand;
varying float vFade;
varying float vRand;
varying float vEnd;
void main() {
  float z = -${DEPTH.toFixed(1)} + mod(aBase.z + uTravel * (0.7 + aRand * 0.6), ${DEPTH.toFixed(1)});
  float len = (0.08 + uSpeed * uSpeed * 2.6) * (0.4 + aRand);
  z -= aEnd * len;
  vec3 p = vec3(aBase.xy, z);
  // The path curves: far stars are displaced more, so the tunnel bends ahead.
  p.xy += uSway * z * z * 0.0008;
  vFade = smoothstep(-${DEPTH.toFixed(1)}, -${(DEPTH * 0.55).toFixed(1)}, z) * smoothstep(0.5, -4.0, z);
  vRand = aRand;
  vEnd = aEnd;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const STREAK_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
varying float vFade;
varying float vRand;
varying float vEnd;
void main() {
  vec3 col = mix(uHighlight, uMain, smoothstep(0.45, 1.0, vRand));
  col = mix(col, uAccent, step(0.92, vRand));
  float a = vFade * (1.0 - vEnd) * uIntensity;
  gl_FragColor = vec4(col * a * 2.2, a);
}
`;

const POINT_VERTEX = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uTravel;
uniform vec2 uSway;
attribute vec3 aBase;
attribute float aRand;
varying float vFade;
varying float vRand;
void main() {
  float z = -${DEPTH.toFixed(1)} + mod(aBase.z + uTravel * (0.7 + aRand * 0.6), ${DEPTH.toFixed(1)});
  vec3 p = vec3(aBase.xy, z);
  p.xy += uSway * z * z * 0.0008;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (1.0 + aRand * 2.2) * uPixelRatio * 42.0 / max(1.0, -mv.z);
  vFade = smoothstep(-${DEPTH.toFixed(1)}, -${(DEPTH * 0.6).toFixed(1)}, z) * smoothstep(0.5, -3.0, z);
  vRand = aRand;
  gl_Position = projectionMatrix * mv;
}
`;

const POINT_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
varying float vFade;
varying float vRand;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float glow = smoothstep(0.5, 0.0, d);
  glow *= glow;
  vec3 col = mix(uHighlight, uMain, smoothstep(0.5, 1.0, vRand));
  float a = glow * vFade * uIntensity;
  gl_FragColor = vec4(col * a * 2.6, a);
}
`;

const NEBULA_STEPS_FULL = 36;
const NEBULA_STEPS_LOW = 20;

/**
 * A volumetric nebula the camera flies through: density is raymarched from
 * layered 3D noise, with a tunnel carved along the flight path so the clouds
 * stream past on every side, lit from a bright core far ahead.
 */
const nebulaFragment = (steps: number) => /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uTravel;
uniform vec2 uSway;
${GLSL_NOISE}
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
vec2 path(float z) {
  return vec2(sin(z * 0.045) * 2.4, cos(z * 0.037) * 1.6);
}
float density(vec3 p) {
  float n = noise3(p * 0.32) * 0.55 + noise3(p * 0.85 + 2.0) * 0.3 + noise3(p * 2.2 + 5.0) * 0.15;
  float tunnel = smoothstep(1.0, 4.2, length(p.xy - path(p.z)));
  return max(0.0, n - 0.4) * 2.6 * tunnel;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float z = uTravel * 0.05;
  vec3 ro = vec3(path(z), z);
  vec2 ahead = path(z + 6.0) - ro.xy;
  vec3 rd = normalize(vec3(uv + ahead * 0.08 + uSway * 0.15, 1.35));
  float t = 0.4 + hash21(gl_FragCoord.xy) * 0.5;
  vec3 col = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < ${steps}; i++) {
    vec3 p = ro + rd * t;
    float d = density(p);
    float stepSize = 0.3 + t * 0.045;
    if (d > 0.001) {
      float hue = noise3(p * 0.15 + 3.0);
      vec3 emit = mix(uMain, uAccent, smoothstep(0.3, 0.75, hue));
      // Thin edges glow; dense cores absorb.
      emit = mix(emit, uHighlight, smoothstep(0.35, 0.0, d) * 0.35);
      col += trans * emit * d * stepSize * 0.65;
      trans *= exp(-d * stepSize * 1.4);
    }
    t += stepSize;
    if (trans < 0.04 || t > 34.0) break;
  }
  float core = exp(-length(uv - ahead * 0.08) * 5.0);
  col += trans * (uBg * 0.7 + uMain * 0.25 * core + uHighlight * 0.9 * core * core);
  gl_FragColor = vec4(col * (0.25 + 0.75 * uIntensity), 1.0);
}
`;

export const createStars: SceneFactory = ({ THREE, gsap, scene, camera, uniforms, quality }) => {
  const count = Math.round(STAR_COUNT * quality);
  const local = { uTravel: { value: 0 }, uSpeed: { value: 0 }, uSway: { value: new THREE.Vector2() } };
  const params = { speed: 0, curve: 0.6 };

  const base = new Float32Array(count * 3);
  const rand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = TUNNEL_INNER + Math.pow(Math.random(), 0.7) * (TUNNEL_OUTER - TUNNEL_INNER);
    base.set([Math.cos(angle) * radius, Math.sin(angle) * radius, Math.random() * DEPTH], i * 3);
    rand[i] = Math.random();
  }

  // Streaks: two vertices per star (head and tail), placed on the GPU.
  const streakBase = new Float32Array(count * 6);
  const streakEnd = new Float32Array(count * 2);
  const streakRand = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    streakBase.set(base.subarray(i * 3, i * 3 + 3), i * 6);
    streakBase.set(base.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    streakEnd[i * 2 + 1] = 1;
    streakRand[i * 2] = streakRand[i * 2 + 1] = rand[i]!;
  }
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
  streakGeo.setAttribute("aBase", new THREE.BufferAttribute(streakBase, 3));
  streakGeo.setAttribute("aEnd", new THREE.BufferAttribute(streakEnd, 1));
  streakGeo.setAttribute("aRand", new THREE.BufferAttribute(streakRand, 1));
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
  const streaks = new THREE.LineSegments(
    streakGeo,
    new THREE.ShaderMaterial({ vertexShader: STREAK_VERTEX, fragmentShader: STREAK_FRAGMENT, uniforms: { ...uniforms, ...local }, ...additive })
  );
  streaks.frustumCulled = false;

  const pointGeo = new THREE.BufferGeometry();
  pointGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  pointGeo.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
  pointGeo.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
  const points = new THREE.Points(
    pointGeo,
    new THREE.ShaderMaterial({ vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT, uniforms: { ...uniforms, ...local }, ...additive })
  );
  points.frustumCulled = false;

  const nebula = fullscreenPass(THREE, nebulaFragment(quality >= 1 ? NEBULA_STEPS_FULL : NEBULA_STEPS_LOW), { ...uniforms, ...local });
  scene.add(nebula, streaks, points);
  camera.position.set(0, 0, 0);

  // Ease into cruise.
  gsap.to(params, { speed: 1, duration: 3.2, ease: "power2.inOut" });

  return {
    bloom: { strength: 0.65, radius: 0.55, threshold: 0.8 },
    resolution: 0.85,
    update(time, delta) {
      local.uSpeed.value = params.speed;
      local.uTravel.value += delta * (1.5 + params.speed * CRUISE);
      local.uSway.value.set(Math.sin(time * 0.09) * params.curve, Math.cos(time * 0.07) * params.curve * 0.6);
      camera.position.set(Math.sin(time * 0.06) * 0.6, Math.cos(time * 0.045) * 0.35, 0);
      camera.rotation.set(0, 0, Math.sin(time * 0.03) * 0.09);
    },
    evolve() {
      // Gentle surges and a path that bends one way, then the other.
      gsap.timeline({ repeat: -1, yoyo: true, delay: 3.2 })
        .to(params, { speed: 1.45, duration: 6, ease: "sine.inOut" })
        .to(params, { curve: -0.6, duration: 9, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf(params);
      gsap.to(params, { speed: 1.6, curve: 0, duration, ease: "sine.in" });
    },
    dispose() {
      gsap.killTweensOf(params);
      disposeTree(nebula);
      disposeTree(streaks);
      disposeTree(points);
    },
  };
};

import { COMMON_UNIFORM_DECLS, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

/**
 * Northern lights over a still mountain lake: three folded curtains, each
 * with a bright lower edge, vertical rays and a colour shift with height,
 * the way real aurora looks. The lake mirrors all of it.
 */

const AURORA_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uFlow;
uniform float uFold;
uniform float uLift;
uniform float uLook;
${GLSL_NOISE}

// One curtain in sky space: x is azimuth, e is elevation. It hangs from a
// wavering lower edge, fades upward, and is streaked with vertical rays.
float curtain(float x, float e, float t, float seed) {
  float w = fbm(vec2(x * 0.9 + seed, t * 0.04)) * 1.6 * uFold;
  float base = 0.045 + 0.05 * sin(x * 1.3 + w * 2.0 + seed) + 0.035 * fbm(vec2(x * 3.0, seed + t * 0.05));
  float h = e - base;
  if (h < -0.03) return 0.0;
  float edge = smoothstep(-0.02, 0.01, h);
  float height = 0.16 + 0.14 * fbm(vec2(x * 1.7 + seed * 3.0, t * 0.03));
  float fall = exp(-max(h, 0.0) / height * 2.4);
  float rays = 0.3 + 0.7 * pow(vnoise(vec2(x * 55.0 + w * 14.0, t * 0.3 + seed)), 1.4);
  float fold = 0.5 + 0.5 * sin(x * 6.0 + w * 6.0 + t * 0.2 + seed);
  return edge * fall * rays * fold;
}

vec3 aurora(vec3 ro, vec3 rd) {
  vec3 col = vec3(0.0);
  if (rd.y <= 0.0) return col;
  float t = uTime * uFlow;
  float x = rd.x / rd.z + ro.z * 0.01;
  float e = rd.y - uLift * 0.12;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float c = curtain(x * (1.0 + fi * 0.35) + fi * 2.1, e - fi * 0.035, t, fi * 4.3);
    vec3 tint = mix(uMain, uAccent, smoothstep(0.12, 0.42, e));
    tint += uHighlight * 0.35 * smoothstep(0.2, 0.0, e - 0.08);
    col += tint * c * (1.0 - fi * 0.28);
  }
  return col * 0.95;
}

vec3 stars(vec3 rd) {
  vec2 g = rd.xy / max(0.2, rd.z) * 180.0;
  vec2 id = floor(g);
  float h = hash21(id);
  float s = step(0.965, h) * smoothstep(0.5, 0.0, length(fract(g) - 0.5 - (vec2(hash21(id + 3.0), hash21(id + 7.0)) - 0.5) * 0.6));
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
  return uHighlight * s * twinkle * (0.4 + 1.6 * hash21(id + 1.0));
}

float ridge(float x) {
  return 0.012 + fbm(vec2(x * 3.2, 1.7)) * 0.06 + fbm(vec2(x * 11.0, 4.1)) * 0.015;
}

vec3 skyColor(vec3 ro, vec3 rd) {
  vec3 col = uBg * (0.55 + 0.9 * smoothstep(0.35, 0.0, rd.y));
  col += stars(rd) * smoothstep(0.02, 0.2, rd.y);
  col += aurora(ro, rd);
  // Mountain silhouettes sit on the horizon, rim-lit by the aurora.
  float m = ridge(rd.x / max(0.3, rd.z));
  if (rd.y < m) {
    col = uBg * 0.18;
    col += uMain * 0.12 * smoothstep(m - 0.012, m, rd.y);
  }
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec3 ro = vec3(0.0, 0.0, uTime * 0.25 * uFlow);
  vec3 rd = normalize(vec3(uv.x, uv.y + uLook, 1.35));
  vec3 col;
  if (rd.y >= 0.0) {
    col = skyColor(ro, rd);
  } else {
    // The lake: the same sky reflected, broken by slow ripples.
    float depth = -rd.y;
    vec3 r = rd;
    r.y = -r.y;
    r.x += sin(depth * 70.0 - uTime * 1.1) * 0.0012 * (1.0 + depth * 4.0);
    r.y += (fbm(vec2(uv.x * 4.0, depth * 18.0 - uTime * 0.2)) - 0.5) * 0.012 * depth;
    col = skyColor(ro, normalize(r)) * 0.55 + uBg * 0.08;
    col += uHighlight * 0.25 * smoothstep(0.004, 0.0, depth);
  }
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

export const createAurora: SceneFactory = ({ THREE, gsap, scene, uniforms }) => {
  const local = { uFlow: { value: 0.4 }, uFold: { value: 0.6 }, uLift: { value: -0.8 }, uLook: { value: -0.05 } };
  const pass = fullscreenPass(THREE, AURORA_FRAGMENT, { ...uniforms, ...local });
  scene.add(pass);

  // The lights rise into the sky as the camera tilts up to meet them.
  gsap.to(local.uLift, { value: 0, duration: 6, ease: "power2.out" });
  gsap.to(local.uLook, { value: 0.12, duration: 7, ease: "power2.inOut" });
  gsap.to(local.uFlow, { value: 1, duration: 3, ease: "power1.out" });

  return {
    bloom: { strength: 0.6, radius: 0.85, threshold: 0.75 },
    update() {},
    evolve() {
      gsap.timeline({ repeat: -1, yoyo: true, delay: 6 })
        .to(local.uFold, { value: 1.25, duration: 11, ease: "sine.inOut" })
        .to(local.uLook, { value: 0.2, duration: 13, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf([local.uFold, local.uLift, local.uFlow, local.uLook]);
      gsap.to(local.uLook, { value: 0.45, duration, ease: "power2.in" });
      gsap.to(local.uFlow, { value: 3, duration, ease: "power2.in" });
    },
    dispose() {
      gsap.killTweensOf([local.uFold, local.uLift, local.uFlow, local.uLook]);
      disposeTree(pass);
    },
  };
};

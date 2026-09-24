import { COMMON_UNIFORM_DECLS, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

/**
 * A black hole in the manner of Interstellar's Gargantua, traced rather than
 * painted. Each pixel's photon is integrated backwards through the
 * Schwarzschild bending equation (units where the horizon radius is 1), so
 * the disk's far side lifts over and under the shadow, the photon ring and
 * the lensed starfield all fall out of the physics instead of being drawn.
 */

const DISK_INNER = 2.6;
const DISK_OUTER = 13.0;
const STEPS_FULL = 160;
const STEPS_LOW = 90;

const fragment = (steps: number) => /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uDist;
uniform float uPitch;
uniform float uYaw;
uniform float uSpin;
uniform float uRoll;
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

vec3 sky(vec3 d, vec3 behind) {
  // Stars on a cube-ish lattice of directions: seam-free and stable.
  vec3 g = d * 220.0;
  vec3 id = floor(g);
  float h = hash31(id);
  vec3 c = id + 0.5 + (vec3(hash31(id + 1.3), hash31(id + 2.7), hash31(id + 5.1)) - 0.5) * 0.7;
  float star = step(0.985, h) * smoothstep(0.55, 0.0, length(g - c));
  // Everything within a few degrees of the point straight behind the hole is
  // smeared around the Einstein ring; a lone star there becomes a hard,
  // glitch-like circle, so stars fade out near that point.
  star *= smoothstep(0.9995, 0.996, dot(d, behind));
  vec3 col = uHighlight * star * (0.6 + 2.4 * hash31(id + 9.1));
  float n = noise3(d * 2.2) * 0.6 + noise3(d * 5.1) * 0.3 + noise3(d * 11.0) * 0.1;
  col += uAccent * pow(n, 4.0) * 0.55 + uMain * pow(noise3(d * 1.3 + 4.0), 5.0) * 0.4;
  return uBg * 0.6 + col;
}

vec4 disk(vec3 p, float r, vec3 dir) {
  float omega = 1.4 / pow(r, 1.5);
  float a = -uTime * uSpin * omega;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 q = rot * p.xz;
  float turb = fbm(q * 0.85) * 0.6 + fbm(q * 2.6 + 7.0) * 0.4;
  float rings = 0.78 + 0.22 * sin(r * 4.6 + turb * 9.0);
  float density = smoothstep(${DISK_INNER.toFixed(2)}, ${(DISK_INNER + 0.5).toFixed(2)}, r)
    // A long, squared fade: lensing squeezes the far side's outer edge into
    // a thin annulus, and a short fade there reads as a hard ring in the sky.
    * pow(smoothstep(${DISK_OUTER.toFixed(2)}, ${(DISK_INNER + 2.5).toFixed(2)}, r), 2.0)
    * (0.25 + 0.95 * turb) * rings;
  float heat = pow(smoothstep(${DISK_OUTER.toFixed(2)}, ${DISK_INNER.toFixed(2)}, r), 1.6);
  vec3 col = mix(uMain * 0.5, mix(uAccent, uHighlight, heat) * 1.35, heat);
  // Relativistic beaming: the side turning toward us is far brighter.
  vec3 orbit = normalize(vec3(-p.z, 0.0, p.x));
  float beta = 0.55 / sqrt(r);
  float doppler = clamp(1.0 + dot(orbit, -dir) * beta * 1.5, 0.35, 1.6);
  col *= pow(doppler, 2.5);
  return vec4(col, clamp(density * 0.95, 0.0, 1.0));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float cr = cos(uRoll), sr = sin(uRoll);
  uv = mat2(cr, -sr, sr, cr) * uv;
  vec3 cam = uDist * vec3(cos(uPitch) * sin(uYaw), sin(uPitch), cos(uPitch) * cos(uYaw));
  vec3 fw = normalize(-cam);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 vel = normalize(fw * 1.55 + uv.x * rt + uv.y * up);
  vec3 pos = cam;
  vec3 hvec = cross(pos, vel);
  float h2 = dot(hvec, hvec);

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  bool captured = false;
  for (int i = 0; i < ${steps}; i++) {
    float r = length(pos);
    if (r < 1.0) { captured = true; break; }
    if (r > 70.0 || alpha > 0.985) break;
    float dt = clamp(0.07 * r, 0.015, 1.4);
    vec3 prev = pos;
    vel += -1.5 * h2 * pos / pow(r, 5.0) * dt;
    pos += vel * dt;
    if (prev.y * pos.y < 0.0) {
      vec3 hit = mix(prev, pos, prev.y / (prev.y - pos.y));
      float rr = length(hit.xz);
      if (rr > ${DISK_INNER.toFixed(2)} && rr < ${DISK_OUTER.toFixed(2)}) {
        vec4 d = disk(hit, rr, normalize(vel));
        col += (1.0 - alpha) * d.rgb * d.a;
        alpha += (1.0 - alpha) * d.a;
      }
    }
  }
  if (!captured) col += (1.0 - alpha) * sky(normalize(vel), -normalize(cam));
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

export const createVortex: SceneFactory = ({ THREE, gsap, scene, uniforms, quality }) => {
  const local = {
    uDist: { value: 46 },
    uPitch: { value: 0.32 },
    uYaw: { value: 0.4 },
    uSpin: { value: 0.4 },
    uRoll: { value: -0.12 },
  };
  const pass = fullscreenPass(THREE, fragment(quality >= 1 ? STEPS_FULL : STEPS_LOW), { ...uniforms, ...local });
  scene.add(pass);

  // Arrive from far out, settling just above the plane of the disk.
  gsap.to(local.uDist, { value: 19, duration: 7, ease: "power3.out" });
  gsap.to(local.uPitch, { value: 0.09, duration: 7, ease: "power2.inOut" });
  gsap.to(local.uSpin, { value: 1, duration: 5, ease: "power2.out" });

  return {
    bloom: { strength: 0.85, radius: 0.7, threshold: 0.78 },
    resolution: 0.7,
    update(time) {
      local.uYaw.value = 0.4 + time * 0.018;
    },
    evolve() {
      gsap.timeline({ repeat: -1, yoyo: true, delay: 7 })
        .to(local.uPitch, { value: 0.2, duration: 14, ease: "sine.inOut" })
        .to(local.uDist, { value: 15.5, duration: 14, ease: "sine.inOut" }, 0)
        .to(local.uRoll, { value: 0.08, duration: 14, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf([local.uDist, local.uPitch, local.uSpin, local.uRoll]);
      gsap.to(local.uDist, { value: 4.2, duration, ease: "power3.in" });
      gsap.to(local.uPitch, { value: 0.02, duration, ease: "power2.in" });
      gsap.to(local.uSpin, { value: 2.4, duration, ease: "power2.in" });
    },
    dispose() {
      gsap.killTweensOf([local.uDist, local.uPitch, local.uSpin, local.uRoll]);
      disposeTree(pass);
    },
  };
};

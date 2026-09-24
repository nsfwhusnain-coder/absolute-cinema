import type { CurrentsMode } from "@/lib/loader/select";
import { COMMON_UNIFORM_DECLS, GLSL_FINISH, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

const PARTICLES = 2600;
const BOX = { x: 7, y: 4.5, zNear: 2.5, zFar: -8 };

/** How each variant moves and looks. */
const MODES: Record<CurrentsMode, { rise: number; wind: number; size: number; softness: number; alpha: number; core: number }> = {
  embers: { rise: 0.9, wind: 0.35, size: 2.2, softness: 2.4, alpha: 1.8, core: 1.2 },
  dust: { rise: 0.06, wind: 0.8, size: 1.6, softness: 1.6, alpha: 1.4, core: 0.8 },
  mist: { rise: 0.12, wind: 0.45, size: 9.0, softness: 1.3, alpha: 0.7, core: 0.3 },
};

const PARTICLE_VERTEX = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uFlow;
uniform float uRise;
uniform float uWind;
uniform float uSize;
attribute vec3 aBase;
attribute float aRand;
varying float vFlicker;
varying float vRand;
varying float vFade;
void main() {
  float t = uTime * uFlow * (0.35 + aRand * 0.65);
  vec3 p = aBase;
  p.x += t * uWind * 1.6;
  p.y += t * uRise * (0.6 + aRand);
  // Swirl through a smooth field so the flow reads as air, not a conveyor.
  p.x += sin(p.y * 1.25 + uTime * 0.45 + aRand * 6.28) * 0.45;
  p.y += cos(p.x * 0.85 + uTime * 0.38) * 0.28;
  p.z += sin(uTime * 0.28 + aRand * 10.0) * 0.35;
  p.x = mod(p.x + ${BOX.x.toFixed(1)}, ${(BOX.x * 2).toFixed(1)}) - ${BOX.x.toFixed(1)};
  p.y = mod(p.y + ${BOX.y.toFixed(1)}, ${(BOX.y * 2).toFixed(1)}) - ${BOX.y.toFixed(1)};
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.45 + aRand) * uPixelRatio * 38.0 / max(0.5, -mv.z);
  vFlicker = 0.6 + 0.4 * sin(uTime * (2.5 + aRand * 5.0) + aRand * 20.0);
  vRand = aRand;
  vFade = smoothstep(${BOX.zFar.toFixed(1)}, ${(BOX.zFar + 3).toFixed(1)}, p.z);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uSoftness;
uniform float uAlpha;
uniform float uCore;
varying float vFlicker;
varying float vRand;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  // A hot core inside a softer halo: embers read as sparks, not blobs.
  float core = smoothstep(0.14, 0.0, d);
  float glow = pow(smoothstep(0.5, 0.0, d), uSoftness);
  vec3 col = mix(uAccent, uHighlight, smoothstep(0.55, 1.0, vRand));
  col = mix(col, uHighlight, core * 0.6);
  float a = (core * uCore + glow * 0.45) * vFlicker * vFade * uAlpha * uIntensity;
  // Hot cores run past 1.0 so the bloom turns them into sparks.
  gl_FragColor = vec4(col * a * (1.0 + core * uCore * 2.4), a);
}
`;

const FOG_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uWind;
${GLSL_NOISE}
${GLSL_FINISH}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = uv * vec2(uResolution.x / uResolution.y, 1.0);
  float f1 = fbm(p * 1.5 + vec2(uTime * 0.03 * uWind, 0.0));
  float f2 = fbm(p * 3.1 + vec2(uTime * 0.07 * uWind, uTime * 0.01) + f1);
  float fog = smoothstep(0.32, 0.95, f2);
  float shaft = pow(max(0.0, sin((p.x * 0.75 - p.y * 1.15) * 5.5 + f1 * 2.0 + uTime * 0.05)), 9.0) * smoothstep(0.0, 1.0, uv.y);
  vec3 col = uBg * (0.9 + 0.5 * uv.y);
  col = mix(col, uMain * 0.75, fog * 0.6);
  col += mix(uMain, uHighlight, 0.5) * shaft * 0.5 * (0.4 + fog);
  col += uMain * 0.2 * smoothstep(0.7, 0.0, abs(uv.y - 0.25));
  gl_FragColor = vec4(finish(col * (0.3 + 0.7 * uIntensity), gl_FragCoord.xy, uResolution), 1.0);
}
`;

export const createCurrents: SceneFactory = ({ THREE, gsap, scene, camera, uniforms, quality, mode }) => {
  const look = MODES[mode];
  const count = Math.round(PARTICLES * quality * (mode === "mist" ? 0.35 : 1));
  const local = {
    uFlow: { value: 0.3 },
    uRise: { value: look.rise },
    uWind: { value: look.wind },
    uSize: { value: look.size },
    uSoftness: { value: look.softness },
    uAlpha: { value: look.alpha },
    uCore: { value: look.core },
  };
  const params = { dolly: 0 };

  const base = new Float32Array(count * 3);
  const rand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    base.set(
      [
        (Math.random() * 2 - 1) * BOX.x,
        (Math.random() * 2 - 1) * BOX.y,
        BOX.zFar + Math.random() * (BOX.zNear - BOX.zFar),
      ],
      i * 3
    );
    rand[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
  geometry.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
  const particles = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: { ...uniforms, ...local },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  particles.frustumCulled = false;
  const fog = fullscreenPass(THREE, FOG_FRAGMENT, { ...uniforms, ...local });
  scene.add(fog, particles);

  gsap.to(local.uFlow, { value: 1, duration: 3, ease: "power2.out" });

  return {
    bloom: { strength: 1.1, radius: 0.65, threshold: 0.6 },
    update(time) {
      camera.position.set(Math.sin(time * 0.05) * 0.8, Math.cos(time * 0.04) * 0.3, 5 - params.dolly);
      camera.lookAt(0, 0, -2);
    },
    evolve() {
      gsap.timeline({ repeat: -1, yoyo: true, delay: 3 })
        .to(params, { dolly: 1.6, duration: 12, ease: "sine.inOut" })
        .to(local.uWind, { value: look.wind * 1.6, duration: 7, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf([params, local.uWind, local.uFlow]);
      gsap.to(params, { dolly: 4.5, duration, ease: "power2.in" });
      gsap.to(local.uFlow, { value: 2.2, duration, ease: "power2.in" });
    },
    dispose() {
      gsap.killTweensOf([params, local.uWind, local.uFlow]);
      disposeTree(fog);
      disposeTree(particles);
    },
  };
};

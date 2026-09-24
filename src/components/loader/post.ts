/**
 * The loader's film pipeline: the scene renders to a half-float target so
 * light can exceed 1.0, bloom spreads those highlights into glow, and a grade
 * pass rolls them off gently, adds a lens's colour fringing and a film grain.
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface BloomLook {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomLook = { strength: 0.6, radius: 0.6, threshold: 0.8 };

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uAberration: { value: 0.005 },
    uGrain: { value: 0.035 },
    uFade: { value: 1 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uAspect;
uniform float uAberration;
uniform float uGrain;
uniform float uFade;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

// Colours below the knee pass through as authored; brighter light rolls off
// smoothly and never reaches full white. A loader is watched in a dark room,
// often at low brightness: peaks at full white read as flashes.
vec3 shoulder(vec3 c) {
  const float knee = 0.55;
  const float headroom = 0.27;
  vec3 over = max(c - knee, 0.0);
  return min(c, knee) + over / (1.0 + over / headroom);
}

void main() {
  vec2 d = vUv - 0.5;
  vec2 fringe = d * dot(d, d) * uAberration * 4.0;
  vec3 col = vec3(
    texture2D(tDiffuse, vUv - fringe).r,
    texture2D(tDiffuse, vUv).g,
    texture2D(tDiffuse, vUv + fringe).b
  );
  col = shoulder(col);
  float vignette = smoothstep(1.05, 0.3, length(d * vec2(uAspect, 1.0)));
  col *= mix(0.62, 1.0, vignette);
  float grain = hash(vUv * 1024.0 + fract(uTime * 7.3) * 91.0) - 0.5;
  col += grain * uGrain * (0.35 + 0.65 * (1.0 - dot(col, vec3(0.333))));
  gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
}
`,
};

export interface FilmPipeline {
  render(time: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  setFade(value: number): void;
  dispose(): void;
}

export function createFilmPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  bloom: BloomLook
): FilmPipeline {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), bloom.strength, bloom.radius, bloom.threshold);
  composer.addPass(bloomPass);
  const grade = new ShaderPass(GRADE_SHADER);
  composer.addPass(grade);

  return {
    render(time) {
      grade.uniforms.uTime.value = time;
      composer.render();
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      grade.uniforms.uAspect.value = width / Math.max(1, height);
    },
    setFade(value) {
      grade.uniforms.uFade.value = value;
    },
    dispose() {
      bloomPass.dispose();
      grade.material.dispose();
      composer.dispose();
      target.dispose();
    },
  };
}

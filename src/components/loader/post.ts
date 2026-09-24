/**
 * The loader's film pipeline: the scene renders to a half-float target so
 * light can exceed 1.0, bloom spreads those highlights into glow, and a grade
 * pass rolls them off gently, adds a lens's colour fringing and a film grain.
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export interface BloomLook {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomLook = { strength: 0.6, radius: 0.6, threshold: 0.8 };

/**
 * How much brighter a frame may be than what the eye has adapted to, and how
 * fast adaptation follows: quickly toward darker, slowly toward brighter.
 * Together they make a sudden burst of light impossible, whatever a scene
 * does: exposure drops at once and recovers over a second or two.
 */
const FLASH_HEADROOM = 1.3;
const ADAPT_UP_PER_S = 0.9;
const ADAPT_DOWN_PER_S = 4;
const LUM_W = 32;
const LUM_H = 18;

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Measures each frame's average brightness and keeps an adapted average. */
class FlashGuardPass extends Pass {
  private readonly small = new THREE.WebGLRenderTarget(LUM_W, LUM_H, { type: THREE.HalfFloatType });
  private readonly current = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private adapted = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  private readonly measure = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2(1 / LUM_W, 1 / LUM_H) } },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 o = (vec2(float(x), float(y)) - 1.5) / 4.0 * uTexel;
      sum += dot(texture2D(tDiffuse, vUv + o).rgb, vec3(0.2126, 0.7152, 0.0722));
    }
  }
  gl_FragColor = vec4(vec3(sum / 16.0), 1.0);
}
`,
  });
  private readonly average = new THREE.ShaderMaterial({
    uniforms: { tSmall: { value: this.small.texture } },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
uniform sampler2D tSmall;
void main() {
  float sum = 0.0;
  for (int y = 0; y < ${LUM_H}; y++) {
    for (int x = 0; x < ${LUM_W}; x++) {
      sum += texture2D(tSmall, (vec2(float(x), float(y)) + 0.5) / vec2(${LUM_W}.0, ${LUM_H}.0)).r;
    }
  }
  gl_FragColor = vec4(vec3(sum / ${LUM_W * LUM_H}.0), 1.0);
}
`,
  });
  private readonly adapt = new THREE.ShaderMaterial({
    uniforms: {
      tPrev: { value: null as THREE.Texture | null },
      tCurrent: { value: this.current.texture },
      uDt: { value: 0 },
    },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tCurrent;
uniform float uDt;
void main() {
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float cur = texture2D(tCurrent, vec2(0.5)).r;
  float rate = cur > prev ? ${ADAPT_UP_PER_S.toFixed(2)} : ${ADAPT_DOWN_PER_S.toFixed(2)};
  gl_FragColor = vec4(vec3(prev + (cur - prev) * (1.0 - exp(-uDt * rate))), 1.0);
}
`,
  });
  private readonly quad = new FullScreenQuad();

  constructor() {
    super();
    this.needsSwap = false;
  }

  get currentTexture(): THREE.Texture {
    return this.current.texture;
  }

  get adaptedTexture(): THREE.Texture {
    return this.adapted[0]!.texture;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget, deltaTime: number): void {
    const draw = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
      this.quad.material = material;
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
    };
    this.measure.uniforms.tDiffuse.value = read.texture;
    draw(this.measure, this.small);
    draw(this.average, this.current);
    this.adapted = [this.adapted[1]!, this.adapted[0]!];
    this.adapt.uniforms.tPrev.value = this.adapted[1]!.texture;
    this.adapt.uniforms.uDt.value = Math.min(Math.max(deltaTime, 0), 0.1);
    draw(this.adapt, this.adapted[0]!);
  }

  dispose(): void {
    [this.small, this.current, ...this.adapted].forEach((t) => t.dispose());
    [this.measure, this.average, this.adapt].forEach((m) => m.dispose());
    this.quad.dispose();
  }
}

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uAberration: { value: 0.005 },
    uGrain: { value: 0.035 },
    uFade: { value: 1 },
    tLumCurrent: { value: null as THREE.Texture | null },
    tLumAdapted: { value: null as THREE.Texture | null },
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
uniform sampler2D tLumCurrent;
uniform sampler2D tLumAdapted;
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
  // Flash guard: a frame brighter than the adapted level allows is scaled
  // down to it, so no scene can burst into light.
  float current = texture2D(tLumCurrent, vec2(0.5)).r;
  float adapted = texture2D(tLumAdapted, vec2(0.5)).r;
  col *= min(1.0, (adapted * ${FLASH_HEADROOM.toFixed(2)} + 0.012) / max(current, 1e-4));
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
  const guard = new FlashGuardPass();
  composer.addPass(guard);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), bloom.strength, bloom.radius, bloom.threshold);
  composer.addPass(bloomPass);
  const grade = new ShaderPass(GRADE_SHADER);
  composer.addPass(grade);

  return {
    render(time) {
      grade.uniforms.uTime.value = time;
      grade.uniforms.tLumCurrent.value = guard.currentTexture;
      grade.uniforms.tLumAdapted.value = guard.adaptedTexture;
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
      guard.dispose();
      grade.material.dispose();
      composer.dispose();
      target.dispose();
    },
  };
}

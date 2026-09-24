import type * as THREE from "three";
import type { gsap as Gsap } from "gsap";
import type { LoaderPalette } from "@/lib/loader/palette";
import type { CurrentsMode, LoaderSceneId } from "@/lib/loader/select";
import type { BloomLook } from "../post";

export type Three = typeof THREE;
export type GsapApi = typeof Gsap;

/** Uniforms every scene shares; the runtime animates intensity and colours. */
export interface CommonUniforms {
  uTime: { value: number };
  uIntensity: { value: number };
  uResolution: { value: THREE.Vector2 };
  uPixelRatio: { value: number };
  uBg: { value: THREE.Vector3 };
  uMain: { value: THREE.Vector3 };
  uAccent: { value: THREE.Vector3 };
  uHighlight: { value: THREE.Vector3 };
}

export interface SceneContext {
  THREE: Three;
  gsap: GsapApi;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  uniforms: CommonUniforms;
  /** 1 on capable devices, lower on slow ones: scenes scale particle counts by it. */
  quality: number;
  mode: CurrentsMode;
}

export interface LoaderScene {
  /** How strongly this scene's highlights glow; the default suits most. */
  bloom?: BloomLook;
  /** Relative render resolution: raymarched scenes are soft and costly, so they draw fewer pixels. */
  resolution?: number;
  /** Per-frame work that is not already on the GPU (camera paths, travel). */
  update(time: number, delta: number): void;
  /** Long, slowly varying motion while the viewer waits. */
  evolve(): void;
  /** Exit choreography over `duration` seconds (the runtime fades intensity alongside). */
  exit(duration: number): void;
  dispose(): void;
}

export type SceneFactory = (ctx: SceneContext) => LoaderScene;

/** Each scene's own palette, used until (or instead of) the film's colours. */
export const SCENE_PALETTES: Record<LoaderSceneId, LoaderPalette> = {
  stars: { background: "#050a1f", main: "#2f6fd6", accent: "#9fd8ff", highlight: "#f2f7ff" },
  ribbons: { background: "#0e0e10", main: "#d4232f", accent: "#ff7a45", highlight: "#fff1e0" },
  vortex: { background: "#050403", main: "#e08a1e", accent: "#ffb347", highlight: "#fff0c2" },
  currents: { background: "#1a0b1e", main: "#b8663a", accent: "#c9a24a", highlight: "#f3dfb0" },
  aurora: { background: "#031417", main: "#19c2b0", accent: "#8b7bff", highlight: "#d9fff8" },
  city: { background: "#0a0a14", main: "#ff4d8d", accent: "#3ad0ff", highlight: "#fff4d6" },
};

/** "#rrggbb" → sRGB components 0-1 (the renderer outputs these unconverted). */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
`;

/** Vignette plus a touch of dither so slow gradients never band. */
export const GLSL_FINISH = /* glsl */ `
vec3 finish(vec3 col, vec2 fragCoord, vec2 resolution) {
  vec2 uv = fragCoord / resolution;
  float vig = smoothstep(1.15, 0.35, length((uv - 0.5) * vec2(resolution.x / resolution.y, 1.0)));
  col *= mix(0.55, 1.0, vig);
  col += (hash21(fragCoord + fract(uTime)) - 0.5) / 255.0;
  return col;
}
`;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.999, 1.0);
}
`;

/** A screen-filling quad drawn behind everything else, whatever the camera does. */
export function fullscreenPass(
  THREE: Three,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>
): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms, depthWrite: false, depthTest: false })
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export const COMMON_UNIFORM_DECLS = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;
uniform float uPixelRatio;
uniform vec3 uBg;
uniform vec3 uMain;
uniform vec3 uAccent;
uniform vec3 uHighlight;
`;

/** Releases GPU resources held by everything under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

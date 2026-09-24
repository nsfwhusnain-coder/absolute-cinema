/**
 * The loading-scene engine: one WebGL renderer, the chosen scene, GSAP for
 * choreography. Loaded on demand (this module pulls in Three.js and GSAP), and
 * stopped and freed the moment the video starts.
 */

import * as THREE from "three";
import { gsap } from "gsap";
import type { LoaderPalette } from "@/lib/loader/palette";
import type { CurrentsMode, LoaderSceneId } from "@/lib/loader/select";
import { hexToRgb, type CommonUniforms, type LoaderScene, type SceneFactory } from "./scenes/common";
import { createFilmPipeline, DEFAULT_BLOOM, type FilmPipeline } from "./post";
import { createAurora } from "./scenes/aurora";
import { createCity } from "./scenes/city";
import { createCurrents } from "./scenes/currents";
import { createRibbons } from "./scenes/ribbons";
import { createStars } from "./scenes/stars";
import { createVortex } from "./scenes/vortex";

const FACTORIES: Record<LoaderSceneId, SceneFactory> = {
  stars: createStars,
  ribbons: createRibbons,
  vortex: createVortex,
  currents: createCurrents,
  aurora: createAurora,
  city: createCity,
};

/** Render below device resolution: the scenes are soft by design and the video is decoding alongside. */
const BASE_RENDER_SCALE = 0.75;
const MIN_RENDER_SCALE = 0.4;
/** Frames slower than this (on average) step the resolution down. */
const SLOW_FRAME_MS = 24;
const FRAME_SAMPLE = 45;
const INTRO_S = 2.2;
const EXIT_S = 0.9;
const PALETTE_BLEND_S = 1.4;

export interface LoaderHandle {
  setPalette(palette: LoaderPalette): void;
  /** Plays the exit and resolves once the canvas has faded; then call dispose(). */
  exit(): Promise<void>;
  dispose(): void;
}

export interface LoaderOptions {
  scene: LoaderSceneId;
  palette: LoaderPalette;
  mode: CurrentsMode;
  /** 1 on capable devices; lower trims particle counts and resolution. */
  quality: number;
}

export function startLoader(canvas: HTMLCanvasElement, options: LoaderOptions): LoaderHandle | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  // Colours are authored as sRGB values and written straight out.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  let scale = BASE_RENDER_SCALE * (options.quality < 1 ? 0.75 : 1);
  // Full-quality devices never drop below one pixel per CSS pixel unless they
  // prove too slow; soft scenes still render under a retina screen's density.
  let floor = options.quality >= 1 ? 1 : 0;
  const pixelRatio = () => Math.max(Math.min(floor, scale / BASE_RENDER_SCALE), Math.min(window.devicePixelRatio || 1, 1.5) * scale);
  renderer.setPixelRatio(pixelRatio());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 400);
  const vec = (hex: string) => new THREE.Vector3(...hexToRgb(hex));
  const uniforms: CommonUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uBg: { value: vec(options.palette.background) },
    uMain: { value: vec(options.palette.main) },
    uAccent: { value: vec(options.palette.accent) },
    uHighlight: { value: vec(options.palette.highlight) },
  };

  let film: FilmPipeline | null = null;
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w, h, false);
    film?.setSize(w, h, renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(uniforms.uResolution.value);
    uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const active: LoaderScene = FACTORIES[options.scene]({
    THREE,
    gsap,
    scene,
    camera,
    uniforms,
    quality: options.quality,
    mode: options.mode,
  });
  if (active.resolution) {
    scale *= active.resolution;
    floor *= active.resolution;
  }
  film = createFilmPipeline(renderer, scene, camera, active.bloom ?? DEFAULT_BLOOM);
  resize();
  gsap.to(uniforms.uIntensity, { value: 1, duration: INTRO_S, ease: "power2.out" });
  active.evolve();

  const timer = new THREE.Timer();
  let frameMs = 0;
  let frames = 0;
  const frame = () => {
    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);
    uniforms.uTime.value += delta;
    active.update(uniforms.uTime.value, delta);
    film?.render(uniforms.uTime.value);
    // Adaptive quality: if the device is struggling, draw fewer pixels.
    frameMs += delta * 1000;
    if (++frames >= FRAME_SAMPLE) {
      if (frameMs / frames > SLOW_FRAME_MS && scale > MIN_RENDER_SCALE) {
        scale = Math.max(MIN_RENDER_SCALE, scale * 0.8);
        resize();
      }
      frameMs = 0;
      frames = 0;
    }
  };
  renderer.setAnimationLoop(frame);

  const onVisibility = () => {
    if (document.hidden) {
      renderer.setAnimationLoop(null);
    } else {
      timer.update();
      renderer.setAnimationLoop(frame);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  let disposed = false;
  return {
    setPalette(palette) {
      const blend = (target: THREE.Vector3, hex: string) => {
        const [r, g, b] = hexToRgb(hex);
        gsap.to(target, { x: r, y: g, z: b, duration: PALETTE_BLEND_S, ease: "sine.inOut" });
      };
      blend(uniforms.uBg.value, palette.background);
      blend(uniforms.uMain.value, palette.main);
      blend(uniforms.uAccent.value, palette.accent);
      blend(uniforms.uHighlight.value, palette.highlight);
    },
    exit() {
      active.exit(EXIT_S);
      gsap.killTweensOf(uniforms.uIntensity);
      return new Promise((resolve) => {
        gsap.to(uniforms.uIntensity, { value: 0, duration: EXIT_S, ease: "power2.in", onComplete: () => resolve() });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      gsap.killTweensOf([uniforms.uIntensity, uniforms.uBg.value, uniforms.uMain.value, uniforms.uAccent.value, uniforms.uHighlight.value]);
      active.dispose();
      film?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

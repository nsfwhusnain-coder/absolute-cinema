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
/** Scene time drawn before the canvas is worth showing: its light has risen from black by then. */
const READY_AFTER_S = 0.9;
/** Shaders that have not reported in by now are drawn anyway rather than waited on forever. */
const COMPILE_WAIT_MS = 4000;

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
  /** The scene is drawing and bright enough to show. */
  onReady?(): void;
  /** The GPU gave up (context lost, a shader failed): the scene is gone for good. */
  onLost?(): void;
}

/** Starts the scene, or returns null where the device has no working WebGL for it (the caller keeps its CSS backdrop). */
export function startLoader(canvas: HTMLCanvasElement, options: LoaderOptions): LoaderHandle | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  try {
    return runScene(renderer, canvas, options);
  } catch {
    // A context that arrives already lost fails somewhere in set-up rather than at creation.
    renderer.dispose();
    return null;
  }
}

function runScene(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement, options: LoaderOptions): LoaderHandle {
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

  const timer = new THREE.Timer();
  let frameMs = 0;
  let frames = 0;
  let ready = false;
  const frame = () => {
    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);
    uniforms.uTime.value += delta;
    active.update(uniforms.uTime.value, delta);
    film?.render(uniforms.uTime.value);
    if (!ready && uniforms.uTime.value >= READY_AFTER_S) {
      ready = true;
      options.onReady?.();
    }
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
  // Compile the scene's shaders before the first frame, in parallel where the
  // GPU driver allows (KHR_parallel_shader_compile). Compiled inside the first
  // render, the shaders block the main thread just as the video is starting
  // (the watch page's own telemetry shows long tasks of up to 1.6 s), which
  // also holds up the player itself.
  let disposed = false;
  let running = false;
  const begin = () => {
    if (disposed || running) return;
    running = true;
    timer.update();
    gsap.to(uniforms.uIntensity, { value: 1, duration: INTRO_S, ease: "power2.out" });
    active.evolve();
    // Not gated on document.hidden: the browser already holds animation frames
    // back for a hidden page, and a home-screen web app on iOS can report
    // "hidden" after returning from the background, which left the canvas blank.
    renderer.setAnimationLoop(frame);
  };
  // A context the GPU process took back (memory pressure next to a 4K decode,
  // common on tablets) never draws again. Stop, and let the page show its own backdrop.
  const lose = () => {
    if (disposed) return;
    renderer.setAnimationLoop(null);
    options.onLost?.();
  };
  canvas.addEventListener("webglcontextlost", lose);
  renderer.debug.onShaderError = lose;
  let compileTimer: ReturnType<typeof setTimeout> | null = null;
  if (typeof renderer.compileAsync === "function") {
    renderer.compileAsync(scene, camera).then(begin, begin);
    compileTimer = setTimeout(begin, COMPILE_WAIT_MS);
  } else {
    begin();
  }

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
      if (compileTimer) clearTimeout(compileTimer);
      canvas.removeEventListener("webglcontextlost", lose);
      observer.disconnect();
      gsap.killTweensOf([uniforms.uIntensity, uniforms.uBg.value, uniforms.uMain.value, uniforms.uAccent.value, uniforms.uHighlight.value]);
      active.dispose();
      film?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

import { COMMON_UNIFORM_DECLS, GLSL_FINISH, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

const RIBBONS = 7;
const SEGMENTS = 260;

const RIBBON_VERTEX = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uPhase;
uniform float uRadius;
uniform float uWidth;
uniform float uFlow;
uniform float uLift;
varying vec2 vUv;
varying float vDepth;
vec3 curve(float u) {
  float t = uTime * 0.16 * uFlow + uPhase;
  float a = u * 6.2831 * 1.2 + t;
  float r = uRadius * (1.0 + 0.28 * sin(u * 9.0 + t * 1.3 + uPhase));
  float y = sin(u * 6.5 + t * 0.9 + uPhase * 2.0) * 1.1 + (u - 0.5) * 2.4 * uLift;
  return vec3(cos(a) * r, y, sin(a) * r - 1.0);
}
void main() {
  vUv = uv;
  float u = uv.x;
  vec3 c = curve(u);
  vec3 tangent = normalize(curve(u + 0.003) - c);
  vec3 side = normalize(cross(tangent, vec3(0.15, 1.0, 0.1)));
  vec3 up = normalize(cross(side, tangent));
  // Slow: a fast twist swings each ribbon from edge-on to face-on and pulses.
  float twist = u * 11.0 + uTime * 0.16 + uPhase;
  vec3 across = side * cos(twist) + up * sin(twist);
  vec3 p = c + across * (uv.y - 0.5) * uWidth * sin(3.14159 * u);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RIBBON_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uPhase;
varying vec2 vUv;
varying float vDepth;
void main() {
  float acrossBand = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float core = pow(acrossBand, 7.0);
  float glow = pow(acrossBand, 1.8);
  float shimmer = 0.8 + 0.2 * sin(vUv.x * 38.0 - uTime * 0.8 + uPhase * 9.0);
  vec3 col = mix(uMain, uAccent, smoothstep(0.15, 0.95, fract(vUv.x * 0.8 + uTime * 0.04 + uPhase * 0.3)));
  col = mix(col, uHighlight, core * 0.85);
  float ends = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
  // Far ribbons fade into the haze; near ones fade too, so a ribbon sweeping
  // past the lens never fills the screen with light.
  float depthFade = smoothstep(10.0, 3.2, vDepth) * smoothstep(1.4, 3.0, vDepth);
  float a = (glow * 0.35 + core * 0.75) * shimmer * ends * depthFade * uIntensity;
  gl_FragColor = vec4(col * a, a);
}
`;

const BACKDROP_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
${GLSL_NOISE}
${GLSL_FINISH}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  vec3 col = uBg * (1.0 + 0.35 * (0.5 - p.y));
  col += uMain * 0.12 * smoothstep(0.85, 0.0, length(p - vec2(0.0, 0.05)));
  col += uAccent * 0.05 * fbm(p * 2.0 + uTime * 0.02);
  gl_FragColor = vec4(finish(col * (0.3 + 0.7 * uIntensity), gl_FragCoord.xy, uResolution), 1.0);
}
`;

export const createRibbons: SceneFactory = ({ THREE, gsap, scene, camera, uniforms, quality }) => {
  const count = Math.max(4, Math.round(RIBBONS * quality));
  const params = { flow: 0.4, push: 0, lift: 0 };
  const geometry = new THREE.PlaneGeometry(1, 1, Math.round(SEGMENTS * Math.max(0.5, quality)), 1);
  const ribbons = Array.from({ length: count }, (_, i) => {
    const local = {
      uPhase: { value: i * 1.37 + Math.random() * 0.5 },
      uRadius: { value: 1.6 + (i % 3) * 0.55 + Math.random() * 0.3 },
      uWidth: { value: 0.28 + Math.random() * 0.34 },
      uFlow: { value: params.flow },
      uLift: { value: 0 },
    };
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: RIBBON_VERTEX,
        fragmentShader: RIBBON_FRAGMENT,
        uniforms: { ...uniforms, ...local },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    mesh.frustumCulled = false;
    return { mesh, local };
  });
  const backdrop = fullscreenPass(THREE, BACKDROP_FRAGMENT, { ...uniforms });
  scene.add(backdrop, ...ribbons.map((r) => r.mesh));

  gsap.to(params, { flow: 1, duration: 2.8, ease: "power2.out" });

  return {
    bloom: { strength: 0.5, radius: 0.7, threshold: 0.8 },
    update(time) {
      for (const r of ribbons) {
        r.local.uFlow.value = params.flow;
        r.local.uLift.value = params.lift;
      }
      camera.position.set(Math.sin(time * 0.05) * 1.1, Math.sin(time * 0.07) * 0.45, 4.2 - params.push);
      camera.lookAt(0, 0, -1);
    },
    evolve() {
      gsap.timeline({ repeat: -1, yoyo: true, delay: 2.8 })
        .to(params, { lift: 1, duration: 8, ease: "sine.inOut" })
        .to(params, { flow: 1.35, duration: 5, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf(params);
      gsap.to(params, { flow: 1.4, push: 0.6, duration, ease: "sine.in" });
    },
    dispose() {
      gsap.killTweensOf(params);
      disposeTree(backdrop);
      ribbons.forEach((r) => (r.mesh.material as { dispose(): void }).dispose());
      geometry.dispose();
    },
  };
};

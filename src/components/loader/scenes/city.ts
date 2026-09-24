import { COMMON_UNIFORM_DECLS, GLSL_NOISE, disposeTree, fullscreenPass, type SceneFactory } from "./common";

/**
 * A city at night seen through a rain-streaked window. The lights behind the
 * glass are out of focus; every raindrop is a small lens, so inside a drop
 * the same lights appear sharper, shifted and brighter. Drops bead, grow,
 * and run down the pane leaving a trail of droplets behind them.
 */

const CITY_FRAGMENT = /* glsl */ `
${COMMON_UNIFORM_DECLS}
uniform float uDrift;
uniform float uRain;
uniform float uFocus;
${GLSL_NOISE}

// Out-of-focus lights: soft discs on a few depth layers, drifting slowly.
vec3 bokeh(vec2 p, float soft) {
  vec3 col = uBg * (0.8 + 0.6 * smoothstep(0.6, -0.5, p.y));
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float scale = 5.0 + fl * 3.5;
    vec2 q = p * scale + vec2(uTime * uDrift * (0.05 + fl * 0.035), fl * 13.7);
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash21(id + fl * 7.0);
    if (h < 0.58) continue;
    vec2 c = (vec2(hash21(id + 2.3), hash21(id + 5.9)) - 0.5) * 0.6;
    float radius = 0.2 + 0.2 * hash21(id + 9.4);
    float edge = mix(0.015, 0.22, soft);
    float disc = smoothstep(radius, radius - edge, length(f - c));
    // Real bokeh has a brighter rim.
    float rim = smoothstep(radius - edge * 2.0, radius - edge * 0.3, length(f - c)) * disc;
    vec3 tint = h > 0.86 ? uHighlight : h > 0.64 ? uAccent : uMain;
    float flicker = 0.85 + 0.15 * sin(uTime * (0.6 + h * 2.0) + h * 30.0);
    col += tint * (disc * 0.55 + rim * 0.35) * flicker * (1.3 - fl * 0.3) * smoothstep(0.9, 0.2, p.y + fl * 0.05);
  }
  return col;
}

// Beads that sit on the glass, grow and fade. Returns the lens offset in xy, coverage in z.
vec3 beads(vec2 uv, float t) {
  vec2 g = uv * 34.0;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id);
  vec2 c = (vec2(hash21(id + 1.7), hash21(id + 4.2)) - 0.5) * 0.7;
  float life = fract(t * 0.06 + h);
  float r = (0.12 + 0.2 * hash21(id + 8.8)) * smoothstep(0.0, 0.2, life) * smoothstep(1.0, 0.7, life);
  vec2 d = f - c;
  float m = smoothstep(r, r * 0.6, length(d)) * step(0.35, h);
  return vec3(d / max(r, 0.001) * m, m);
}

// Drops running down the pane, each leaving a trail of small droplets.
vec3 runners(vec2 uv, float t) {
  vec2 g = uv * vec2(7.0, 1.2);
  float col = floor(g.x);
  float h = hash21(vec2(col, 3.3));
  float speed = 0.18 + h * 0.3;
  float y = fract(g.y + t * speed + h * 7.0);
  float x = fract(g.x) - 0.5 + sin(g.y * 9.0 + h * 20.0) * 0.08;
  vec2 d = vec2(x, (y - 0.25) * 2.2);
  float r = 0.16 + 0.06 * h;
  float drop = smoothstep(r, r * 0.55, length(d * vec2(1.0, 1.4)));
  float trailY = fract(y * 14.0);
  vec2 td = vec2(x * 1.4, (trailY - 0.5) * 0.16);
  float trail = smoothstep(0.06, 0.03, length(td)) * smoothstep(0.25, 0.95, y) * step(0.5, hash21(vec2(col, floor(y * 14.0))));
  float m = max(drop, trail) * step(0.25, h);
  vec2 n = drop > trail ? d / r : td / 0.06;
  return vec3(n * m, m);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime;
  vec3 b = beads(p, t) * uRain;
  vec3 r = runners(p, t) * uRain;
  vec2 lens = b.xy * 0.035 + r.xy * 0.05;
  float wet = clamp(b.z + r.z, 0.0, 1.0);
  // Through a drop the lights are nearer to focus and flipped slightly.
  float soft = mix(0.9 - uFocus * 0.4, 0.25, wet);
  vec3 col = bokeh(p - lens * 3.0, soft);
  // A fogged pane dims what is outside the drops.
  col *= mix(0.72, 1.18, wet);
  // Speculars on the top edge of each drop.
  vec2 n = b.xy + r.xy;
  col += uHighlight * smoothstep(0.55, 0.95, dot(normalize(n + 1e-4), normalize(vec2(-0.4, 0.9)))) * wet * 0.35;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

export const createCity: SceneFactory = ({ THREE, gsap, scene, uniforms }) => {
  const local = { uDrift: { value: 0.3 }, uFocus: { value: 1 }, uRain: { value: 0 } };
  const pass = fullscreenPass(THREE, CITY_FRAGMENT, { ...uniforms, ...local });
  scene.add(pass);

  // The rain arrives on the window while the city drifts out of focus.
  gsap.to(local.uFocus, { value: 0, duration: 4, ease: "power2.out" });
  gsap.to(local.uRain, { value: 1, duration: 3.5, ease: "power1.in" });
  gsap.to(local.uDrift, { value: 1, duration: 3, ease: "power2.out" });

  return {
    bloom: { strength: 0.55, radius: 0.7, threshold: 0.8 },
    update() {},
    evolve() {
      gsap.timeline({ repeat: -1, yoyo: true, delay: 5 })
        .to(local.uFocus, { value: 0.6, duration: 9, ease: "sine.inOut" })
        .to(local.uDrift, { value: 1.6, duration: 12, ease: "sine.inOut" }, 0);
    },
    exit(duration) {
      gsap.killTweensOf([local.uDrift, local.uFocus, local.uRain]);
      gsap.to(local.uFocus, { value: 1.4, duration, ease: "power2.in" });
      gsap.to(local.uDrift, { value: 4, duration, ease: "power2.in" });
    },
    dispose() {
      gsap.killTweensOf([local.uDrift, local.uFocus, local.uRain]);
      disposeTree(pass);
    },
  };
};

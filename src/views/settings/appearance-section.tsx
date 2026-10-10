"use client";

import { useRef, useState } from "react";
import { LOADER_SCENES, LOADER_SCENE_KEY, LOADER_SCENE_LABELS, readSceneOverride } from "@/lib/loader/select";
import { Check, Palette, Pipette } from "lucide-react";
import {
  ACCENTS,
  accentHex,
  applyAccent,
  applyMaterial,
  applyUiScale,
  currentAccent,
  currentMaterial,
  type Material,
} from "@/lib/appearance";
import { UI_SCALE_PERCENT, type UiScale } from "@/lib/profile-extras";
import { useProfilePreferences } from "@/lib/preferences-client";
import { cn } from "@/lib/utils";
import { Row, Section, Segmented, Toggle } from "./primitives";

const MATERIALS: { id: Material; label: string; help: string }[] = [
  { id: "clear", label: "Clear", help: "Frosted glass over the artwork" },
  { id: "solid", label: "Solid", help: "Opaque dark surfaces, less motion" },
];

export function AppearanceSection() {
  const { data, save } = useProfilePreferences();
  const [material, setMaterial] = useState<Material>(currentMaterial);
  const [accent, setAccent] = useState<string>(currentAccent);
  const [loaderScene, setLoaderScene] = useState<string>(() => readSceneOverride() ?? "auto");
  const uiScale = data?.uiScale ?? "default";
  const customAccent = !ACCENTS.some((a) => a.id === accent);
  // The colour picker reports every shade while dragging: paint each, save the last.
  const accentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chooseAccent = (next: string, debounce = false) => {
    setAccent(next);
    applyAccent(next);
    if (accentTimer.current) clearTimeout(accentTimer.current);
    accentTimer.current = setTimeout(() => void save({ accent: next }), debounce ? 450 : 0);
  };

  return (
    <Section
      title="Appearance"
      icon={<Palette className="h-4 w-4 text-white/70" />}
      description="Saved to your profile, so every device you sign in on looks the same."
    >
      <Row label="Theme">
        <div className="grid grid-cols-2 gap-3 sm:w-80" role="radiogroup" aria-label="Theme">
          {MATERIALS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={material === m.id}
              onClick={() => {
                setMaterial(m.id);
                applyMaterial(m.id);
                void save({ material: m.id });
              }}
              className={cn(
                "overflow-hidden rounded-2xl border text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                material === m.id ? "border-white/70" : "border-white/10 hover:border-white/30"
              )}
            >
              <MaterialPreview material={m.id} accent={accentHex(accent)} />
              <div className="px-3 py-2">
                <div className="text-sm font-semibold text-white">{m.label}</div>
                <div className="text-[11px] leading-snug text-white/55">{m.help}</div>
              </div>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Accent colour" help="Buttons, switches and highlights. Pick any colour with the last swatch.">
        <div className="flex max-w-xs flex-wrap gap-2 sm:justify-end" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              title={a.label}
              onClick={() => chooseAccent(a.id)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                accent === a.id && "ring-2 ring-white ring-offset-2 ring-offset-black/40"
              )}
              style={{ background: a.hex }}
            >
              {accent === a.id && <Check className="h-4 w-4 text-white" />}
            </button>
          ))}
          <label
            title="Any colour"
            className={cn(
              "relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:scale-110 focus-within:ring-2 focus-within:ring-white/70",
              customAccent && "ring-2 ring-white ring-offset-2 ring-offset-black/40"
            )}
            style={{ background: customAccent ? accent : "conic-gradient(#f43f5e, #eab308, #22c55e, #06b6d4, #6366f1, #d946ef, #f43f5e)" }}
          >
            {customAccent ? <Check className="h-4 w-4 text-white" /> : <Pipette className="h-3.5 w-3.5 text-white drop-shadow" />}
            <input
              type="color"
              aria-label="Pick any accent colour"
              value={accentHex(accent)}
              onChange={(e) => chooseAccent(e.target.value.toLowerCase(), true)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </div>
      </Row>
      <Row label="Interface size" help="Bigger text and controls everywhere: handy on a TV or from across the room.">
        <Segmented
          label="Interface size"
          value={uiScale}
          options={[
            { value: "default", label: "Default" },
            { value: "large", label: "Large" },
            { value: "larger", label: "Larger" },
          ]}
          onChange={(v: UiScale) => {
            applyUiScale(UI_SCALE_PERCENT[v]);
            void save({ uiScale: v });
          }}
        />
      </Row>
      <Row inline label="Rotate the home banner" help="Off: the banner stays on one title until you swipe or press an arrow.">
        <Toggle label="Rotate the home banner" checked={data?.heroAutoplay ?? true} disabled={!data} onChange={(on) => void save({ heroAutoplay: on })} />
      </Row>
      <Row label="Loading scene" help="Shown while a movie or episode starts. Automatic picks one that suits the film. This device only.">
        <select
          aria-label="Loading scene"
          value={loaderScene}
          onChange={(e) => {
            setLoaderScene(e.target.value);
            try {
              if (e.target.value === "auto") window.localStorage.removeItem(LOADER_SCENE_KEY);
              else window.localStorage.setItem(LOADER_SCENE_KEY, e.target.value);
            } catch {
              /* private mode */
            }
          }}
          className="h-10 rounded-full border border-white/12 bg-white/[0.06] px-4 text-sm text-white focus:border-white/45 focus:outline-none [&>option]:bg-neutral-900"
        >
          <option value="auto">Automatic</option>
          {LOADER_SCENES.map((id) => (
            <option key={id} value={id}>
              {LOADER_SCENE_LABELS[id]}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  );
}

/** A tiny poster-and-panel sketch of what each material looks like, with the accent on its button. */
function MaterialPreview({ material, accent }: { material: Material; accent: string }) {
  return (
    <div className="relative h-16 bg-[linear-gradient(135deg,#3b1d5a,#b4442f_55%,#f0a64a)]">
      <div
        className={cn(
          "absolute inset-x-3 bottom-2 top-5 rounded-xl border",
          material === "clear" ? "border-white/35 bg-white/15 backdrop-blur-md" : "border-white/10 bg-neutral-900"
        )}
      >
        <span className="absolute bottom-1.5 left-2 h-2.5 w-8 rounded-full" style={{ background: accent }} />
        <span className="absolute bottom-1.5 left-12 h-2.5 w-5 rounded-full bg-white/50" />
      </div>
    </div>
  );
}

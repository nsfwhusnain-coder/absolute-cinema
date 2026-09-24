"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PREFERENCES_QUERY_KEY, patchPreferences } from "@/lib/preferences-client";
import { LOADER_SCENES, LOADER_SCENE_KEY, LOADER_SCENE_LABELS, readSceneOverride } from "@/lib/loader/select";
import { Check, Palette } from "lucide-react";
import {
  ACCENTS,
  applyAccent,
  applyMaterial,
  currentAccent,
  currentMaterial,
  type AccentId,
  type Material,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { Row, Section } from "./primitives";

const MATERIALS: { id: Material; label: string; help: string }[] = [
  { id: "clear", label: "Clear", help: "Frosted glass over the artwork" },
  { id: "solid", label: "Solid", help: "Opaque dark surfaces, less motion" },
];

export function AppearanceSection() {
  const [material, setMaterial] = useState<Material>(currentMaterial);
  const [accent, setAccent] = useState<AccentId>(currentAccent);
  const qc = useQueryClient();
  const [loaderScene, setLoaderScene] = useState<string>(() => readSceneOverride() ?? "auto");
  // Applied at once on this device, then saved to the profile so every device follows.
  const save = (patch: { material?: Material; accent?: AccentId }) =>
    patchPreferences(patch)
      .then((prefs) => qc.setQueryData(PREFERENCES_QUERY_KEY, prefs))
      .catch(() => toast.error("Couldn't save to your profile; it applies on this device only"));

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
              <MaterialPreview material={m.id} />
              <div className="px-3 py-2">
                <div className="text-sm font-semibold text-white">{m.label}</div>
                <div className="text-[11px] leading-snug text-white/55">{m.help}</div>
              </div>
            </button>
          ))}
        </div>
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
      <Row label="Accent colour">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.label}
              title={a.label}
              onClick={() => {
                setAccent(a.id);
                applyAccent(a.id);
                void save({ accent: a.id });
              }}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                accent === a.id && "ring-2 ring-white ring-offset-2 ring-offset-black/40"
              )}
              style={{ background: a.hex }}
            >
              {accent === a.id && <Check className="h-4 w-4 text-white" />}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

/** A tiny poster-and-panel sketch of what each material looks like. */
function MaterialPreview({ material }: { material: Material }) {
  return (
    <div className="relative h-16 bg-[linear-gradient(135deg,#3b1d5a,#b4442f_55%,#f0a64a)]">
      <div
        className={cn(
          "absolute inset-x-3 bottom-2 top-5 rounded-xl border",
          material === "clear"
            ? "border-white/35 bg-white/15 backdrop-blur-md"
            : "border-white/10 bg-neutral-900"
        )}
      />
    </div>
  );
}

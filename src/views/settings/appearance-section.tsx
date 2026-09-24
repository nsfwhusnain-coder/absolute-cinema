"use client";

import { useState } from "react";
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

  return (
    <Section
      title="Appearance"
      icon={<Palette className="h-4 w-4 text-white/70" />}
      description="Applies to this device only."
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

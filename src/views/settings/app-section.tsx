"use client";

import { useState } from "react";
import { Download, Info, Keyboard } from "lucide-react";
import { PLAYER_SHORTCUTS } from "@/lib/shortcuts";
import { useUIStore } from "@/stores/ui-store";
import { PrimaryButton, Row, Section } from "./primitives";


const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

export function AppSection() {
  const installPrompt = useUIStore((s) => s.installPrompt);
  const setInstallPrompt = useUIStore((s) => s.setInstallPrompt);
  const [installing, setInstalling] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const install = async () => {
    if (!installPrompt) return;
    setInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      // The captured event can be used only once, whatever the outcome.
      setInstallPrompt(null);
      setInstalling(false);
    }
  };

  return (
    <Section title="App" icon={<Info className="h-4 w-4 text-white/70" />}>
      {installPrompt && (
        <Row label="Install" help="Add Absolute Cinema to your home screen or dock for a full-screen app.">
          <PrimaryButton onClick={() => void install()} busy={installing}>
            <Download className="h-4 w-4" />
            Install app
          </PrimaryButton>
        </Row>
      )}
      <div className="py-4 first:pt-0 last:pb-0">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-white">Keyboard shortcuts</div>
            <div className="mt-0.5 text-xs text-white/55">In the player.</div>
          </div>
          <PrimaryButton tone="subtle" onClick={() => setShowKeys((v) => !v)}>
            <Keyboard className="h-4 w-4" />
            {showKeys ? "Hide" : "Show"}
          </PrimaryButton>
        </div>
        {showKeys && (
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {PLAYER_SHORTCUTS.map(({ key, desc }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <dt className="text-white/65">{desc}</dt>
                <dd>
                  <kbd className="rounded-lg bg-white/10 px-2 py-0.5 font-mono text-xs text-white">{key}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <Row
        label="About"
        help={
          <>
            Absolute Cinema{APP_VERSION && ` ${APP_VERSION}`}. Catalog data from{" "}
            <a className="underline underline-offset-2 hover:text-white" href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
              TMDB
            </a>
            ; this product uses the TMDB API but is not endorsed or certified by TMDB.
          </>
        }
      >
        <a
          href="https://github.com/nsfwhusnain-coder/absolute-cinema"
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-white/80 underline-offset-2 hover:text-white hover:underline"
        >
          Source on GitHub
        </a>
      </Row>
    </Section>
  );
}

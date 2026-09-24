"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { Check, ExternalLink, KeyRound, Loader2, Zap } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SetupStatus {
  tmdb: boolean;
  realDebrid: boolean;
  isAdmin: boolean;
}

type Step = "tmdb" | "debrid" | "done";

const SETUP_QUERY_KEY = ["setup-status"];

async function postJson(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `Request failed (HTTP ${res.status}).`;
}

/**
 * First-run setup. Until a TMDB key exists nothing in the catalog can load,
 * so this takes over the screen for the admin (and explains the wait to
 * anyone else) instead of showing a wall of empty rails.
 */
export function SetupWizard() {
  const pathname = usePathname();
  const sessionStatus = useSession()?.status;
  const qc = useQueryClient();
  const [step, setStep] = useState<Step | null>(null);

  const { data } = useQuery({
    queryKey: SETUP_QUERY_KEY,
    queryFn: async (): Promise<SetupStatus | null> => {
      const res = await fetch("/api/setup");
      return res.ok ? res.json() : null;
    },
    enabled: sessionStatus === "authenticated",
    staleTime: Infinity,
  });

  const needsSetup = data != null && !data.tmdb;
  if (pathname === "/login" || (!needsSetup && step === null)) return null;

  const finish = () => {
    setStep(null);
    qc.invalidateQueries();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-[#050508]/95 px-4 py-10 backdrop-blur-xl">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0c0c11] p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark size="nav" />
          <div>
            <h1 className="font-display text-xl font-bold">Welcome to Absolute Cinema</h1>
            <p className="text-sm text-muted-foreground">Two keys and you are streaming.</p>
          </div>
        </div>

        {!data?.isAdmin ? (
          <p className="text-sm leading-relaxed text-white/80">
            This server has not been set up yet. Ask whoever runs it to sign in with the admin
            account and add a TMDB key in Settings.
          </p>
        ) : (
          <>
            <StepIndicator step={step ?? "tmdb"} />
            {(step ?? "tmdb") === "tmdb" && <TmdbStep onDone={() => setStep(data?.realDebrid ? "done" : "debrid")} />}
            {step === "debrid" && <DebridStep onDone={() => setStep("done")} />}
            {step === "done" && (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <Check className="h-6 w-6" />
                </div>
                <p className="text-sm text-white/80">
                  All set. You can change these any time under Settings → Connections.
                </p>
                <Button className="w-full rounded-full" onClick={finish}>
                  Start watching
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "tmdb", label: "Catalog" },
    { id: "debrid", label: "Streaming" },
    { id: "done", label: "Done" },
  ];
  const current = steps.findIndex((s) => s.id === step);
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-1 items-center gap-2">
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.7rem] font-semibold",
              i < current && "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
              i === current && "border-white bg-white text-black",
              i > current && "border-white/15 text-muted-foreground",
            )}
          >
            {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className={i === current ? "text-white" : "text-muted-foreground"}>{s.label}</span>
          {i < steps.length - 1 && <span className="h-px flex-1 bg-white/10" />}
        </li>
      ))}
    </ol>
  );
}

function KeyForm({
  label,
  placeholder,
  help,
  submitLabel,
  onSubmit,
  secondary,
}: {
  label: string;
  placeholder: string;
  help: React.ReactNode;
  submitLabel: string;
  onSubmit: (value: string) => Promise<string | null>;
  secondary?: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onSubmit(value.trim());
    setBusy(false);
    if (failure) setError(failure);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="setup-key">
        {label}
      </label>
      <Input
        id="setup-key"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-sm"
      />
      <div className="text-xs leading-relaxed text-muted-foreground">{help}</div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2 pt-1">
        <Button type="submit" className="flex-1 rounded-full" disabled={!value.trim() || busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {busy ? "Checking…" : submitLabel}
        </Button>
        {secondary}
      </div>
    </form>
  );
}

function TmdbStep({ onDone }: { onDone: () => void }) {
  return (
    <div>
      <div className="mb-4 flex items-start gap-3 rounded-2xl bg-white/[0.04] p-4">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-white/70" />
        <p className="text-sm leading-relaxed text-white/80">
          TMDB provides posters, titles, cast and search. A free account takes a minute.
        </p>
      </div>
      <KeyForm
        label="TMDB API key"
        placeholder="API key or API Read Access Token"
        submitLabel="Verify and continue"
        help={
          <>
            Sign up at themoviedb.org, then open{" "}
            <a
              className="inline-flex items-center gap-0.5 text-white underline underline-offset-2"
              href="https://www.themoviedb.org/settings/api"
              target="_blank"
              rel="noreferrer"
            >
              Settings → API <ExternalLink className="h-3 w-3" />
            </a>
            . Either the API Key or the Read Access Token works.
          </>
        }
        onSubmit={async (tmdbKey) => {
          const error = await postJson("/api/setup", { tmdbKey });
          if (!error) onDone();
          return error;
        }}
      />
    </div>
  );
}

function DebridStep({ onDone }: { onDone: () => void }) {
  return (
    <div>
      <div className="mb-4 flex items-start gap-3 rounded-2xl bg-amber-400/[0.06] p-4">
        <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <p className="text-sm leading-relaxed text-white/80">
          Real-Debrid unlocks fast, reliable 1080p and 4K sources. Without it, playback uses free
          web sources, which are slower and usually top out at 1080p.
        </p>
      </div>
      <KeyForm
        label="Real-Debrid API token"
        placeholder="Your private API token"
        submitLabel="Verify and finish"
        help={
          <>
            Copy it from{" "}
            <a
              className="inline-flex items-center gap-0.5 text-white underline underline-offset-2"
              href="https://real-debrid.com/apitoken"
              target="_blank"
              rel="noreferrer"
            >
              real-debrid.com/apitoken <ExternalLink className="h-3 w-3" />
            </a>
            . It stays on your server and is never sent to the browser.
          </>
        }
        onSubmit={async (token) => {
          const error = await postJson("/api/debrid/status", { token });
          if (!error) onDone();
          return error;
        }}
        secondary={
          <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
            Skip
          </Button>
        }
      />
    </div>
  );
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Row, Section, StatusPill, Toggle } from "./primitives";

interface Circuit {
  state: "closed" | "open" | "half_open";
  enabled: boolean;
  samples: number;
  errors: number;
  errorRate: number;
  lastMs: number | null;
}

interface SystemStatus {
  db: "ok" | "error";
  scraper: "ok" | "error";
  scraperHealth: { circuits?: Record<string, Circuit>; lastScrape?: { totalMs: number; at: number } | null; error?: string } | null;
  remuxer?: { status: "ok" | "off" | "error"; sessions: number; runs: number };
  proxy: { hitRate: number; entries: number; bytesCached: number };
}

const REFRESH_MS = 15_000;

const FLAGS = [
  { key: "flag_ui_bottom_nav", label: "Bottom bar on phones", help: "Takes effect on the next page load." },
  { key: "flag_ui_hubs", label: "Movies and Shows pages in the menu", help: "Takes effect on the next page load." },
  { key: "flag_playback_fast_path", label: "Quick first results", help: "Shows the first sources found while the full search continues." },
] as const;

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function SystemSection({
  settings,
  providers,
}: {
  settings: Record<string, string>;
  providers: { id: string; name: string }[];
}) {
  const [advanced, setAdvanced] = useState(false);
  const { data, isError } = useQuery<SystemStatus>({
    queryKey: ["system-status"],
    queryFn: async () => (await fetch("/api/system-status", { cache: "no-store" })).json(),
    refetchInterval: REFRESH_MS,
  });

  const remux = data?.remuxer;

  return (
    <Section title="System" icon={<Activity className="h-4 w-4 text-white/70" />} description="Live status of this server.">
      <Row label="Database">
        <StatusPill tone={!data ? "off" : data.db === "ok" ? "ok" : "warn"}>{!data ? (isError ? "Unknown" : "Checking") : data.db === "ok" ? "Healthy" : "Error"}</StatusPill>
      </Row>
      <Row
        label="Source finder"
        help={data?.scraperHealth?.lastScrape ? `Last search took ${(data.scraperHealth.lastScrape.totalMs / 1000).toFixed(1)}s.` : undefined}
      >
        <StatusPill tone={!data ? "off" : data.scraper === "ok" ? "ok" : "warn"}>
          {!data ? "Checking" : data.scraper === "ok" ? "Running" : data.scraperHealth?.error || "Unreachable"}
        </StatusPill>
      </Row>
      <Row label="MKV / 4K streaming" help="Rewraps MKV releases so they play and seek in any browser.">
        <StatusPill tone={!remux ? "off" : remux.status === "ok" ? "ok" : remux.status === "off" ? "off" : "warn"}>
          {!remux ? "Checking" : remux.status === "ok" ? `Running · ${remux.sessions} active` : remux.status === "off" ? "Turned off" : "Unreachable"}
        </StatusPill>
      </Row>
      <div className="py-4 last:pb-0">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          className="flex w-full items-center justify-between text-sm font-medium text-white/80 hover:text-white"
        >
          Advanced
          <ChevronDown className={cn("h-4 w-4 transition-transform", advanced && "rotate-180")} />
        </button>
        {advanced && <Advanced settings={settings} providers={providers} status={data} />}
      </div>
    </Section>
  );
}

function Advanced({
  settings,
  providers,
  status,
}: {
  settings: Record<string, string>;
  providers: { id: string; name: string }[];
  status: SystemStatus | undefined;
}) {
  const qc = useQueryClient();
  const [values, setValues] = useState(settings);
  const save = useMutation({
    mutationFn: async (patch: Record<string, string>) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Could not save");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const set = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    save.mutate({ [key]: value });
  };
  const circuits = Object.entries(status?.scraperHealth?.circuits ?? {});

  return (
    <div className="mt-4 divide-y divide-white/[0.07]">
      <Row label="Playback source" help="“Not configured” turns playback off for everyone.">
        <select
          aria-label="Playback source"
          value={values.playback_provider}
          onChange={(e) => set("playback_provider", e.target.value)}
          className="h-10 w-full max-w-xs truncate rounded-full border border-white/12 sm:w-64 bg-white/[0.06] px-4 text-sm text-white focus:border-white/45 focus:outline-none [&>option]:bg-neutral-900"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      {FLAGS.map((f) => (
        <Row key={f.key} label={f.label} help={f.help} inline>
          <Toggle label={f.label} checked={values[f.key] !== "off"} onChange={(on) => set(f.key, on ? "on" : "off")} />
        </Row>
      ))}
      {status && (
        <Row label="Stream cache" help="Recently fetched stream segments kept in memory.">
          <span className="text-sm tabular-nums text-white/75">
            {Math.round(status.proxy.hitRate * 100)}% hits · {formatBytes(status.proxy.bytesCached)}
          </span>
        </Row>
      )}
      {circuits.length > 0 && (
        <div className="py-4 last:pb-0">
          <div className="mb-2 text-sm font-medium text-white">Providers</div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {circuits.map(([id, c]) => (
              <li key={id} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs">
                <span className="font-medium capitalize text-white">{id}</span>
                <span className="flex items-center gap-2 tabular-nums text-white/55">
                  {c.lastMs != null && `${c.lastMs} ms`}
                  <StatusPill tone={!c.enabled ? "off" : c.state === "closed" ? "ok" : "warn"}>
                    {!c.enabled ? "Off" : c.state === "closed" ? "OK" : c.state === "open" ? "Paused" : "Retrying"}
                  </StatusPill>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

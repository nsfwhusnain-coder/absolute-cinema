"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Film, Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PrimaryButton, Row, Section, StatusPill, inputClass } from "./primitives";

interface RealDebridStatus {
  configured: boolean;
  source: "database" | "env" | "none";
  valid: boolean;
  premium: boolean;
  username: string | null;
  expiresAt: string | null;
  points: number | null;
  error: string | null;
}

const DAY_MS = 86_400_000;

function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.floor((at.getTime() - Date.now()) / DAY_MS);
  const date = at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (days < 0) return `Expired ${date}`;
  return `Premium until ${date} · ${days === 0 ? "ends today" : `${days} day${days === 1 ? "" : "s"} left`}`;
}

async function send(url: string, method: string, body?: object): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}

export function ConnectionsSection({ tmdbConfigured, tmdbMasked }: { tmdbConfigured: boolean; tmdbMasked: string }) {
  return (
    <Section
      title="Connections"
      icon={<Plug className="h-4 w-4 text-white/70" />}
      description="The two keys Absolute Cinema needs. Both are checked before they're saved and never shown again."
    >
      <TmdbRow configured={tmdbConfigured} masked={tmdbMasked} />
      <RealDebridRow />
    </Section>
  );
}

function SecretForm({
  placeholder,
  action,
  onSubmit,
  busy,
}: {
  placeholder: string;
  action: string;
  onSubmit: (value: string) => Promise<void>;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    await onSubmit(value.trim()).then(() => setValue(""), () => undefined);
  };
  return (
    <form onSubmit={submit} className="flex w-full gap-2 sm:w-auto">
      <input
        className={cn(inputClass, "sm:w-64")}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        aria-label={placeholder}
      />
      <PrimaryButton type="submit" disabled={!value.trim()} busy={busy}>
        {action}
      </PrimaryButton>
    </form>
  );
}

function TmdbRow({ configured, masked }: { configured: boolean; masked: string }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (tmdbKey: string) => send("/api/setup", "POST", { tmdbKey }),
    onSuccess: () => {
      toast.success("TMDB connected");
      void qc.invalidateQueries();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  return (
    <Row
      label="TMDB"
      help={
        <span className="flex flex-col gap-1.5">
          <span>
            Posters, titles and search. Free key at{" "}
            <a className="underline underline-offset-2 hover:text-white" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">
              themoviedb.org
            </a>
            .
          </span>
          <span>
            <StatusPill tone={configured ? "ok" : "warn"}>
              <Film className="h-3 w-3" />
              {configured ? `Connected${masked ? ` ${masked}` : ""}` : "Not connected"}
            </StatusPill>
          </span>
        </span>
      }
    >
      <SecretForm
        placeholder={configured ? "Replace key" : "API key or read token"}
        action={configured ? "Replace" : "Connect"}
        busy={save.isPending}
        onSubmit={(v) => save.mutateAsync(v).then(() => undefined)}
      />
    </Row>
  );
}

function RealDebridRow() {
  const qc = useQueryClient();
  const { data: status, isFetching, refetch } = useQuery<RealDebridStatus>({
    queryKey: ["debrid-status"],
    queryFn: async () => {
      const res = await fetch("/api/debrid/status");
      if (!res.ok) throw new Error("Could not load status");
      return res.json();
    },
  });
  const onStatus = (next: unknown) => qc.setQueryData(["debrid-status"], next);
  const save = useMutation({
    mutationFn: (token: string) => send("/api/debrid/status", "POST", { token }),
    onSuccess: (next) => {
      onStatus(next);
      toast.success((next as RealDebridStatus).premium ? "Real-Debrid connected" : "Token saved, but the account isn't premium");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const remove = useMutation({
    mutationFn: () => send("/api/debrid/status", "DELETE"),
    onSuccess: onStatus,
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not remove"),
  });

  const active = Boolean(status?.valid && status.premium);
  const pill = !status ? null : active ? (
    <StatusPill tone="ok">
      <Crown className="h-3 w-3" />
      {status.username ?? "Premium"}
    </StatusPill>
  ) : (
    <StatusPill tone={status.configured ? "warn" : "off"}>
      {status.configured ? (status.valid ? "Not premium" : "Token rejected") : "Not connected"}
    </StatusPill>
  );

  return (
    <Row
      label="Real-Debrid"
      help={
        <span className="flex flex-col gap-1.5">
          <span>
            Fast 1080p and 4K from your premium account. Token at{" "}
            <a className="underline underline-offset-2 hover:text-white" href="https://real-debrid.com/apitoken" target="_blank" rel="noreferrer">
              real-debrid.com/apitoken
            </a>
            .
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {pill}
            <button
              type="button"
              onClick={() => void refetch()}
              aria-label="Check again"
              className="rounded-full p-1 text-white/55 hover:text-white"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </button>
          </span>
          {active && status?.expiresAt && <span>{expiryText(status.expiresAt)}</span>}
          {!active && status?.error && <span className="text-amber-300/90">{status.error}</span>}
        </span>
      }
    >
      <div className="flex flex-col items-stretch gap-2 sm:items-end">
        <SecretForm
          placeholder={status?.configured ? "Replace token" : "API token"}
          action={status?.configured ? "Replace" : "Connect"}
          busy={save.isPending}
          onSubmit={(v) => save.mutateAsync(v).then(() => undefined)}
        />
        {status?.source === "database" && (
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="self-end text-xs font-medium text-white/50 hover:text-red-300"
          >
            Disconnect
          </button>
        )}
      </div>
    </Row>
  );
}

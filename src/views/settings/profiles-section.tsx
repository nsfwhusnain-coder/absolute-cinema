"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import { ProfileAvatar } from "@/views/login";
import { PrimaryButton, Row, Section, Toggle, inputClass } from "./primitives";

interface AdminProfile {
  id: string;
  name: string;
  isAdmin: boolean;
  avatarColor: string;
  watchlistCount: number;
  progressCount: number;
}

const USERS_KEY = ["admin", "users"] as const;

export function ProfilesSection({ settings }: { settings: Record<string, string> }) {
  const qc = useQueryClient();
  const { data: profiles } = useQuery<AdminProfile[]>({
    queryKey: USERS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Could not load profiles");
      return res.json();
    },
  });

  const flag = useMutation({
    mutationFn: async (patch: Record<string, string>) => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Could not save");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  // Optimistic view of the two switches, so they respond instantly.
  const [signups, setSignups] = useState(settings.signups_open !== "off");
  const [picker, setPicker] = useState(settings.profile_picker !== "off");

  return (
    <Section
      title="Profiles"
      icon={<Users className="h-4 w-4 text-white/70" />}
      description="Everyone who watches on this server. Each profile has its own list, history and settings."
    >
      <Row label="Show profiles on sign-in" help="Off hides the Who's-watching grid; people type their name instead." inline>
        <Toggle
          label="Show profiles on sign-in"
          checked={picker}
          onChange={(next) => {
            setPicker(next);
            flag.mutate({ profile_picker: next ? "on" : "off" });
          }}
        />
      </Row>
      <Row label="Anyone can add a profile" help="Off means only an admin can add people, from here." inline>
        <Toggle
          label="Anyone can add a profile"
          checked={signups}
          onChange={(next) => {
            setSignups(next);
            flag.mutate({ signups_open: next ? "on" : "off" });
          }}
        />
      </Row>
      <div className="py-4 last:pb-0">
        <ul className="space-y-2">
          {(profiles ?? []).map((p) => (
            <ProfileRow key={p.id} profile={p} />
          ))}
        </ul>
        <AddProfile existing={profiles?.length ?? 0} />
      </div>
    </Section>
  );
}

function ProfileRow({ profile }: { profile: AdminProfile }) {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const [confirming, setConfirming] = useState(false);
  const isSelf = session?.user?.id === profile.id;

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/users?id=${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not delete");
    },
    onSuccess: () => {
      toast.success(`${profile.name} deleted`);
      void qc.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete"),
  });

  return (
    <li className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5">
      <ProfileAvatar name={profile.name} color={profile.avatarColor} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">
          {profile.name}
          {isSelf && <span className="text-white/45"> · you</span>}
        </div>
        <div className="text-xs text-white/50">
          {profile.isAdmin ? "Admin · " : ""}
          {profile.watchlistCount} in list · {profile.progressCount} in progress
        </div>
      </div>
      {!isSelf &&
        (confirming ? (
          <div className="flex gap-1.5">
            <PrimaryButton tone="subtle" onClick={() => setConfirming(false)}>
              Keep
            </PrimaryButton>
            <PrimaryButton tone="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </PrimaryButton>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${profile.name}`}
            className="rounded-full p-2 text-white/45 transition hover:bg-red-500/15 hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ))}
    </li>
  );
}

function AddProfile({ existing }: { existing: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const color = AVATAR_COLORS[existing % AVATAR_COLORS.length]!;
  const ready = name.trim().length >= 2 && pin.length >= 4;

  const add = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), pin, avatarColor: color }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not add profile");
    },
    onSuccess: () => {
      toast.success(`${name.trim()} added`);
      setName("");
      setPin("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add profile"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) add.mutate();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 py-3 text-sm font-medium text-white/70 transition hover:border-white/35 hover:text-white"
      >
        <Plus className="h-4 w-4" />
        Add profile
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3 sm:flex-row sm:items-center">
      <ProfileAvatar name={name.trim() || "?"} color={color} size="sm" />
      <input
        className={cn(inputClass, "sm:flex-1")}
        value={name}
        maxLength={24}
        placeholder="Name"
        autoFocus
        onChange={(e) => setName(e.target.value)}
        aria-label="Name"
      />
      <input
        className={cn(inputClass, "sm:w-32")}
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        value={pin}
        placeholder="PIN"
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
        aria-label="PIN"
      />
      <div className="flex gap-2">
        <PrimaryButton tone="subtle" onClick={() => setOpen(false)}>
          Cancel
        </PrimaryButton>
        <PrimaryButton type="submit" disabled={!ready} busy={add.isPending}>
          Add
        </PrimaryButton>
      </div>
    </form>
  );
}

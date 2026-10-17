"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { Check, Copy, Link2, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { defaultAvatar } from "@/lib/avatars";
import { cn } from "@/lib/utils";
import { ProfileAvatar } from "@/components/profile-avatar";
import { PrimaryButton, Row, Section, Toggle, inputClass } from "./primitives";

interface AdminProfile {
  id: string;
  name: string;
  isAdmin: boolean;
  avatarColor: string;
  avatar: string;
  locked: boolean;
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

  // Optimistic view of the switches, so they respond instantly.
  const [signups, setSignups] = useState(settings.signups_open !== "off");
  const [picker, setPicker] = useState(settings.profile_picker !== "off");
  const [pinNeeded, setPinNeeded] = useState(settings.require_pin === "on");

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
      <Row label="New profiles need a PIN" help="On a server shared outside the home, a profile without one opens for anyone." inline>
        <Toggle
          label="New profiles need a PIN"
          checked={pinNeeded}
          onChange={(next) => {
            setPinNeeded(next);
            flag.mutate({ require_pin: next ? "on" : "off" });
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
      <InviteLinks />
    </Section>
  );
}

interface InviteRow {
  code: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  state: "valid" | "expired" | "used" | "revoked" | "unknown";
}

const INVITES_KEY = ["admin", "invites"] as const;
const INVITE_USES = [
  { label: "1 person", value: 1 },
  { label: "5 people", value: 5 },
  { label: "25 people", value: 25 },
  { label: "No limit", value: 0 },
] as const;
const INVITE_DAYS = [
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "Never", value: 0 },
] as const;

/** "abcd-efgh-jkmn": the dashes are for people. */
function grouped(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Invite links: each lets whoever holds it create a profile while sign-ups
 * are closed (src/lib/invites.ts), for testers on a server shared outside the home.
 */
function InviteLinks() {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [uses, setUses] = useState<number>(1);
  const [days, setDays] = useState<number>(7);
  const [copied, setCopied] = useState<string | null>(null);
  const { data } = useQuery<{ invites: InviteRow[]; publicBase?: string | null }>({
    queryKey: INVITES_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/invites", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load invites");
      return res.json();
    },
  });
  // The site's own address when the server knows it, so a link copied on the machine itself still works outside.
  const linkOf = (code: string) => `${data?.publicBase || (typeof window === "undefined" ? "" : window.location.origin)}/join/${grouped(code)}`;
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(linkOf(code));
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 2000);
    } catch {
      toast.message(linkOf(code));
    }
  };
  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, maxUses: uses || null, expiresInDays: days || null }),
      });
      const json = (await res.json().catch(() => ({}))) as { invite?: InviteRow; error?: string };
      if (!res.ok || !json.invite) throw new Error(json.error || "Could not create the invite");
      return json.invite;
    },
    onSuccess: (invite) => {
      setNote("");
      void qc.invalidateQueries({ queryKey: INVITES_KEY });
      void copy(invite.code);
      toast.success("Invite link created and copied");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create the invite"),
  });
  const revoke = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch(`/api/admin/invites?code=${encodeURIComponent(code)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not switch the invite off");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: INVITES_KEY }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not switch the invite off"),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const select = "h-10 rounded-xl border border-white/15 bg-white/[0.06] px-2 text-sm text-white focus:border-white/50 focus:outline-none";
  const describe = (invite: InviteRow) => {
    const parts = [invite.maxUses ? `${invite.uses} of ${invite.maxUses} used` : `${invite.uses} used`];
    if (invite.state === "valid") parts.push(invite.expiresAt ? `until ${new Date(invite.expiresAt).toLocaleDateString()}` : "no end date");
    else parts.push({ expired: "expired", used: "used up", revoked: "switched off", unknown: "unknown", valid: "" }[invite.state]);
    return parts.join(" · ");
  };
  return (
    <div className="border-t border-white/10 py-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-white">
        <Link2 className="h-4 w-4 text-white/60" /> Invite links
      </div>
      <p className="mb-3 text-xs text-white/50">
        Each link lets whoever has it make a profile, even with sign-ups off. Send it to a tester; switch it off any time.
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <input className={cn(inputClass, "h-10 min-w-0 flex-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder="Who it's for (optional)" />
        <select className={select} value={uses} onChange={(e) => setUses(Number(e.target.value))} aria-label="How many people">
          {INVITE_USES.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select className={select} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How long it works">
          {INVITE_DAYS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <PrimaryButton busy={create.isPending} type="submit">
          <Plus className="h-4 w-4" /> Create link
        </PrimaryButton>
      </form>
      {(data?.invites ?? []).length > 0 && (
        <ul className="mt-3 space-y-2">
          {data!.invites.map((invite) => (
            <li key={invite.code} className={cn("flex items-center gap-3 rounded-2xl bg-white/[0.04] px-3 py-2.5", invite.state !== "valid" && "opacity-55")}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm text-white">{grouped(invite.code)}</div>
                <div className="truncate text-xs text-white/50">
                  {invite.note ? `${invite.note} · ` : ""}
                  {describe(invite)}
                </div>
              </div>
              {invite.state === "valid" && (
                <>
                  <button
                    type="button"
                    onClick={() => void copy(invite.code)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-medium text-white hover:bg-white/15"
                  >
                    {copied === invite.code ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied === invite.code ? "Copied" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => revoke.mutate(invite.code)}
                    aria-label={`Switch off ${grouped(invite.code)}`}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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
      <ProfileAvatar name={profile.name} color={profile.avatarColor} avatar={profile.avatar} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">
          {profile.name}
          {isSelf && <span className="text-white/45"> · you</span>}
        </div>
        <div className="text-xs text-white/50">
          {profile.isAdmin ? "Admin · " : ""}
          {profile.locked ? "PIN · " : ""}
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
  const ready = name.trim().length >= 2 && (pin.length === 0 || pin.length >= 4);

  const add = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), avatarColor: color, avatar: defaultAvatar(existing), ...(pin ? { pin } : {}) }),
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
      <ProfileAvatar name={name.trim() || "?"} color={color} avatar={defaultAvatar(existing)} size="sm" />
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
        placeholder="PIN (optional)"
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

"use client";

import { useState, type FormEvent } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import { AvatarPicker, ProfileAvatar } from "@/components/profile-avatar";
import { useNavigate } from "@/hooks/use-navigate";
import { PrimaryButton, Row, Section, Toggle, inputClass } from "./primitives";

export const OWN_PROFILE_QUERY_KEY = ["own-profile"] as const;

export interface OwnProfile {
  name: string;
  avatarColor: string;
  avatar: string;
  pinRequired: boolean;
}

async function patchProfile(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || "Could not save");
}

export function useOwnProfile() {
  return useQuery<OwnProfile>({
    queryKey: OWN_PROFILE_QUERY_KEY,
    queryFn: async () => (await fetch("/api/profile", { cache: "no-store" })).json(),
  });
}

const digits = (value: string) => value.replace(/\D/g, "").slice(0, 10);

export function ProfileSection() {
  const { data: session, update } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: profile } = useOwnProfile();
  const [editing, setEditing] = useState(false);

  const name = profile?.name ?? session?.user?.name ?? "";
  const color = profile?.avatarColor ?? session?.user?.avatarColor ?? AVATAR_COLORS[0];
  const avatar = profile?.avatar ?? session?.user?.avatar ?? "";

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: OWN_PROFILE_QUERY_KEY });
    await update();
  };

  const saveLook = async (next: { avatar?: string; color?: string }) => {
    qc.setQueryData<OwnProfile>(OWN_PROFILE_QUERY_KEY, (old) =>
      old ? { ...old, ...(next.avatar ? { avatar: next.avatar } : {}), ...(next.color ? { avatarColor: next.color } : {}) } : old
    );
    try {
      await patchProfile({ ...(next.avatar ? { avatar: next.avatar } : {}), ...(next.color ? { avatarColor: next.color } : {}) });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
      await qc.invalidateQueries({ queryKey: OWN_PROFILE_QUERY_KEY });
    }
  };

  return (
    <Section title="Profile" icon={<UserRound className="h-4 w-4 text-white/70" />}>
      <div className="flex items-center gap-4 pb-4">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-label="Change picture"
          className="rounded-[30%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <ProfileAvatar name={name || "?"} color={color} avatar={avatar} size="md" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-xl font-semibold text-white">{name}</div>
          <div className="text-sm text-white/55">{session?.user?.isAdmin ? "Admin" : "Profile"}</div>
        </div>
        <PrimaryButton tone="subtle" onClick={() => navigate("/login")}>
          Switch profile
        </PrimaryButton>
      </div>
      <Row label="Picture" help="A picture and colour so everyone spots their profile.">
        <PrimaryButton tone="subtle" onClick={() => setEditing((v) => !v)}>
          {editing ? "Done" : "Change"}
        </PrimaryButton>
      </Row>
      {editing && (
        <div className="pb-4">
          <AvatarPicker name={name} avatar={avatar} color={color} onChange={(next) => void saveLook(next)} />
        </div>
      )}
      <RenameRow currentName={name} locked={Boolean(profile?.pinRequired)} onSaved={() => void refresh()} />
      <PinLockRow locked={Boolean(profile?.pinRequired)} onSaved={() => void refresh()} />
    </Section>
  );
}

function RenameRow({ currentName, locked, onSaved }: { currentName: string; locked: boolean; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const changed = trimmed.length >= 2 && trimmed !== currentName;
  const ready = changed && (!locked || pin.length >= 4);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await patchProfile({ name: trimmed, ...(locked ? { currentPin: pin } : {}) });
      toast.success(`Renamed to ${trimmed}`);
      setName("");
      setPin("");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row label="Name" help={locked ? "Confirm with your PIN." : undefined}>
      <form onSubmit={submit} className="flex w-full flex-col gap-2 sm:w-72">
        <div className="flex gap-2">
          <input
            className={cn(inputClass, "sm:w-auto sm:flex-1")}
            value={name}
            maxLength={24}
            placeholder={currentName}
            onChange={(e) => setName(e.target.value)}
            aria-label="New name"
          />
          {changed && !locked && (
            <PrimaryButton type="submit" busy={busy}>
              Save
            </PrimaryButton>
          )}
        </div>
        {changed && locked && (
          <div className="flex gap-2">
            <input
              className={cn(inputClass, "sm:w-auto sm:flex-1")}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              placeholder="Your PIN"
              onChange={(e) => setPin(digits(e.target.value))}
              aria-label="Your PIN"
            />
            <PrimaryButton type="submit" disabled={!ready} busy={busy}>
              Save
            </PrimaryButton>
          </div>
        )}
      </form>
    </Row>
  );
}

/** "Require PIN": off by default, so profiles open with one tap like Netflix. */
function PinLockRow({ locked, onSaved }: { locked: boolean; onSaved: () => void }) {
  const [mode, setMode] = useState<"idle" | "lock" | "unlock" | "change">("idle");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode("idle");
    setCurrent("");
    setNext("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "lock") await patchProfile({ newPin: next });
      else if (mode === "unlock") await patchProfile({ pinRequired: false, currentPin: current });
      else await patchProfile({ newPin: next, currentPin: current });
      toast.success(mode === "unlock" ? "PIN removed" : mode === "lock" ? "Profile locked with a PIN" : "PIN changed");
      reset();
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const needsCurrent = mode === "unlock" || mode === "change";
  const needsNext = mode === "lock" || mode === "change";
  const ready = (!needsCurrent || current.length >= 4) && (!needsNext || next.length >= 4);

  return (
    <>
      <Row inline label="Require PIN" help="Ask for a PIN before this profile opens. Off: one tap, like Netflix.">
        <Toggle
          label="Require PIN"
          checked={(locked && mode !== "unlock") || mode === "lock"}
          onChange={(on) => setMode(on ? (locked ? "idle" : "lock") : locked ? "unlock" : "idle")}
        />
      </Row>
      {locked && mode === "idle" && (
        <Row label="PIN">
          <PrimaryButton tone="subtle" onClick={() => setMode("change")}>
            Change PIN
          </PrimaryButton>
        </Row>
      )}
      {mode !== "idle" && (
        <form onSubmit={submit} className="flex flex-col gap-2 py-4 sm:ml-auto sm:w-72">
          {needsCurrent && (
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={current}
              placeholder="Current PIN"
              onChange={(e) => setCurrent(digits(e.target.value))}
              aria-label="Current PIN"
              autoFocus
            />
          )}
          {needsNext && (
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={next}
              placeholder="New PIN (4-10 digits)"
              onChange={(e) => setNext(digits(e.target.value))}
              aria-label="New PIN"
              autoFocus={!needsCurrent}
            />
          )}
          <div className="flex justify-end gap-2">
            <PrimaryButton tone="subtle" onClick={reset}>
              Cancel
            </PrimaryButton>
            <PrimaryButton type="submit" disabled={!ready} busy={busy}>
              {mode === "unlock" ? "Remove PIN" : mode === "lock" ? "Lock profile" : "Change PIN"}
            </PrimaryButton>
          </div>
        </form>
      )}
    </>
  );
}

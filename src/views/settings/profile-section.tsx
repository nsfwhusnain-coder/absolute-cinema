"use client";

import { useState, type FormEvent } from "react";
import { useSession } from "next-auth/react";
import { Check, UserRound } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import { ProfileAvatar } from "@/views/login";
import { useNavigate } from "@/hooks/use-navigate";
import { PrimaryButton, Row, Section, inputClass } from "./primitives";

async function patchProfile(body: Record<string, string>): Promise<void> {
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error || "Could not save");
}

export function ProfileSection() {
  const { data: session, update } = useSession();
  const navigate = useNavigate();
  const name = session?.user?.name ?? "";
  const color = session?.user?.avatarColor ?? AVATAR_COLORS[0];
  const [savingColor, setSavingColor] = useState<string | null>(null);

  const pickColor = async (next: string) => {
    if (next === color) return;
    setSavingColor(next);
    try {
      await patchProfile({ avatarColor: next });
      await update();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSavingColor(null);
    }
  };

  return (
    <Section title="Profile" icon={<UserRound className="h-4 w-4 text-white/70" />}>
      <div className="flex items-center gap-4 pb-4">
        <ProfileAvatar name={name || "?"} color={savingColor ?? color} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-xl font-semibold text-white">{name}</div>
          <div className="text-sm text-white/55">{session?.user?.isAdmin ? "Admin" : "Profile"}</div>
        </div>
        <PrimaryButton tone="subtle" onClick={() => navigate("/login")}>
          Switch profile
        </PrimaryButton>
      </div>
      <Row label="Colour">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar colour">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === (savingColor ?? color)}
              aria-label={`Colour ${c}`}
              onClick={() => void pickColor(c)}
              disabled={savingColor !== null}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                c === (savingColor ?? color) && "ring-2 ring-white ring-offset-2 ring-offset-black/40"
              )}
              style={{ background: c }}
            >
              {c === (savingColor ?? color) && <Check className="h-4 w-4 text-white" />}
            </button>
          ))}
        </div>
      </Row>
      <RenameRow currentName={name} onSaved={() => void update()} />
      <PinRow />
    </Section>
  );
}

function RenameRow({ currentName, onSaved }: { currentName: string; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const ready = trimmed.length >= 2 && trimmed !== currentName && pin.length >= 4;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await patchProfile({ name: trimmed, currentPin: pin });
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
    <Row label="Name" help="Confirm with your current PIN.">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:items-end">
        <input
          className={inputClass}
          value={name}
          maxLength={24}
          placeholder={currentName}
          onChange={(e) => setName(e.target.value)}
          aria-label="New name"
        />
        {trimmed.length >= 2 && trimmed !== currentName && (
          <div className="flex w-full gap-2 sm:w-72">
            <input
              className={cn(inputClass, "sm:w-auto sm:flex-1")}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              placeholder="Current PIN"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 10))}
              aria-label="Current PIN"
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

function PinRow() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = current.length >= 4 && next.length >= 4;

  const reset = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await patchProfile({ currentPin: current, newPin: next });
      toast.success("PIN changed");
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change PIN");
    } finally {
      setBusy(false);
    }
  };

  const digits = (value: string) => value.replace(/\D/g, "").slice(0, 10);

  return (
    <Row label="PIN" help="4 to 10 digits, asked for when you pick this profile.">
      {open ? (
        <form onSubmit={submit} className="flex flex-col gap-2 sm:w-72">
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
          <input
            className={inputClass}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={next}
            placeholder="New PIN"
            onChange={(e) => setNext(digits(e.target.value))}
            aria-label="New PIN"
          />
          <div className="flex justify-end gap-2">
            <PrimaryButton tone="subtle" onClick={reset}>
              Cancel
            </PrimaryButton>
            <PrimaryButton type="submit" disabled={!ready} busy={busy}>
              Change PIN
            </PrimaryButton>
          </div>
        </form>
      ) : (
        <PrimaryButton tone="subtle" onClick={() => setOpen(true)}>
          Change PIN
        </PrimaryButton>
      )}
    </Row>
  );
}

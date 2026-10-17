"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Check, Delete, Loader2, Lock, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { BrandLockup } from "@/components/brand-mark";
import { useNavigate } from "@/hooks/use-navigate";
import { transitionEnter } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AVATAR_COLORS } from "@/lib/avatar-colors";
import { defaultAvatar } from "@/lib/avatars";
import { AvatarPicker, ProfileAvatar } from "@/components/profile-avatar";

export const LAST_PROFILE_KEY = "absolute-cinema:last-profile";

const PIN_MIN = 4;
const PIN_MAX = 10;

function unsafePath(value: string): boolean {
  if (!value.startsWith("/")) return true;
  if (value.startsWith("//")) return true;
  if (value.includes("\\") || value.includes("://")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
  const lowered = pathOnly.toLowerCase();
  return lowered === "/login" || lowered.startsWith("/login/");
}

/**
 * Same-origin relative path only. Rejects protocol-relative, login loops, and schemes.
 *
 * The value arrives already decoded once (from the URL's search params), so it
 * is returned as it is: decoding it again turned "Fast%20%26%20Furious" into a
 * query whose "&" split it in two. The checks still run on a decoded copy too,
 * so an encoded "//" cannot slip past them.
 */
export function safeCallbackPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  const value = raw.trim();
  if (!value) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    return "/";
  }
  if (unsafePath(value) || unsafePath(decoded)) return "/";
  return value;
}

export function readLastProfile(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_PROFILE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeLastProfile(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    window.localStorage.setItem(LAST_PROFILE_KEY, trimmed);
  } catch {
    // private mode / quota
  }
}

interface ProfileSummary {
  name: string;
  avatarColor: string;
  avatar: string;
  /** Asks for a PIN before opening. */
  locked: boolean;
}

interface ProfilesResponse {
  firstRun: boolean;
  signupsOpen: boolean;
  pickerEnabled: boolean;
  /** Every new profile must be locked with a PIN on this server. */
  requirePin?: boolean;
  profiles: ProfileSummary[];
}

type InviteState = "valid" | "expired" | "used" | "revoked" | "unknown";
/** What the page learned of an invite link: its state, or that it could not ask just now. */
type InviteCheck = InviteState | "unreachable";

/** What a link that cannot be used says, in words. */
function inviteProblem(state: InviteCheck): string {
  switch (state) {
    case "unreachable":
      return "We couldn't check this invite link just now.";
    case "expired":
      return "This invite link has expired.";
    case "used":
      return "This invite link has already been used.";
    case "revoked":
      return "This invite link was switched off.";
    default:
      return "This invite link isn't valid.";
  }
}

async function rateLimitMessage(name: string): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/rate-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = (await res.json()) as { allowed?: boolean; message?: string };
    if (json.allowed === false) return json.message ?? "Too many attempts. Try again in a few minutes.";
  } catch {
    // fall through to the generic message
  }
  return null;
}

type Screen =
  | { kind: "pick" }
  | { kind: "pin"; profile: ProfileSummary }
  | { kind: "create" }
  | { kind: "manual" }
  | { kind: "invite"; problem: string; retry?: boolean };

export function LoginView({ callbackUrl, error, invite }: { callbackUrl?: string; error?: string; invite?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const nextPath = safeCallbackPath(callbackUrl);
  const [screen, setScreen] = useState<Screen>({ kind: "pick" });

  const { data, isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: async (): Promise<ProfilesResponse> => {
      const res = await fetch("/api/profiles", { cache: "no-store" });
      return res.json();
    },
  });

  useEffect(() => {
    if (error === "SessionExpired") toast.message("Your session expired. Pick your profile to continue.");
  }, [error]);

  // An invite link (/join/<code>): asked once whether it can still let someone in.
  // A failed request, a busy server or too many look-ups is not a dead link: the page says so and offers another try.
  const { data: inviteCheck, isFetching: checkingInvite, refetch: checkInviteAgain } = useQuery({
    queryKey: ["invite", invite],
    enabled: Boolean(invite),
    retry: false,
    queryFn: async (): Promise<{ state: InviteCheck }> => {
      try {
        const res = await fetch(`/api/invites/${encodeURIComponent(invite!)}`, { cache: "no-store" });
        if (res.status === 429 || res.status >= 500) return { state: "unreachable" };
        if (!res.ok) return { state: "unknown" };
        return (await res.json()) as { state: InviteState };
      } catch {
        return { state: "unreachable" };
      }
    },
  });

  // The first screen hangs on the server's answer (and an invite's): nothing shows until it is chosen, so a
  // visitor never glimpses the profile list of a server that hides it. It is chosen once: a refetch when the
  // window comes back to the front does not undo where the visitor went since.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!data || settled) return;
    if (data.firstRun) setScreen({ kind: "create" });
    else if (invite) {
      if (!inviteCheck || checkingInvite) return;
      setScreen(
        inviteCheck.state === "valid"
          ? { kind: "create" }
          : { kind: "invite", problem: inviteProblem(inviteCheck.state), retry: inviteCheck.state === "unreachable" }
      );
    } else if (!data.pickerEnabled) setScreen({ kind: "manual" });
    setSettled(true);
  }, [data, invite, inviteCheck, checkingInvite, settled]);

  const finish = useCallback(
    (name: string) => {
      writeLastProfile(name);
      qc.clear();
      // A full navigation so every server component re-renders for the new profile.
      window.location.assign(nextPath);
    },
    [nextPath, qc]
  );

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#050508] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 45% at 20% 15%, rgba(154,58,50,0.35), transparent 62%), radial-gradient(50% 42% at 85% 80%, rgba(74,69,96,0.38), transparent 60%)",
        }}
      />
      <header className="relative z-10 px-6 pt-6 sm:px-10">
        <BrandLockup />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-10">
        {isLoading || !data || !settled ? (
          <Loader2 className="h-8 w-8 animate-spin text-white/60" />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={screen.kind + (screen.kind === "pin" ? screen.profile.name : "")}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={transitionEnter}
              className="w-full"
            >
              {screen.kind === "pick" && (
                <PickScreen
                  data={data}
                  onLocked={(profile) => setScreen({ kind: "pin", profile })}
                  onDone={finish}
                  onAdd={() => setScreen({ kind: "create" })}
                  onManual={() => setScreen({ kind: "manual" })}
                />
              )}
              {screen.kind === "pin" && (
                <PinScreen profile={screen.profile} onBack={() => setScreen({ kind: "pick" })} onDone={finish} />
              )}
              {screen.kind === "create" && (
                <CreateScreen
                  firstRun={data.firstRun}
                  existing={data.profiles.length}
                  requirePin={Boolean(data.requirePin)}
                  invite={invite && inviteCheck?.state === "valid" ? invite : undefined}
                  onBack={data.firstRun || invite ? undefined : () => setScreen({ kind: data.pickerEnabled ? "pick" : "manual" })}
                  onSignIn={invite && !data.firstRun ? () => setScreen({ kind: data.pickerEnabled ? "pick" : "manual" }) : undefined}
                  onDone={finish}
                />
              )}
              {screen.kind === "invite" && (
                <div className="mx-auto w-full max-w-md text-center">
                  <h1 className="font-display text-2xl font-bold">{screen.problem}</h1>
                  <p className="mt-2 text-sm text-white/60">
                    {screen.retry
                      ? "Check your connection and try again in a moment."
                      : "Ask whoever sent it for a new one. Already have a profile? Sign in instead."}
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-3">
                    {screen.retry && (
                      <button
                        type="button"
                        onClick={() => {
                          setSettled(false);
                          void checkInviteAgain();
                        }}
                        className="inline-flex h-12 items-center justify-center rounded-full bg-white px-6 font-semibold text-black transition hover:bg-white/90"
                      >
                        Try again
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setScreen({ kind: data.pickerEnabled ? "pick" : "manual" })}
                      className={
                        screen.retry
                          ? "inline-flex h-12 items-center justify-center rounded-full bg-white/10 px-6 font-semibold text-white transition hover:bg-white/15"
                          : "inline-flex h-12 items-center justify-center rounded-full bg-white px-6 font-semibold text-black transition hover:bg-white/90"
                      }
                    >
                      Sign in
                    </button>
                  </div>
                </div>
              )}
              {screen.kind === "manual" && (
                <ManualScreen
                  canCreate={data.signupsOpen}
                  onCreate={() => setScreen({ kind: "create" })}
                  onBack={data.pickerEnabled ? () => setScreen({ kind: "pick" }) : undefined}
                  onDone={finish}
                />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>
      <footer className="relative z-10 pb-6 text-center text-xs text-white/40">
        <button type="button" className="hover:text-white/70" onClick={() => navigate("/dmca")}>
          DMCA
        </button>
      </footer>
    </div>
  );
}

function PickScreen({
  data,
  onLocked,
  onDone,
  onAdd,
  onManual,
}: {
  data: ProfilesResponse;
  onLocked: (profile: ProfileSummary) => void;
  onDone: (name: string) => void;
  onAdd: () => void;
  onManual: () => void;
}) {
  const last = readLastProfile();
  const [opening, setOpening] = useState<string | null>(null);

  // Unlocked profiles open with one tap, like Netflix; locked ones ask for their PIN.
  const open = async (profile: ProfileSummary) => {
    if (profile.locked) return onLocked(profile);
    if (opening) return;
    setOpening(profile.name);
    const res = await signIn("credentials", { name: profile.name, redirect: false });
    if (res?.error) {
      setOpening(null);
      toast.error((await rateLimitMessage(profile.name)) ?? `Couldn't open ${profile.name}. Try again.`);
      return;
    }
    onDone(profile.name);
  };

  // Where a remote starts: the profile last used on this device, else the first.
  const remoteStart = data.profiles.some((profile) => profile.name === last) ? last : data.profiles[0]?.name;

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center">
      <h1 className="font-display text-3xl font-bold tracking-tight sm:text-5xl">Who&apos;s watching?</h1>
      <ul className="mt-10 flex flex-wrap justify-center gap-x-3 gap-y-6 sm:gap-8">
        {data.profiles.map((profile) => (
          <li key={profile.name}>
            <button
              type="button"
              onClick={() => void open(profile)}
              disabled={opening !== null}
              data-tv-first-focus={profile.name === remoteStart ? true : undefined}
              className="group flex w-24 flex-col items-center gap-3 rounded-3xl p-1 focus-visible:outline-none disabled:cursor-wait sm:w-36"
            >
              <span className="relative rounded-[30%] ring-0 ring-white/80 ring-offset-4 ring-offset-[#050508] transition group-hover:scale-105 group-hover:ring-2 group-focus-visible:scale-105 group-focus-visible:ring-2">
                <ProfileAvatar name={profile.name} color={profile.avatarColor} avatar={profile.avatar} />
                {opening === profile.name && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-[28%] bg-black/45">
                    <Loader2 className="h-7 w-7 animate-spin" />
                  </span>
                )}
                {profile.locked && (
                  <span className="glass-clear absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full" aria-label="Locked with a PIN">
                    <Lock className="h-3.5 w-3.5" />
                  </span>
                )}
              </span>
              <span className="max-w-full truncate text-sm font-medium text-white/80 group-hover:text-white">{profile.name}</span>
            </button>
          </li>
        ))}
        {data.signupsOpen && (
          <li>
            <button
              type="button"
              onClick={onAdd}
              className="group flex w-24 flex-col items-center gap-3 rounded-3xl p-1 focus-visible:outline-none sm:w-36"
            >
              <span className="glass-clear flex h-20 w-20 items-center justify-center rounded-[28%] text-white/70 transition group-hover:scale-105 group-hover:text-white sm:h-32 sm:w-32">
                <Plus className="h-8 w-8 sm:h-10 sm:w-10" />
              </span>
              <span className="text-sm font-medium text-white/60 group-hover:text-white">Add profile</span>
            </button>
          </li>
        )}
      </ul>
      <button type="button" onClick={onManual} className="mt-10 text-sm text-white/50 hover:text-white">
        Sign in with a name instead
      </button>
    </div>
  );
}

function PinPad({ value, onChange, onSubmit, busy }: { value: string; onChange: (v: string) => void; onSubmit: () => void; busy: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (/^[0-9]$/.test(e.key) && value.length < PIN_MAX) onChange(value + e.key);
      else if (e.key === "Backspace" && value.length > 0) {
        // Marked as taken: on a Hisense remote Backspace is also Back, and with
        // digits entered it should clear one, not leave the page.
        e.preventDefault();
        onChange(value.slice(0, -1));
      } else if (e.key === "Enter" && value.length >= PIN_MIN) onSubmit();
    };
    // Capture, so the press is marked before the remote navigation hears it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [value, onChange, onSubmit, busy]);

  const key = (label: React.ReactNode, action: () => void, aria: string) => (
    <button
      type="button"
      aria-label={aria}
      disabled={busy}
      onClick={action}
      className="glass-icon h-16 w-16 text-xl font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40 sm:h-[4.5rem] sm:w-[4.5rem]"
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-6">
      <div aria-live="polite" aria-label={`${value.length} digits entered`} className="flex h-4 items-center gap-3">
        {Array.from({ length: Math.max(PIN_MIN, value.length) }).map((_, i) => (
          <span key={i} className={cn("h-3.5 w-3.5 rounded-full transition", i < value.length ? "bg-white" : "bg-white/20")} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => key(d, () => value.length < PIN_MAX && onChange(value + d), d))}
        {key(<Delete className="h-5 w-5" />, () => onChange(value.slice(0, -1)), "Delete")}
        {key("0", () => value.length < PIN_MAX && onChange(value + "0"), "0")}
        {key(busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-6 w-6" />, () => value.length >= PIN_MIN && onSubmit(), "Sign in")}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white">
      <ArrowLeft className="h-4 w-4" /> Back
    </button>
  );
}

function PinScreen({ profile, onBack, onDone }: { profile: ProfileSummary; onBack: () => void; onDone: (name: string) => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy || pin.length < PIN_MIN) return;
    setBusy(true);
    setMessage(null);
    const locked = await rateLimitMessage(profile.name);
    if (locked) {
      setBusy(false);
      setMessage(locked);
      return;
    }
    const res = await signIn("credentials", { name: profile.name, pin, redirect: false });
    if (res?.error) {
      setBusy(false);
      setPin("");
      setShake((n) => n + 1);
      setMessage((await rateLimitMessage(profile.name)) ?? "That PIN isn't right. Try again.");
      return;
    }
    onDone(profile.name);
  }, [busy, pin, profile.name, onDone]);

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center text-center">
      <div className="mb-6 self-start">
        <BackButton onClick={onBack} />
      </div>
      <ProfileAvatar name={profile.name} color={profile.avatarColor} avatar={profile.avatar} size="md" />
      <h1 className="mt-4 font-display text-2xl font-bold">{profile.name}</h1>
      <p className="mt-1 text-sm text-white/60">Enter your PIN</p>
      <motion.div key={shake} animate={shake ? { x: [0, -10, 10, -6, 6, 0] } : undefined} transition={{ duration: 0.35 }} className="mt-8">
        <PinPad value={pin} onChange={setPin} onSubmit={() => void submit()} busy={busy} />
      </motion.div>
      <p role="alert" className="mt-5 min-h-5 text-sm text-red-300">
        {message}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-left">
      <span className="mb-1.5 block text-sm font-medium text-white/80">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "h-12 w-full rounded-2xl border border-white/15 bg-white/[0.06] px-4 text-base text-white placeholder:text-white/35 focus:border-white/50 focus:outline-none";

function CreateScreen({
  firstRun,
  existing,
  requirePin = false,
  invite,
  onBack,
  onSignIn,
  onDone,
}: {
  firstRun: boolean;
  existing: number;
  /** The server wants every new profile locked with a PIN: the switch stays on. */
  requirePin?: boolean;
  /** The invite link this sign-up came through (sign-ups may be closed to everyone else). */
  invite?: string;
  onBack?: () => void;
  /** Someone who followed an invite but already has a profile goes to sign in instead. */
  onSignIn?: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string>(defaultAvatar(existing));
  const [color, setColor] = useState<string>(AVATAR_COLORS[existing % AVATAR_COLORS.length]!);
  // On by default for the first profile: it is the admin, and every profile shows on the sign-in screen.
  const [lock, setLock] = useState(firstRun || requirePin);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock && pin !== confirm) return setMessage("The PINs don't match.");
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), avatar, avatarColor: color, ...(lock ? { pin } : {}), ...(invite ? { invite } : {}) }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setBusy(false);
      return setMessage(json.error ?? "Couldn't create the profile.");
    }
    const signedIn = await signIn("credentials", { name: name.trim(), ...(lock ? { pin } : {}), redirect: false });
    if (signedIn?.error) {
      setBusy(false);
      return setMessage("Profile created. Pick it to continue.");
    }
    onDone(name.trim());
  };

  const valid = name.trim().length >= 2 && (!lock || (/^\d{4,10}$/.test(pin) && confirm.length >= PIN_MIN));

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-md">
      {onBack && (
        <div className="mb-6">
          <BackButton onClick={onBack} />
        </div>
      )}
      <div className="flex flex-col items-center text-center">
        <ProfileAvatar name={name || "?"} color={color} avatar={avatar} size="md" />
        <h1 className="mt-4 font-display text-2xl font-bold">{firstRun ? "Create your profile" : invite ? "You're invited" : "Add a profile"}</h1>
        <p className="mt-1 text-sm text-white/60">
          {firstRun ? "This first profile manages the server." : invite ? "Pick a name, a picture and a PIN to make your profile." : "Pick a name and a picture."}
        </p>
      </div>
      <div className="glass-clear mt-8 space-y-5 rounded-3xl p-5">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoFocus placeholder="e.g. Alex" autoComplete="nickname" />
        </Field>
        <div>
          <span className="mb-2 block text-sm font-medium text-white/80">Picture</span>
          <AvatarPicker
            name={name}
            avatar={avatar}
            color={color}
            onChange={(next) => {
              if (next.avatar) setAvatar(next.avatar);
              if (next.color) setColor(next.color);
            }}
          />
        </div>
        {requirePin ? (
          <p className="text-xs text-white/55">You&apos;ll use this PIN to sign in. Profiles on this server always have one.</p>
        ) : (
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-white">Lock with a PIN</span>
            <span className="block text-xs text-white/55">
              {firstRun ? "Recommended: this profile manages the server. " : ""}Off: anyone here can open this profile with one tap.
            </span>
          </span>
          <input type="checkbox" className="peer sr-only" checked={lock} onChange={(e) => setLock(e.target.checked)} />
          <span className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-white/15 transition-colors peer-checked:bg-[var(--primary)] peer-focus-visible:ring-2 peer-focus-visible:ring-white/60 after:ml-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
        </label>
        )}
        {lock && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="PIN">
              <input
                className={inputClass}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
                placeholder="4-10 digits"
              />
            </Field>
            <Field label="Confirm PIN">
              <input
                className={inputClass}
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
                placeholder="Again"
              />
            </Field>
          </div>
        )}
        {message && (
          <p role="alert" className="text-sm text-red-300">
            {message}
          </p>
        )}
        <button
          type="submit"
          disabled={!valid || busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white font-semibold text-black transition hover:bg-white/90 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {firstRun ? "Create and continue" : "Create profile"}
        </button>
        {onSignIn && (
          <p className="text-center text-sm text-white/55">
            Already have a profile?{" "}
            <button type="button" onClick={onSignIn} className="font-medium text-white underline-offset-4 hover:underline">
              Sign in
            </button>
          </p>
        )}
      </div>
    </form>
  );
}

function ManualScreen({
  canCreate,
  onCreate,
  onBack,
  onDone,
}: {
  canCreate: boolean;
  onCreate: () => void;
  onBack?: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(readLastProfile());
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const locked = await rateLimitMessage(name);
    if (locked) {
      setBusy(false);
      return setMessage(locked);
    }
    const res = await signIn("credentials", { name: name.trim(), ...(pin ? { pin } : {}), redirect: false });
    if (res?.error) {
      setBusy(false);
      return setMessage((await rateLimitMessage(name)) ?? "No profile with that name, or its PIN isn't right.");
    }
    onDone(name.trim());
  };

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-sm">
      {onBack && (
        <div className="mb-6">
          <BackButton onClick={onBack} />
        </div>
      )}
      <div className="flex flex-col items-center text-center">
        <span className="glass-clear flex h-16 w-16 items-center justify-center rounded-[28%]">
          <UserRound className="h-7 w-7" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold">Sign in</h1>
      </div>
      <div className="glass-clear mt-8 space-y-4 rounded-3xl p-5">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="username" />
        </Field>
        <Field label="PIN (only if the profile is locked)">
          <input
            className={inputClass}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
          />
        </Field>
        {message && (
          <p role="alert" className="text-sm text-red-300">
            {message}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !name.trim() || (pin.length > 0 && pin.length < PIN_MIN)}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white font-semibold text-black transition hover:bg-white/90 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign in
        </button>
        {canCreate && (
          <button type="button" onClick={onCreate} className="w-full text-sm text-white/60 hover:text-white">
            Create a new profile
          </button>
        )}
      </div>
    </form>
  );
}

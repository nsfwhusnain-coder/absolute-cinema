/**
 * Invite links: while sign-ups are closed, whoever holds one may still create
 * a profile, so a server shared on a public address (docs/SHARING.md) lets in
 * the people its admin sent a link to and nobody else. An invite can be good
 * for a number of uses, until a date, or both; the admin can revoke it.
 *
 * Kept as one JSON setting: a server has a handful, and a profile is created
 * rarely enough that reading and writing the list whole costs nothing.
 */

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

export const INVITES_SETTING = "invites";

export interface Invite {
  code: string;
  /** Who it is for, as the admin wrote it. */
  note: string;
  createdAt: number;
  /** Epoch ms, or null for never. */
  expiresAt: number | null;
  /** Profiles it may create, or null for any number. */
  maxUses: number | null;
  uses: number;
  revoked: boolean;
}

export type InviteState = "valid" | "expired" | "used" | "revoked" | "unknown";

/** Letters and digits that cannot be mistaken for each other (no 0/o, 1/l/i). */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 12;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
/** Invites kept at most; past it the oldest that can no longer be used go first. */
const MAX_INVITES = 200;
const DAY_MS = 86_400_000;

/** A new code: twelve characters (about 59 bits), shown in groups of four. */
export function newInviteCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i]! % ALPHABET.length];
  return code;
}

/** "abcd-efgh-jkmn" for a link or a message; the dashes are for people, not the server. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** A code as someone typed or pasted it (any case, with or without dashes or spaces), or null when it cannot be one. */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.toLowerCase().replace(/[\s-]/g, "");
  return CODE_PATTERN.test(code) ? code : null;
}

export function inviteState(invite: Invite | undefined, now = Date.now()): InviteState {
  if (!invite) return "unknown";
  if (invite.revoked) return "revoked";
  if (invite.expiresAt !== null && now >= invite.expiresAt) return "expired";
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return "used";
  return "valid";
}

function parse(value: string | null | undefined): Invite[] {
  if (!value) return [];
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? (list.filter((i) => i && typeof i === "object" && typeof (i as Invite).code === "string") as Invite[]) : [];
  } catch {
    return [];
  }
}

type Tx = Pick<typeof db, "appSetting">;

async function read(tx: Tx = db): Promise<Invite[]> {
  const row = await tx.appSetting.findUnique({ where: { key: INVITES_SETTING } });
  return parse(row?.value);
}

async function write(list: Invite[], tx: Tx = db): Promise<void> {
  const value = JSON.stringify(list);
  await tx.appSetting.upsert({ where: { key: INVITES_SETTING }, update: { value }, create: { key: INVITES_SETTING, value } });
}

/** Every invite, newest first. */
export async function listInvites(): Promise<Invite[]> {
  return (await read()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Drops the oldest invites that can no longer be used, once there are more than MAX_INVITES. */
export function pruneInvites(list: Invite[], now = Date.now()): Invite[] {
  if (list.length <= MAX_INVITES) return list;
  const dead = list.filter((i) => inviteState(i, now) !== "valid").sort((a, b) => a.createdAt - b.createdAt);
  const drop = new Set(dead.slice(0, list.length - MAX_INVITES).map((i) => i.code));
  return list.filter((i) => !drop.has(i.code));
}

export async function createInvite(input: { note?: string; maxUses?: number | null; expiresInDays?: number | null }, now = Date.now()): Promise<Invite> {
  const maxUses = input.maxUses && Number.isFinite(input.maxUses) && input.maxUses > 0 ? Math.min(1000, Math.round(input.maxUses)) : null;
  const days = input.expiresInDays && Number.isFinite(input.expiresInDays) && input.expiresInDays > 0 ? Math.min(3650, input.expiresInDays) : null;
  const invite: Invite = {
    code: newInviteCode(),
    note: (input.note ?? "").trim().slice(0, 60),
    createdAt: now,
    expiresAt: days === null ? null : now + days * DAY_MS,
    maxUses,
    uses: 0,
    revoked: false,
  };
  await db.$transaction(async (tx) => {
    const list = await read(tx);
    await write(pruneInvites([...list, invite], now), tx);
  });
  return invite;
}

export async function revokeInvite(code: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const list = await read(tx);
    const invite = list.find((i) => i.code === code);
    if (!invite) return false;
    invite.revoked = true;
    await write(list, tx);
    return true;
  });
}

export async function checkInvite(code: string, now = Date.now()): Promise<InviteState> {
  return inviteState((await read()).find((i) => i.code === code), now);
}

/** Takes one use of an invite, if it can still be used. True when it was taken. */
export async function consumeInvite(code: string, now = Date.now()): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const list = await read(tx);
    const invite = list.find((i) => i.code === code);
    if (inviteState(invite, now) !== "valid") return false;
    invite!.uses++;
    await write(list, tx);
    return true;
  });
}

/** Gives a use back (the profile it was taken for could not be created). */
export async function refundInvite(code: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const list = await read(tx);
    const invite = list.find((i) => i.code === code);
    if (!invite || invite.uses === 0) return;
    invite.uses--;
    await write(list, tx);
  });
}

import { beforeEach, describe, expect, it, mock } from "bun:test";

// The invite list lives in one app setting: a map stands in for the database.
const store = new Map<string, string>();
const appSetting = {
  findUnique: async ({ where }: { where: { key: string } }) => {
    const value = store.get(where.key);
    return value === undefined ? null : { id: "row", key: where.key, value };
  },
  upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
    store.set(where.key, store.has(where.key) ? update.value : create.value);
    return { id: "row", key: where.key, value: store.get(where.key)! };
  },
};
// Bun shares module mocks between test files: db.ts's helpers stay real for the files that test them (db-retry.test.ts).
const real = { ...(await import("@/lib/db")) };
mock.module("@/lib/db", () => ({
  ...real,
  db: {
    appSetting,
    $transaction: async <T,>(fn: (tx: { appSetting: typeof appSetting }) => Promise<T>) => fn({ appSetting }),
  },
}));

const {
  checkInvite,
  consumeInvite,
  createInvite,
  formatInviteCode,
  inviteState,
  listInvites,
  newInviteCode,
  normalizeInviteCode,
  pruneInvites,
  refundInvite,
  revokeInvite,
} = await import("./invites");

const DAY = 86_400_000;

beforeEach(() => store.clear());

describe("invite codes", () => {
  it("are twelve unambiguous characters, shown in groups of four", () => {
    const code = newInviteCode();
    expect(code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    expect(formatInviteCode("abcdefghjkmn")).toBe("abcd-efgh-jkmn");
  });

  it("are read back however they were typed or pasted", () => {
    expect(normalizeInviteCode("ABCD-EFGH-JKMN")).toBe("abcdefghjkmn");
    expect(normalizeInviteCode(" abcd efgh jkmn ")).toBe("abcdefghjkmn");
  });

  it("refuse anything that cannot be a code", () => {
    expect(normalizeInviteCode("abcd-efgh")).toBeNull();
    expect(normalizeInviteCode("abcd-efgh-jkm0")).toBeNull();
    expect(normalizeInviteCode(42)).toBeNull();
    expect(normalizeInviteCode("../../etc/passwd")).toBeNull();
  });
});

describe("invite states", () => {
  const base = { code: "abcdefghjkmn", note: "", createdAt: 0, expiresAt: null, maxUses: null, uses: 0, revoked: false };

  it("tells valid, expired, used up and switched off apart", () => {
    expect(inviteState(base, 1)).toBe("valid");
    expect(inviteState({ ...base, expiresAt: 10 }, 10)).toBe("expired");
    expect(inviteState({ ...base, maxUses: 2, uses: 2 }, 1)).toBe("used");
    expect(inviteState({ ...base, revoked: true }, 1)).toBe("revoked");
    expect(inviteState(undefined)).toBe("unknown");
  });

  it("keeps the newest dead invites and every live one when the list is pruned", () => {
    const many = Array.from({ length: 205 }, (_, i) => ({ ...base, code: `c${i}`, createdAt: i, revoked: i < 10 }));
    const kept = pruneInvites(many, 1000);
    expect(kept).toHaveLength(200);
    expect(kept.some((i) => i.code === "c0")).toBe(false);
    expect(kept.some((i) => i.code === "c9")).toBe(true);
    expect(kept.filter((i) => !i.revoked)).toHaveLength(195);
  });
});

describe("invite store", () => {
  it("lets as many people in as it was made for, then no more", async () => {
    const invite = await createInvite({ note: "Sam", maxUses: 2, expiresInDays: 7 }, 1_000);
    expect(invite.expiresAt).toBe(1_000 + 7 * DAY);
    expect(await checkInvite(invite.code, 2_000)).toBe("valid");
    expect(await consumeInvite(invite.code, 2_000)).toBe(true);
    expect(await consumeInvite(invite.code, 2_000)).toBe(true);
    expect(await consumeInvite(invite.code, 2_000)).toBe(false);
    expect(await checkInvite(invite.code, 2_000)).toBe("used");
  });

  it("gives a use back when the profile could not be made", async () => {
    const invite = await createInvite({ maxUses: 1 });
    expect(await consumeInvite(invite.code)).toBe(true);
    await refundInvite(invite.code);
    expect(await checkInvite(invite.code)).toBe("valid");
  });

  it("stops working when it expires or is switched off", async () => {
    const lasting = await createInvite({ expiresInDays: 1 }, 0);
    expect(await checkInvite(lasting.code, DAY + 1)).toBe("expired");
    expect(await consumeInvite(lasting.code, DAY + 1)).toBe(false);
    const open = await createInvite({});
    expect(open.maxUses).toBeNull();
    expect(open.expiresAt).toBeNull();
    expect(await revokeInvite(open.code)).toBe(true);
    expect(await checkInvite(open.code)).toBe("revoked");
    expect(await revokeInvite("nosuchcodexx")).toBe(false);
  });

  it("lists the newest first, and knows nothing of codes it never made", async () => {
    const first = await createInvite({ note: "first" }, 1);
    const second = await createInvite({ note: "second" }, 2);
    expect((await listInvites()).map((i) => i.code)).toEqual([second.code, first.code]);
    expect(await checkInvite("zzzzzzzzzzzz")).toBe("unknown");
  });

  it("survives a damaged setting", async () => {
    store.set("invites", "not json");
    expect(await listInvites()).toEqual([]);
    const invite = await createInvite({});
    expect(await checkInvite(invite.code)).toBe("valid");
  });
});

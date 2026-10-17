import { beforeEach, describe, expect, it, mock } from "bun:test";

// The feedback list lives in one app setting: a map stands in for the database.
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

const { FEEDBACK_SETTING, FeedbackRejected, addFeedback, deleteFeedback, isFeedbackCategory, listFeedback, sanitizeFeedbackContext } = await import("./feedback");

const sender = { userId: "u1", name: "Sam" };

beforeEach(() => store.clear());

describe("feedback categories", () => {
  it("are the four a tester can pick, and nothing else", () => {
    for (const category of ["playback", "broken", "idea", "other"]) expect(isFeedbackCategory(category)).toBe(true);
    for (const category of ["Idea", "", "praise", undefined, 1]) expect(isFeedbackCategory(category)).toBe(false);
  });

  it("refuses to keep feedback in a category it does not know", async () => {
    await expect(addFeedback({ ...sender, category: "praise", message: "Lovely" })).rejects.toBeInstanceOf(FeedbackRejected);
    expect(await listFeedback()).toEqual([]);
  });
});

describe("feedback store", () => {
  it("keeps what was sent, newest first, with who sent it and when", async () => {
    const first = await addFeedback({ ...sender, category: "idea", message: "first" }, 1_000);
    const second = await addFeedback({ userId: "u2", name: "Ada", category: "broken", message: "second" }, 2_000);
    const list = await listFeedback();
    expect(list.map((item) => item.message)).toEqual(["second", "first"]);
    expect(list[0]).toEqual({ id: second.id, at: 2_000, userId: "u2", name: "Ada", category: "broken", message: "second" });
    expect(first.id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.id).not.toBe(second.id);
  });

  it("keeps the message trimmed", async () => {
    const item = await addFeedback({ ...sender, category: "playback", message: "  Stutters at 12:00\n " });
    expect(item.message).toBe("Stutters at 12:00");
    expect((await listFeedback())[0]!.message).toBe("Stutters at 12:00");
  });

  it("refuses a message that is empty, only spaces, or longer than 1000 characters", async () => {
    await expect(addFeedback({ ...sender, category: "idea", message: "" })).rejects.toBeInstanceOf(FeedbackRejected);
    await expect(addFeedback({ ...sender, category: "idea", message: " \n\t " })).rejects.toBeInstanceOf(FeedbackRejected);
    await expect(addFeedback({ ...sender, category: "idea", message: undefined })).rejects.toBeInstanceOf(FeedbackRejected);
    await expect(addFeedback({ ...sender, category: "idea", message: "x".repeat(1001) })).rejects.toThrow("1000 characters");
    expect(await listFeedback()).toEqual([]);
  });

  it("accepts a message of exactly 1000 characters", async () => {
    const item = await addFeedback({ ...sender, category: "idea", message: "x".repeat(1000) });
    expect(item.message).toHaveLength(1000);
  });

  it("keeps 500 items, and drops the oldest when one more comes", async () => {
    // A full list already in the setting, newest first, as addFeedback leaves it.
    const full = Array.from({ length: 500 }, (_, i) => ({ id: `old${500 - i}`, at: 500 - i, userId: "u1", name: "Sam", category: "idea", message: `m${500 - i}` }));
    store.set(FEEDBACK_SETTING, JSON.stringify(full));
    await addFeedback({ ...sender, category: "idea", message: "newest" }, 1_000);
    const list = await listFeedback();
    expect(list).toHaveLength(500);
    expect(list[0]!.message).toBe("newest");
    expect(list[1]!.id).toBe("old500");
    expect(list.some((item) => item.id === "old1")).toBe(false);
  });

  it("deletes one item, and says when there is nothing to delete", async () => {
    const keep = await addFeedback({ ...sender, category: "idea", message: "keep" }, 1);
    const gone = await addFeedback({ ...sender, category: "idea", message: "gone" }, 2);
    expect(await deleteFeedback(gone.id)).toBe(true);
    expect((await listFeedback()).map((item) => item.id)).toEqual([keep.id]);
    expect(await deleteFeedback(gone.id)).toBe(false);
    expect(await deleteFeedback("nosuchid0000")).toBe(false);
  });

  it("survives a damaged setting", async () => {
    store.set(FEEDBACK_SETTING, "not json");
    expect(await listFeedback()).toEqual([]);
    store.set(FEEDBACK_SETTING, '{"id":"not a list"}');
    expect(await listFeedback()).toEqual([]);
    await addFeedback({ ...sender, category: "idea", message: "after" });
    expect((await listFeedback()).map((item) => item.message)).toEqual(["after"]);
  });

  it("skips the junk in a damaged list and keeps the items that are whole", async () => {
    const whole = { id: "whole0000000", at: 1, userId: "u1", name: "Sam", category: "idea", message: "kept" };
    store.set(FEEDBACK_SETTING, JSON.stringify([null, 5, { id: "half" }, { ...whole, category: "praise" }, whole]));
    expect((await listFeedback()).map((item) => item.id)).toEqual(["whole0000000"]);
  });
});

describe("feedback context", () => {
  it("keeps only the fields it knows", () => {
    const context = sanitizeFeedbackContext({ path: "/watch/movie/550", password: "hunter2", cookie: "session=abc", isAdmin: true });
    expect(context).toEqual({ path: "/watch/movie/550" });
    expect(context).not.toHaveProperty("password");
  });

  it("trims text and cuts it to the length each field allows", () => {
    const context = sanitizeFeedbackContext({
      path: " /watch ",
      title: "t".repeat(300),
      quality: "1080p",
      userAgent: "u".repeat(500),
      provider: "p".repeat(41),
    });
    expect(context).toEqual({ path: "/watch", title: "t".repeat(120), quality: "1080p", userAgent: "u".repeat(200), provider: "p".repeat(40) });
  });

  it("drops text that is blank once trimmed, or not text at all", () => {
    expect(sanitizeFeedbackContext({ path: "   ", title: 42, device: null })).toBeUndefined();
  });

  it("drops numbers that are not finite, are negative, or (for counts and ids) are not whole", () => {
    expect(sanitizeFeedbackContext({ positionS: NaN, season: 1.5, tmdbId: "550", episode: -2, stalls: Infinity })).toBeUndefined();
    expect(sanitizeFeedbackContext({ positionS: -1, tmdbId: 550.5 })).toBeUndefined();
    // Zero is a real position, and a position need not be a whole second.
    expect(sanitizeFeedbackContext({ positionS: 0, tmdbId: 550, stalls: 3 })).toEqual({ positionS: 0, tmdbId: 550, stalls: 3 });
    expect(sanitizeFeedbackContext({ positionS: 754.25 })).toEqual({ positionS: 754.25 });
  });

  it("accepts only movie or tv as a media type", () => {
    expect(sanitizeFeedbackContext({ mediaType: "anime" })).toBeUndefined();
    expect(sanitizeFeedbackContext({ mediaType: "tv", season: 2, episode: 4 })).toEqual({ mediaType: "tv", season: 2, episode: 4 });
  });

  it("is nothing for anything that is not an object", () => {
    expect(sanitizeFeedbackContext(undefined)).toBeUndefined();
    expect(sanitizeFeedbackContext(null)).toBeUndefined();
    expect(sanitizeFeedbackContext("/watch")).toBeUndefined();
    expect(sanitizeFeedbackContext([{ path: "/watch" }])).toBeUndefined();
  });

  it("is stored with the feedback, sanitised, and not stored when there is none", async () => {
    const withContext = await addFeedback({ ...sender, category: "playback", message: "Stalls", context: { path: "/watch", engine: "hlsjs", junk: 1 } });
    const without = await addFeedback({ ...sender, category: "idea", message: "Dark mode" });
    expect(withContext.context).toEqual({ path: "/watch", engine: "hlsjs" });
    expect(without).not.toHaveProperty("context");
    const stored = await listFeedback();
    expect(stored[1]!.context).toEqual({ path: "/watch", engine: "hlsjs" });
    expect(stored[0]).not.toHaveProperty("context");
  });
});

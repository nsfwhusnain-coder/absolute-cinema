import { afterEach, describe, expect, it, mock } from "bun:test";

// The switches live in app settings: a map stands in for the database. Bun shares module mocks between test
// files, so db.ts's helpers stay real (db-retry.test.ts).
const store = new Map<string, string>();
const real = { ...(await import("@/lib/db")) };
mock.module("@/lib/db", () => ({
  ...real,
  db: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = store.get(where.key);
        return value === undefined ? null : { id: "row", key: where.key, value };
      },
    },
  },
}));

const { profilePickerEnabled, requirePin, signupsOpen } = await import("./profiles");

const NAMES = ["PUBLIC_INSTANCE", "SIGNUPS_OPEN_DEFAULT", "PROFILE_PICKER_DEFAULT", "REQUIRE_PIN_DEFAULT"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  store.clear();
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function switches() {
  return { signups: await signupsOpen(), picker: await profilePickerEnabled(), pin: await requirePin() };
}

describe("the profile switches before the admin chooses", () => {
  it("are a household's on a household server", async () => {
    for (const name of NAMES) delete process.env[name];
    expect(await switches()).toEqual({ signups: true, picker: true, pin: false });
  });

  it("start locked on a public instance", async () => {
    for (const name of NAMES) delete process.env[name];
    process.env.PUBLIC_INSTANCE = "1";
    expect(await switches()).toEqual({ signups: false, picker: false, pin: true });
  });

  it("follow an explicit default over the instance's, and the admin's choice over both", async () => {
    process.env.PUBLIC_INSTANCE = "1";
    process.env.PROFILE_PICKER_DEFAULT = "on";
    store.set("require_pin", "off");
    expect(await switches()).toEqual({ signups: false, picker: true, pin: false });
  });
});

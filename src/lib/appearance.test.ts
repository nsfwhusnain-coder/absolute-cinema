import { describe, expect, it } from "bun:test";
import { ACCENTS, appearanceBootstrapScript } from "./appearance";

function run(stored: Record<string, string>) {
  const attrs: Record<string, string> = {};
  const styles: Record<string, string> = {};
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => (attrs[k] = v),
      style: { setProperty: (k: string, v: string) => (styles[k] = v) },
    },
  };
  const localStorage = { getItem: (k: string) => stored[k] ?? null };
  new Function("document", "localStorage", appearanceBootstrapScript())(document, localStorage);
  return { attrs, styles };
}

describe("appearance bootstrap", () => {
  it("defaults to the clear material and leaves the accent alone", () => {
    const { attrs, styles } = run({});
    expect(attrs["data-material"]).toBe("clear");
    expect(styles["--primary"]).toBeUndefined();
  });
  it("applies a stored solid material and accent", () => {
    const violet = ACCENTS.find((a) => a.id === "violet")!;
    const { attrs, styles } = run({ "absolute-cinema:material": "solid", "absolute-cinema:accent": "violet" });
    expect(attrs["data-material"]).toBe("solid");
    expect(styles["--primary"]).toBe(violet.hex);
  });
  it("ignores unknown stored values", () => {
    const { attrs, styles } = run({ "absolute-cinema:material": "neon", "absolute-cinema:accent": "plaid" });
    expect(attrs["data-material"]).toBe("clear");
    expect(styles["--primary"]).toBeUndefined();
  });
});

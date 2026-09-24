import { describe, expect, it } from "bun:test";
import { languageName } from "./language-name";

describe("languageName", () => {
  it("names 2- and 3-letter codes", () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("jpn")).toBe("Japanese");
    expect(languageName("en")).toBe("English");
  });
  it("handles regions, undetermined and junk", () => {
    expect(languageName("pt-br")).toBe("Brazilian Portuguese");
    expect(languageName("und")).toBe("Unknown");
    expect(languageName(null)).toBe("Unknown");
  });
});

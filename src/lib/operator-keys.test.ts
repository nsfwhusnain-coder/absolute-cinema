/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  NOT_REQUIRED_OPERATOR_ENV,
  OPERATOR_DEBRID_ENV,
  OPERATOR_DEBRID_SETTING_KEY,
  OPERATOR_TMDB_ENV,
  OPTIONAL_OPERATOR_MEDIA_ENV,
  REQUIRED_OPERATOR_MEDIA_ENV,
} from "./operator-keys";

describe("operator media keys — two keys, nothing else required", () => {
  it("requires only TMDB for catalog", () => {
    expect(REQUIRED_OPERATOR_MEDIA_ENV).toEqual([OPERATOR_TMDB_ENV]);
    expect(REQUIRED_OPERATOR_MEDIA_ENV).toHaveLength(1);
  });

  it("treats Real-Debrid as the only optional premium key", () => {
    expect(OPTIONAL_OPERATOR_MEDIA_ENV).toEqual([OPERATOR_DEBRID_ENV]);
    expect(OPERATOR_DEBRID_SETTING_KEY).toBe("realdebrid_token");
  });

  it("does not require TorBox, CinePro, or the edge worker", () => {
    for (const extra of NOT_REQUIRED_OPERATOR_ENV) {
      expect(REQUIRED_OPERATOR_MEDIA_ENV).not.toContain(extra);
      expect(OPTIONAL_OPERATOR_MEDIA_ENV).not.toContain(extra);
    }
  });
});

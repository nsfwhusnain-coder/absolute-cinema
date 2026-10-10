/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AVATAR_GROUPS,
  CHARACTER_GROUPS,
  allBundledAvatars,
  avatarName,
  defaultAvatar,
  isAvatarValue,
  isCharacterAvatar,
  resolveAvatar,
} from "./avatars";

const AVATAR_DIR = join(import.meta.dir, "..", "..", "public", "avatars");

describe("bundled profile pictures", () => {
  it("has artwork on disk for every picture in the catalogue", () => {
    const missing = AVATAR_GROUPS.flatMap((group) => group.ids).filter((id) => !existsSync(join(AVATAR_DIR, `${id}.svg`)));
    expect(missing).toEqual([]);
  });

  it("lists each picture once", () => {
    const ids = AVATAR_GROUPS.flatMap((group) => group.ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws the house characters edge to edge and keeps retired sets resolving", () => {
    expect(resolveAvatar("animal-fox")).toEqual({ kind: "image", src: "/avatars/animal-fox.svg", fit: "contain", fullBleed: true });
    expect(resolveAvatar("avataaars-rocky").kind).toBe("image");
    expect(isAvatarValue("thumbs-gus")).toBe(true);
    expect(resolveAvatar("animal-dragon")).toEqual({ kind: "initials" });
  });
});

describe("the house characters", () => {
  it("names a picture from its id", () => {
    expect(avatarName("animal-fox")).toBe("Fox");
    expect(avatarName("cinema-popcorn")).toBe("Popcorn");
  });

  it("gives a household's first profiles a picture from a different set each", () => {
    const firstFive = [0, 1, 2, 3, 4].map(defaultAvatar);
    expect(firstFive.every(isCharacterAvatar)).toBe(true);
    expect(new Set(firstFive.map((id) => id.split("-")[0])).size).toBe(CHARACTER_GROUPS.length);
    expect(defaultAvatar(CHARACTER_GROUPS.length)).not.toBe(defaultAvatar(0));
  });

  it("surprises only with house characters", () => {
    expect(allBundledAvatars().every(isCharacterAvatar)).toBe(true);
  });
});

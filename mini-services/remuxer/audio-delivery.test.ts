import { describe, expect, it } from "bun:test";
import type { AudioCaps } from "../../src/lib/playback/decode-capability";
import { audioArgs, audioDelivery } from "./audio-delivery";

const STEREO: AudioCaps = { ec3: false, ac3: false, channels: 2 };
const DOLBY_STEREO: AudioCaps = { ec3: true, ac3: true, channels: 2 };
const SIX_CHANNEL_OUTPUT: AudioCaps = { ec3: false, ac3: false, channels: 6 };
const EC3_SURROUND: AudioCaps = { ec3: true, ac3: false, channels: 8 };

describe("audioDelivery", () => {
  it("copies E-AC-3 5.1 to a viewer whose browser decodes E-AC-3", () => {
    expect(audioDelivery({ codecId: "A_EAC3", channels: 6 }, { ec3: true, ac3: false, channels: 6 })).toBe("copy");
  });

  it("copies AC-3 to a viewer whose browser decodes AC-3", () => {
    expect(audioDelivery({ codecId: "A_AC3", channels: 6 }, { ec3: false, ac3: true, channels: 2 })).toBe("copy");
  });

  it("re-encodes E-AC-3 to 5.1 AAC for a six-channel output that cannot decode E-AC-3", () => {
    expect(audioDelivery({ codecId: "A_EAC3", channels: 6 }, SIX_CHANNEL_OUTPUT)).toBe("aac51");
  });

  it("re-encodes TrueHD 7.1 to E-AC-3 for a viewer whose browser decodes E-AC-3", () => {
    expect(audioDelivery({ codecId: "A_TRUEHD", channels: 8 }, EC3_SURROUND)).toBe("eac3");
  });

  it("keeps DTS 5.1 stereo for a stereo output with no Dolby decoder", () => {
    expect(audioDelivery({ codecId: "A_DTS", channels: 6 }, STEREO)).toBe("aac20");
  });

  it("keeps stereo AAC stereo, whatever the output", () => {
    expect(audioDelivery({ codecId: "A_AAC", channels: 2 }, SIX_CHANNEL_OUTPUT)).toBe("aac20");
    expect(audioDelivery({ codecId: "A_AAC", channels: 2 }, DOLBY_STEREO)).toBe("aac20");
  });

  it("keeps a surround track stereo when the viewer sent no capabilities", () => {
    expect(audioDelivery({ codecId: "A_DTS", channels: 6 }, STEREO)).toBe("aac20");
    expect(audioDelivery({ codecId: "A_TRUEHD", channels: 8 }, STEREO)).toBe("aac20");
  });

  it("treats a track whose channel count is unknown as stereo", () => {
    expect(audioDelivery({ codecId: "A_DTS", channels: null }, EC3_SURROUND)).toBe("aac20");
  });

  it("gives no track stereo AAC", () => {
    expect(audioDelivery(null, DOLBY_STEREO)).toBe("aac20");
  });
});

describe("audioArgs", () => {
  it("copies the track untouched", () => {
    expect(audioArgs("copy")).toEqual(["-c:a", "copy"]);
  });

  it("encodes E-AC-3 at 640k over 5.1", () => {
    expect(audioArgs("eac3")).toEqual(["-c:a", "eac3", "-b:a", "640k", "-ac", "6"]);
  });

  it("encodes AAC at 384k over 5.1", () => {
    expect(audioArgs("aac51")).toEqual(["-c:a", "aac", "-b:a", "384k", "-ac", "6"]);
  });

  it("encodes AAC at 192k in stereo, exactly as every session did before", () => {
    expect(audioArgs("aac20")).toEqual(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
  });

  it("returns a fresh array so a caller cannot change the table", () => {
    const args = audioArgs("aac20");
    args.push("-ac", "8");
    expect(audioArgs("aac20")).toEqual(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
  });
});

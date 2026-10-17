import { describe, expect, it } from "bun:test";
import type { AudioCaps } from "../../src/lib/playback/decode-capability";
import { audioDelivery } from "./audio-delivery";
import { sessionId, videoBitstreamArgs, type VodAudioRequest, type VodViewer } from "./vod";

const URL = "https://cdn.example/d/ABC/Movie.2024.2160p.REMUX.mkv";
const AUDIO: VodAudioRequest = { preference: "original", originalLanguage: "en", preferredLanguage: "en" };
const STEREO: AudioCaps = { ec3: false, ac3: false, channels: 2 };
const DOLBY_STEREO: AudioCaps = { ec3: true, ac3: false, channels: 2 };
const SIX_CHANNEL_OUTPUT: AudioCaps = { ec3: false, ac3: false, channels: 6 };

function viewer(audio: AudioCaps): VodViewer {
  return { decodesDolbyVision: false, audio };
}

describe("sessionId", () => {
  it("is shared by viewers whose audio capabilities are the same", () => {
    expect(sessionId(URL, AUDIO, viewer(STEREO), "src")).toBe(sessionId(URL, AUDIO, viewer({ ...STEREO }), "src"));
  });

  it("differs for viewers who would be sent different audio from the same E-AC-3 track", () => {
    const track = { codecId: "A_EAC3", channels: 6 };
    expect(audioDelivery(track, DOLBY_STEREO)).not.toBe(audioDelivery(track, STEREO));
    expect(sessionId(URL, AUDIO, viewer(DOLBY_STEREO), "src")).not.toBe(sessionId(URL, AUDIO, viewer(STEREO), "src"));
  });

  it("differs for a viewer whose output takes six channels", () => {
    expect(sessionId(URL, AUDIO, viewer(SIX_CHANNEL_OUTPUT), "src")).not.toBe(sessionId(URL, AUDIO, viewer(STEREO), "src"));
  });

  it("is still a 24-character hex key", () => {
    expect(sessionId(URL, AUDIO, viewer(STEREO), "src")).toMatch(/^[a-f0-9]{24}$/);
  });
});

describe("videoBitstreamArgs", () => {
  it("rebuilds HEVC and H.264 parameter sets from the stream, and leaves other video alone", () => {
    expect(videoBitstreamArgs("V_MPEGH/ISO/HEVC")).toEqual(["-bsf:v", "hevc_mp4toannexb,extract_extradata"]);
    expect(videoBitstreamArgs("V_MPEG4/ISO/AVC")).toEqual(["-bsf:v", "h264_mp4toannexb,extract_extradata"]);
    expect(videoBitstreamArgs("V_AV1")).toEqual([]);
    expect(videoBitstreamArgs(null)).toEqual([]);
  });
});

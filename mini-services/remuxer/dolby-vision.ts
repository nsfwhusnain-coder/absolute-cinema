/**
 * Dolby Vision in remuxed files.
 *
 * A Dolby Vision file says what it is in a small configuration record (the
 * payload of an MP4 dvcC/dvvC box, carried in Matroska as a block addition
 * mapping). Most releases keep an ordinary HDR10 picture underneath, which
 * every HEVC decoder shows correctly. Profile 5 does not: its picture is
 * stored in Dolby's own colour encoding, and a decoder that treats it as
 * plain HEVC shows it green and purple.
 */

import type { DynamicRange } from "./mkv-cues";

/** A configuration record is at least this long (the fields read here). */
const RECORD_MIN_BYTES = 5;

/**
 * What the stream looks like to a player that ignores the Dolby Vision
 * layer: ordinary HDR10, HLG or SDR, or nothing watchable ("none").
 */
export type DolbyVisionBaseLayer = "hdr10" | "hlg" | "sdr" | "none";

export interface DolbyVisionInfo {
  profile: number;
  level: number;
  baseLayer: DolbyVisionBaseLayer;
}

/** dv_bl_signal_compatibility_id → what the base layer is on its own. */
const BASE_LAYERS: Partial<Record<number, DolbyVisionBaseLayer>> = {
  1: "hdr10",
  2: "sdr",
  4: "hlg",
  6: "hdr10",
};

/** Reads a DOVIDecoderConfigurationRecord. */
export function parseDolbyVisionRecord(record: Uint8Array): DolbyVisionInfo | null {
  if (record.length < RECORD_MIN_BYTES) return null;
  const packed = record[2]! * 256 + record[3]!;
  const profile = (packed >> 9) & 0x7f;
  const level = (packed >> 3) & 0x3f;
  const compatibility = (record[4]! >> 4) & 0x0f;
  return { profile, level, baseLayer: BASE_LAYERS[compatibility] ?? "none" };
}

/** How a Dolby Vision file reaches a viewer: as Dolby Vision, as its ordinary base layer, or not at all. */
export type DolbyVisionDelivery = "dolby-vision" | "base-layer" | "unplayable";

export function dolbyVisionDelivery(info: DolbyVisionInfo | null, viewerDecodesDolbyVision: boolean): DolbyVisionDelivery | null {
  if (!info) return null;
  if (info.baseLayer !== "none") return "base-layer";
  return viewerDecodesDolbyVision ? "dolby-vision" : "unplayable";
}

/** SDR, PQ (HDR10), HLG, or DV when the stream is sent as Dolby Vision. */
export type DeliveredRange = DynamicRange | "DV";

/** The range a viewer receives: Dolby Vision itself, the base layer's, or what the container states. */
export function deliveredRange(container: DynamicRange, dolbyVision: DolbyVisionInfo | null, asDolbyVision: boolean): DeliveredRange {
  if (asDolbyVision) return "DV";
  if (dolbyVision?.baseLayer === "hdr10") return "PQ";
  if (dolbyVision?.baseLayer === "hlg") return "HLG";
  return container;
}

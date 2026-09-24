/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { parseVtt } from "./vtt";

describe("parseVtt", () => {
  it("reads timings, joins lines and strips markup", () => {
    const cues = parseVtt("WEBVTT\n\n1\n00:00:03.670 --> 00:00:05.463\n<i>Your age</i>\nis 27?\n\n00:01:05.547 --> 00:01:06.464 align:start\nI'm 20.\n");
    expect(cues).toEqual([
      { start: 3.67, end: 5.463, text: "Your age\nis 27?" },
      { start: 65.547, end: 66.464, text: "I'm 20." },
    ]);
  });

  it("accepts SRT-style commas and short timestamps", () => {
    expect(parseVtt("1\r\n01:02,500 --> 01:04,000\r\nHi\r\n")).toEqual([{ start: 62.5, end: 64, text: "Hi" }]);
  });

  it("skips headers and empty cues", () => {
    expect(parseVtt("WEBVTT\n\nNOTE hello\n\n00:00:01.000 --> 00:00:02.000\n\n")).toEqual([]);
  });
});

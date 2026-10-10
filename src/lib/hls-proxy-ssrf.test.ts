/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isPrivateHostname } from "./hls-proxy";

const host = (url: string) => new URL(url).hostname;

describe("isPrivateHostname", () => {
  it("blocks private IPv4 and the hostnames URL() produces for them", () => {
    for (const url of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/", "http://192.168.0.29/", "http://100.89.184.84/", "http://0x7f000001/", "http://2130706433/"]) {
      expect(isPrivateHostname(host(url))).toBe(true);
    }
  });

  it("blocks IPv4 hidden inside IPv6, as URL() writes it", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:7f00:1]/",
      "http://[::7f00:1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:7f00:1::]/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
    ]) {
      expect(isPrivateHostname(host(url))).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const url of ["http://8.8.8.8/", "http://[2606:4700:4700::1111]/", "http://[::ffff:8.8.8.8]/", "https://cdn.example.com/"]) {
      expect(isPrivateHostname(host(url))).toBe(false);
    }
  });
});

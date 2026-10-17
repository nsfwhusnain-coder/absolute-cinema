import { describe, expect, it } from "bun:test";
import { isRemoteAddress } from "./network-place";

describe("isRemoteAddress", () => {
  it("counts the home network as home", () => {
    for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.4.1", "172.31.255.255", "127.0.0.1", "169.254.10.1", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.5"]) {
      expect(isRemoteAddress(ip)).toBe(false);
    }
  });

  it("counts Tailscale's addresses as home", () => {
    expect(isRemoteAddress("100.101.102.103")).toBe(false);
    expect(isRemoteAddress("100.64.0.1")).toBe(false);
  });

  it("counts the internet as outside", () => {
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.9", "2001:db8::1", "::ffff:8.8.4.4"]) {
      expect(isRemoteAddress(ip)).toBe(true);
    }
  });

  it("never turns a missing address into a stranger", () => {
    expect(isRemoteAddress(null)).toBe(false);
    expect(isRemoteAddress("")).toBe(false);
    expect(isRemoteAddress("unknown")).toBe(false);
  });
});

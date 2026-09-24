import { describe, expect, it } from "bun:test";
import { checkRegistrationGate, REGISTRATION_CLOSED_MESSAGE } from "./registration-gate";

describe("checkRegistrationGate", () => {
  it("always lets the first profile in", () => {
    expect(checkRegistrationGate({ isAdminCreating: false, isFirstUser: true, signupsOpen: false })).toEqual({ allowed: true, reason: "first_user" });
  });
  it("lets anyone sign up while sign-ups are open", () => {
    expect(checkRegistrationGate({ isAdminCreating: false, isFirstUser: false, signupsOpen: true })).toEqual({ allowed: true, reason: "open" });
  });
  it("blocks self sign-up when closed, with a clear message", () => {
    expect(checkRegistrationGate({ isAdminCreating: false, isFirstUser: false, signupsOpen: false })).toEqual({ allowed: false, error: REGISTRATION_CLOSED_MESSAGE });
  });
  it("always lets an admin add profiles", () => {
    expect(checkRegistrationGate({ isAdminCreating: true, isFirstUser: false, signupsOpen: false }).allowed).toBe(true);
  });
});

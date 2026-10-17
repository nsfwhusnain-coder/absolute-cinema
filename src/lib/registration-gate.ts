/**
 * Who may create a profile.
 *
 *  - The first profile on a fresh install (it becomes the admin).
 *  - Anyone, while sign-ups are open (the default for a household server).
 *  - Whoever holds a valid invite link, when they are not (src/lib/invites.ts).
 *  - An admin, always (Settings → Profiles).
 */

export interface RegistrationGateInput {
  isAdminCreating: boolean;
  isFirstUser: boolean;
  signupsOpen: boolean;
  /** The request carries an invite that can still be used. */
  inviteValid?: boolean;
}

export interface RegistrationGateResult {
  allowed: boolean;
  reason?: "admin" | "first_user" | "open" | "invite";
  error?: string;
}

export const REGISTRATION_CLOSED_MESSAGE = "New profiles are turned off on this server. Ask the admin to add you.";

export function checkRegistrationGate(input: RegistrationGateInput): RegistrationGateResult {
  if (input.isAdminCreating) return { allowed: true, reason: "admin" };
  if (input.isFirstUser) return { allowed: true, reason: "first_user" };
  if (input.signupsOpen) return { allowed: true, reason: "open" };
  if (input.inviteValid) return { allowed: true, reason: "invite" };
  return { allowed: false, error: REGISTRATION_CLOSED_MESSAGE };
}

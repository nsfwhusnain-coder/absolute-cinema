/**
 * Pure decision logic for the registration invite-code gate.
 * Extracted out of `src/app/api/register/route.ts` so the actual access-
 * control decision is unit-testable without mocking Next's Request/DB/
 * NextAuth plumbing.
 *
 * Rules:
 *  - An already-authenticated admin may always create additional accounts
 *    (mirrors the admin user-management path — there is no separate
 *    admin-create-user endpoint today), regardless of the invite code.
 *  - Otherwise, `REGISTRATION_INVITE_CODE` must be set AND must match the
 *    request's `inviteCode` exactly, or the request is rejected.
 *  - If the env var is unset, registration is disabled entirely — no code
 *    (correct-looking or otherwise) can pass, since there's nothing to match.
 *  - Exception: a fresh install with zero accounts always lets the first
 *    person register (they become the admin), otherwise nobody could ever
 *    sign in to a new deployment.
 */

export interface RegistrationGateInput {
  /** True when the request is already authenticated as an admin. */
  isAdminCreating: boolean;
  /** True when the database has no accounts yet (first-run setup). */
  isFirstUser?: boolean;
  /** `process.env.REGISTRATION_INVITE_CODE` — undefined/empty means registration is closed. */
  requiredCode: string | undefined;
  /** `inviteCode` from the request body. */
  providedCode: string | undefined;
}

export interface RegistrationGateResult {
  allowed: boolean;
  /** Present only when `allowed` is true — why the request was let through. */
  reason?: "admin" | "first_user" | "invite_ok";
  /** Present only when `allowed` is false — the client-facing error message. */
  error?: string;
}

export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed";

export function checkRegistrationGate(input: RegistrationGateInput): RegistrationGateResult {
  if (input.isAdminCreating) {
    return { allowed: true, reason: "admin" };
  }
  if (input.isFirstUser) {
    return { allowed: true, reason: "first_user" };
  }

  const requiredCode = input.requiredCode;
  if (!requiredCode) {
    return { allowed: false, error: REGISTRATION_CLOSED_MESSAGE };
  }

  if (typeof input.providedCode !== "string" || input.providedCode !== requiredCode) {
    return { allowed: false, error: REGISTRATION_CLOSED_MESSAGE };
  }

  return { allowed: true, reason: "invite_ok" };
}

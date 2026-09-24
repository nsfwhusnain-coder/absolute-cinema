import { REMUXER_URL } from "./remuxer";

const REMUX_HEALTH_TIMEOUT_MS = 400;

/**
 * Whether MKV sources can be offered. Capacity is enforced by the remuxer
 * itself (it refuses a session and the player moves on), so this only checks
 * that remuxing is enabled and the service is up. Fails open on a slow probe.
 */
export async function remuxHasCapacity(): Promise<boolean> {
  if (process.env.REMUX_ENABLED === "0") return false;
  try {
    const response = await fetch(`${REMUXER_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REMUX_HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch (err) {
    return err instanceof DOMException && err.name === "TimeoutError";
  }
}

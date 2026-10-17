/** The full stream answer as the watch page's query sees it. */
export interface StreamDiscoveryInput {
  hasFullData: boolean;
  fullStatus: "pending" | "success" | "error";
  fullFetching: boolean;
  /** A partial answer whose polling window has not run out yet. */
  partialWithinWindow: boolean;
}

/**
 * Whether more sources may still arrive. The full answer counts as still to
 * come until it has arrived or failed: the fast answer can already hold
 * sources, and starting on them before the full answer is in is what let a
 * show open on a web stream while a 4K file was a second away.
 */
export function streamsDiscovering({ hasFullData, fullStatus, fullFetching, partialWithinWindow }: StreamDiscoveryInput): boolean {
  const fullOpen = (!hasFullData && fullStatus !== "error") || fullFetching;
  return fullOpen || partialWithinWindow;
}

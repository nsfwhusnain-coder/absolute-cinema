import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Removes what an earlier run of the remuxer left in its cache folder.
 * Sessions live in memory, so after a restart nothing can reach the folders
 * of the sessions before it, and nothing counted them against the cache's
 * cap either: one install held 100 GB in 74 folders for 3 live sessions,
 * under a 50 GB cap, growing with every update. Returns how many were removed.
 *
 * `isLive` is asked as each folder's turn comes, not once at the start: the
 * same file opened again while this is still working has a folder of the
 * same name, and that one is in use.
 */
export async function removeCacheLeftovers(cacheDir: string, isLive: (name: string) => boolean = () => false): Promise<number> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    if (isLive(name)) continue;
    await rm(join(cacheDir, name), { recursive: true, force: true }).then(() => removed++, () => undefined);
  }
  return removed;
}

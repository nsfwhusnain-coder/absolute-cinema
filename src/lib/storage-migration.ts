/**
 * The app was renamed from "CineHome" to "Absolute Cinema". Browser-side
 * preferences (volume, quality, watched marks, recent searches, TV mode) were
 * stored under `cinehome:` / `cinehome.` keys; this moves them to the new
 * prefix once so existing viewers keep their settings.
 *
 * Emitted as an inline ES5 script so it runs before any component reads
 * localStorage on first paint.
 */
export const LEGACY_STORAGE_PREFIX = "cinehome";
export const STORAGE_PREFIX = "absolute-cinema";

export function migrateLegacyStorage(storage: Storage): number {
  const legacyKeys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && /^cinehome[:.]/.test(key)) legacyKeys.push(key);
  }
  for (const key of legacyKeys) {
    const next = STORAGE_PREFIX + key.slice(LEGACY_STORAGE_PREFIX.length);
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
  return legacyKeys.length;
}

export function legacyStorageMigrationScript(): string {
  return `(function(){try{var s=localStorage,k=[],i,n;for(i=0;i<s.length;i++){n=s.key(i);if(n&&/^cinehome[:.]/.test(n))k.push(n)}
for(i=0;i<k.length;i++){var v=s.getItem(k[i]),t="${STORAGE_PREFIX}"+k[i].slice(${LEGACY_STORAGE_PREFIX.length});if(v!==null&&s.getItem(t)===null)s.setItem(t,v);s.removeItem(k[i])}}catch(e){}})()`;
}

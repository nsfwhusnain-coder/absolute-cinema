/**
 * A web stream's master playlist, sharp renditions first.
 *
 * Safari's player, and the native players of TVs, open on the first rendition
 * a master lists and climb from there, and web providers list theirs from the
 * bottom up (427p first, on Vixsrc). The owner's rule is to start sharp and
 * never play under 1080p while the title has better, so when a master has a
 * rendition at least SHARP_HEIGHT tall the shorter ones are left out, the
 * smallest of the sharp ones is listed first (a start that does not lean on
 * the connection), and the taller follow. Renditions that do not say their
 * size are kept, last. Other tags keep their order, ahead of the renditions.
 * Anything not understood is returned as it came.
 */

export const SHARP_HEIGHT = 1080;

interface Variant {
  lines: string[];
  height: number | null;
  order: number;
}

function heightOf(tag: string): number | null {
  const match = /RESOLUTION=(\d+)x(\d+)/i.exec(tag);
  return match ? Number(match[2]) : null;
}

export function preferSharpVariants(text: string): string {
  if (!text.includes("#EXT-X-STREAM-INF")) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("#EXT-X-STREAM-INF")) {
      kept.push(line);
      continue;
    }
    // The rendition's URI is the next line that is neither blank nor a comment; a tag first is not understood.
    let uri = i + 1;
    while (uri < lines.length && (!lines[uri]!.trim() || (lines[uri]!.trim().startsWith("#") && !lines[uri]!.trim().startsWith("#EXT")))) uri++;
    if (uri >= lines.length || lines[uri]!.trim().startsWith("#")) return text;
    variants.push({ lines: lines.slice(i, uri + 1), height: heightOf(line), order: variants.length });
    i = uri;
  }
  // A bare URI outside a rendition is not a master this understands.
  if (variants.length < 2 || kept.some((line) => line.trim() && !line.trim().startsWith("#"))) return text;
  const sized = variants.filter((v) => v.height !== null);
  const sharp = sized.filter((v) => v.height! >= SHARP_HEIGHT);
  const chosen = sharp.length ? variants.filter((v) => v.height === null || v.height >= SHARP_HEIGHT) : variants;
  const opening = sharp.length ? Math.min(...sharp.map((v) => v.height!)) : Math.max(0, ...sized.map((v) => v.height!));
  const rank = (v: Variant) => (v.height === null ? 2 : v.height === opening ? 0 : 1);
  const ordered = [...chosen].sort((a, b) => rank(a) - rank(b) || (b.height ?? 0) - (a.height ?? 0) || a.order - b.order);
  // Trailing blank lines stay at the end.
  let end = kept.length;
  while (end > 0 && !kept[end - 1]!.trim()) end--;
  return [...kept.slice(0, end), ...ordered.flatMap((v) => v.lines), ...kept.slice(end)].join("\n");
}

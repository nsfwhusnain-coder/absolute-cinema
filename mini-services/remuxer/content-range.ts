/** The whole size of a file, from the Content-Range of a ranged answer ("bytes 0-0/12345"), or null when it is not stated. */
export function totalSizeFromContentRange(header: string | null | undefined): number | null {
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i.exec((header ?? "").trim());
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

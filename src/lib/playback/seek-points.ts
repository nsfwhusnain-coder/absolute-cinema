/**
 * Where playback can begin in a stream that only opens on keyframes.
 *
 * A remuxed file is offered to Media Source players in slices shorter than
 * its keyframe interval, so a frame shows as soon as the first slice arrives
 * (see mini-services/remuxer/vod-plan.ts). A slice in the middle of an
 * interval cannot be decoded on its own: a jump has to land on the keyframe
 * before it. These are the times the server says such a jump may land on.
 */

/** The last point at or before `time`; the first point when `time` comes before them all. */
export function seekPointAtOrBefore(points: readonly number[], time: number): number {
  if (!points.length) return time;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]! <= time) lo = mid;
    else hi = mid - 1;
  }
  return points[lo]!;
}

/** The first point after `time`, if there is one. */
export function seekPointAfter(points: readonly number[], time: number): number | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo < points.length ? points[lo]! : null;
}

/**
 * Where a jump from `from` to `to` lands: the point before the target, so
 * nothing the viewer aimed at is skipped. A forward jump whose point is not
 * ahead of where playback already is goes to the next one instead, or a skip
 * forward inside a long keyframe interval would go backwards.
 */
export function snapSeek(points: readonly number[], from: number, to: number): number {
  const before = seekPointAtOrBefore(points, to);
  if (to > from && before <= from) return seekPointAfter(points, to) ?? before;
  return before;
}

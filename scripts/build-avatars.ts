/**
 * Draws the house profile pictures (public/avatars/<id>.svg).
 *
 *   bun scripts/build-avatars.ts
 *
 * Every picture is a full square tile with its own background, drawn from a
 * handful of shared parts (eyes, mouths, cheeks) so the set reads as one
 * family. The ids here are the ones listed in src/lib/avatars.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(import.meta.dir, "..", "public", "avatars");
const SIZE = 120;
const INK = "#1d1626";
const WHITE = "#ffffff";
const BLUSH = "#ff5d8f";
const TONGUE = "#ff7096";

type Gradient = readonly [string, string];

const BG = {
  red: ["#ff7b7b", "#c9184a"],
  coral: ["#ff9e80", "#e8452c"],
  orange: ["#ffb347", "#f0650e"],
  amber: ["#ffd95a", "#f59f00"],
  lime: ["#c5f277", "#5c9e12"],
  green: ["#7be495", "#1f9d55"],
  mint: ["#8ff0d2", "#0fa37f"],
  teal: ["#5eead4", "#0e7490"],
  sky: ["#7cc8ff", "#1c6fd6"],
  blue: ["#6b9bff", "#2f45c5"],
  indigo: ["#8f86ff", "#4330b8"],
  violet: ["#c59bff", "#7630d6"],
  magenta: ["#f58ad8", "#b3248f"],
  pink: ["#ff9cc2", "#e03a7b"],
  night: ["#3d4a9c", "#141737"],
  plum: ["#6d3fa8", "#26123f"],
  wine: ["#b5325a", "#3f0d22"],
  steel: ["#9fb3c8", "#4a5d78"],
} as const satisfies Record<string, Gradient>;

// ---------- shared parts ----------

/** The same fragment again, mirrored left to right. */
const mirrored = (fragment: string): string => `${fragment}<g transform="matrix(-1 0 0 1 ${SIZE} 0)">${fragment}</g>`;

const circle = (cx: number, cy: number, r: number, fill: string, extra = ""): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${extra}/>`;

const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string, extra = ""): string =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${extra}/>`;

const path = (d: string, fill: string, extra = ""): string => `<path d="${d}" fill="${fill}"${extra}/>`;

const stroke = (d: string, color: string, width: number, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;

/** A tall dark eye with a glint. */
const eye = (cx: number, cy: number, r = 5.5, color: string = INK): string =>
  ellipse(cx, cy, r, r * 1.28, color) + circle(cx + r * 0.3, cy - r * 0.5, r * 0.36, WHITE);

const eyes = (cy: number, gap: number, r = 5.5, cx = 60, color: string = INK): string =>
  eye(cx - gap, cy, r, color) + eye(cx + gap, cy, r, color);

/** A round white eye with a pupil, looking by (dx, dy). */
const roundEye = (cx: number, cy: number, r: number, dx = 0, dy = 0, iris: string = INK): string =>
  circle(cx, cy, r, WHITE) + circle(cx + dx, cy + dy, r * 0.55, iris) + circle(cx + dx + r * 0.18, cy + dy - r * 0.22, r * 0.18, WHITE);

/** A closed, smiling eye. */
const happyEye = (cx: number, cy: number, w = 6.5, color: string = INK, width = 3.6): string =>
  stroke(`M${cx - w} ${cy + 2}Q${cx} ${cy - w} ${cx + w} ${cy + 2}`, color, width);

/** A closed, resting eye. */
const sleepyEye = (cx: number, cy: number, w = 6.5, color: string = INK, width = 3.6): string =>
  stroke(`M${cx - w} ${cy - 1}Q${cx} ${cy + w * 0.8} ${cx + w} ${cy - 1}`, color, width);

const smile = (cx: number, cy: number, w: number, depth: number, color: string = INK, width = 3.6): string =>
  stroke(`M${cx - w} ${cy}Q${cx} ${cy + depth} ${cx + w} ${cy}`, color, width);

/** An open, laughing mouth with a tongue. */
const laugh = (cx: number, cy: number, w: number, h: number, fill: string = INK): string =>
  path(`M${cx - w} ${cy}H${cx + w}Q${cx + w} ${cy + h} ${cx} ${cy + h}Q${cx - w} ${cy + h} ${cx - w} ${cy}Z`, fill) +
  ellipse(cx, cy + h * 0.74, w * 0.5, h * 0.26, TONGUE);

/** The little "w" under an animal's nose. */
const muzzleMouth = (cx: number, cy: number, w = 6, color: string = INK, width = 2.6): string =>
  stroke(`M${cx} ${cy - 4}V${cy}M${cx - w} ${cy - 1}Q${cx - w / 2} ${cy + 4} ${cx} ${cy}Q${cx + w / 2} ${cy + 4} ${cx + w} ${cy - 1}`, color, width);

const blush = (cy: number, gap: number, r = 6, cx = 60, color: string = BLUSH, opacity = 0.42): string =>
  ellipse(cx - gap, cy, r, r * 0.68, color, ` opacity="${opacity}"`) + ellipse(cx + gap, cy, r, r * 0.68, color, ` opacity="${opacity}"`);

/** A spiky outline around (cx, cy): fur, a mane, a burst. */
function spiky(cx: number, cy: number, outer: number, inner: number, points: number, rotation = 0): string {
  const d: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = rotation + (Math.PI * i) / points;
    d.push(`${i === 0 ? "M" : "L"}${(cx + Math.cos(angle) * radius).toFixed(1)} ${(cy + Math.sin(angle) * radius).toFixed(1)}`);
  }
  return `${d.join("")}Z`;
}

/** A ring of circles around (cx, cy): a mane, a flower, a cloud. */
function petals(cx: number, cy: number, ring: number, r: number, count: number, fill: string): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    out += circle(Number((cx + Math.cos(angle) * ring).toFixed(1)), Number((cy + Math.sin(angle) * ring).toFixed(1)), r, fill);
  }
  return out;
}

const star = (cx: number, cy: number, outer: number, fill: string, extra = ""): string =>
  path(spiky(cx, cy, outer, outer * 0.45, 5, -Math.PI / 2), fill, extra);

const sparkles = (points: ReadonlyArray<readonly [number, number, number]>, fill: string = WHITE, opacity = 0.85): string =>
  points.map(([x, y, r]) => circle(x, y, r, fill, ` opacity="${opacity}"`)).join("");

/** A soft light from the top-left, laid over every tile's background. */
const SHEEN = `<rect width="${SIZE}" height="${SIZE}" fill="url(#s)"/>`;

function tile(background: Gradient, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${background[0]}"/><stop offset="1" stop-color="${background[1]}"/></linearGradient>` +
    `<radialGradient id="s" cx="0.28" cy="0.18" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#b)"/>${SHEEN}${body}</svg>\n`
  );
}

// ---------- the classics: the tile is the face ----------

const CLASSICS: Record<string, string> = {
  "classic-smile": tile(BG.sky, eyes(52, 17, 7) + smile(60, 76, 22, 18, INK, 5)),
  "classic-grin": tile(BG.amber, happyEye(42, 52, 9, INK, 5) + happyEye(78, 52, 9, INK, 5) + laugh(60, 68, 23, 24) + blush(70, 34, 7)),
  "classic-wink": tile(
    BG.pink,
    eye(42, 52, 7) + stroke("M70 54L86 50", INK, 5) + stroke("M70 54L85 59", INK, 5) + smile(58, 74, 20, 16, INK, 5) + ellipse(66, 86, 8, 10, TONGUE) + stroke("M66 80V88", "#d6336c", 2)
  ),
  "classic-cool": tile(
    BG.teal,
    path("M22 44H98V54Q98 68 82 68Q68 68 65 54H55Q52 68 38 68Q22 68 22 54Z", INK) +
      stroke("M30 51L40 49", WHITE, 3, ' opacity="0.7"') +
      stroke("M70 51L80 49", WHITE, 3, ' opacity="0.7"') +
      stroke("M44 82Q62 92 78 78", INK, 5)
  ),
  "classic-smirk": tile(BG.red, eyes(54, 17, 7) + stroke("M31 38L50 42", INK, 5) + stroke("M70 36L90 32", INK, 5) + stroke("M42 80Q62 88 80 72", INK, 5)),
  "classic-wow": tile(BG.violet, roundEye(42, 50, 12) + roundEye(78, 50, 12) + ellipse(60, 84, 9, 12, INK) + stroke("M30 30L46 28", INK, 4) + stroke("M74 28L90 30", INK, 4)),
  "classic-sleepy": tile(
    BG.night,
    sleepyEye(42, 56, 9, WHITE, 5) + sleepyEye(78, 56, 9, WHITE, 5) + ellipse(60, 82, 6, 5, WHITE) + stroke("M84 26H96L84 38H96", WHITE, 3.4, ' opacity="0.9"') + stroke("M100 12H107L100 19H107", WHITE, 2.6, ' opacity="0.7"') + sparkles([[20, 22, 1.8], [32, 96, 1.4], [16, 60, 1.2]])
  ),
  "classic-love": tile(
    BG.magenta,
    mirrored(path("M42 62C30 53 26 46 31 40C35 36 40 38 42 42C44 38 49 36 53 40C58 46 54 53 42 62Z", "#ffe3ec")) + laugh(60, 72, 20, 20) + blush(74, 34, 7, 60, WHITE, 0.3)
  ),
  "classic-nerd": tile(
    BG.green,
    circle(40, 54, 17, WHITE, ' opacity="0.9"') + circle(80, 54, 17, WHITE, ' opacity="0.9"') +
      stroke("M57 54H63", INK, 4.5) + `<circle cx="40" cy="54" r="17" fill="none" stroke="${INK}" stroke-width="4.5"/><circle cx="80" cy="54" r="17" fill="none" stroke="${INK}" stroke-width="4.5"/>` +
      eye(42, 55, 5) + eye(78, 55, 5) + path("M44 82H76Q76 96 60 96Q44 96 44 82Z", INK) + path("M52 82H68V88H52Z", WHITE)
  ),
  "classic-shy": tile(BG.coral, eye(46, 54, 6.5) + eye(80, 54, 6.5) + smile(62, 76, 12, 9, INK, 4.6) + blush(68, 32, 9, 62, "#ffd6e0", 0.75)),
  "classic-star": tile(BG.plum, star(40, 52, 14, "#ffd95a") + star(80, 52, 14, "#ffd95a") + laugh(60, 72, 20, 22, "#120a1c") + sparkles([[18, 24, 2], [102, 30, 1.6], [98, 96, 2], [24, 98, 1.4]])),
  "classic-zen": tile(BG.mint, happyEye(42, 56, 9, INK, 5) + happyEye(78, 56, 9, INK, 5) + smile(60, 78, 10, 7, INK, 4.6) + blush(72, 34, 7, 60, WHITE, 0.4)),
};

// ---------- animals ----------

const fox =
  mirrored(path("M22 50L28 10L56 34Z", "#f58a1f") + path("M30 40L33 22L46 34Z", "#4a2b22")) +
  path("M18 60Q18 32 60 32Q102 32 102 60Q100 84 60 108Q20 84 18 60Z", "#f58a1f") +
  path("M22 70Q42 62 60 84Q78 62 98 70Q90 90 60 108Q30 90 22 70Z", "#fff7ed") +
  eyes(62, 17, 5.4) + ellipse(60, 90, 6.5, 4.8, INK) + smile(60, 96, 6, 4, INK, 2.4);

const panda =
  mirrored(circle(28, 36, 15, INK)) + ellipse(60, 68, 42, 38, "#fbfbfd") +
  mirrored(ellipse(42, 64, 11, 14, INK, ' transform="rotate(-22 42 64)"')) +
  circle(43, 63, 4.6, WHITE) + circle(77, 63, 4.6, WHITE) + circle(44, 63.5, 2.4, INK) + circle(76, 63.5, 2.4, INK) +
  ellipse(60, 80, 5.5, 4, INK) + muzzleMouth(60, 88) + blush(82, 27, 6);

const cat =
  mirrored(path("M20 52L24 12L54 34Z", "#2f2638") + path("M27 42L29 24L42 34Z", "#ff9cc2")) +
  ellipse(60, 70, 42, 36, "#2f2638") +
  mirrored(ellipse(42, 66, 9, 10, "#ffe066") + ellipse(42, 66, 2.8, 8, INK) + circle(44.5, 62, 2, WHITE)) +
  path("M55 78H65L60 84Z", "#ff9cc2") + muzzleMouth(60, 90, 7, "#8b7a99") +
  mirrored(stroke("M30 82L10 78M30 87L10 92", WHITE, 1.8, ' opacity="0.75"'));

const dog =
  mirrored(ellipse(24, 66, 14, 28, "#8a5a2b", ' transform="rotate(10 24 66)"')) +
  ellipse(60, 64, 37, 38, "#e3a857") + ellipse(77, 56, 13, 15, "#8a5a2b") + ellipse(60, 84, 21, 17, "#fdebd0") +
  eyes(58, 16, 5.2) + ellipse(60, 75, 7.5, 5.4, INK) + stroke("M60 80V86", INK, 2.6) + ellipse(60, 95, 6, 8, TONGUE) + stroke("M49 87Q60 96 71 87", INK, 2.8);

const owl =
  mirrored(path("M20 46L22 14L48 32Z", "#8a6243")) + path("M16 120V64Q16 28 60 28Q104 28 104 64V120Z", "#8a6243") +
  path("M34 120Q34 92 60 92Q86 92 86 120Z", "#e9d3b0") +
  mirrored(circle(41, 60, 20, "#f4e4c9") + circle(41, 60, 12, "#ffc233") + circle(42, 60, 6.5, INK) + circle(44.5, 57, 2.2, WHITE)) +
  path("M53 70H67L60 84Z", "#ff8f1f") + stroke("M48 104l4 4l4-4M64 104l4 4l4-4", "#a9865c", 2.4);

const penguin =
  path("M14 120V66Q14 24 60 24Q106 24 106 66V120Z", "#26222f") +
  path("M60 46Q44 32 31 47Q20 62 29 86Q38 110 60 114Q82 110 91 86Q100 62 89 47Q76 32 60 46Z", "#fbfbfd") +
  eyes(66, 16, 5.2) + ellipse(60, 81, 10, 6, "#ffa51f") + stroke("M51 81H69", "#d97706", 1.8) + blush(82, 26, 6);

const frog =
  mirrored(circle(36, 40, 17, "#4fcf6d")) + ellipse(60, 76, 48, 38, "#4fcf6d") +
  mirrored(circle(36, 40, 11, WHITE) + circle(37, 41, 6, INK) + circle(39.5, 38.5, 2, WHITE)) +
  stroke("M28 78Q60 104 92 78", INK, 4) + circle(54, 66, 1.8, "#238b45") + circle(66, 66, 1.8, "#238b45") + blush(84, 36, 7, 60, "#2f9e56", 0.5);

const bear =
  mirrored(circle(28, 36, 15, "#8f5a2e") + circle(28, 36, 7.5, "#d49b63")) + circle(60, 68, 42, "#a36a37") +
  ellipse(60, 84, 19, 15, "#ecc9a2") + eyes(62, 17, 5) + ellipse(60, 77, 7.5, 5.4, INK) + muzzleMouth(60, 88, 7);

const bunny =
  mirrored(ellipse(42, 30, 11, 30, "#fbfbfd", ' transform="rotate(-8 42 30)"') + ellipse(42, 32, 5.5, 21, "#ffb3cd", ' transform="rotate(-8 42 32)"')) +
  ellipse(60, 80, 38, 34, "#fbfbfd") + eyes(74, 15, 5.2) + path("M55.5 84H64.5L60 89Z", "#ff8fb4") + muzzleMouth(60, 95, 6) +
  `<rect x="56" y="96" width="8" height="8" rx="2" fill="${WHITE}" stroke="${INK}" stroke-width="1.6"/>` + blush(88, 25, 6);

const tiger =
  mirrored(circle(28, 38, 14, "#ff9330") + circle(28, 38, 7, "#fff1dc")) + circle(60, 68, 42, "#ff9330") +
  stroke("M60 27V41M48 30L50 41M72 30L70 41", INK, 4.2) + mirrored(stroke("M20 60L33 64M19 74H32", INK, 4.2)) +
  ellipse(60, 86, 21, 15, "#fff7ed") + eyes(62, 17, 5.2) + path("M54.5 78H65.5L60 85Z", INK) + muzzleMouth(60, 92, 7);

const koala =
  mirrored(circle(21, 48, 21, "#9aa5b4") + circle(21, 48, 11.5, "#f4c2d0")) + ellipse(60, 70, 39, 36, "#aeb8c5") +
  ellipse(60, 77, 9.5, 14, "#30343c") + ellipse(57, 71, 2.6, 3.4, WHITE, ' opacity="0.5"') + eyes(64, 22, 4.4) + smile(60, 97, 6, 4, INK, 2.6) + blush(80, 28, 6);

const lion =
  circle(60, 68, 40, "#e0610f") + petals(60, 68, 36, 13, 12, "#e0610f") +
  mirrored(circle(36, 40, 10, "#ffcf47") + circle(36, 40, 5, "#e0610f")) + circle(60, 68, 31, "#ffcf47") +
  ellipse(60, 82, 15, 11, "#fff7dc") + eyes(64, 13, 4.8) + path("M55 76H65L60 82Z", "#7a3b12") + muzzleMouth(60, 88, 6);

const monkey =
  mirrored(circle(19, 64, 14, "#8a5a33") + circle(19, 64, 7.5, "#f2cba6")) + circle(60, 64, 40, "#8a5a33") +
  circle(45, 58, 17, "#f2cba6") + circle(75, 58, 17, "#f2cba6") + ellipse(60, 82, 27, 21, "#f2cba6") +
  eyes(58, 15, 5.2) + circle(56, 75, 1.8, "#7a4a25") + circle(64, 75, 1.8, "#7a4a25") + smile(60, 84, 14, 12, INK, 3.2);

const unicorn =
  circle(24, 52, 15, "#ff7b7b") + circle(20, 74, 14, "#ffd95a") + circle(25, 96, 14, "#7be495") + circle(38, 34, 13, "#7cc8ff") +
  path("M62 4L53 38H71Z", "#ffd95a") + stroke("M56 28L68 24M58 19L65 16", "#f59f00", 2.4) +
  mirrored(path("M36 46L40 26L52 40Z", "#fbfbfd")) + ellipse(62, 74, 35, 38, "#fbfbfd") + ellipse(62, 97, 21, 14, "#ffe3ec") +
  eyes(70, 15, 5.2, 62) + circle(56, 97, 2, "#e68aa8") + circle(68, 97, 2, "#e68aa8") + blush(82, 27, 6, 62);

const ANIMALS: Record<string, string> = {
  "animal-fox": tile(BG.teal, fox),
  "animal-panda": tile(BG.green, panda),
  "animal-cat": tile(BG.pink, cat),
  "animal-dog": tile(BG.sky, dog),
  "animal-owl": tile(BG.night, owl + sparkles([[14, 16, 1.6], [104, 22, 1.4], [96, 8, 1]])),
  "animal-penguin": tile(BG.sky, penguin),
  "animal-frog": tile(BG.amber, frog),
  "animal-bear": tile(BG.mint, bear),
  "animal-bunny": tile(BG.violet, bunny),
  "animal-tiger": tile(BG.green, tiger),
  "animal-koala": tile(BG.coral, koala),
  "animal-lion": tile(BG.indigo, lion),
  "animal-monkey": tile(BG.lime, monkey),
  "animal-unicorn": tile(BG.magenta, unicorn),
};

// ---------- creatures ----------

const cyclops =
  mirrored(path("M30 36L33 12L48 28Z", "#fff3bf")) + path("M12 120V72Q12 26 60 26Q108 26 108 72V120Z", "#9a7bff") +
  circle(26, 96, 5, "#7f5ff0") + circle(96, 84, 4, "#7f5ff0") + circle(88, 104, 6, "#7f5ff0") +
  circle(60, 62, 21, WHITE) + circle(61, 63, 12, "#14b89a") + circle(61, 63, 6.5, INK) + circle(65, 59, 2.6, WHITE) +
  path("M38 92H82Q82 110 60 110Q38 110 38 92Z", INK) + `<rect x="46" y="92" width="9" height="8" rx="2" fill="${WHITE}"/><rect x="65" y="92" width="9" height="8" rx="2" fill="${WHITE}"/>`;

const alien =
  mirrored(stroke("M46 28L37 10", "#8ee59f", 3.6) + circle(36, 8, 4.6, "#c8f7d0")) +
  path("M60 22C98 22 106 54 97 77C90 97 74 110 60 110C46 110 30 97 23 77C14 54 22 22 60 22Z", "#8ee59f") +
  mirrored(ellipse(42, 62, 11.5, 16, INK, ' transform="rotate(20 42 62)"') + ellipse(44, 55, 3, 4.4, WHITE, ' transform="rotate(20 44 55)"')) +
  smile(60, 90, 8, 5, "#1f6b3a", 3);

const fuzzy =
  mirrored(path("M34 38Q20 26 28 8Q40 18 46 32Z", "#fff3bf")) + path(spiky(60, 70, 47, 39, 16), "#4aa8ff", ' stroke="#4aa8ff" stroke-width="5" stroke-linejoin="round"') +
  roundEye(45, 60, 11, 2, 1) + roundEye(75, 60, 11, -2, 1) +
  path("M36 80H84Q84 104 60 104Q36 104 36 80Z", INK) + path("M40 80L46 88L52 80L58 88L64 80L70 88L76 80Z", WHITE) + ellipse(60, 98, 11, 5, TONGUE);

const ghost =
  path("M24 112V60Q24 22 60 22Q96 22 96 60V112L84 101L72 112L60 101L48 112L36 101Z", "#f7f8ff") +
  ellipse(47, 58, 6.5, 9, INK) + ellipse(73, 58, 6.5, 9, INK) + circle(49, 54, 2.2, WHITE) + circle(75, 54, 2.2, WHITE) +
  ellipse(60, 80, 6.5, 8.5, INK) + blush(72, 26, 6, 60, "#ff9cc2", 0.6);

const slime =
  circle(60, 26, 7, "#63d97f") + path("M14 120V80Q14 34 60 34Q106 34 106 80V120Z", "#63d97f") +
  ellipse(38, 54, 11, 6, WHITE, ' opacity="0.5" transform="rotate(-32 38 54)"') + circle(88, 96, 5, "#3fbf62") + circle(26, 100, 3.6, "#3fbf62") +
  eyes(76, 19, 5.4) + smile(60, 88, 9, 7, INK, 3.2) + blush(88, 30, 6, 60, "#2f9e56", 0.55);

const vampire =
  path("M10 120L28 88H92L110 120Z", "#17111f") + mirrored(path("M12 120L30 86L46 120Z", "#d3224a")) +
  mirrored(path("M30 60L15 52L30 80Z", "#dfe6f4")) + ellipse(60, 68, 32, 36, "#dfe6f4") +
  path("M27 66Q20 20 60 20Q100 20 93 66Q88 44 72 42L60 56L48 42Q32 44 27 66Z", INK) +
  eyes(68, 14, 5, 60, "#b0172f") + stroke("M38 57L52 61M82 57L68 61", INK, 3) + smile(60, 86, 13, 9, INK, 3) +
  path("M50 89L53.5 98L57 90Z", WHITE) + path("M63 90L66.5 98L70 89Z", WHITE);

const zombie =
  path("M36 34L42 16L50 30L58 12L64 30L74 14L80 34Z", "#3b4a2a") + `<rect x="22" y="28" width="76" height="82" rx="28" fill="#a8cf8e"/>` +
  roundEye(44, 62, 12, 1.5, 1) + roundEye(77, 64, 7.5, -1, 0) + stroke("M62 36L76 42M66 34L64 42M71 36L69 45", "#4f6b3a", 2.4) +
  stroke("M40 90Q48 84 56 90Q64 96 72 90Q78 86 82 90", INK, 3.2) + `<rect x="50" y="88" width="7" height="8" rx="1.5" fill="${WHITE}"/>` + circle(34, 84, 3, "#7fae63") + circle(88, 80, 2.4, "#7fae63");

const imp =
  mirrored(path("M30 42Q18 28 30 8Q40 20 46 34Z", "#8f1230")) + mirrored(path("M26 62L10 56L24 78Z", "#f0455a")) + circle(60, 70, 39, "#f0455a") +
  eyes(66, 15, 5.2) + stroke("M34 54L52 59M86 54L68 59", INK, 4) +
  path("M40 84H80Q80 100 60 100Q40 100 40 84Z", INK) + path("M44 84H76V90H44Z", WHITE) + stroke("M52 84V90M60 84V90M68 84V90", INK, 1.6);

const yeti =
  circle(60, 68, 40, "#f3f6fa") + petals(60, 68, 38, 12, 14, "#f3f6fa") + ellipse(60, 72, 27, 25, "#a9dcff") +
  eyes(68, 12, 5) + smile(60, 82, 10, 7, INK, 3) + path("M52 85L55 91L58 86Z", WHITE) + path("M62 86L65 91L68 85Z", WHITE) + blush(78, 20, 5, 60, "#ff9cc2", 0.6);

const robot =
  stroke("M60 36V18", "#7b8794", 4) + circle(60, 14, 6.5, "#ff6b6b") + mirrored(`<rect x="13" y="56" width="11" height="20" rx="3.5" fill="#7b8794"/>`) +
  `<rect x="22" y="34" width="76" height="66" rx="16" fill="#d5dbe3"/><rect x="32" y="46" width="56" height="25" rx="12.5" fill="${INK}"/>` +
  circle(47, 58.5, 6, "#5eead4") + circle(73, 58.5, 6, "#5eead4") + circle(49, 56.5, 1.8, WHITE) + circle(75, 56.5, 1.8, WHITE) +
  `<rect x="42" y="80" width="36" height="10" rx="5" fill="#7b8794"/>` + stroke("M51 81V89M60 81V89M69 81V89", "#d5dbe3", 2.2);

const skull =
  circle(60, 58, 36, "#f8f9fb") + `<rect x="40" y="76" width="40" height="28" rx="9" fill="#f8f9fb"/>` +
  mirrored(ellipse(45, 60, 10.5, 12, INK) + circle(48, 56, 2.6, WHITE)) + path("M55 78L60 69L65 78Z", INK) +
  stroke("M42 90H78M51 86V103M60 86V103M69 86V103", INK, 2.6);

const pumpkin =
  path("M56 34Q54 20 64 16L70 22Q64 26 66 34Z", "#3f8f3a") + ellipse(60, 74, 44, 36, "#ff8f1f") + ellipse(60, 74, 26, 36, "#ff9f3a") + ellipse(60, 74, 9, 36, "#ffab52") +
  mirrored(path("M33 67L48 55L51 73Z", "#3a1708", ' stroke="#ffe680" stroke-width="2" stroke-linejoin="round"')) +
  path("M30 84L40 80L46 88L54 80L60 88L66 80L74 88L80 80L90 84Q76 104 60 104Q44 104 30 84Z", "#3a1708", ' stroke="#ffe680" stroke-width="2" stroke-linejoin="round"');

const CREATURES: Record<string, string> = {
  "creature-cyclops": tile(BG.lime, cyclops),
  "creature-alien": tile(BG.night, sparkles([[16, 18, 1.6], [102, 14, 1.2], [108, 70, 1.6], [12, 86, 1.2], [96, 104, 1]]) + alien),
  "creature-fuzzy": tile(BG.orange, fuzzy),
  "creature-ghost": tile(BG.indigo, ghost),
  "creature-slime": tile(BG.pink, slime),
  "creature-vampire": tile(BG.wine, vampire),
  "creature-zombie": tile(BG.violet, zombie),
  "creature-imp": tile(BG.amber, imp),
  "creature-yeti": tile(BG.teal, yeti),
  "creature-robot": tile(BG.blue, robot),
  "creature-skull": tile(BG.magenta, skull),
  "creature-pumpkin": tile(BG.plum, pumpkin + sparkles([[16, 22, 1.6], [104, 30, 1.2], [98, 12, 1]])),
};

// ---------- the cast ----------

const SKIN = { light: "#f6cfa9", tan: "#e3ac6e", medium: "#c98a52", brown: "#9c6238", deep: "#75452a" } as const;

const astronaut =
  `<rect x="28" y="96" width="64" height="30" rx="12" fill="#e3e8ef"/>` + path("M52 100H68V120H52Z", "#ff6b6b") + circle(60, 60, 42, "#f3f6fa") +
  `<circle cx="60" cy="60" r="42" fill="none" stroke="#c4ccd8" stroke-width="3"/>` + ellipse(60, 62, 31, 27, "#16204a") +
  path("M36 54Q44 38 64 38", "none", ` stroke="${WHITE}" stroke-width="5" stroke-linecap="round" opacity="0.45"`) + star(76, 72, 6, "#ffd95a") + circle(48, 74, 2, WHITE, ' opacity="0.8"');

const ninja =
  path("M92 44L112 34L106 48L116 54L94 54Z", "#e03a4f") + circle(60, 68, 40, "#2c2a3d") + `<rect x="26" y="54" width="68" height="24" rx="12" fill="${SKIN.light}"/>` +
  `<rect x="20" y="40" width="80" height="11" rx="5" fill="#e03a4f"/>` + eyes(67, 15, 5) + stroke("M34 58L52 62M86 58L68 62", INK, 3.6);

const pirate =
  circle(24, 82, 4.5, "none", ' stroke="#ffd95a" stroke-width="2.6"') + circle(60, 68, 35, SKIN.tan) +
  path("M26 82Q60 124 94 82Q78 94 60 94Q42 94 26 82Z", "#5c3a21") + path("M48 96H72Q72 106 60 106Q48 106 48 96Z", INK) + `<rect x="62" y="96" width="6" height="6" rx="1.2" fill="#ffd95a"/>` +
  path("M24 60Q24 24 60 24Q96 24 96 60Q60 44 24 60Z", "#e03a4f") + sparkles([[40, 40, 2.6], [60, 34, 2.6], [80, 40, 2.6], [50, 48, 2.2], [72, 48, 2.2]], WHITE, 0.95) +
  path("M94 56L112 50L104 62L114 70L94 64Z", "#e03a4f") + stroke("M25 58L96 68", INK, 3) + ellipse(45, 72, 10, 9, INK) + eye(75, 72, 5.2);

const wizard =
  path("M26 56L66 2L96 56Z", "#5a3fd0") + star(62, 30, 6, "#ffd95a") + circle(78, 46, 2.4, "#ffd95a") + circle(48, 44, 2, "#ffd95a") +
  ellipse(60, 58, 47, 10, "#4630b0") + ellipse(60, 74, 25, 18, SKIN.light) +
  path("M32 76Q26 118 60 120Q94 118 88 76Q76 90 60 90Q44 90 32 76Z", "#f8f9fb") + eyes(71, 11, 4.4) + stroke("M42 64Q48 60 54 64M66 64Q72 60 78 64", "#f8f9fb", 4) +
  ellipse(60, 80, 5, 4, "#e8b78c") + path("M60 84Q50 80 40 88Q52 94 60 86Q68 94 80 88Q70 80 60 84Z", "#f8f9fb");

const hero =
  mirrored(path("M10 120L34 94L50 120Z", "#e03a4f")) + path("M40 96H80L74 120H46Z", "#2f45c5") + star(60, 110, 7, "#ffd95a") + circle(60, 64, 35, SKIN.brown) +
  path("M26 58Q24 24 60 24Q96 24 94 58Q86 38 60 40Q34 38 26 58Z", "#231a2e") +
  path("M26 60Q60 46 94 60Q96 78 78 80Q66 80 60 71Q54 80 42 80Q24 78 26 60Z", "#e03a4f") +
  mirrored(path("M36 66Q45 58 54 66Q46 73 36 66Z", WHITE)) + smile(60, 86, 11, 8, INK, 3.2);

const detective =
  mirrored(path("M14 120L38 92L60 120Z", "#c9a56a")) + path("M50 100H70L66 120H54Z", "#f3ead7") + ellipse(60, 76, 29, 28, SKIN.tan) +
  path("M34 46Q36 16 60 16Q84 16 86 46Z", "#5a4433") + path("M34 40H86V46H34Z", "#2f2219") + ellipse(60, 48, 49, 9.5, "#4a372a") +
  path("M34 62H86V70Q60 60 34 70Z", "#3a2a1f", ' opacity="0.28"') + eyes(72, 13, 4.6) + stroke("M38 66H54M66 66H82", INK, 3.4) +
  path("M60 84Q50 82 44 90Q54 92 60 88Q66 92 76 90Q70 82 60 84Z", "#5a3a22");

const cowboy =
  path("M30 96H90L60 124Z", "#e03a4f") + sparkles([[46, 102, 2], [60, 108, 2], [74, 102, 2]], WHITE, 0.9) + circle(60, 76, 29, SKIN.light) +
  path("M36 50Q33 14 50 20Q60 28 70 20Q87 14 84 50Z", "#b8762f") + path("M36 44H84V50H36Z", "#6b3f17") +
  path("M6 52Q30 38 60 46Q90 38 114 52Q90 64 60 59Q30 64 6 52Z", "#a2632a") + eyes(74, 13, 4.8) + smile(60, 88, 11, 8, INK, 3.2) +
  stroke("M70 91L84 96", "#e7c873", 2.6) + blush(84, 22, 5);

const knight =
  path("M60 22Q70 -2 96 8Q82 14 78 30Z", "#f0455a") + path("M24 112V58Q24 20 60 20Q96 20 96 58V112Z", "#b4bfcc") +
  path("M24 58Q24 20 60 20V112H24Z", "#c8d1dc") + `<rect x="32" y="52" width="56" height="14" rx="5" fill="${INK}"/><rect x="55" y="40" width="10" height="46" rx="4" fill="#8996a6"/>` +
  circle(44, 59, 2.6, WHITE) + circle(76, 59, 2.6, WHITE) + sparkles([[40, 84, 2.2], [48, 92, 2.2], [40, 100, 2.2], [80, 84, 2.2], [72, 92, 2.2], [80, 100, 2.2]], "#6f7c8c", 1);

const queen =
  path("M20 120V66Q20 34 60 34Q100 34 100 66V120Z", "#3a1f14") + ellipse(60, 74, 28, 30, SKIN.deep) +
  path("M30 42L35 16L48 32L60 10L72 32L85 16L90 42Z", "#ffd95a") + `<rect x="30" y="38" width="60" height="8" rx="3" fill="#f5b400"/>` +
  circle(60, 24, 3.4, "#f0455a") + circle(38, 26, 2.6, "#5eead4") + circle(82, 26, 2.6, "#5eead4") +
  eyes(72, 13, 5) + stroke("M36 66Q42 62 50 65M70 65Q78 62 84 66", "#1c0f0a", 2.6) + path("M52 90Q60 96 68 90Q60 92 52 90Z", "#e03a6a", ` stroke="#e03a6a" stroke-width="3" stroke-linejoin="round"`) +
  circle(31, 86, 3, "#ffd95a") + circle(89, 86, 3, "#ffd95a") + blush(84, 20, 5, 60, "#ff7096", 0.35);

const rocker =
  path("M46 44L42 8L54 26L60 2L66 26L78 8L74 44Z", "#ff5fa2") + circle(60, 72, 33, SKIN.light) + circle(27, 80, 3.4, "none", ' stroke="#d5dbe3" stroke-width="2.2"') +
  `<rect x="28" y="60" width="64" height="18" rx="8" fill="${INK}"/>` + stroke("M36 66L46 64M68 66L78 64", WHITE, 2.6, ' opacity="0.7"') +
  path("M46 88H74Q74 100 60 100Q46 100 46 88Z", INK) + ellipse(60, 99, 7, 7, TONGUE) + stroke("M60 94V102", "#d6336c", 1.8);

const gamer =
  circle(60, 70, 33, SKIN.medium) + path("M28 66Q26 34 60 34Q94 34 92 66Q80 48 60 50Q40 48 28 66Z", "#2a1c3a") +
  stroke("M22 68Q22 22 60 22Q98 22 98 68", "#2f3440", 8) + mirrored(`<rect x="10" y="58" width="18" height="30" rx="8" fill="#f0455a"/>`) +
  stroke("M22 88Q26 104 46 100", "#2f3440", 3.4) + circle(48, 100, 4, "#2f3440") + eyes(72, 13, 5.4) + laugh(60, 84, 11, 11) + blush(84, 22, 5);

const agent =
  path("M10 120L38 96L60 112L82 96L110 120Z", "#20242c") + path("M46 98L60 114L74 98Z", "#f3f6fa") + path("M56 104H64L62 120H58Z", "#b0172f") +
  circle(60, 64, 33, SKIN.brown) + path("M28 58Q26 26 60 26Q94 26 92 58Q84 40 60 42Q36 40 28 58Z", "#17111f") +
  path("M30 58H56V66Q56 76 44 76Q30 76 30 64ZM64 58H90V64Q90 76 76 76Q64 76 64 66Z", INK) + stroke("M56 61H64", INK, 3) + stroke("M36 63L44 61M70 63L78 61", WHITE, 2.4, ' opacity="0.6"') +
  stroke("M50 88H70", INK, 3.4) + stroke("M93 66Q98 72 94 78Q90 84 95 90", "#c4ccd8", 2);

const CAST: Record<string, string> = {
  "cast-astronaut": tile(BG.night, sparkles([[14, 20, 1.6], [106, 16, 1.2], [110, 84, 1.6], [10, 70, 1.2], [20, 104, 1]]) + astronaut),
  "cast-ninja": tile(BG.amber, ninja),
  "cast-pirate": tile(BG.teal, pirate),
  "cast-wizard": tile(BG.blue, sparkles([[14, 24, 1.8], [104, 20, 1.4], [108, 96, 1.6], [12, 98, 1.2]]) + wizard),
  "cast-hero": tile(BG.sky, hero),
  "cast-detective": tile(BG.steel, detective),
  "cast-cowboy": tile(BG.coral, cowboy),
  "cast-knight": tile(BG.violet, knight),
  "cast-queen": tile(BG.pink, queen),
  "cast-rocker": tile(BG.lime, rocker),
  "cast-gamer": tile(BG.indigo, gamer),
  "cast-agent": tile(BG.steel, agent),
};

// ---------- movie night ----------

const popcorn =
  sparkles([[40, 50, 12], [58, 40, 13], [78, 48, 12], [48, 34, 10], [70, 32, 10], [30, 58, 9], [90, 58, 9]], "#fff3c4", 1) +
  sparkles([[58, 40, 6], [40, 52, 5], [78, 50, 5]], "#ffe07a", 1) + path("M26 60H94L85 118H35Z", "#fbfbfd") +
  path("M26 60H40L44 118H35ZM53 60H67L65 118H55ZM80 60H94L85 118H76Z", "#f0455a") + eyes(84, 12, 4.8) + smile(60, 94, 9, 7, INK, 3) + blush(94, 20, 4.6);

const clapper =
  `<g transform="rotate(-13 22 50)"><rect x="20" y="30" width="80" height="16" rx="3" fill="#2a2d36"/>` + path("M30 30H42L34 46H22ZM54 30H66L58 46H46ZM78 30H90L82 46H70Z", WHITE) + `</g>` +
  `<rect x="20" y="50" width="80" height="56" rx="7" fill="#2a2d36"/>` + roundEye(46, 74, 8, 1, 1) + roundEye(74, 74, 8, -1, 1) + smile(60, 90, 10, 7, WHITE, 3.2) + stroke("M20 60H100", "#454a57", 2);

const reel =
  stroke("M92 86Q108 100 96 116", "#2a2d36", 11) + stroke("M92 86Q108 100 96 116", "#fbfbfd", 2, ' stroke-dasharray="1 6"') + circle(60, 62, 42, "#3a3f4c") +
  circle(60, 62, 34, "#4a5060") + circle(60, 88, 9, "#22252d") + circle(36, 72, 9, "#22252d") + circle(84, 72, 9, "#22252d") +
  roundEye(45, 44, 10, 1, 1) + roundEye(75, 44, 10, -1, 1) + circle(60, 64, 5, "#d5dbe3");

const glasses =
  `<rect x="16" y="42" width="88" height="32" rx="7" fill="#fbfbfd"/><rect x="23" y="48" width="33" height="20" rx="4" fill="#f0455a"/><rect x="64" y="48" width="33" height="20" rx="4" fill="#22b8cf"/>` +
  stroke("M28 53L38 51M69 53L79 51", WHITE, 2.6, ' opacity="0.6"') + laugh(60, 84, 16, 16, "#0d0f24");

const ticket =
  `<g transform="rotate(-10 60 64)">` + path("M18 40H102V54A10 10 0 0 0 102 74V88H18V74A10 10 0 0 0 18 54Z", "#ffd95a") + stroke("M38 44V84", "#d99a00", 2.4, ' stroke-dasharray="3 5"') +
  star(28, 64, 6, "#f59f00") + eyes(60, 10, 4.8, 68) + smile(68, 72, 9, 7, INK, 3) + blush(70, 19, 4.4, 68) + `</g>`;

const soda =
  stroke("M66 44L78 10", "#fbfbfd", 7) + stroke("M70.5 32L77 34M73.5 23L80 25", "#f0455a", 3) + path("M36 50H84L77 116H43Z", "#f0455a") +
  path("M38 70Q50 62 60 70Q70 78 82 70L80.5 84Q70 92 60 84Q50 76 39.5 84Z", "#fbfbfd") + `<rect x="31" y="42" width="58" height="11" rx="5" fill="#f3f6fa"/>` +
  eyes(98, 10, 4.4) + smile(60, 105, 6, 4, INK, 2.6);

const camera =
  circle(40, 40, 15, "#3a3f4c") + circle(70, 40, 15, "#3a3f4c") + circle(40, 40, 5, "#d5dbe3") + circle(70, 40, 5, "#d5dbe3") + path("M80 68L104 56V96L80 84Z", "#3a3f4c") +
  `<rect x="18" y="54" width="64" height="46" rx="9" fill="#2a2d36"/>` + roundEye(38, 74, 7.5, 1, 1) + roundEye(62, 74, 7.5, -1, 1) + smile(50, 88, 8, 6, WHITE, 3) + circle(72, 62, 2.6, "#f0455a");

const goldStar =
  path(spiky(60, 64, 46, 22, 5, -Math.PI / 2), "#ffd95a", ' stroke="#ffd95a" stroke-width="9" stroke-linejoin="round"') + eyes(62, 11, 5) + smile(60, 74, 9, 7, INK, 3.2) + blush(72, 19, 4.6);

const tv =
  stroke("M60 34L44 12M60 34L76 12", "#3a3f4c", 3.4) + circle(44, 12, 3.6, "#f0455a") + circle(76, 12, 3.6, "#f0455a") + stroke("M34 100L30 112M86 100L90 112", "#3a3f4c", 4.4) +
  `<rect x="14" y="32" width="92" height="70" rx="14" fill="#ff8f1f"/><rect x="22" y="40" width="60" height="54" rx="10" fill="#16122b"/>` +
  circle(42, 62, 5, "#5eead4") + circle(62, 62, 5, "#5eead4") + smile(52, 74, 9, 7, "#5eead4", 3.2) + circle(94, 52, 5, "#ffe9c7") + circle(94, 70, 5, "#ffe9c7") + stroke("M90 86H98", "#c9650d", 3);

const CINEMA: Record<string, string> = {
  "cinema-popcorn": tile(BG.sky, popcorn),
  "cinema-clapper": tile(BG.amber, clapper),
  "cinema-reel": tile(BG.violet, reel),
  "cinema-glasses": tile(BG.blue, glasses),
  "cinema-ticket": tile(BG.red, ticket),
  "cinema-soda": tile(BG.lime, soda),
  "cinema-camera": tile(BG.orange, camera),
  "cinema-star": tile(BG.indigo, goldStar + sparkles([[16, 20, 2], [104, 24, 1.6], [100, 100, 2], [18, 96, 1.4]])),
  "cinema-tv": tile(BG.teal, tv),
};

const ALL: Record<string, string> = { ...CLASSICS, ...ANIMALS, ...CREATURES, ...CAST, ...CINEMA };

mkdirSync(OUT_DIR, { recursive: true });
for (const [id, svg] of Object.entries(ALL)) writeFileSync(join(OUT_DIR, `${id}.svg`), svg);
process.stdout.write(`${Object.keys(ALL).length} avatars written to ${OUT_DIR}\n`);

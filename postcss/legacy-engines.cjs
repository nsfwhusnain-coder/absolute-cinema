/**
 * Fallbacks for browser engines older than the ones Tailwind 4 writes for.
 *
 * Smart-TV browsers are frozen at the Chromium their firmware shipped with: a
 * Hisense VIDAA 6 set runs Chromium 76, a 2022 LG runs 87. Tailwind's output
 * leans on features those engines never got, and a rule the engine cannot
 * parse is dropped whole, so the page arrived with no padding, no transforms
 * and no hover or focus states. This plugin adds, next to each such rule, a
 * version the old engines understand:
 *
 *   everywhere (an older declaration first, the modern one after it)
 *     - padding-inline, margin-block and friends   → physical longhands
 *     - min(), max(), clamp() as a whole value     → one plain length
 *     - dvh / svh / lvh                            → vh
 *
 *   only where the feature is missing (inside @supports not …)
 *     - translate, scale, rotate properties        → one composed transform
 *     - :is() and :where() in selectors            → the selectors written out
 *     - :focus-visible                             → :focus
 *     - aspect-ratio                               → a padding box
 *     - @property starting values                  → Tailwind's own fallback, opened to old Chromium
 *
 *   only where the modern form is understood (inside @supports …), with the plain form as the default
 *     - gradients interpolated "in oklab"          → the same gradient without the colour space
 *     - a theme colour at part opacity (color-mix) → rgba() over that colour's r, g, b
 *
 *   only where the page says so (html[data-flexgap="0"], set by a head script,
 *   since CSS cannot ask whether gap works in a flex container)
 *     - gap on flex containers                     → margins between children
 *
 * Modern engines skip every gated block, so nothing changes for them.
 */

const selectorParser = require("postcss-selector-parser");
const valueParser = require("postcss-value-parser");

/** True on engines without :is()/:where()/aspect-ratio (Chromium < 88): all three arrived together. */
const NO_SELECTOR_LISTS = "not (aspect-ratio: 1 / 1)";
/** True on engines without the individual transform properties (Chromium < 104). */
const NO_INDIVIDUAL_TRANSFORMS = "not (translate: 0)";
const NO_FLEX_GAP = 'html[data-flexgap="0"]';
/** A flex child that takes the gap margin: one pushed to the far side by an auto margin keeps its own. */
const PUSHED_APART = '*:not([class*="ml-auto"]):not([class*="mx-auto"])';
/** Tailwind sets its variables' starting values for engines without @property behind a test only Safari and Firefox pass. */
const PROPERTY_FALLBACK_TEST = /-webkit-hyphens.*-moz-orient/;

const LOGICAL_SHORTHANDS = {
  "padding-inline": ["padding-left", "padding-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  "margin-inline": ["margin-left", "margin-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
};

const VIEWPORT_UNIT = /\d(?:vw|vh|vmin|vmax|dvh|svh|lvh|dvw|svw|lvw|%)\b/;
const DYNAMIC_VIEWPORT_UNIT = /(\d)(?:d|s|l)(vh|vw)\b/g;
const MATH_FUNCTIONS = new Set(["min", "max", "clamp"]);
/** True on engines that can interpolate a gradient in a named colour space (Chromium 111, Safari 16.2). */
const GRADIENT_SPACES = "(background-image: linear-gradient(in lab, red, red))";
const GRADIENT_SPACE = /\s+in\s+[a-z0-9-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\s*$/;
/** Tailwind writes a colour at part opacity as this, behind @supports, after a fallback that is fully opaque. */
const MIXED_WITH_TRANSPARENT = /^color-mix\(in oklab,\s*var\((--[\w-]+)\)\s+([\d.]+)%,\s*transparent\)$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** How far :is()/:where() expansion may multiply one selector before it is left alone. */
const MAX_EXPANSIONS = 48;
/** The transform that stands in for translate/scale/rotate; unset parts fall back to no change. */
const COMPOSED_TRANSFORM =
  "translate(var(--tw-translate-x, 0), var(--tw-translate-y, 0)) rotate(var(--tw-legacy-rotate, 0deg)) scale(var(--tw-legacy-scale-x, 1), var(--tw-legacy-scale-y, 1))";
const TRANSFORM_RESET = "--tw-legacy-rotate: 0deg; --tw-legacy-scale-x: 1; --tw-legacy-scale-y: 1";

// ---------- declarations every engine gets ----------

/** Splits a value on top-level spaces: "1px calc(2px + 3px)" → two parts. */
function topLevelWords(value) {
  const parts = [];
  let current = "";
  for (const node of valueParser(value).nodes) {
    if (node.type === "space") {
      if (current) parts.push(current);
      current = "";
    } else {
      current += valueParser.stringify(node);
    }
  }
  if (current) parts.push(current);
  return parts;
}

function addPhysicalLonghands(decl) {
  const physical = LOGICAL_SHORTHANDS[decl.prop];
  if (!physical) return;
  const [start, end = start] = topLevelWords(decl.value);
  if (!start) return;
  decl.cloneBefore({ prop: physical[0], value: start });
  decl.cloneBefore({ prop: physical[1], value: end });
}

/** The arguments of a function node, as strings. */
function functionArguments(node) {
  const args = [];
  let current = "";
  for (const child of node.nodes) {
    if (child.type === "div" && child.value === ",") {
      args.push(current.trim());
      current = "";
    } else {
      current += valueParser.stringify(child);
    }
  }
  args.push(current.trim());
  return args;
}

/**
 * One plain length standing in for min()/max()/clamp(). A television is the
 * engine this is for, so the choice assumes a large screen: clamp() takes its
 * preferred value, min() its first fixed length (the viewport share is the
 * larger one there) and max() its first viewport share, for the same reason.
 * Safe-area env() values are zero on a television and are passed over.
 */
function mathFallback(value) {
  const parsed = valueParser(value);
  const nodes = parsed.nodes.filter((node) => node.type !== "space");
  if (nodes.length !== 1 || nodes[0].type !== "function" || !MATH_FUNCTIONS.has(nodes[0].value)) return null;
  const all = functionArguments(nodes[0]);
  if (all.some((arg) => /\b(?:min|max|clamp)\(/.test(arg))) return null;
  const plain = (arg) => (/[+\-*/]/.test(arg.replace(/^-/, "")) ? `calc(${arg})` : arg);
  if (nodes[0].value === "clamp") return all.length === 3 && !all[1].includes("env(") ? plain(all[1]) : null;
  const args = all.filter((arg) => !arg.includes("env("));
  if (args.length === 0) return null;
  const wantsViewport = nodes[0].value === "max";
  const preferred = args.find((arg) => VIEWPORT_UNIT.test(arg) === wantsViewport);
  return plain(preferred ?? args[0]);
}

function sameProperty(node, prop) {
  return Boolean(node) && node.type === "decl" && node.prop === prop;
}

function addValueFallbacks(decl) {
  if (decl.prop.startsWith("--") || sameProperty(decl.prev(), decl.prop)) return;
  const math = mathFallback(decl.value);
  if (math) {
    decl.cloneBefore({ value: math.replace(DYNAMIC_VIEWPORT_UNIT, "$1$2") });
    return;
  }
  if (DYNAMIC_VIEWPORT_UNIT.test(decl.value)) {
    DYNAMIC_VIEWPORT_UNIT.lastIndex = 0;
    decl.cloneBefore({ value: decl.value.replace(DYNAMIC_VIEWPORT_UNIT, "$1$2") });
  }
}

// ---------- selectors without :is() and :where() ----------

const isListPseudo = (node) => node.type === "pseudo" && (node.value === ":is" || node.value === ":where");
const hasCombinator = (selector) => selector.nodes.some((node) => node.type === "combinator");

/** The compound (run of simple selectors between combinators) that holds `index`. */
function compoundBounds(nodes, index) {
  let start = index;
  while (start > 0 && nodes[start - 1].type !== "combinator") start--;
  let end = index;
  while (end < nodes.length - 1 && nodes[end + 1].type !== "combinator") end++;
  return { start, end };
}

/** `option` merged into the compound in place of the pseudo: tags must lead a compound. */
function mergeCompound(nodes, index, option) {
  const { start } = compoundBounds(nodes, index);
  const inner = option.nodes.map((node) => node.clone());
  const leading = inner.length && (inner[0].type === "tag" || inner[0].type === "universal") ? inner.shift() : null;
  const out = nodes.map((node) => node.clone());
  out.splice(index, 1, ...inner);
  if (leading && leading.type === "tag") out.splice(start, 0, leading);
  return out;
}

/**
 * `X:is(A B *)` says X sits under `A B`, which is `A B X` written plainly.
 * Returns null when the option is some other shape of complex selector.
 */
function hoistAncestor(nodes, index, option) {
  const inner = option.nodes;
  const last = inner[inner.length - 1];
  const joiner = inner[inner.length - 2];
  if (!last || last.type !== "universal" || !joiner || joiner.type !== "combinator") return null;
  const out = nodes.map((node) => node.clone());
  out.splice(index, 1);
  const prefix = inner.slice(0, -1).map((node) => node.clone());
  return [...prefix, ...out];
}

/** Every plain selector `selector` stands for, or null when part of it cannot be written out. */
function expandSelector(selector) {
  let queue = [selector.nodes.map((node) => node.clone())];
  const finished = [];
  while (queue.length) {
    const nodes = queue.shift();
    const index = nodes.findIndex(isListPseudo);
    if (index < 0) {
      finished.push(nodes);
      continue;
    }
    const alone = nodes.length === 1;
    for (const option of nodes[index].nodes) {
      let next;
      if (!hasCombinator(option)) next = mergeCompound(nodes, index, option);
      else if (alone) next = option.nodes.map((node) => node.clone());
      else next = hoistAncestor(nodes, index, option);
      if (!next) return null;
      queue.push(next);
    }
    if (queue.length + finished.length > MAX_EXPANSIONS) return null;
  }
  return finished.map((nodes) => nodes.map(String).join("").replace(/\s+/g, " ").trim());
}

/** The rule's selector with lists written out and :focus-visible relaxed, or null when nothing changes. */
function legacySelector(selector) {
  if (!/:is\(|:where\(|:focus-visible/.test(selector)) return null;
  const expanded = [];
  let failed = false;
  selectorParser((root) => {
    root.each((entry) => {
      const plain = expandSelector(entry);
      if (!plain) failed = true;
      else expanded.push(...plain);
    });
  }).processSync(selector);
  if (failed || expanded.length === 0) return null;
  return [...new Set(expanded)].join(", ").replace(/:focus-visible/g, ":focus");
}

// ---------- transforms, aspect ratio, flex gap ----------

function percentToNumber(value) {
  const match = /^(-?\d*\.?\d+)%$/.exec(value.trim());
  return match ? String(Number(match[1]) / 100) : null;
}

/** Declarations that rebuild a rule's translate/scale/rotate as one transform, or null when it has none. */
function composedTransform(rule) {
  const decls = [];
  let needed = false;
  rule.each((node) => {
    if (node.type !== "decl") return;
    if (node.prop === "translate" || node.prop === "scale" || node.prop === "rotate") needed = true;
    if (node.prop === "rotate" && node.value !== "none") decls.push(`--tw-legacy-rotate: ${node.value}`);
    if (node.prop === "--tw-scale-x" || node.prop === "--tw-scale-y") {
      const number = percentToNumber(node.value);
      if (number) decls.push(`--tw-legacy-scale-${node.prop.slice(-1)}: ${number}`);
    }
  });
  if (!needed) return null;
  return [...decls, `transform: ${COMPOSED_TRANSFORM}`].join("; ");
}

/** "16 / 9", "1", "2/3" → height as a percentage of width. */
function heightPercent(value, variables) {
  const resolved = value.replace(/var\((--[\w-]+)\)/g, (_all, name) => variables.get(name) ?? "");
  const match = /^\s*(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+))?\s*$/.exec(resolved);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2] ?? 1);
  return width > 0 ? `${Number(((height / width) * 100).toFixed(4))}%` : null;
}

const prefixed = (selector, build) =>
  selector
    .split(/,(?![^(]*\))/)
    .map((part) => build(part.trim()))
    .join(", ");

/** Margins between flex children standing in for gap; `axis` is "", "x" or "y". */
function flexGapRules(selector, value, axis) {
  const rules = [];
  const row = (s) => `${NO_FLEX_GAP} ${s}:not(.grid):not(.inline-grid):not(.flex-col) > * + ${PUSHED_APART}, ${NO_FLEX_GAP} ${s}.flex-col[class*=":flex-row"] > * + ${PUSHED_APART}`;
  const column = (s) => `${NO_FLEX_GAP} ${s}.flex-col:not([class*=":flex-row"]) > * + *`;
  if (axis !== "y") {
    rules.push(`${prefixed(selector, row)} { margin-left: ${value} }`);
    // An icon beside a label: the label is a bare text node, which no selector
    // reaches. Half the gap on each side of the lone icon spaces the two apart
    // and leaves an icon-only button's icon where it was, in the middle.
    const loneIcon = (s) => `${NO_FLEX_GAP} ${s}:not(.grid):not(.inline-grid):not(.flex-col) > svg:only-child`;
    rules.push(`${prefixed(selector, loneIcon)} { margin-left: calc(${value} / 2); margin-right: calc(${value} / 2) }`);
  }
  if (axis !== "x") rules.push(`${prefixed(selector, column)} { margin-top: ${value} }`);
  return rules;
}

function gapAxis(prop) {
  if (prop === "gap") return "";
  if (prop === "column-gap") return "x";
  return prop === "row-gap" ? "y" : null;
}

// ---------- colours ----------

/** "#0a0a0f" → "10, 10, 15". */
function hexChannels(hex) {
  const digits = hex.length === 4 ? hex.slice(1).replace(/./g, "$&$&") : hex.slice(1);
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)).join(", ");
}

/** Every declaration that mixes a variable colour with transparent, with the variable and the opacity. */
function translucentColors(root) {
  const found = [];
  root.walkAtRules("supports", (supports) => {
    if (!supports.params.includes("color-mix")) return;
    supports.walkDecls((decl) => {
      const match = MIXED_WITH_TRANSPARENT.exec(decl.value.trim());
      if (match) found.push({ supports, decl, name: match[1], alpha: Number(match[2]) / 100 });
    });
  });
  return found;
}

/**
 * Old engines get Tailwind's fallback for `bg-background/55`, which is the
 * colour at full opacity: a scrim meant to tint a picture hides it instead.
 * Each theme colour written as hex gains an "r, g, b" twin beside it, and the
 * rule gains an rgba() over that twin, ahead of the color-mix() version.
 */
function addTranslucentFallbacks(root, parse) {
  const uses = translucentColors(root);
  const wanted = new Set(uses.map((use) => use.name));
  const available = new Set();
  root.walkDecls((decl) => {
    if (!wanted.has(decl.prop) || !HEX_COLOR.test(decl.value.trim())) return;
    decl.cloneAfter({ prop: `${decl.prop}-rgb`, value: hexChannels(decl.value.trim()) });
    available.add(decl.prop);
  });
  for (const { supports, decl, name, alpha } of uses) {
    if (!available.has(name) || decl.parent.type !== "rule") continue;
    supports.before(parse(`${decl.parent.selector} { ${decl.prop}: rgba(var(${name}-rgb), ${alpha}) }`).nodes);
  }
}

/** `to top in oklab` is no gradient at all before Chromium 111: plain by default, the colour space where it works. */
function addGradientFallbacks(root, parse) {
  root.walkDecls("--tw-gradient-position", (decl) => {
    const plain = decl.value.replace(GRADIENT_SPACE, "");
    if (plain === decl.value || !plain.trim() || decl.parent.type !== "rule" || insideSupports(decl.parent)) return;
    decl.parent.after(parse(`@supports ${GRADIENT_SPACES} { ${decl.parent.selector} { ${decl.prop}: ${decl.value} } }`).nodes);
    decl.value = plain;
  });
}

function insideSupports(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && parent.name === "supports") return true;
  }
  return false;
}

// ---------- the plugin ----------

function insideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && /keyframes$/.test(parent.name)) return true;
  }
  return false;
}

function themeVariables(root) {
  const variables = new Map();
  root.walkDecls(/^--aspect-/, (decl) => variables.set(decl.prop, decl.value));
  return variables;
}

/** Everything a rule needs added after it, as CSS text. */
function fallbacksFor(rule, variables) {
  const css = [];
  const plainSelector = legacySelector(rule.selector);
  if (plainSelector) {
    const body = rule.nodes.map(String).join("; ");
    css.push(`@supports ${NO_SELECTOR_LISTS} { ${plainSelector} { ${body} } }`);
  }
  const target = plainSelector ?? rule.selector;
  const transform = composedTransform(rule);
  if (transform) css.push(`@supports ${NO_INDIVIDUAL_TRANSFORMS} { ${target} { ${transform} } }`);
  rule.each((node) => {
    if (node.type !== "decl") return;
    if (node.prop === "aspect-ratio") {
      const percent = heightPercent(node.value, variables);
      const before = prefixed(target, (s) => `${s}::before`);
      const after = prefixed(target, (s) => `${s}::after`);
      if (percent) css.push(`@supports ${NO_SELECTOR_LISTS} { ${before} { content: ""; float: left; padding-top: ${percent} } ${after} { content: ""; display: table; clear: both } }`);
    }
    const axis = gapAxis(node.prop);
    if (axis !== null) css.push(...flexGapRules(target, node.value, axis));
  });
  return css;
}

/** Tailwind's layers, when this stylesheet has them: fallbacks for everything belong beneath the utilities. */
function hasLayer(root, name) {
  let found = false;
  root.walkAtRules("layer", (rule) => {
    if (rule.nodes && rule.params.trim() === name) found = true;
  });
  return found;
}

const plugin = () => ({
  postcssPlugin: "legacy-engines",
  Once(root, { parse }) {
    const variables = themeVariables(root);
    // Chromium before 85 has no @property either: let it take the same starting
    // values, or every border, ring, shadow and gradient built on them is void.
    root.walkAtRules("supports", (rule) => {
      if (PROPERTY_FALLBACK_TEST.test(rule.params)) rule.params = `${rule.params} or (${NO_SELECTOR_LISTS})`;
    });
    addGradientFallbacks(root, parse);
    addTranslucentFallbacks(root, parse);
    root.walkDecls((decl) => {
      addPhysicalLonghands(decl);
      addValueFallbacks(decl);
    });
    // Collected first: the fallbacks added below are rules too, and must not be given fallbacks of their own.
    const rules = [];
    root.walkRules((rule) => {
      if (!insideKeyframes(rule)) rules.push(rule);
    });
    let transforms = false;
    for (const rule of rules) {
      const css = fallbacksFor(rule, variables);
      if (css.some((text) => text.includes(NO_INDIVIDUAL_TRANSFORMS))) transforms = true;
      // Inserted in order straight after the rule, so each stays in its layer and media query.
      for (const text of css.reverse()) rule.after(parse(text).nodes);
    }
    if (!transforms) return;
    // Unregistered custom properties inherit: reset them on every element so a
    // parent's scale or rotation does not reach into its children. In the base
    // layer where there is one, or the reset would outrank the utilities it resets.
    const reset = `@supports ${NO_INDIVIDUAL_TRANSFORMS} { *, ::before, ::after { ${TRANSFORM_RESET} } }`;
    root.append(parse(hasLayer(root, "base") ? `@layer base { ${reset} }` : reset).nodes);
  },
});
plugin.postcss = true;

module.exports = plugin;
module.exports.legacySelector = legacySelector;
module.exports.mathFallback = mathFallback;
module.exports.heightPercent = heightPercent;

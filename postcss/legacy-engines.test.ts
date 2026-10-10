/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import postcss from "postcss";
import legacyEngines from "./legacy-engines.cjs";

const { legacySelector, mathFallback, heightPercent } = legacyEngines as unknown as {
  legacySelector(selector: string): string | null;
  mathFallback(value: string): string | null;
  heightPercent(value: string, variables: Map<string, string>): string | null;
};

/** Runs the plugin and squeezes whitespace so expectations read as CSS. */
async function run(css: string): Promise<string> {
  const result = await postcss([legacyEngines()]).process(css, { from: undefined });
  return result.css.replace(/\s+/g, " ").trim();
}

describe("selectors without :is() and :where()", () => {
  it("writes Tailwind's group, peer and dark variants out as plain descendants", () => {
    expect(legacySelector(".group-hover\\:opacity-100:is(:where(.group):hover *)")).toBe(".group:hover .group-hover\\:opacity-100");
    expect(legacySelector(".peer-checked\\:block:is(:where(.peer):checked ~ *)")).toBe(".peer:checked ~ .peer-checked\\:block");
    expect(legacySelector(".dark\\:bg-input:is(.dark *)")).toBe(".dark .dark\\:bg-input");
  });

  it("unwraps a selector that is one :where() and expands lists", () => {
    expect(legacySelector(":where(.space-y-4 > :not(:last-child))")).toBe(".space-y-4 > :not(:last-child)");
    expect(legacySelector('html[data-tv="1"] :where(button, a[href]):focus-visible')).toBe('html[data-tv="1"] button:focus, html[data-tv="1"] a[href]:focus');
    expect(legacySelector("abbr:where([title])")).toBe("abbr[title]");
  });

  it("puts a tag from inside the list at the front of its compound", () => {
    expect(legacySelector(".field:is(input, select)")).toBe("input.field, select.field");
  });

  it("relaxes :focus-visible to :focus, which every engine has", () => {
    expect(legacySelector(".focus-visible\\:ring-2:focus-visible")).toBe(".focus-visible\\:ring-2:focus");
  });

  it("leaves alone what it cannot write out, and what needs no change", () => {
    expect(legacySelector(".a:is(.b .c)")).toBeNull();
    expect(legacySelector(".plain > .selector")).toBeNull();
  });
});

describe("values old engines cannot compute", () => {
  it("picks a plain length for min(), max() and clamp()", () => {
    expect(mathFallback("clamp(680px, 92vh, 1040px)")).toBe("92vh");
    expect(mathFallback("min(92vw, 22rem)")).toBe("22rem");
    expect(mathFallback("min(70vh, 34rem, 100dvh - 8.5rem)")).toBe("34rem");
    expect(mathFallback("max(3vw, 1rem)")).toBe("3vw");
    expect(mathFallback("max(0.5rem, env(safe-area-inset-bottom))")).toBe("0.5rem");
    expect(mathFallback("1rem")).toBeNull();
    expect(mathFallback("max(18px, min(1vw, 40px))")).toBeNull();
  });

  it("turns an aspect ratio into a height as a share of the width", () => {
    expect(heightPercent("2/3", new Map())).toBe("150%");
    expect(heightPercent("var(--aspect-video)", new Map([["--aspect-video", "16 / 9"]]))).toBe("56.25%");
    expect(heightPercent("auto", new Map())).toBeNull();
  });
});

describe("the plugin", () => {
  it("adds physical longhands and plain lengths ahead of the modern declaration", async () => {
    expect(await run(".px-4 { padding-inline: calc(var(--spacing) * 4) }")).toBe(
      ".px-4 { padding-left: calc(var(--spacing) * 4); padding-right: calc(var(--spacing) * 4); padding-inline: calc(var(--spacing) * 4) }"
    );
    expect(await run(".h { height: 100dvh }")).toBe(".h { height: 100vh; height: 100dvh }");
    expect(await run(".w { width: min(92vw, 22rem) }")).toBe(".w { width: 22rem; width: min(92vw, 22rem) }");
  });

  it("does not add a fallback where the author already wrote one", async () => {
    expect(await run(".h { height: 100vh; height: 100dvh }")).toBe(".h { height: 100vh; height: 100dvh }");
  });

  it("rebuilds translate, scale and rotate as one transform for engines without them", async () => {
    const css = await run(".scale-105 { --tw-scale-x: 105%; --tw-scale-y: 105%; scale: var(--tw-scale-x) var(--tw-scale-y) } .rotate-45 { rotate: 45deg }");
    expect(css).toContain("@supports not (translate: 0) { .scale-105 { --tw-legacy-scale-x: 1.05; --tw-legacy-scale-y: 1.05; transform: translate(");
    expect(css).toContain("@supports not (translate: 0) { .rotate-45 { --tw-legacy-rotate: 45deg; transform:");
    expect(css).toContain("*, ::before, ::after { --tw-legacy-rotate: 0deg; --tw-legacy-scale-x: 1; --tw-legacy-scale-y: 1 }");
  });

  it("stands a padding box in for aspect-ratio", async () => {
    const css = await run(".poster { aspect-ratio: 2/3 }");
    expect(css).toContain('@supports not (aspect-ratio: 1 / 1) { .poster::before { content: ""; float: left; padding-top: 150% }');
  });

  it("spaces flex children with margins where the page reports gap does not work", async () => {
    const css = await run(".gap-4 { gap: 1rem }");
    expect(css).toContain('html[data-flexgap="0"] .gap-4:not(.grid):not(.inline-grid):not(.flex-col) > * + *:not([class*="ml-auto"]):not([class*="mx-auto"])');
    expect(css).toContain('html[data-flexgap="0"] .gap-4.flex-col:not([class*=":flex-row"]) > * + * { margin-top: 1rem }');
    expect(css).toContain("> svg:only-child { margin-left: calc(1rem / 2); margin-right: calc(1rem / 2) }");
  });

  it("opens Tailwind's @property fallback to Chromium that has no @property", async () => {
    const test = "(((-webkit-hyphens: none)) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color: rgb(from red r g b))))";
    const css = await run(`@supports ${test} { * { --tw-border-style: solid } } @supports (color: lab(0% 0 0)) { .a { color: red } }`);
    expect(css).toContain(`@supports ${test} or (not (aspect-ratio: 1 / 1)) { * { --tw-border-style: solid } }`);
    expect(css).toContain("@supports (color: lab(0% 0 0)) { .a { color: red } }");
  });

  it("keeps gradients working where they cannot be interpolated in a colour space", async () => {
    const css = await run(".bg-gradient-to-t { --tw-gradient-position: to top in oklab; background-image: linear-gradient(var(--tw-gradient-stops)) }");
    expect(css).toStartWith(".bg-gradient-to-t { --tw-gradient-position: to top; background-image: linear-gradient(var(--tw-gradient-stops)) }");
    expect(css).toContain("@supports (background-image: linear-gradient(in lab, red, red)) { .bg-gradient-to-t { --tw-gradient-position: to top in oklab } }");
  });

  it("gives a theme colour at part opacity an rgba() fallback instead of the opaque one", async () => {
    const css = await run(
      ".dark { --background: #0a0a0f; --border: rgba(255, 255, 255, 0.12) } " +
        ".scrim { background-color: var(--background) } " +
        "@supports (color: color-mix(in lab, red, red)) { .scrim { background-color: color-mix(in oklab, var(--background) 55%, transparent) } } " +
        "@supports (color: color-mix(in lab, red, red)) { .line { border-color: color-mix(in oklab, var(--border) 60%, transparent) } }"
    );
    expect(css).toContain(".dark { --background: #0a0a0f; --background-rgb: 10, 10, 15;");
    expect(css).toContain(".scrim { background-color: var(--background) } .scrim { background-color: rgba(var(--background-rgb), 0.55) } @supports (color: color-mix(in lab, red, red))");
    expect(css).not.toContain("--border-rgb");
  });

  it("gives its own fallbacks no fallbacks, and leaves keyframes alone", async () => {
    const css = await run(".a:is(.dark *) { gap: 1rem } @keyframes spin { to { rotate: 360deg } }");
    expect(css.match(/data-flexgap/g)?.length).toBe(4);
    expect(css).toContain("@keyframes spin { to { rotate: 360deg } }");
  });
});

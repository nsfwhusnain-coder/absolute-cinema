/**
 * Tailwind writes for current browsers; the two plugins after it keep the
 * result working on the engines smart TVs are stuck with (see
 * postcss/legacy-engines.cjs).
 *
 * `optimize` makes Tailwind hand over flat rules in development as well as in
 * production, so the fallback plugin sees the same stylesheet in both. The
 * cascade-layers plugin goes last: engines before Chromium 99 drop everything
 * inside @layer, so the layers are rewritten as plain rules that rank the
 * same way.
 */
import path from "node:path";

// By absolute path: the bundler loads plugins by name from its own output
// folder, where a path relative to this file means nothing.
const legacyEngines = path.join(process.cwd(), "postcss", "legacy-engines.cjs");

const config = {
  plugins: [
    ["@tailwindcss/postcss", { optimize: { minify: false } }],
    legacyEngines,
    "@csstools/postcss-cascade-layers",
  ],
};

export default config;

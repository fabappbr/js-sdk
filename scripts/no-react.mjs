/**
 * The boundary that makes this package publishable: it must not import React, and it must not reach for a
 * bundler-specific global.
 *
 * Both rules exist because they were once broken. The client and the React components lived in one 1,682-line file,
 * so "the pure part" was a claim nobody could check; and the configuration came from `import.meta.env.VITE_*`, which
 * simply does not exist in Node, in Next.js or in a test — the package would have installed cleanly and then read
 * `undefined` as its API base. A convention nobody enforces is a convention that drifts, so this runs in CI.
 *
 * JSX is caught by extension rather than by pattern: TypeScript only accepts JSX in a `.tsx` file, and a pattern
 * loose enough to spot a tag is also loose enough to flag every generic call in the package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  { pattern: /from\s+["']react(-dom|-router[\w-]*)?["']/, why: "imports React" },
  { pattern: /\bimport\.meta\.env\b/, why: "reads import.meta.env (a bundler global)" },
  { pattern: /\bprocess\.env\b/, why: "reads process.env (pass configuration to createClient instead)" },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const failures = [];
for (const file of walk("src")) {
  if (file.endsWith(".tsx")) {
    failures.push(`${file} is a .tsx file — this package holds no components`);
    continue;
  }
  if (!file.endsWith(".ts")) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(line)) failures.push(`${file}:${i + 1} ${why}\n    ${line.trim()}`);
    }
  });
}

if (failures.length) {
  console.error("@fabappai/sdk must stay framework-agnostic:\n\n" + failures.join("\n") + "\n");
  process.exit(1);
}
console.log("no-react: ok");

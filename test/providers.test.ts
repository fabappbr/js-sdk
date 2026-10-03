import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `IntegrationProvider` is the server's provider registry written as a union: it refuses `integrations.call('maps')`
 * at compile time instead of at the first click. A union is a copy, and a copy drifts — when the platform's source
 * sits next to this package (the monorepo checkout) the two are compared; a standalone checkout has nothing to
 * compare against and skips, it does not pretend.
 */
const REGISTRY = resolve(__dirname, "../../../api/control-plane/app/modules/integrations/registry.py");

describe("IntegrationProvider", () => {
  it.skipIf(!existsSync(REGISTRY))("names exactly the providers the platform registry has", () => {
    const py = readFileSync(REGISTRY, "utf8");
    const block = py.slice(py.indexOf("PROVIDERS: dict[str, dict] = {"), py.indexOf("\n}\n"));
    const server = new Set([...block.matchAll(/^    "([a-z_]+)": \{/gm)].map((m) => m[1]));
    const ts = readFileSync(resolve(__dirname, "../src/resources.ts"), "utf8");
    const m = ts.match(/export type IntegrationProvider =\s*([^;]+);/);
    expect(m).not.toBeNull();
    const union = new Set([...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
    expect([...union].sort()).toEqual([...server].sort());
  });
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for E1.
 *
 * expo-router registers EVERY module inside the route directory as a route.
 * A helper module (like the health client) placed there becomes a page and
 * breaks the build ("Minified React error #306" / blank page).
 *
 * The route directory must therefore contain route files ONLY.
 */
const CLIENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROUTE_DIR = path.join(CLIENT_ROOT, "app");

const ALLOWED_ROUTE_FILES = ["_layout.tsx", "about.tsx", "index.tsx", "status.tsx"];

describe("expo-router route directory", () => {
  it("contains only route files", () => {
    expect(fs.existsSync(ROUTE_DIR)).toBe(true);

    const entries = fs.readdirSync(ROUTE_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(files).toEqual(ALLOWED_ROUTE_FILES);
  });

  it("contains no helper module (*.ts) next to the routes", () => {
    const entries = fs.readdirSync(ROUTE_DIR, { withFileTypes: true });
    const helperModules = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);

    expect(helperModules).toEqual([]);
  });

  it("keeps the health helper outside the route directory", () => {
    const helper = path.join(CLIENT_ROOT, "src", "lib", "health.ts");

    expect(fs.existsSync(helper)).toBe(true);
    expect(fs.existsSync(path.join(ROUTE_DIR, "health.ts"))).toBe(false);
  });
});

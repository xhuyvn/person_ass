import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readVersion(modulePath: string): string | undefined {
  try {
    const pkg = require(modulePath) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Application version reported by /health/live.
 *
 * The ROOT package.json is the single source of truth for the release
 * version (the workspace packages keep their own placeholder versions). The
 * server package.json is only used as a fallback when the root file is not
 * reachable.
 */
export function appVersion(): string {
  return (
    readVersion("../../../package.json") ?? readVersion("../package.json") ?? "0.0.0"
  );
}

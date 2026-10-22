import { describe, expect, it } from "vitest";
import {
  assertServerModeRequirements,
  loadConfig,
  type Config,
} from "../src/config.js";
import { createLogger } from "../src/logger.js";

/**
 * Build a Config without depending on the shell environment.
 * The repository .env may define MASTER_KEY_FILE, so the key fields are
 * always reset explicitly.
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ ...process.env, APP_MODE: "local" });
  return {
    ...base,
    APP_MODE: "local",
    MASTER_KEY: undefined,
    MASTER_KEY_FILE: undefined,
    ...overrides,
  };
}

describe("assertServerModeRequirements", () => {
  it("throws in server mode when neither MASTER_KEY nor MASTER_KEY_FILE is set", () => {
    const config = makeConfig({ APP_MODE: "server" });

    expect(() => assertServerModeRequirements(config)).toThrow(/MASTER_KEY/);
  });

  it("does not throw in server mode when MASTER_KEY is set", () => {
    const config = makeConfig({
      APP_MODE: "server",
      MASTER_KEY: "a-very-secret-master-key",
    });

    expect(() => assertServerModeRequirements(config)).not.toThrow();
  });

  it("does not throw in server mode when MASTER_KEY_FILE is set", () => {
    const config = makeConfig({
      APP_MODE: "server",
      MASTER_KEY_FILE: "./.data/secrets/master.key",
    });

    expect(() => assertServerModeRequirements(config)).not.toThrow();
  });

  it("does not throw in local mode without any key", () => {
    const config = makeConfig({ APP_MODE: "local" });

    expect(() => assertServerModeRequirements(config)).not.toThrow();
  });

  it("never puts the key material into the error message", () => {
    const secret = "super-secret-master-key-value";
    const config = makeConfig({ APP_MODE: "server", MASTER_KEY: "  " });

    let message = "";
    try {
      assertServerModeRequirements(config);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("  ");
  });

  it("treats an empty MASTER_KEY as missing", () => {
    const config = makeConfig({ APP_MODE: "server", MASTER_KEY: "" });

    expect(() => assertServerModeRequirements(config)).toThrow(/MASTER_KEY/);
  });
});

describe("MASTER_KEY handling", () => {
  it("is accepted by the environment schema", () => {
    const config = loadConfig({
      ...process.env,
      APP_MODE: "server",
      MASTER_KEY: "another-secret",
    });

    expect(config.MASTER_KEY).toBe("another-secret");
    expect(config.APP_MODE).toBe("server");
  });

  it("is redacted by the logger", () => {
    const secret = "another-secret";
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ) => {
      chunks.push(chunk);
      return true;
    };

    try {
      createLogger("info").info("startup", {
        MASTER_KEY: secret,
        MASTER_KEY_FILE: "./.data/secrets/master.key",
      });
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write =
        originalWrite;
    }

    const output = chunks.join("");
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });
});

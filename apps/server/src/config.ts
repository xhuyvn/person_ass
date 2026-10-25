import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Environment contract (docs/06 §4). Placeholders only, no real secrets.
 */
export const envSchema = z.object({
  APP_MODE: z.enum(["local", "server"]).default("local"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(2310),
  DATA_DIR: z.string().min(1).default("./.data"),
  APP_ORIGIN: z.string().min(1).default("http://127.0.0.1:2311,http://localhost:2311"),
  /**
   * Optional operator extension of the Host allowlist (comma separated).
   * Entries are ADDED to the default loopback allowlist, never a wildcard.
   */
  ALLOWED_HOSTS: z.string().optional(),
  TZ: z.string().min(1).default("Asia/Ho_Chi_Minh"),
  /**
   * Master key material for server mode. Optional in the schema (local mode
   * does not need it) but MANDATORY in APP_MODE=server (docs/06 §4).
   * The value is never logged and never returned by an endpoint; the logger
   * redacts any field whose name matches /key|token|secret|password|authorization/i.
   */
  MASTER_KEY: z.string().optional(),
  MASTER_KEY_FILE: z.string().optional(),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(1).default(15),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  ENABLE_DEBUG_AI: z.enum(["true", "false"]).default("false"),
});

export type Env = z.infer<typeof envSchema>;

export type DataPaths = {
  dataDir: string;
  dbFile: string;
  attachmentsOriginal: string;
  attachmentsDerived: string;
  backups: string;
  logs: string;
  secrets: string;
};

export type Config = Env & {
  dataDir: string;
  appOrigins: string[];
  trustProxy: boolean;
  enableDebugAi: boolean;
  /** Exact Host header values accepted by the server (DNS-rebinding guard). */
  allowedHosts: string[];
};

/* ------------------------------------------------------------------ */
/* Host allowlist (docs/06 §1 — "Chặn DNS rebinding bằng allowed Host   */
/* chính xác"). The allowlist is exact-match, case-insensitive on the   */
/* host part, and never contains the wildcard "*".                      */
/* ------------------------------------------------------------------ */

/** Loopback names the local server answers to. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

export type ParsedHost = {
  /** Lower-cased host without brackets, e.g. "::1" for "[::1]". */
  host: string;
  /** Port as written, or null when the value carries no port. */
  port: string | null;
};

const PORT_PATTERN = /^\d{1,5}$/;

/**
 * Split a "host" / "host:port" value into its parts.
 * Returns null for malformed values (empty host, non-numeric port, ...).
 */
export function parseHostValue(value: string): ParsedHost | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) return null;
    const host = trimmed.slice(1, end);
    if (host.length === 0) return null;
    const rest = trimmed.slice(end + 1);
    if (rest.length === 0) return { host, port: null };
    if (!rest.startsWith(":")) return null;
    const port = rest.slice(1);
    if (!PORT_PATTERN.test(port)) return null;
    return { host, port };
  }

  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return { host: trimmed, port: null };
  if (firstColon !== trimmed.lastIndexOf(":")) {
    // Bare IPv6 literal (e.g. "::1"): no port can be told apart from the host.
    return { host: trimmed, port: null };
  }
  const host = trimmed.slice(0, firstColon);
  const port = trimmed.slice(firstColon + 1);
  if (host.length === 0 || !PORT_PATTERN.test(port)) return null;
  return { host, port };
}

/** True for bind addresses that accept any Host (never allowlisted). */
function isWildcardBind(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "*" || v === "0.0.0.0" || v === "::" || v === "[::]";
}

/**
 * Default allowlist: the loopback names this server answers to, each with
 * and without the configured PORT, plus the configured HOST when it is a
 * concrete (non-wildcard) address the server binds to.
 *
 * Example for PORT=2310:
 *   ["127.0.0.1:2310", "localhost:2310", "[::1]:2310", "127.0.0.1", "localhost", "[::1]"]
 */
export function buildDefaultAllowedHosts(host: string, port: number): string[] {
  const names = new Set<string>(LOOPBACK_HOSTS);
  const configured = host.trim();
  if (configured.length > 0 && !isWildcardBind(configured)) {
    names.add(configured);
  }
  const entries: string[] = [];
  for (const name of names) entries.push(`${name}:${port}`);
  for (const name of names) entries.push(name);
  return entries;
}

function configWarning(message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level: "warn",
    msg: message,
    ...fields,
  });
  process.stderr.write(line + "\n");
}

/**
 * Build the effective Host allowlist.
 * `ALLOWED_HOSTS` may only EXTEND the default list; a wildcard entry is
 * rejected so the guard can never be turned off.
 */
export function resolveAllowedHosts(env: {
  HOST: string;
  PORT: number;
  ALLOWED_HOSTS?: string | undefined;
}): string[] {
  const entries = buildDefaultAllowedHosts(env.HOST, env.PORT);
  const seen = new Set(entries.map((e) => e.toLowerCase()));

  const extra = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const value of extra) {
    if (value === "*") {
      configWarning("allowed_hosts_wildcard_rejected", { value });
      continue;
    }
    if (parseHostValue(value) === null) {
      configWarning("allowed_hosts_entry_invalid", { value });
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(value);
  }

  return entries;
}

/**
 * Exact-match check of an incoming Host header against the allowlist.
 *
 * - A missing Host header is accepted (HTTP/1.0 clients).
 * - The port of the incoming header is stripped before comparing against the
 *   port-less entries; the "host:port" form is compared against the entries
 *   that carry a port.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (hostHeader === undefined) return true;
  const parsed = parseHostValue(hostHeader);
  if (parsed === null) return false;

  for (const entry of allowedHosts) {
    const candidate = parseHostValue(entry);
    if (candidate === null) continue;
    if (candidate.host !== parsed.host) continue;
    if (candidate.port === null) return true;
    if (candidate.port === parsed.port) return true;
  }
  return false;
}

/**
 * Minimal .env reader. Existing process env always wins; malformed lines are ignored.
 * (Deliberately tiny: no dependency, no secret handling beyond plain key=value.)
 */
/**
 * Locate the repository root: the nearest ancestor directory whose
 * package.json declares `workspaces`. Used so DATA_DIR and .env resolve the
 * same way regardless of the directory the process was started from.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? process.cwd();
  const fsRoot = path.parse(dir).root;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          workspaces?: unknown;
        };
        if (parsed.workspaces) return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    if (dir === fsRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadDotEnv(file?: string): void {
  const target = file ?? path.join(findRepoRoot(), ".env");
  if (!fs.existsSync(target)) return;
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length === 0) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv();
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(findRepoRoot(), parsed.DATA_DIR);
  const appOrigins = parsed.APP_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return {
    ...parsed,
    dataDir,
    appOrigins: appOrigins.length > 0 ? appOrigins : ["http://127.0.0.1:2311"],
    trustProxy: parsed.TRUST_PROXY === "true",
    enableDebugAi: parsed.ENABLE_DEBUG_AI === "true",
    allowedHosts: resolveAllowedHosts(parsed),
  };
}

/**
 * Fail-closed guard for APP_MODE=server (docs/06 §4).
 *
 * "APP_MODE=server mà thiếu auth/master key phải fail startup, không tự hạ
 * bảo vệ." A server that is reachable from the network must never start
 * without a master key (either inline or in a key file).
 *
 * The function is pure: it never logs and never returns the key material.
 */
export function assertServerModeRequirements(config: Config): void {
  if (config.APP_MODE !== "server") return;

  const hasInlineKey =
    typeof config.MASTER_KEY === "string" && config.MASTER_KEY.trim().length > 0;
  const hasKeyFile =
    typeof config.MASTER_KEY_FILE === "string" &&
    config.MASTER_KEY_FILE.trim().length > 0;

  if (hasInlineKey || hasKeyFile) return;

  throw new Error(
    "APP_MODE=server requires a master key: set MASTER_KEY or MASTER_KEY_FILE (docs/06 §4). Refusing to start.",
  );
}

export function dataPaths(config: Config): DataPaths {
  const dataDir = config.dataDir;
  return {
    dataDir,
    dbFile: path.join(dataDir, "database", "personalass.sqlite"),
    attachmentsOriginal: path.join(dataDir, "attachments", "original"),
    attachmentsDerived: path.join(dataDir, "attachments", "derived"),
    backups: path.join(dataDir, "backups"),
    logs: path.join(dataDir, "logs"),
    secrets: path.join(dataDir, "secrets"),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  const dirs = [
    paths.dataDir,
    path.dirname(paths.dbFile),
    paths.attachmentsOriginal,
    paths.attachmentsDerived,
    paths.backups,
    paths.logs,
    paths.secrets,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

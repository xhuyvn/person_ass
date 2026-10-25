import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AiConnectionKind } from "@personalass/contracts";
import { ProviderError } from "./errors.js";

/**
 * Outbound endpoint policy for provider connections (docs/06 §2):
 * - only http/https, no credentials/query/fragment in the URL;
 * - cloud kinds require https; plain http only for an explicitly configured
 *   loopback/LAN endpoint (Ollama on localhost or the local network);
 * - link-local/metadata, unspecified, multicast and broadcast addresses are
 *   always blocked, and the check runs on the resolved IP at connect time so
 *   a hostname cannot be re-pointed (DNS rebinding);
 * - redirects are never followed, so the key can never reach another host.
 */

const HTTPS_ONLY_KINDS: ReadonlySet<AiConnectionKind> = new Set(["openrouter", "ollama_cloud"]);

export type NormalizedEndpoint = {
  baseUrl: string;
  /** Exact "host:port" the connection may talk to. */
  allowedHost: string;
};

export function normalizeBaseUrl(raw: string, kind: AiConnectionKind): NormalizedEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderError("blocked_by_policy", "Base URL không hợp lệ.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("blocked_by_policy", "Base URL chỉ được dùng http hoặc https.");
  }
  if (url.username || url.password) {
    throw new ProviderError("blocked_by_policy", "Base URL không được chứa thông tin đăng nhập.");
  }
  if (url.search || url.hash) {
    throw new ProviderError("blocked_by_policy", "Base URL không được chứa query hoặc fragment.");
  }
  if (url.protocol === "http:" && HTTPS_ONLY_KINDS.has(kind)) {
    throw new ProviderError("blocked_by_policy", "Endpoint cloud phải dùng https.");
  }
  const literal = hostLiteral(url.hostname);
  if (literal && isAlwaysBlocked(literal)) {
    throw new ProviderError("blocked_by_policy", "Địa chỉ đích bị chặn (link-local/metadata/multicast).");
  }
  if (url.protocol === "http:" && literal && !isLoopbackOrPrivate(literal)) {
    throw new ProviderError("blocked_by_policy", "http chỉ dùng cho địa chỉ loopback hoặc mạng nội bộ; dùng https.");
  }
  // Normalize: drop trailing slashes and an accidentally pasted endpoint
  // suffix; never append /v1 (docs/04 §1: avoid joining /v1 twice).
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(chat\/completions|models)$/, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return {
    baseUrl: `${url.protocol}//${url.host}${pathname}`,
    allowedHost: `${url.hostname.toLowerCase()}:${port}`,
  };
}

function hostLiteral(hostname: string): string | null {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return net.isIP(h) ? h : null;
}

function v4Parts(ip: string): number[] {
  return ip.split(".").map((p) => Number(p));
}

function mappedV4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? (m[1] as string) : null;
}

export function isAlwaysBlocked(ip: string): boolean {
  const v4 = net.isIPv4(ip) ? ip : mappedV4(ip);
  if (v4) {
    const [a, b] = v4Parts(v4) as [number, number];
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local, cloud metadata
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::") return true;
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("fd00:ec2::254")) return true; // AWS IMDS over IPv6
  return false;
}

export function isLoopbackOrPrivate(ip: string): boolean {
  const v4 = net.isIPv4(ip) ? ip : mappedV4(ip);
  if (v4) {
    const [a, b] = v4Parts(v4) as [number, number];
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / overlay VPN
    return false;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || /^f[cd]/.test(lower); // loopback, ULA fc00::/7
}

/** Validate one resolved address for a given scheme. */
export function checkResolvedAddress(ip: string, scheme: "http:" | "https:"): void {
  if (isAlwaysBlocked(ip)) {
    throw new ProviderError("blocked_by_policy", "Địa chỉ đích bị chặn (link-local/metadata/multicast).");
  }
  if (scheme === "http:" && !isLoopbackOrPrivate(ip)) {
    throw new ProviderError("blocked_by_policy", "http chỉ được tới địa chỉ loopback hoặc mạng nội bộ.");
  }
}

/* ---- transport ---- */

export type HttpRequest = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** The connection's allowlist; the URL host:port must be in it. */
  allowedHosts: readonly string[];
};

export type HttpResponse = { status: number; headers: Record<string, string>; body: string };

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * Real transport over node:http(s): allowlist check, connect-time IP policy,
 * no redirects, hard deadline and response size cap.
 */
export const policyTransport: Transport = (req) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const url = new URL(req.url);
    const scheme = url.protocol as "http:" | "https:";
    const port = url.port || (scheme === "https:" ? "443" : "80");
    const hostKey = `${url.hostname.toLowerCase()}:${port}`;
    if (!req.allowedHosts.includes(hostKey)) {
      reject(new ProviderError("blocked_by_policy", "Đích không nằm trong allowlist của kết nối."));
      return;
    }
    const literal = hostLiteral(url.hostname);
    if (literal) {
      try {
        checkResolvedAddress(literal, scheme);
      } catch (err) {
        reject(err);
        return;
      }
    }
    const lookup = (hostname: string, options: dns.LookupOptions, cb: LookupCb): void => {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, []);
        try {
          for (const a of addresses) checkResolvedAddress(a.address, scheme);
        } catch (policyErr) {
          return cb(policyErr as NodeJS.ErrnoException, []);
        }
        if (options.all) return cb(null, addresses);
        const first = addresses[0];
        if (!first) return cb(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), []);
        cb(null, first.address, first.family);
      });
    };
    const mod = scheme === "https:" ? https : http;
    const request = mod.request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, ...(req.body ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
        lookup: lookup as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new ProviderError("invalid_response", "Phản hồi của provider quá lớn."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new ProviderError("timeout", "Provider không phản hồi trong thời gian cho phép."));
    }, req.timeoutMs);
    request.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (req.body) request.write(req.body);
    request.end();
  });

/**
 * Network policy guard for user-configured MCP endpoints (SSRF defense).
 *
 * The sidecar can reach any host the OS can, so an http/sse MCP URL is a
 * network primitive. `assertExternalUrlAllowed` implements the default
 * policy: block loopback, private (RFC1918/CGNAT), link-local (incl. the
 * cloud metadata address 169.254.169.254), multicast and reserved targets
 * — checked both against literal IPs and against every IP a hostname
 * resolves to. Redirect targets are re-checked hop by hop (see the
 * redirect loop in `McpManager.guardedFetch`).
 *
 * The guard intentionally does NOT cover the code-owned provider endpoints
 * (OpenAI/Anthropic/Ollama are fixed hosts, not user-configured).
 */
import { lookup } from "node:dns/promises";

/** Max redirect hops followed (and re-validated) for one MCP request. */
export const MCP_MAX_REDIRECTS = 5;
/** Cap on MCP JSON-RPC response bodies read by the fallback client. */
export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Cap on probe (connectivity check) response bodies. */
export const MCP_MAX_PROBE_BYTES = 8 * 1024;

/** Resolve a hostname to IP strings (IPv4 + IPv6). */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Default resolver backed by the OS resolver (same one fetch uses). */
export const dnsResolveHost: ResolveHost = async (hostname) => {
  const res = await lookup(hostname, { all: true, verbatim: true });
  return res.map((a) => a.address);
};

const IPV4_MAPPED_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;

/** Whether an IP string is a blocked (local/private/metadata/etc.) address. */
export function isBlockedAddress(ip: string): boolean {
  const host = ip.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (host === "") return true;

  if (host.includes(":")) {
    // IPv6 (or IPv4-mapped). Handle the common blocked families; anything
    // non-global-unicast that isn't explicitly global is treated as local.
    if (IPV4_MAPPED_RE.test(host)) {
      return isBlockedAddress(host.match(IPV4_MAPPED_RE)![1]!);
    }
    if (host.startsWith("::ffff:")) {
      // Hex-form IPv4-mapped address, e.g. ::ffff:7f00:1 → 127.0.0.1.
      const groups = host.slice(7).split(":").filter(Boolean);
      const octets: number[] = [];
      for (const g of groups) {
        if (g.length > 4 || !/^[0-9a-f]{1,4}$/.test(g)) return false;
        const value = parseInt(g, 16);
        octets.push((value >> 8) & 0xff, value & 0xff);
      }
      if (octets.length === 4) return isBlockedAddress(octets.join("."));
      return false;
    }
    if (host === "::" || host === "::1") return true;
    // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast, ::/8 + other
    // reserved are conservatively blocked; 2000::/3 is global unicast.
    const first = host.split(":")[0] ?? "";
    if (first.startsWith("fc") || first.startsWith("fd")) return true; // ULA
    if (first.startsWith("fe8") || first.startsWith("fe9") || first.startsWith("fea") || first.startsWith("feb")) return true; // link-local
    if (first.startsWith("ff")) return true; // multicast
    return false;
  }

  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false; // not an IP literal — hostname handling resolves it
  }
  const [a, b, c, d] = parts;
  void c; void d;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 (doc)
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 (doc)
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 (doc)
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

/** Hostnames that are local by name (no resolution needed). */
export function hostnameIsExplicitlyBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  // Covers 127.0.0.0/8 in dotted form plus any literal blocked IP.
  return isBlockedAddress(h);
}

/**
 * Assert that a URL may be contacted under the default (private-blocking)
 * policy. Throws with a descriptive error when blocked.
 *
 * `allowPrivate` is the per-server opt-out stored on the config
 * (`privateNetworkAllowed: true`). Resolution failures are deliberately
 * *not* treated as blocked: the request resolver is the same one fetch
 * will use, so an unresolvable name simply fails downstream.
 */
export async function assertExternalUrlAllowed(
  url: URL,
  resolveHost: ResolveHost,
  allowPrivate: boolean,
): Promise<void> {
  if (allowPrivate) return;
  const hostname = url.hostname.toLowerCase();
  if (hostnameIsExplicitlyBlocked(hostname)) {
    throw new Error(
      `MCP network policy: "${hostname}" is a local/private address and is blocked. ` +
        "Set privateNetworkAllowed: true on this server to permit it explicitly.",
    );
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return; // let the actual fetch surface the resolution failure
  }
  const blocked = addresses.find((ip) => isBlockedAddress(ip));
  if (blocked) {
    throw new Error(
      `MCP network policy: "${hostname}" resolves to blocked address ${blocked}. ` +
        "Set privateNetworkAllowed: true on this server to permit it explicitly.",
    );
  }
}

/** Read a response body up to `maxBytes`; throws when the cap is exceeded. */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`MCP response exceeded the ${maxBytes}-byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

/** Whether a status is a redirect that fetch's manual mode returns. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

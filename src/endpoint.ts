import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { invariant } from "./errors.js";
import type { Mode } from "./types.js";

const PRIVATE_V4 = [
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
  /^192\.168\./u,
  /^0\./u
];

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(address) === 4) return PRIVATE_V4.some((pattern) => pattern.test(address));
  if (isIP(address) === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

export async function approveEndpoint(raw: string, mode: Mode): Promise<URL> {
  invariant(raw.length <= 2048, "endpoint-too-long", "Endpoint exceeds 2,048 characters");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Endpoint must be an absolute URL");
  }
  invariant(endpoint.username === "" && endpoint.password === "", "credential-url-denied", "Credentials in endpoint URLs are forbidden");
  invariant(endpoint.hash === "" && endpoint.search === "", "endpoint-components-denied", "Endpoint query and fragment are forbidden");
  invariant(endpoint.pathname === "/mcp", "wrong-workshop-path", "Workshop endpoint must end exactly in /mcp");
  invariant(!["localhost"].includes(endpoint.hostname.toLowerCase()) || mode === "docker-local", "private-remote-denied", "Remote targets must be public");

  const addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
  invariant(addresses.length > 0, "dns-empty", "Endpoint hostname did not resolve");
  if (mode === "docker-local") {
    invariant(endpoint.protocol === "http:" || endpoint.protocol === "https:", "scheme-denied", "Unsupported local endpoint scheme");
    invariant(addresses.every(({ address }) => isPrivateAddress(address)), "local-target-public", "Docker-local endpoint must resolve privately");
  } else {
    invariant(endpoint.protocol === "https:", "remote-tls-required", "Remote Workshop requires HTTPS");
    invariant(addresses.every(({ address }) => !isPrivateAddress(address)), "private-remote-denied", "Remote Workshop cannot resolve privately");
  }
  return endpoint;
}

export async function assertDnsStable(endpoint: URL, original: readonly string[]): Promise<void> {
  const current = (await lookup(endpoint.hostname, { all: true, verbatim: true }))
    .map(({ address }) => address)
    .sort();
  invariant(
    JSON.stringify(current) === JSON.stringify([...original].sort()),
    "dns-rebinding",
    "Endpoint DNS changed during verification"
  );
}

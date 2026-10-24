export interface HelperServerConfig {
  host: string;
  port: number;
  token: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const MIN_TOKEN_LENGTH = 24;

export function validateHelperServerConfig(
  config: HelperServerConfig,
): HelperServerConfig {
  const host = config.host.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Claudero helper only accepts loopback hosts (127.0.0.1 or ::1), received ${config.host || "<empty>"}`,
    );
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error(`Invalid Claudero helper port: ${String(config.port)}`);
  }
  const token = config.token.trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `Claudero helper token must contain at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return { host, port: config.port, token };
}

export function hasValidBearerAuthorization(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization || !expectedToken) return false;
  const expected = `Bearer ${expectedToken}`;
  let difference = authorization.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |=
      expected.charCodeAt(index) ^
      (index < authorization.length ? authorization.charCodeAt(index) : 0);
  }
  return difference === 0;
}

function isLocalAuthority(authority: string, port: number): boolean {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(
    authority,
  );
  return !!match && Number(match[1] || 80) === port;
}

/** Apply after authentication, including to health, diagnostics, and shutdown. */
export function helperRequestRefusal(
  headers: { host?: string; origin?: string },
  port: number,
): string | null {
  if (!headers.host || !isLocalAuthority(headers.host, port)) {
    return "Helper requests must name its loopback address and port.";
  }
  const origin = headers.origin;
  // Privileged Gecko fetches may have an opaque origin. They still need the
  // private bearer token; no origin receives CORS access to the helper.
  if (!origin || origin === "null" || origin === "chrome://zotero") return null;
  if (!origin.startsWith("http://")) {
    return "Helper requests from web pages are not allowed.";
  }
  return isLocalAuthority(origin.slice("http://".length), port)
    ? null
    : "Helper requests from web pages are not allowed.";
}

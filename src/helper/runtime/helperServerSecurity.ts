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

export const ZOTERO_ENDPOINT_TOKEN_FIELD = "_clauderoToken";

type JsonRecord = Record<string, unknown>;

export function buildAuthenticatedZoteroPayload(
  action: string,
  args: JsonRecord,
  token: string,
): JsonRecord {
  return {
    ...args,
    action,
    [ZOTERO_ENDPOINT_TOKEN_FIELD]: token,
  };
}

export function hasValidZoteroEndpointToken(
  payload: unknown,
  expectedToken: string,
): boolean {
  if (!expectedToken || !payload || typeof payload !== "object") return false;
  const supplied = (payload as JsonRecord)[ZOTERO_ENDPOINT_TOKEN_FIELD];
  if (typeof supplied !== "string") return false;

  // The token has a fixed length. Still compare every expected character so a
  // mismatch does not disclose how much of the capability token was correct.
  let difference = supplied.length ^ expectedToken.length;
  for (let index = 0; index < expectedToken.length; index++) {
    difference |=
      expectedToken.charCodeAt(index) ^
      (index < supplied.length ? supplied.charCodeAt(index) : 0);
  }
  return difference === 0;
}

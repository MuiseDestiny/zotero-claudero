import { assert } from "chai";
import { getOrCreateHelperToken } from "../src/modules/helperToken";
import {
  buildAuthenticatedZoteroPayload,
  hasValidZoteroEndpointToken,
  ZOTERO_ENDPOINT_TOKEN_FIELD,
} from "../src/shared/zoteroEndpointAuth";

interface EndpointResponse {
  status: number;
  type: string;
  body: Record<string, unknown>;
}

function callRegisteredEndpoint(
  payload: Record<string, unknown>,
): Promise<EndpointResponse> {
  const endpoint = (Zotero as any).Server?.Endpoints?.["/claudero"];
  assert.isFunction(endpoint);
  assert.isFunction(endpoint.prototype?.init);
  return new Promise((resolve) => {
    endpoint.prototype.init.call(
      {},
      payload,
      (status: number, type: string, body: string) => {
        resolve({
          status,
          type,
          body: JSON.parse(body) as Record<string, unknown>,
        });
      },
    );
  });
}

describe("Zotero endpoint capability authentication", function () {
  it("builds an authenticated payload that callers cannot override", function () {
    const payload = buildAuthenticatedZoteroPayload(
      "get_item",
      { action: "set_field", [ZOTERO_ENDPOINT_TOKEN_FIELD]: "attacker" },
      "capability",
    );
    assert.equal(payload.action, "get_item");
    assert.equal(payload[ZOTERO_ENDPOINT_TOKEN_FIELD], "capability");
    assert.isTrue(hasValidZoteroEndpointToken(payload, "capability"));
    assert.isFalse(hasValidZoteroEndpointToken(payload, "capabilitz"));
  });

  it("rejects missing and incorrect tokens before dispatch", async function () {
    const missing = await callRegisteredEndpoint({ action: "list_history" });
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, {
      success: false,
      error: "unauthorized",
    });

    const incorrect = await callRegisteredEndpoint({
      action: "list_history",
      [ZOTERO_ENDPOINT_TOKEN_FIELD]: "0".repeat(64),
    });
    assert.equal(incorrect.status, 401);
  });

  it("accepts the helper capability token for a read action", async function () {
    const token = await getOrCreateHelperToken();
    const response = await callRegisteredEndpoint(
      buildAuthenticatedZoteroPayload("list_history", {}, token),
    );
    assert.equal(response.status, 200);
    assert.equal(response.type, "application/json");
    assert.equal(response.body.success, true);
  });

  it("does not mutate Zotero data when an unauthorized write is requested", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Claudero endpoint auth original title");
    const itemId = await item.saveTx();
    try {
      const response = await callRegisteredEndpoint({
        action: "set_field",
        itemId,
        field: "title",
        value: "unauthorized replacement",
      });
      assert.equal(response.status, 401);
      assert.equal(
        Zotero.Items.get(itemId as number).getField("title"),
        "Claudero endpoint auth original title",
      );
    } finally {
      await item.eraseTx();
    }
  });
});

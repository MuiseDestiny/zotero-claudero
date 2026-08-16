import { assert } from "chai";
import {
  decodeEvidencePayload,
  decodeEvidenceReference,
  evidenceReferencesFromToolResultContent,
  evidenceReferencesForText,
  encodeEvidenceMarker,
  encodeEvidencePayload,
  encodeEvidenceReference,
  hydrateEvidenceMarkers,
  restoreEvidenceReferences,
  sanitizeEvidencePresentation,
} from "../src/shared/evidenceLinkCodec";
import {
  evidencePackForAgent,
  locatedQuoteForAgent,
  numberedEvidencePackForAgent,
} from "../src/shared/evidenceTransport";
import { shouldReplayConversationHistory } from "../src/shared/promptHistory";

describe("Codex latency payload", function () {
  const locator = {
    attachmentId: 13688,
    pageIndex: 18,
    pageNumber: 19,
    paragraphIndex: 39,
    excerpt:
      "国外对个人信息保护有大量立法实践，欧盟通过《一般数据保护条例》，并增加删除权、被遗忘权及数据可携带权。".repeat(
        4,
      ),
    position: {
      pageIndex: 18,
      rects: Array.from({ length: 12 }, (_, index) => [
        80,
        700 - index * 24,
        510,
        716 - index * 24,
      ]),
    },
  };
  const legacyPayload = encodeURIComponent(JSON.stringify(locator));
  const encodedPayload = encodeEvidencePayload(locator);
  const href = `claudero-evidence:${encodedPayload}`;
  const paragraph = {
    id: "para-40",
    text: locator.excerpt,
    locator: { ...locator, evidenceUri: href },
    markdownLink: `[para-40](${href})`,
    score: 1,
    matchReason: "exact normalized quote match",
  };

  it("round-trips compact links and remains backward compatible", function () {
    assert.deepEqual(decodeEvidencePayload(encodedPayload), locator);
    assert.deepEqual(decodeEvidencePayload(legacyPayload), locator);
    assert.isBelow(encodedPayload.length, legacyPayload.length * 0.65);
  });

  it("uses short live references with a restart-safe location fallback", function () {
    const reference = encodeEvidenceReference(locator);
    assert.match(reference, /^ref\./);
    assert.isBelow(reference.length, 50);
    assert.deepEqual(decodeEvidenceReference(reference), locator);

    const missingRegistryReference = `${reference.slice(0, reference.lastIndexOf(".") + 1)}missing`;
    assert.deepInclude(decodeEvidenceReference(missingRegistryReference), {
      attachmentId: 13688,
      pageIndex: 18,
      pageNumber: 19,
      paragraphIndex: 39,
    });

    const saved = evidenceReferencesForText(
      `[para-40](claudero-evidence:${reference})`,
    );
    assert.hasAllKeys(saved || {}, [reference]);
    restoreEvidenceReferences(saved);
    assert.deepEqual(decodeEvidenceReference(reference), locator);
  });

  it("lets the model emit only a marker and hydrates it locally", function () {
    const marker = encodeEvidenceMarker(locator);
    assert.match(marker, /^\[E[A-Za-z0-9]+\]$/);
    assert.notInclude(marker, "claudero-evidence:");
    const hydrated = hydrateEvidenceMarkers(`支持的句子${marker}。`);
    assert.include(hydrated, `${marker}(claudero-evidence:ref.`);
    assert.isBelow(marker.length, 20);
  });

  it("restores academic-trace markers from persisted tool results", function () {
    const marker = encodeEvidenceMarker(locator);
    const toolResult = JSON.stringify({
      success: true,
      result: {
        evidence: [{ evidenceId: "para-40", locator }],
        markdown: `| Claim | Support |\n| --- | --- |\n| claim | para-40 ${marker} |`,
      },
    });
    const references = evidenceReferencesFromToolResultContent(toolResult);
    assert.deepEqual(references?.[marker.slice(1, -1)], locator);
    restoreEvidenceReferences(references);
    assert.include(
      hydrateEvidenceMarkers(`claim${marker}.`),
      `${marker}(claudero-evidence:ref.`,
    );
  });

  it("hides internal paragraph ids without changing code", function () {
    assert.equal(
      sanitizeEvidencePresentation(
        "作者支持该观点。来源段落 para-2 [Eabc]。 `para-2`",
      ),
      "作者支持该观点。 [Eabc]。 `para-2`",
    );
  });

  it("removes duplicate locators from ranked and quote MCP results", function () {
    const rawPack = {
      item: { id: 443, title: "Data rights" },
      attachment: { id: 13688, key: "KEY", title: "PDF", path: "/tmp/a.pdf" },
      query: "一般数据保护条例",
      paragraphs: Array.from({ length: 5 }, () => paragraph),
      annotations: [],
      figuresTables: [],
      warnings: [],
      citationGuidance: [],
    };
    const compactPack = evidencePackForAgent(rawPack);
    const rawQuote = {
      quote: "一般数据保护条例",
      matches: rawPack.paragraphs,
      warnings: [],
    };
    const compactQuote = locatedQuoteForAgent(rawQuote);

    assert.notInclude(JSON.stringify(compactPack), '"locator"');
    assert.notInclude(JSON.stringify(compactQuote), '"locator"');
    assert.isBelow(
      JSON.stringify(compactQuote).length,
      JSON.stringify(rawQuote).length * 0.55,
    );
  });

  it("does not duplicate numbered sources already present in contextText", function () {
    const raw = {
      mode: "full",
      contextText: `${paragraph.markdownLink}\n${paragraph.text}`,
      sources: [
        {
          sourceId: "P0001",
          text: paragraph.text,
          locator: paragraph.locator,
          citationMarkdown: paragraph.markdownLink,
        },
      ],
      warnings: [],
      citationGuidance: [],
    };
    const compact = numberedEvidencePackForAgent(raw) as Record<
      string,
      unknown
    >;
    assert.notProperty(compact, "sources");
    assert.equal(compact.sourceCount, 1);
  });

  it("replays history only when no provider session can resume it", function () {
    assert.isFalse(
      shouldReplayConversationHistory("codex", {
        codex: { threadId: "thread-1" },
      }),
    );
    assert.isFalse(
      shouldReplayConversationHistory("claude", {
        claude: { sessionId: "session-1" },
      }),
    );
    assert.isTrue(shouldReplayConversationHistory("codex", undefined));
  });
});

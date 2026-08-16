import { assert } from "chai";
import {
  claudePackageEntrypointCandidates,
  windowsClaudeCandidates,
  windowsClaudeNativeCandidates,
  windowsClaudePackageRoots,
} from "../src/shared/windowsExecutablePaths";

describe("Windows executable discovery", function () {
  it("includes the Claude native installer location", function () {
    const candidates = windowsClaudeNativeCandidates("C:\\Users\\reader");

    assert.include(candidates, "C:\\Users\\reader\\.local\\bin\\claude.exe");
  });

  it("uses Windows environment directories when provided", function () {
    const candidates = windowsClaudeNativeCandidates("C:\\Users\\reader", {
      localAppData: "D:\\Profiles\\reader\\Local",
      programFiles: "D:\\Apps",
      programFilesX86: "D:\\Apps32",
    });

    assert.include(
      candidates,
      "D:\\Profiles\\reader\\Local\\Programs\\Claude\\claude.exe",
    );
    assert.include(candidates, "D:\\Apps\\Claude\\claude.exe");
  });

  it("finds npm Claude Code entrypoints from PATH and APPDATA", function () {
    const roots = windowsClaudePackageRoots(
      "C:\\Users\\reader",
      { appData: "D:\\Roaming" },
      ["E:\\npm-bin"],
    );
    const entrypoints = claudePackageEntrypointCandidates(roots);

    assert.include(
      entrypoints,
      "E:\\npm-bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    );
    assert.include(
      entrypoints,
      "D:\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs",
    );
  });

  it("deduplicates Windows paths case-insensitively", function () {
    const candidates = windowsClaudeCandidates(
      "C:\\Users\\reader",
      { appData: "C:\\Users\\reader\\AppData\\Roaming" },
      [
        "C:\\Users\\reader\\AppData\\Roaming\\npm",
        "c:\\users\\reader\\appdata\\roaming\\NPM",
      ],
    );
    const lowered = candidates.map((candidate) => candidate.toLowerCase());

    assert.equal(new Set(lowered).size, lowered.length);
  });
});

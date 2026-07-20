import { describe, test, expect } from "vitest";
import {
  buildCompactPrompt,
  COMPACT_SUMMARY_TEMPLATE,
  CONSOLIDATION_MERGE_SYSTEM,
  CONSOLIDATION_SYSTEM,
  consolidationUser,
  CURATOR_SYSTEM,
  recursiveUser,
  formatDistillations,
} from "../src/prompt";

// All required section headings emitted by COMPACT_SUMMARY_TEMPLATE. Pinning
// this list keeps Lore's /compact output aligned with the upstream OpenCode
// SUMMARY_TEMPLATE (see packages/core/src/prompt.ts commentary).
const REQUIRED_SECTIONS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
  "## Relevant Files",
];

describe("COMPACT_SUMMARY_TEMPLATE", () => {
  test("contains every required section heading", () => {
    for (const heading of REQUIRED_SECTIONS) {
      expect(COMPACT_SUMMARY_TEMPLATE).toContain(heading);
    }
  });

  test("does NOT include 'I'm ready to continue.' (prevents model echoing)", () => {
    expect(COMPACT_SUMMARY_TEMPLATE).not.toContain("I'm ready to continue.");
  });

  test("sections appear in the upstream-canonical order", () => {
    const positions = REQUIRED_SECTIONS.map((s) =>
      COMPACT_SUMMARY_TEMPLATE.indexOf(s),
    );
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]).toBeLessThan(positions[i + 1]);
    }
  });
});

describe("buildCompactPrompt", () => {
  test("no distillations, no knowledge — emits template only", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      knowledge: "",
    });
    // Template body present.
    for (const heading of REQUIRED_SECTIONS) {
      expect(prompt).toContain(heading);
    }
    // Distillation-reminder sentence absent when no distillations provided.
    expect(prompt).not.toContain("Lore has pre-computed chunked summaries");
    // No knowledge block.
    expect(prompt).not.toContain("## Long-term Knowledge");
  });

  test("with distillations — injects the pre-computed summaries reminder", () => {
    const prompt = buildCompactPrompt({ hasDistillations: true });
    expect(prompt).toContain("Lore has pre-computed chunked summaries");
  });

  test("with knowledge block — appends knowledge after template", () => {
    const knowledge = "## Long-term Knowledge\n### Pattern\n- **X**: Y";
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      knowledge,
    });
    expect(prompt).toContain(knowledge);
  });

  test("undefined knowledge is treated the same as empty string", () => {
    const a = buildCompactPrompt({
      hasDistillations: false,
      knowledge: undefined,
    });
    const b = buildCompactPrompt({ hasDistillations: false, knowledge: "" });
    expect(a).toBe(b);
    expect(a).not.toContain("## Long-term Knowledge");
  });

  test("block ordering: distill-reminder → template → knowledge", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: true,
      knowledge: "## Long-term Knowledge\n### Pattern\n- **X**: Y",
    });
    const reminderIdx = prompt.indexOf("Lore has pre-computed");
    const templateIdx = prompt.indexOf("## Goal");
    const knowledgeIdx = prompt.indexOf("## Long-term Knowledge");

    expect(reminderIdx).toBeGreaterThan(-1);
    expect(templateIdx).toBeGreaterThan(reminderIdx);
    expect(knowledgeIdx).toBeGreaterThan(templateIdx);
  });

  // F1b: anchor parameter
  test("emits a <previous-summary> block when previousSummary is provided", () => {
    const priorSummary =
      "## Goal\n- Refactor auth module\n## Progress\n### Done\n- Wrote tests";
    const prompt = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: priorSummary,
    });
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain(priorSummary);
    expect(prompt).toContain("</previous-summary>");
    // Update-in-place instruction.
    expect(prompt).toContain("Update it using the conversation history above");
  });

  test("no anchor block when previousSummary is undefined (byte-identical to pre-F1b)", () => {
    const withParam = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: undefined,
    });
    const withoutParam = buildCompactPrompt({
      hasDistillations: false,
    });
    expect(withParam).toBe(withoutParam);
    expect(withParam).not.toContain("<previous-summary>");
    expect(withParam).not.toContain("Update it using the conversation history");
  });

  test("empty-string previousSummary is treated as absent", () => {
    const withEmpty = buildCompactPrompt({
      hasDistillations: false,
      previousSummary: "",
    });
    const withoutParam = buildCompactPrompt({
      hasDistillations: false,
    });
    expect(withEmpty).toBe(withoutParam);
    expect(withEmpty).not.toContain("<previous-summary>");
  });

  test("anchor block placement: distill-reminder → anchor → template → knowledge", () => {
    const prompt = buildCompactPrompt({
      hasDistillations: true,
      knowledge: "## Long-term Knowledge\n### Pattern\n- **X**: Y",
      previousSummary: "PRIOR_SUMMARY_TOKEN",
    });
    const reminderIdx = prompt.indexOf("Lore has pre-computed");
    const anchorIdx = prompt.indexOf("<previous-summary>");
    const summaryBodyIdx = prompt.indexOf("PRIOR_SUMMARY_TOKEN");
    const templateIdx = prompt.indexOf("## Goal");
    const knowledgeIdx = prompt.indexOf("## Long-term Knowledge");

    expect(reminderIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeGreaterThan(reminderIdx);
    expect(summaryBodyIdx).toBeGreaterThan(anchorIdx);
    expect(templateIdx).toBeGreaterThan(anchorIdx);
    expect(knowledgeIdx).toBeGreaterThan(templateIdx);
  });
});

// ─── F2: recursiveUser anchor parameter ──────────────────────────────

describe("recursiveUser", () => {
  const segments = [{ observations: "obs A" }, { observations: "obs B" }];

  test("no anchor: emits plain consolidation prompt", () => {
    const out = recursiveUser(segments);
    expect(out).toContain("Observation segments to consolidate");
    expect(out).toContain("Segment 1:\nobs A");
    expect(out).toContain("Segment 2:\nobs B");
    expect(out).not.toContain("<previous-meta-summary>");
  });

  test("undefined previousMeta is byte-identical to no parameter", () => {
    const withParam = recursiveUser(segments, undefined);
    const withoutParam = recursiveUser(segments);
    expect(withParam).toBe(withoutParam);
  });

  test("empty-string previousMeta is treated as absent (falsy check)", () => {
    const withEmpty = recursiveUser(segments, "");
    const withoutParam = recursiveUser(segments);
    expect(withEmpty).toBe(withoutParam);
    expect(withEmpty).not.toContain("<previous-meta-summary>");
  });

  test("with anchor: emits <previous-meta-summary> block + new-segments header", () => {
    const priorMeta =
      "### Current State\n- working on auth module\n### Key Decisions\n- chose OAuth2";
    const out = recursiveUser(segments, priorMeta);
    expect(out).toContain("<previous-meta-summary>");
    expect(out).toContain(priorMeta);
    expect(out).toContain("</previous-meta-summary>");
    // Update-in-place instruction.
    expect(out).toContain("Update the anchored meta-summary below");
    expect(out).toContain("Preserve still-true details");
    // New segments still present.
    expect(out).toContain("New observation segments to merge");
    expect(out).toContain("Segment 1:\nobs A");
    expect(out).toContain("Segment 2:\nobs B");
  });

  test("anchor block placement: instruction → anchor → new segments", () => {
    const priorMeta = "PRIOR_META_TOKEN";
    const out = recursiveUser(segments, priorMeta);
    const instructionIdx = out.indexOf("Update the anchored meta-summary");
    const anchorOpenIdx = out.indexOf("<previous-meta-summary>");
    const anchorBodyIdx = out.indexOf(priorMeta);
    const segmentsHeaderIdx = out.indexOf("New observation segments");

    expect(instructionIdx).toBeGreaterThan(-1);
    expect(anchorOpenIdx).toBeGreaterThan(instructionIdx);
    expect(anchorBodyIdx).toBeGreaterThan(anchorOpenIdx);
    expect(segmentsHeaderIdx).toBeGreaterThan(anchorBodyIdx);
  });

  test("with anchor + 0 segments: still emits anchor block (caller's threshold gate)", () => {
    // metaDistill rejects 0-segment input early; recursiveUser doesn't enforce
    // a minimum and produces a valid prompt either way. Pin this to keep the
    // helper's contract independent of the caller's thresholding.
    const out = recursiveUser([], "PRIOR_META");
    expect(out).toContain("<previous-meta-summary>");
    expect(out).toContain("PRIOR_META");
    expect(out).toContain("New observation segments to merge");
  });
});

describe("formatDistillations — rolling-summary block ordering (RC4)", () => {
  // The in-context structure is meta-distillations THEN normal distillations.
  // Once a distillation is meta-distilled it is removed from the in-context
  // prefix (archived → not loaded), so the meta block stays stable above while
  // NEW gen-0 distillations created afterwards append to the normal block
  // below. This test locks in that meta (generation > 0) always renders before
  // recent (generation === 0).
  test("meta block renders before the recent/normal block", () => {
    const out = formatDistillations([
      // intentionally pass recent before meta to prove ordering is by
      // generation, not input order
      { observations: "RECENT gen-0 work", generation: 0, id: "r1" },
      { observations: "META summarized work", generation: 1, id: "m1" },
    ]);
    expect(out).toContain("### Earlier Work (summarized)");
    expect(out).toContain("### Recent Work (distilled)");
    expect(out.indexOf("META summarized work")).toBeLessThan(
      out.indexOf("RECENT gen-0 work"),
    );
    // And the meta heading precedes the recent heading.
    expect(out.indexOf("### Earlier Work (summarized)")).toBeLessThan(
      out.indexOf("### Recent Work (distilled)"),
    );
  });

  test("new gen-0 distillation appends below a stable meta block", () => {
    const meta = { observations: "META state", generation: 2, id: "m1" };
    const before = formatDistillations([meta]);
    // A fresh gen-0 distillation arrives after the meta-distillation.
    const after = formatDistillations([
      meta,
      { observations: "NEW gen-0 after meta", generation: 0, id: "r1" },
    ]);
    // The meta block bytes are unchanged and remain at the top; the new gen-0
    // content is appended below in the recent section.
    expect(after.startsWith(before.split("\n\n### Recent")[0])).toBe(true);
    expect(after).toContain("NEW gen-0 after meta");
    expect(after.indexOf("META state")).toBeLessThan(
      after.indexOf("NEW gen-0 after meta"),
    );
  });

  test("only meta present: no recent section emitted", () => {
    const out = formatDistillations([
      { observations: "only meta", generation: 1, id: "m1" },
    ]);
    expect(out).toContain("### Earlier Work (summarized)");
    expect(out).not.toContain("### Recent Work (distilled)");
  });
});

describe("consolidationUser — value annotation (#497)", () => {
  const base = { id: "abc123", category: "pattern", title: "T", content: "C" };

  test("renders confidence + verifier record inside the category parens", () => {
    const out = consolidationUser({
      entries: [{ ...base, confidence: 0.9, outcome: { passes: 5, fails: 2 } }],
      targetMax: 0,
      mode: "merge-duplicates",
    });
    expect(out).toContain("(pattern, conf 0.90, verifier pass 5, fail 2)");
    // The [id] bracket stays clean so the model echoes a usable id.
    expect(out).toContain("- [abc123] (pattern,");
  });

  test("omits the verifier record when there is no signal (0/0)", () => {
    const out = consolidationUser({
      entries: [{ ...base, confidence: 0.8, outcome: { passes: 0, fails: 0 } }],
      targetMax: 0,
      mode: "merge-duplicates",
    });
    expect(out).toContain("(pattern, conf 0.80)");
    expect(out).not.toContain("verifier");
  });

  test("renders confidence even when outcome is absent; bare entry has no tag", () => {
    const withConf = consolidationUser({
      entries: [{ ...base, confidence: 0.7 }],
      targetMax: 0,
      mode: "merge-duplicates",
    });
    expect(withConf).toContain("(pattern, conf 0.70)");
    // No value fields at all → plain category, no trailing comma.
    const bare = consolidationUser({
      entries: [base],
      targetMax: 0,
      mode: "merge-duplicates",
    });
    expect(bare).toContain("- [abc123] (pattern) T: C");
  });

  test("value tag also renders in trim mode", () => {
    const out = consolidationUser({
      entries: [{ ...base, confidence: 0.3, outcome: { passes: 0, fails: 4 } }],
      targetMax: 0,
      mode: "trim",
    });
    expect(out).toContain("(pattern, conf 0.30, verifier pass 0, fail 4)");
  });

  test("both consolidation system prompts explain the value annotation", () => {
    expect(CONSOLIDATION_MERGE_SYSTEM).toContain("verifier pass");
    expect(CONSOLIDATION_MERGE_SYSTEM.toLowerCase()).toContain("higher-value");
    expect(CONSOLIDATION_SYSTEM).toContain("verifier pass");
  });
});

describe("CURATOR_SYSTEM — discoverable titles (Modem)", () => {
  test("declares a DISCOVERABLE TITLES section", () => {
    expect(CURATOR_SYSTEM).toContain("DISCOVERABLE TITLES");
  });

  test("tells the curator the title is the search key / dedup identity", () => {
    // The load-bearing rationale: a specific title is what makes an entry
    // retrievable (top-weighted recall field) and keeps distinct facts distinct
    // (dedup key). Pin both so the guidance can't silently drop back to a bare
    // "Short descriptive title".
    expect(CURATOR_SYSTEM).toMatch(
      /search key|highest-weighted|dedup identity/i,
    );
    expect(CURATOR_SYSTEM).toMatch(/BAD:[\s\S]{0,200}GOOD:/);
  });
});

describe("CURATOR_SYSTEM — procedural pattern runbooks (#914)", () => {
  test("declares a PROCEDURAL PATTERNS section heading", () => {
    expect(CURATOR_SYSTEM).toContain("PROCEDURAL PATTERNS");
  });

  test("requires Steps / Gotchas / Verify headings for procedural entries", () => {
    // Each must appear as a label the curator is told to emit.
    expect(CURATOR_SYSTEM).toMatch(/\bSteps\s*:/);
    expect(CURATOR_SYSTEM).toMatch(/\bGotchas\s*:/);
    expect(CURATOR_SYSTEM).toMatch(/\bVerify\s*:/);
  });

  test("mentions the 1200-character content cap so curators know when to split", () => {
    expect(CURATOR_SYSTEM).toContain("1200");
  });

  test("does not force the runbook shape onto flat (non-procedural) patterns", () => {
    // The guidance must explicitly carve out a flat-pattern path. Pin a phrase
    // that pins the "FLAT / 1-3 sentence" carve-out so it can't regress to
    // "always emit Steps/Gotchas/Verify".
    expect(CURATOR_SYSTEM).toMatch(/FLAT/i);
    expect(CURATOR_SYSTEM).toMatch(/non-?procedural/i);
  });

  test("includes a golden example showing the runbook shape", () => {
    // A worked example lets the model pattern-match the structure. Pin that
    // the example contains a numbered step, a dashed gotcha, and a checkbox.
    expect(CURATOR_SYSTEM).toMatch(/^\s*\d+\.\s/m);
    expect(CURATOR_SYSTEM).toContain("[ ]");
  });

  test("PROCEDURAL PATTERNS section appears between INCLUDE THE WHY and BREVITY", () => {
    const whyIdx = CURATOR_SYSTEM.indexOf('INCLUDE THE "WHY"');
    const procIdx = CURATOR_SYSTEM.indexOf("PROCEDURAL PATTERNS");
    const brevIdx = CURATOR_SYSTEM.indexOf("BREVITY IS CRITICAL");

    expect(whyIdx).toBeGreaterThan(-1);
    expect(procIdx).toBeGreaterThan(whyIdx);
    expect(brevIdx).toBeGreaterThan(procIdx);
  });

  test("brevity cap exempts procedural runbooks — no 600-vs-1200 contradiction (#923 Seer)", () => {
    // Seer flagged that the 1200-char runbook cap contradicted the blanket
    // ~600-char (150-word) brevity cap, which could make the model truncate
    // runbooks. The brevity mandate MUST carve out procedural patterns up to
    // 1200 chars; this pins the two sections so they can't silently diverge.
    expect(CURATOR_SYSTEM).toMatch(
      /under 150 words[^\n]*EXCEPT[^\n]*procedural[\s\S]{0,120}1200/i,
    );
    // And the split-on-overflow rule must not tell runbooks to split at 150 words.
    expect(CURATOR_SYSTEM).toMatch(
      /procedural runbook stays a single entry but splits by PHASE/i,
    );
  });
});

import type { DiffHunk } from "../../src/semantic-lint/check";
import type {
  RecordedJudgeTrace,
  RecordedVerifierTrace,
  SemanticLintReplayCase,
} from "./types";

function judge(
  verdict: RecordedJudgeTrace["verdict"],
  reason: string,
  overrides: Partial<RecordedJudgeTrace> = {},
): RecordedJudgeTrace {
  return {
    verdict,
    reason,
    semanticCalls: 1,
    transportAttempts: 1,
    inputTokens: 1_800,
    outputTokens: 96,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 48,
    ...overrides,
  };
}

function verifier(
  outcome: RecordedVerifierTrace["outcome"],
  reason: string,
  overrides: Partial<RecordedVerifierTrace> = {},
): RecordedVerifierTrace {
  return {
    outcome,
    reason,
    semanticCalls: 1,
    transportAttempts: 1,
    inputTokens: 2_400,
    outputTokens: 128,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 64,
    ...overrides,
  };
}

function invariant(
  id: string,
  title: string,
  content: string,
  severity: "advisory" | "soft" | "strict" = "strict",
) {
  return { id, title, content, severity } as const;
}

function hunk(
  file: string,
  text: string,
  extra: Partial<DiffHunk> = {},
): DiffHunk {
  return { file, text, ...extra };
}

const relocatedGateInvariant = invariant(
  "inv-temporal-recall-gate",
  "Temporal backfill must yield to live recall embedding",
  "Temporal backfill must wait while recallEmbedsInFlight() is non-zero; the gate may be implemented in core rather than the gateway.",
  "soft",
);

const lifecycleInvariant = invariant(
  "inv-embedded-gateway-lifecycle",
  "Owned embedded gateways must shut down on process termination",
  "An embedded gateway owned by the host process must install a SIGTERM shutdown handler and must not rely on per-workspace disposal.",
  "strict",
);

const heldOutTerminationInvariant = invariant(
  "inv-process-worker-termination-hook",
  "Process-owned workers must release resources on termination",
  "A process-owned worker must register a one-shot termination hook that releases its resources before exit.",
  "strict",
);

const replacementInvariant = invariant(
  "inv-replacement-guard",
  "Replacement requests must retain the authentication guard",
  "A replacement request must pass through the shared authentication guard before dispatch; removing the guard is a true violation.",
  "strict",
);

const heldOutReplacementInvariant = invariant(
  "inv-session-replacement-authorization",
  "Session replacement must retain authorization before execution",
  "A session replacement must validate the caller before executing the replacement operation.",
  "strict",
);

const extractionInvariant = invariant(
  "inv-embedding-facade",
  "The embedding facade must preserve the bounded provider boundary",
  "Embedding callers must continue to use the bounded provider boundary when the implementation is split into modules.",
  "soft",
);

const heldOutExtractionInvariant = invariant(
  "inv-storage-facade",
  "The storage facade must preserve the bounded persistence boundary",
  "Storage callers must continue to use the bounded persistence provider when the implementation is split into modules.",
  "soft",
);

const relocatedGateHunks: DiffHunk[] = [
  hunk(
    "packages/core/src/embedding/backfill.ts",
    "@@ -180,8 +180,15 @@ async function backfillTemporalEmbeddings()\n-  if (isSessionBusy()) await waitForIdle();\n+  while (recallEmbedsInFlight() > 0) await waitForCapacity();\n+  enqueueTemporalEmbedding(row);",
  ),
  hunk(
    "packages/gateway/src/pipeline.ts",
    "@@ -4220,8 +4220,5 @@ function startupBackfill()\n-  const gate = buildTemporalBackfillGate();\n-  runStartupBackfill({ shouldPause: gate });\n+  runStartupBackfill({ shouldPause: () => isBackgroundPaused() });",
  ),
  hunk(
    "packages/core/test/semantic-lint-replay.test.ts",
    '@@ -1,3 +1,8 @@\n+it("keeps the core-owned recall gate active", () => {\n+  expect(recallEmbedsInFlight()).toBeGreaterThanOrEqual(0);\n+});',
  ),
];

const relocatedGateAdaptive = {
  firstPass: judge(
    "violates",
    "The gateway-side gate was removed from the changed pipeline hunk.",
    { inputTokens: 1_620, outputTokens: 88, latencyMs: 44 },
  ),
  verifier: verifier(
    "cleared",
    "The companion core hunk reinstates the same admission rule at the shared boundary.",
    { inputTokens: 2_720, outputTokens: 132, latencyMs: 71 },
  ),
};

const lifecycleHunks: DiffHunk[] = [
  hunk(
    "packages/opencode/src/index.ts",
    '@@ -92,12 +92,13 @@ async function startInProcess()\n-  processLifecycle.ownGateway(handle);\n-  if (!handle.owned) log.info("reusing existing gateway");\n+  if (handle.owned) installEmbeddedGatewaySigtermHandler(handle.shutdown);\n+  else log.info("reusing existing gateway");',
  ),
  hunk(
    "packages/opencode/src/internal.ts",
    '@@ -1,7 +1,10 @@\n+export function installEmbeddedGatewaySigtermHandler(shutdown) {\n+  process.prependOnceListener("SIGTERM", () => void shutdown());\n+}',
  ),
];

const replacementHunks: DiffHunk[] = [
  hunk(
    "packages/gateway/src/requests/replacement.ts",
    "@@ -40,8 +40,4 @@ export async function replaceRequest(request)\n-  await requireAuthentication(request);\n-  return dispatchReplacement(request);\n+  return dispatchReplacement(request);",
  ),
  hunk(
    "packages/gateway/test/replacement.test.ts",
    '@@ -10,4 +10,4 @@ it("replacement is authenticated", async () => {\n-  await replaceRequest(authenticated);\n+  await replaceRequest(request);',
  ),
];

const extractionHunks: DiffHunk[] = [
  hunk(
    "packages/core/src/embedding/runtime.ts",
    "@@ -1,5 +1,8 @@\n+export async function embed(texts, inputType) {\n+  return provider.embed(texts, inputType);\n+}",
  ),
  hunk(
    "packages/core/src/embedding.ts",
    '@@ -1,4 +1,4 @@\n-export { embed } from "./embedding-legacy";\n+export { embed } from "./embedding/runtime";',
  ),
];

const largeHeldOutHunk = hunk(
  "packages/core/src/embedding/large-refactor.ts",
  `@@ -1,2 +1,2 @@\n-${"old implementation line ".repeat(2_200)}\n+${"new implementation line ".repeat(2_200)}`,
);

const heldOutTerminationHunks: DiffHunk[] = [
  hunk(
    "packages/cli/src/runtime.ts",
    "@@ -204,6 +204,7 @@ async function runWorker()\n-  await worker.start();\n+  installProcessTerminationHook(worker.stop);\n+  await worker.start();",
  ),
  hunk(
    "packages/cli/src/termination.ts",
    '@@ -1,2 +1,5 @@\n+export function installProcessTerminationHook(stop) {\n+  process.once("SIGTERM", () => void stop());\n+}',
  ),
];

const heldOutReplacementHunks: DiffHunk[] = [
  hunk(
    "packages/api/src/session-replacement.ts",
    "@@ -52,7 +52,4 @@ export async function replaceSession(request)\n-  await authorizeReplacement(request.session);\n-  return executeReplacement(request);\n+  return executeReplacement(request);",
  ),
  hunk(
    "packages/api/test/session-replacement.test.ts",
    '@@ -18,4 +18,4 @@ it("replaces an authorized session", async () => {\n-  await replaceSession(authorized);\n+  await replaceSession(request);',
  ),
];

type ReplayFixtureDefinition = Omit<SemanticLintReplayCase, "integrity">;

const FIXTURE_DEFINITIONS: readonly ReplayFixtureDefinition[] = [
  {
    id: "labeled-pr-1766-relocated-temporal-gate",
    name: "PR #1766 relocated the temporal gate into core",
    split: "labeled",
    label: "context-fp",
    revision: {
      source: "BYK/loreai#1766",
      base: "7092beefbb73c3fa0342dd34080ad405843f182a",
      head: "fe39795ab783f97beb75beea53790334e62df6ca",
    },
    invariant: relocatedGateInvariant,
    hunks: relocatedGateHunks,
    seedHunkIndex: 1,
    tags: ["known-fp", "relocation", "same-invariant", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The old gateway gate is absent from the changed pipeline hunk.",
        { inputTokens: 1_960, outputTokens: 104, latencyMs: 52 },
      ),
      holistic: judge(
        "satisfies",
        "The complete diff shows the gate moved to the core backfill boundary.",
        { inputTokens: 5_420, outputTokens: 144, latencyMs: 78 },
      ),
      adaptive: relocatedGateAdaptive,
    },
  },
  {
    id: "labeled-pr-1768-intentional-lifecycle-change",
    name: "PR #1768 intentional lifecycle baseline change",
    split: "labeled",
    label: "true-violation",
    revision: {
      source: "BYK/loreai#1768",
      base: "11cfe10bae21371461afd14a83c86f688950caa4",
      head: "dd93fea67f3858c37c5bf710bcf6ebd52d9ad459",
    },
    invariant: lifecycleInvariant,
    hunks: lifecycleHunks,
    seedHunkIndex: 0,
    tags: ["intentional-baseline-change", "lifecycle", "sigterm"],
    recorded: {
      isolated: judge(
        "violates",
        "The per-workspace lifecycle owner was removed.",
        { inputTokens: 1_740, outputTokens: 102, latencyMs: 51 },
      ),
      holistic: judge(
        "violates",
        "The new process-level SIGTERM handler does not preserve the old disposal contract.",
        { inputTokens: 4_880, outputTokens: 151, latencyMs: 73 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The previous lifecycle ownership contract is intentionally changed.",
          { inputTokens: 1_680, outputTokens: 93, latencyMs: 49 },
        ),
        verifier: verifier(
          "confirmed",
          "The connected internal helper confirms the new shutdown semantics are a baseline-rule change.",
          { inputTokens: 2_540, outputTokens: 136, latencyMs: 67 },
        ),
      },
    },
  },
  {
    id: "labeled-mutant-remove-replacement-guard",
    name: "Mutant: remove the replacement authentication guard",
    split: "labeled",
    label: "true-violation",
    revision: {
      source: "controlled-mutant:replacement-guard",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "mutant-remove-replacement-guard-v1",
    },
    invariant: replacementInvariant,
    hunks: replacementHunks,
    seedHunkIndex: 0,
    tags: ["controlled-mutant", "guard-removal", "security"],
    mutation: {
      id: "remove-replacement-guard",
      parentCaseId: "labeled-pr-1766-relocated-temporal-gate",
      ancestry: "derived",
      description:
        "Delete the replacement guard while retaining the dispatch call.",
    },
    recorded: {
      isolated: judge(
        "violates",
        "The replacement dispatch bypasses authentication.",
      ),
      holistic: judge(
        "violates",
        "No connected hunk restores the removed replacement guard.",
        { inputTokens: 4_220, outputTokens: 128, latencyMs: 65 },
      ),
      adaptive: {
        firstPass: judge("violates", "The replacement call is now direct."),
        verifier: verifier(
          "confirmed",
          "Connected context contains no replacement authentication guard.",
        ),
      },
    },
  },
  {
    id: "labeled-safe-embedding-extraction",
    name: "Safe embedding extraction preserves the facade boundary",
    split: "labeled",
    label: "clean-change",
    revision: {
      source: "synthetic-replay:embedding-extraction",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "synthetic-safe-extraction-v1",
    },
    invariant: extractionInvariant,
    hunks: extractionHunks,
    seedHunkIndex: 0,
    tags: ["clean", "refactor", "facade"],
    recorded: {
      isolated: judge(
        "satisfies",
        "The extracted runtime still uses the provider boundary.",
      ),
      holistic: judge(
        "satisfies",
        "The complete refactor preserves the public embedding facade.",
        { inputTokens: 3_820, outputTokens: 132, latencyMs: 59 },
      ),
      adaptive: {
        firstPass: judge(
          "satisfies",
          "The provider boundary is still present.",
        ),
      },
    },
  },
  {
    id: "labeled-connected-test-pair-clears-fp",
    name: "Connected test-pair context clears a moved guard false positive",
    split: "labeled",
    label: "context-fp",
    revision: {
      source: "synthetic-replay:connected-test-pair",
      base: "fe39795ab783f97beb75beea53790334e62df6ca",
      head: "synthetic-connected-test-pair-v1",
    },
    invariant: replacementInvariant,
    hunks: [
      hunk(
        "packages/gateway/src/requests/replacement.ts",
        "@@ -40,5 +40,5 @@ export async function replaceRequest(request)\n-  return dispatchReplacement(request);\n+  return dispatchReplacementThroughGuard(request);",
      ),
      hunk(
        "packages/gateway/test/replacement.test.ts",
        '@@ -10,3 +10,5 @@ it("replacement is authenticated", async () => {\n+  expect(replacementGuard).toHaveBeenCalled();\n+  await replaceRequest(authenticated);',
      ),
    ],
    seedHunkIndex: 0,
    tags: ["known-fp-class", "test-pair", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The seed hunk does not show the guard assertion.",
      ),
      holistic: judge(
        "satisfies",
        "The changed test confirms the replacement guard remains active.",
        { inputTokens: 3_460, outputTokens: 126, latencyMs: 57 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The seed hunk appears to bypass the guard.",
        ),
        verifier: verifier(
          "cleared",
          "The connected test pair confirms the guard is still exercised.",
        ),
      },
    },
  },
  {
    id: "heldout-relocated-sigterm-helper",
    name: "Held-out relocation of SIGTERM helper",
    split: "held-out",
    label: "context-fp",
    revision: {
      source: "synthetic-held-out:relocated-sigterm",
      base: "synthetic-worker-runtime-baseline-v1",
      head: "synthetic-heldout-sigterm-v1",
    },
    invariant: heldOutTerminationInvariant,
    hunks: heldOutTerminationHunks,
    seedHunkIndex: 0,
    tags: ["held-out", "relocation", "connected-context"],
    recorded: {
      isolated: judge(
        "violates",
        "The worker is started without the process termination hook in the seed.",
      ),
      holistic: judge(
        "satisfies",
        "The companion termination module preserves the worker shutdown hook.",
        { inputTokens: 3_980, outputTokens: 137, latencyMs: 63 },
      ),
      adaptive: {
        firstPass: judge(
          "violates",
          "The worker start path does not show the termination hook.",
        ),
        verifier: verifier(
          "cleared",
          "The connected helper installs the process-level worker stop hook.",
        ),
      },
    },
  },
  {
    id: "heldout-remove-replacement-guard",
    name: "Held-out replacement guard mutant",
    split: "held-out",
    label: "true-violation",
    revision: {
      source: "controlled-mutant:replacement-guard-held-out",
      base: "synthetic-session-replacement-baseline-v1",
      head: "mutant-remove-session-authorization-v1",
    },
    invariant: heldOutReplacementInvariant,
    hunks: heldOutReplacementHunks,
    seedHunkIndex: 0,
    tags: ["held-out", "controlled-mutant", "guard-removal"],
    mutation: {
      id: "remove-session-authorization-held-out",
      parentCaseId: "synthetic-session-replacement-baseline-v1",
      ancestry: "independent",
      description:
        "Independently remove the session authorization guard before execution.",
    },
    recorded: {
      isolated: judge(
        "violates",
        "The session replacement executes without authorization.",
      ),
      holistic: judge(
        "violates",
        "The authorization guard is absent from the complete diff.",
        {
          inputTokens: 4_060,
          outputTokens: 130,
          latencyMs: 62,
        },
      ),
      adaptive: {
        firstPass: judge("violates", "The session replacement call is direct."),
        verifier: verifier(
          "confirmed",
          "No connected hunk restores session authorization.",
        ),
      },
    },
  },
  {
    id: "heldout-large-clean-refactor",
    name: "Held-out large clean refactor exceeds holistic budget",
    split: "held-out",
    label: "clean-change",
    revision: {
      source: "synthetic-held-out:large-clean-refactor",
      base: "synthetic-storage-facade-baseline-v1",
      head: "synthetic-large-clean-v1",
    },
    invariant: heldOutExtractionInvariant,
    hunks: [largeHeldOutHunk],
    seedHunkIndex: 0,
    tags: ["held-out", "large-pr", "budget-boundary"],
    recorded: {
      isolated: judge(
        "satisfies",
        "The large replacement keeps the persistence provider boundary.",
        {
          inputTokens: 5_900,
          outputTokens: 110,
          latencyMs: 83,
        },
      ),
      holistic: judge("satisfies", "The complete storage diff is clean.", {
        inputTokens: 21_000,
        outputTokens: 120,
        latencyMs: 110,
      }),
      adaptive: {
        firstPass: judge(
          "satisfies",
          "The bounded seed remains within the persistence provider boundary.",
          {
            inputTokens: 5_800,
            outputTokens: 102,
            latencyMs: 79,
          },
        ),
      },
    },
  },
];

export const SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS = {
  "labeled-pr-1766-relocated-temporal-gate": {
    inputSha256:
      "ce49a5c6961e0a22bca46fbd8a5c016626d03d14a0ada4abca0150c012c7ffbf",
    traceSha256:
      "1faff28a1decb978f1f46dcbf396fdec6d2feb4c3467d98deec98b84b3ca6523",
  },
  "labeled-pr-1768-intentional-lifecycle-change": {
    inputSha256:
      "e704a669146872061138cc0d9bdbf7a1748a59505680eb36e15045be039b12c7",
    traceSha256:
      "f47550a84c0d3613bf85cd106e08e57b441afa439f326ca9ce0a8d1a8d80e94f",
  },
  "labeled-mutant-remove-replacement-guard": {
    inputSha256:
      "bf780fef6dee42a2decf18c488471cce641bb21a78273d07b9d98a046cdb0b1b",
    traceSha256:
      "9824a2f00d3952c81bc7a9c0c6ace43fd1acccceb801ae8647c5b8f8c0c2b851",
  },
  "labeled-safe-embedding-extraction": {
    inputSha256:
      "170f00d80965ec7aa6c2211792b3c3b27258e7a807f1a26c7983d0e17a8b1bb7",
    traceSha256:
      "8a190d216e3dcdd7114392b4d8d196fdcb46677fbb3f682d794ddb1fa4c3fd6f",
  },
  "labeled-connected-test-pair-clears-fp": {
    inputSha256:
      "ac6bb45655ddcf907bee9c0c30096438afbf2695285f83cde814c42f28e56ed0",
    traceSha256:
      "7ee8562931633db4f8ae8dd7e2eb672085d346c0184d4fe1045cd55ef124fd83",
  },
  "heldout-relocated-sigterm-helper": {
    inputSha256:
      "ef62aecb04ad7a46d9f022c5272666248f55fb679d53c669fbfa1c7701b99adc",
    traceSha256:
      "fbc89102c9f0824246cbe4383985b960cbcf892134f4939909cafeb8fc0cbf13",
  },
  "heldout-remove-replacement-guard": {
    inputSha256:
      "e979dd44d803b3b2da73b5da3d87d52b0f2d77e5224946d6d8245d887a400688",
    traceSha256:
      "59ddcb1d23fa9134f758dff8360f2c709839d0a6ec635b4aa607ffb8f9e7e816",
  },
  "heldout-large-clean-refactor": {
    inputSha256:
      "a4275ae1fb663a2491e5fad243d7a252cda4afd2462dca95e1199c77c700f65d",
    traceSha256:
      "5047113b9f03b59464969aeaa965165f10d64b92b7e7d696215949fe90a98352",
  },
} as const;

export const SEMANTIC_LINT_REPLAY_FIXTURES: readonly SemanticLintReplayCase[] =
  FIXTURE_DEFINITIONS.map((item) => ({
    ...item,
    integrity:
      SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS[
        item.id as keyof typeof SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS
      ],
  }));

export function getSemanticLintReplayFixtures(): readonly SemanticLintReplayCase[] {
  return SEMANTIC_LINT_REPLAY_FIXTURES;
}

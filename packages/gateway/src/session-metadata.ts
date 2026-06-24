/** Shared helper: translate `SessionState.gitHead` into the `metadata` shape
 *  that core curator/distillation/pattern-echo accept (#627 Phase 1). One
 *  builder keeps the gateway→core translation uniform: every new knowledge
 *  entry mints with the same `metadata.gitHead` if and only if the session
 *  probe captured one. Centralizing also means a future metadata key (e.g.
 *  `gitRemote`, `workerSessionId`) only needs to be added in one place.
 */
export function buildSessionMetadata(
  gitHead: string | undefined,
): { gitHead: string } | undefined {
  return gitHead ? { gitHead } : undefined;
}

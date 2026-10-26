# Guided project sharing

Goal: replace the flat settings block with a contextual, interactive sharing card.

Approaches considered: a project card (chosen for everyday use and clear next actions), a setup wizard (more first-time guidance but extra navigation), and a central collaboration page (useful at scale but removed from the project). The user delegated choosing and implementing the approach.

Design: a three-step path—Connect team, Choose sharing, Keep in sync—with the actual account/team/sharing/sync state driving progress. Show a compact team identity and member count, a clear automatic-sharing control with review rules, and configured sync state plus Sync now. Contextual setup instructions handle sign-in, hosted mode, disabled sync, locked keys, and missing teams. Unlink gets an explicit consequence dialog; it never claims to revoke copies already shared. Technical overrides move into expandable details. No automatic permission or encryption changes.

Implementation:
- Preserve existing stale-response/account/project guards and expected-revision APIs in SharingPanel.
- Add meaningful tests for unlink confirmation/cancellation, empty or viewer-only teams, setup guidance, sync actions, and account/project races.
- Make shared sync receipts acknowledge conflicts, skipped rows, quota pauses, and account changes rather than claiming full success.
- Render the guided card responsively with accessible labels, real pending/error receipts, and reduced-motion-friendly feedback.
- Verify focused tests, all UI tests, typecheck/lint/format/build; independently review correctness and security.
- Capture actual frontend before/after states against a disposable API fixture: unlinked, connected automatic sharing, unlink confirmation, setup needed, and mobile. Upload images with gh --attach in a draft PR. Leave the PR open for the user's review.

Review refinements: enabled sync is configuration rather than proof of an active scheduler or unlocked keys. Explicit sync attempts surface unlock/enable/sign-in blockers and an explicit retry. Hosted recovery must stop the existing gateway before starting in local mode; foreground gateways need Ctrl+C. New entries stay private until team proposal/approval, although personal backup may already exist. Healthy refreshes preserve selections; failed reads cannot revive stale status.

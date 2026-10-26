# Intentional everyday UI

The user approved all nine ideas from the UI audit and requested one PR, real
before/after screenshots, review for bugs/DRY/gaps, fixes, and ready-for-review
status. Do not merge this PR.

## Outcomes

1. Knowledge browsing gives titles/content most of the width, with readable
   two-line previews and secondary metadata. Keep filtering, sorts, pagination,
   keyboard navigation, selected-row behavior and global/project readers intact.
2. Project overview is useful after setup: connected/configured sharing is a
   compact summary with an explicit expansion control. Incomplete or blocked
   setup remains visible. Recent knowledge/activity appear near the top.
3. Team management leads with members and Invite teammate. Use Members,
   Invitations and Settings sections; move discovery, domain and account-ID
   tools to Settings. Keep create/join recovery for people without a team.
4. Distinguish Filter this list, Search this project's memory and Search
   knowledge across projects. Use readable labels for recall scope values and
   explain actual search coverage; never pretend workspace search includes
   sessions when its API only searches knowledge.
5. Provide labeled desktop navigation with a compact option, preserve mobile
   navigation, and use Team proposals, Conflicting instructions and Sync recovery
   consistently in destinations/headings. Keep routes unchanged.
6. Distinguish sync configuration, running, completed and blocked states. Do not
   invent a last-success timestamp when the API has none. Replace count-derived
   Memory health / No recorded health warnings with Memory summary.
7. Remove unimplemented roadmap actions from production knowledge and session
   readers. Keep implemented copy/edit/source/history actions and their feedback.
8. Empty states give a relevant next step: runnable capture/import guidance,
   filter reset, search scope correction, or team setup/recovery. Guidance must
   match existing capabilities and permissions.
9. Project directory groups checkouts sharing a nonempty recorded git_remote,
   separates unattributed records, and supports Recent activity, Name and
   Knowledge count sorts. Grouping is presentation only: no merging/deleting,
   no grouping merely by display name, and every project keeps its own link.

## Constraints

- Solid/Vite, existing owned UI components and olive/amber semantic tokens.
- No added dependencies, backend/schema changes or production-data mutations.
- No invented sync guarantees, timestamps, project totals or team-wide content.
- Preserve ownership/auth/generation/revision guards and explicit sharing consent.
- Use existing shared logic where applicable; extract small pure helpers for new
  grouping/labels rather than duplicating behavior across consumers.
- URL state for new meaningful tabs/sorts/filters when practical; sanitize input.
- Narrow/mobile layouts, keyboard use, focus restoration and reduced motion work.
- All work stays in the attached worktree; primary checkout is untouched.
- Screenshots use actual base/branch frontend with identical fictional API data.

## Review priorities

Account/project/team changes during pending actions; cross-project filter/sort
preservation; unknown/stale status versus confirmed success; grouped checkout
identity/filtering without hidden records; mobile overlays, long content and
keyboard/modified-link navigation.

# Public navigation refinement

The user is unhappy with the top navigation and confirmed that target after the
site-wide visual update. Continue the authorized website refinements in PR2115,
keep the journal and the compact Light/System/Dark pill.

## Approaches and decision

A centered navigation capsule adds a separate container competing with the theme
pill. An RPG menu with renamed destinations weakens the clearer product story.
Use the app-like grouping proposed in chat: Logo + Docs/Why Lore/Blog on the left;
GitHub icon + existing theme pill + prominent Get started action on the right.
The grouping and exact spacing are implementation calls, not new product behavior.

Use the same primary links and utility controls on public pages and docs. Keep
all five destinations readable in the native mobile menu and the Starlight drawer.
Retain active-section semantics, static base-prefixed paths, all theme behavior,
keyboard focus, 44px touch targets, reduced-motion behavior and 320px containment.
No new dependencies, menus, settings, animations, or navigation destinations.

This is a narrow continuation of the approved compact/app-consistent UI scope;
implement inline in the existing checkout and leave the same PR draft/unmerged.

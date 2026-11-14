# Landscape Animation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this scoped update.

**Goal:** Animate refinement up a continuous terrain that tapers toward one summit.

**Architecture:** Keep shared SVG/GPU contours and elevation bands. Add pure
surface-position/retention helpers and a finite, interruptible renderer transition.
Use shared geometry for transient fragments, cached theme colors and no idle loop.

**Tech Stack:** Astro, TypeScript, Three.js, native radios, Playwright.

- [x] Add failing shape, surface-path and retention tests.
- [x] Implement the single connected terrain and user-triggered sweep/fragments.
- [x] Cover rapid retargeting, interrupted transitions, reduced motion and settled pixels.
- [x] Check actual desktop/mobile renders, units, Astro, lint, format and links;
  complete correctness/security review and update PR #2115 with fresh screenshots.

# Landscape Refinement Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this scoped update.

**Goal:** Make terrain elevation explain conversation refinement and relevant context.

**Architecture:** Keep the existing Astro component, shared contour geometry and
lazy Three.js renderer. Replace nearest-landmark regions with a shared elevation
classifier; each contour mesh and corresponding SVG face owns the same band.

**Tech Stack:** Astro, TypeScript, Three.js, native radio inputs, Playwright.

- [x] Replace landmark tests with failing elevation classification and no-marker coverage.
- [x] Update the shared model, SVG component and GPU renderer; remove marker/route code.
- [x] Update example copy and stage labels, preserving truthful relevance semantics.
- [x] Verify static/GPU band selection, keyboard/touch/drag, context loss and fallback;
  run website browser/unit checks, Astro, lint and formatting.
- [x] Complete independent correctness/security review, capture the real site and push
  this update to PR #2115 using gh CLI.

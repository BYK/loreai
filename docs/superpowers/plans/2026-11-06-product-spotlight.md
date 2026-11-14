# Product Spotlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the rejected oversized homepage screenshot section with a compact product walkthrough.

**Architecture:** One Astro component, native radios/CSS and the existing allowlisted URL helper; actual theme-specific detail captures stay unchanged.

**Tech Stack:** Astro, CSS, TypeScript, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-product-spotlight.md`

## Global Constraints

- Keep header, hero, journal, fragment IDs and app proof truthful.
- Use existing assets/dependencies; no backend or simulated live actions.
- Preserve native fallback,44px targets, separate URL state and BASE_URL.
- Update the existing draft PR; no merge.

## Review Focus

- Cropping must not overflow phones or hide the controls/caption.
- Source notes must preserve exact-message qualification.
- History must show only recorded version metadata, not fabricated contents.
- New preview state must coexist with hero/journal parameters through history.
- Native links must retain meaningful destinations under the preview prefix.

### Task 1: Compact product workbench

**Files:** Create website `src/components/ProductSpotlight.astro`; replace homepage section; remove obsolete spotlight CSS and add scoped styles; add `test/browser/product-spotlight.spec.ts`; update visual evidence.

**Interfaces:** Consume bindUrlChoice(selector, parameter, choices), fixed BASE_URL and existing knowledge-detail PNG assets. Produce `.product-spotlight`/#product with `.spotlight-choices` and `preview` state, plus per-view tour links.

- [x] Add failing browser tests for new controls, compact dimensions, URL/history isolation, readable original links and no-JS phone use.
- [x] Confirm tests fail against old section.
- [x] Implement native workbench and remove obsolete empty-panel layout.
- [x] Run focused then full website browser checks, Astro/unit/lint/format and prefixed links; visually inspect both themes and phone.
- [x] Obtain separate correctness/security source reviews and address actionable findings.
- [x] Commit, push existingPR2115, update description/evidence with gh and verify head; leave unmerged.

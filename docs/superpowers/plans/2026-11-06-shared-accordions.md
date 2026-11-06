# Shared Accordions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-style content disclosures with a consistent shadcn-inspired native Astro component across the website.

**Architecture:** Shared Accordion/AccordionItem composition owns native disclosure markup and CSS, with a small pointer-modality enhancement. Existing menus and Starlight navigation keep their controllers.

**Tech Stack:** Astro, TypeScript, native details/summary, CSS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-shared-accordions.md`

## Global Constraints

- Keep native/no-JS controls, existing content, anchor destinations and journal semantics.
- FAQ is single-open; journal disclosures remain independently openable.
- Preserve framework navigation controllers and appearance state.
- No new dependency, backend or merge; update existingPR2115.

## Review Focus

- Named-group exclusivity must not accidentally close a journal disclosure or header menu.
- Nested summary text/count must retain the existing accessible name and useful phone wrapping.
- Closing during pointer motion or switching to keyboard must not trap focus or leave content visible.
- Expanded outline/inventory links and controls must keep visible focus near clipped edges.
- Framework sidebar and mobile TOC state must survive styling changes.

### Task 1: Shared disclosure system and migration

**Files:** Create website Accordion.astro, AccordionItem.astro, accordion CSS and modality script; modify FAQ, QuestJournal, blog outline and docs navigation styling; add browser contracts, provenance and screenshots.

**Interfaces:** Accordion wraps grouped items; AccordionItem accepts title/meta/class/name/id/open and slot content. Native `open` is authoritative. The script changes only pointer-motion metadata, not disclosure state.

- [x] Write and observe failing tests for shared chevron triggers, FAQ single-open behavior, independent journal panels, outline links and responsive/no-JS paths.
- [x] Implement shared components/styles and migrate content disclosures; retain shadcn attribution/license.
- [x] Audit docs navigation controls and align sizing/focus while preserving state hooks.
- [x] Verify keyboard/pointer/reduced-motion/early-native behavior; run website/browser/Astro/unit and root type/lint/format plus prefix/link checks.
- [x] Obtain separate correctness/security source reviews, fix reproduced defects, and capture actual light/dark/phone views.
- [x] Commit, push same draftPR2115, update description/evidence with gh, verify remote head and leave unmerged.

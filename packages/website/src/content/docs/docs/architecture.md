---
title: Architecture
description: Lore combines temporal storage, distillation, and long-term knowledge into one memory pipeline.
sidebar:
  order: 2
---

Lore treats context management and memory as one pipeline.

## Temporal Storage

Every message is stored locally in SQLite with full-text search. This creates a searchable raw history that the recall tool can query when distilled context is not enough.

## Distillation

Conversation segments are distilled into observation logs that preserve file paths, decisions, errors, and other operational details. Older distillations can be consolidated into higher-level context while raw detail remains searchable.

## Long-Term Knowledge

Durable project facts, decisions, patterns, preferences, and gotchas are curated into long-term memory. Project knowledge can be exported to `.lore.md`, reviewed in pull requests, and imported by teammates.

## Gradient Context

The gradient context manager decides how much raw history, distilled context, and long-term knowledge to include on each turn so sessions can continue without destructive compaction.

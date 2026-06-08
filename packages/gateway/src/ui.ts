/**
 * ui.ts — Web dashboard for browsing and managing Lore data.
 *
 * Served from the gateway at `/ui/*`. No frontend framework — pure
 * server-rendered HTML with inline CSS. Destructive actions use
 * `<form method="POST">` with PRG (Post-Redirect-Get) pattern.
 */
import {
  data,
  db,
  ltm,
  entities,
  embedding,
  temporal,
  searchRecall,
  recallById,
  config,
  log,
  projectName,
  projectId as lookupProjectId,
  isUnattributedProjectPath,
  renderMarkdown,
  loadParentChildMap,
  type TaggedResult,
} from "@loreai/core";
import {
  computeHistoricalEstimates,
  computeDailyCosts,
  getSessionCosts,
  getAllSessionCosts,
  totalActualCost,
  totalWorkerCost,
  totalSavings,
  costWithoutLore,
  getDailySpend,
  getDailyBudget,
  setDailyBudget,
  getCostRate,
  type SessionCosts,
} from "./cost-tracker";
import { getActiveSessions } from "./pipeline";
import {
  computeWarmingSnapshot,
  getCircuitBreakerStatus,
  getGlobalHistogramsSnapshot,
  HISTOGRAM_BINS,
  BLEND_PSEUDOCOUNT,
  type WarmingSnapshot,
} from "./cache-warmer";
import type { InterTurnHistogram, SessionState } from "./translate/types";
import { resolveAuth } from "./auth";
import { getQuotaForCredential, type QuotaSnapshot } from "./quota";

// ---------------------------------------------------------------------------
// HTML template helpers
// ---------------------------------------------------------------------------

const FAVICON_HREF =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGFyaWEtbGFiZWxsZWRieT0idCBkIiB2aWV3Qm94PSIwIDQgNTAgNTAiPjx0aXRsZSBpZD0idCI+TG9yZS5BSTwvdGl0bGU+PGRlc2MgaWQ9ImQiPkxvcmUuQUkgbGlseSBtYXJrIOKAlCBtb25vY2hyb21lIGFkYXB0aXZlIGZhdmljb24uPC9kZXNjPjxzdHlsZT4ubGlseXtmaWxsOiMwMDB9QG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTpkYXJrKXsubGlseXtmaWxsOiNmZmZ9fTwvc3R5bGU+PHBhdGggZD0iTTIyLjkgMTEuMWMuMzUuMTkyLjY0LjQwOC43NjIuOC4wMjcuNDE1LS4wMzQuNTY2LS4zMDYuODk0TDIzLjEgMTNsLS4xLjFjLS40NDcuMDM3LS42OTUuMDU2LTEuMDk0LS4xNTYtLjI3My0uMzIzLS4zMDYtLjUyMy0uMzA2LS45NDQuMjM5LS42NTQuNTc1LTEuMDI4IDEuMy0uOW0tLjc2Mi40MDZjLS4yMzguMTk0LS4yMzguMTk0LS4zNDQuNDgxLjAwNi4zMTMuMDA2LjMxMy4xNjIuNi4yNDQuMjEzLjI0NC4yMTMuNTUuMjYzLjI5NC0uMDUuMjk0LS4wNS40ODItLjE2Mi4xNjgtLjI4LjE1OC0uNDY4LjExMi0uNzg4LS4yNzctLjM1My0uNTExLS41NzYtLjk2Mi0uMzk0TTMzLjkgMTQuMmMuMzQ0LjI0OS40NzUuNDQ2LjY1LjgzMS4wNjQuNDctLjAxNi43NjItLjI1IDEuMTY5LS4zMzguMzg4LS42OC40ODItMS4xNzguNTE2LS4zNjMtLjAyNy0uNTU3LS4xNzctLjgyMi0uNDE2LS4yOTctLjM1Ni0uMzQ4LS42NTctLjMyOS0xLjEwNy4wNTgtLjM4OC4yNDEtLjYxNi41MjktLjg2OC40NjEtLjI4OC44ODktLjI1NCAxLjQtLjEyNU0zMi40IDE4Yy0uMzg1IDAtLjY1LS4xNTctLjk4OC0uMzI1YTExIDExIDAgMCAwLTIuMzI3LS44MjljLS43MDUtLjE2LTEuMzg5LS4xNzctMi4xMS0uMTcxbC0uMzYzLjAwMmMtNC4yMTUuMDUyLTcuOTA0IDIuMjk1LTEwLjgxMiA1LjIyM2wtLjEuMmgtLjJsLS4wODIuMThjLS4xMTguMjItLjI0LjM2NS0uNDEyLjU0NS0zLjA3OSAzLjQ2OS00LjA2MiA3Ljk1NC0zLjgwNiAxMi40NzUuMjE2IDIuNTEzIDEuMjA4IDUuMTIxIDIuNzcgNy4xMTcuMTMuMTgzLjEzLjE4My4xMy4zODNsLjMuMWMuMTU4LjE2LjE1OC4xNi4zMjUuMzYzLjM0LjQuNjk5Ljc3MSAxLjA3NSAxLjEzN2wtLjIuMWMtMi44MzctMS44ODUtNC42MjMtNC41NDMtNS4zMjUtNy44ODEtLjQxNi0yLjEyOC0uMjg0LTQuMjAyLjEyNS02LjMxOWwuMDY1LS4zNDZjLjE4NS0uODg3LjQ4Ny0xLjcyLjgzNS0yLjU1NGwuMDkzLS4yMjNjLjcxMy0xLjY3NSAxLjY3My0zLjMwMyAyLjk1LTQuNjEyLjE1Ny0uMTY1LjE1Ny0uMTY1LjI1Ny0uMzY1aC4ybC4wNjQtLjE2MmMuMTg4LS4zMy40NDQtLjU4LjcxMS0uODQ0bC4xNzQtLjE3M2MuNjEtLjU5NCAxLjI2Ny0xLjExNSAxLjk1MS0xLjYyMWwuMjYxLS4xOTZDMjEuOTQgMTYuMzIgMjguMjA2IDE0LjUyMiAzMi40IDE4TTE0IDE2LjdjLjM0NC4xODEuMzQ0LjE4MS42LjRsLjE3NS4xMjVjLjI4OC40MDMuMzI5Ljg1OS4zMTMgMS4zMzgtLjEyNS40ODEtLjMyMy44LS43MDcgMS4xMTgtLjQ2MS4xOTUtLjkxMy4zMDMtMS40MDMuMTUtLjM4NS0uMTgzLS43MTMtLjM5MS0uOTc4LS43MzFhMi41IDIuNSAwIDAgMSAuMDE5LTEuNjMxYy41LS43NCAxLjEzNy0uODY2IDEuOTgxLS43NjltLTYgNC43Yy4yODctLjAxMi4yODctLjAxMi42IDBsLjIuMmMtLjAxMy4yNS0uMDEzLjI1LS4xLjUtLjIwNi4xMzEtLjIwNi4xMzEtLjQuMmwtLjQtLjN6bTMyLjY5LjAzNGMuMjEuMDY2LjIxLjA2Ni40MjMuMzI4LjEwMi4zOTcuMDk5LjY0NC0uMDEzIDEuMDM4LS4xOC4yMjQtLjMxLjI4My0uNTkuMzM1YTIgMiAwIDAgMS0uNjEtLjAzNWMtLjIzNy0uMjItLjM1NS0uNDA2LS40OTQtLjY5NC0uMDEtLjMyNS4xMjgtLjUzMy4yOTQtLjgwNi4zNzQtLjI1LjU1OC0uMjI3Ljk5LS4xNjYiIGNsYXNzPSJsaWx5Ii8+PHBhdGggZD0iTTI4LjYgMjIuNGMuNDguNDc2LjcxMy44MzQuNzMxIDEuNTI1LS4wMDcuNjItLjEzNi45NjUtLjU3IDEuNDIxLS40My4zOS0uODMuNTMzLTEuMzk4LjU4NS0uNjIzLS4wNTQtMS4wNzYtLjE5NC0xLjUtLjY2OS0uNDA3LS41MjktLjU0LS45OS0uNDYzLTEuNjYyLjExNy0uNTY3LjM1My0uOTI5LjgxMi0xLjI4Ljc0My0uNDcxIDEuNjY5LS40IDIuMzg4LjA4bS04LjI2OSA0LjA3NWMuNDMuMjM2LjY2Mi41MjcuODk0Ljk1Ni4xNzcuNjM1LjExNiAxLjExOC0uMTk3IDEuNjg2LS4yNDIuMzQ2LS41NS41OTQtLjkyOC43ODMtLjczNy4wNjgtMS40MzUuMTItMi4wNDUtLjM0Ni0uNDM4LS40MzYtLjYyNy0uOTExLS42NzEtMS41MjcuMDM4LS41My4zMTktLjkwOS42NDctMS4zMDguNzQ3LS42MDggMS40NDktLjYzMiAyLjMtLjI0NE00LjQ1IDI2LjQ0NGMuMzYuMDU4LjU2Mi4xMzYuODUuMzU2LjE1NS4zMS4xMjkuNTU4LjEuOS0uMTguMjc1LS4zMDUuNDUzLS42LjYtLjQxNC4wNTYtLjU3Ni4wMTUtLjkzNy0uMjA2LS4yNjMtLjI5NC0uMjYzLS4yOTQtLjMzMi0uNjM4LjEwOS0uNTYzLjMxMi0uOTE1LjkxOS0xLjAxMm00MC4xMTYgMy4xODFjMS42NDIgMS41NDMgMi40NTggMy42OCAyLjU1OSA1LjkwNy4wOCAzLjIzLTEuMDQ1IDYuMjcyLTIuOTI1IDguODY4bC0uMjMxLjMyMkExOSAxOSAwIDAgMSA0MC4yIDQ4LjVsLS4yNjMuMjFjLTIuNDgzIDEuOTQ5LTUuNDE4IDMuMTU0LTguNDM3IDMuOTlsLS4zMy4wOTNjLTEuNzA4LjQzOC0zLjUxNC41NDctNS4yNy42MDdsLS4wOC4xNjhjLS40MzguODQ5LTEuMDA4IDEuNjAzLTEuNjIgMi4zMzJsLS4xMzYuMTY0Yy0xLjI4MyAxLjUzNi0yLjc0IDMuMTMtNC41NjQgNC4wMzZsLS4yLS4xLjMtLjF2LS4yYy4xNS0uMTQ4LjE1LS4xNDguMzU2LS4zMTkgMy4zNzItMi44OCA1LjYyNC03LjUxOCA2LjAyNi0xMS45MTIuMTktMi44LS4yNjUtNS40MDktMS4wMzgtOC4wODhsLS4wNTYtLjE5NmMtLjEzNS0uNDUtLjMwMi0uODgyLS40NzktMS4zMTdhNjYgNjYgMCAwIDEtLjMzMi0uODM1IDU0IDU0IDAgMCAwLTEuNDgxLTMuNDZsLS4xMjItLjI2LS4xMS0uMjI4cS0uMDMtLjA5MS0uMDY0LS4xODVsLjEtLjJjMi4wNTYgMy4xOCA0LjAzMSA2Ljk5IDQuNTUzIDEwLjc4Ni4wNDcuMzE0LjA0Ny4zMTQuMTQ3LjQxNC44MjMtNC4zMjQuNTQtOS4wMy0uMDAzLTEzLjM3LS4wNi0uNDgtLjExNS0uOTQ1LS4wOTctMS40My4xOTMuMzMzLjI0OS42MzMuMyAxLjAxMy4wNTYuMzkuMTE0Ljc3Ni4xOTQgMS4xNjIuMjY2IDEuMjkuNDcgMi41ODUuNjE5IDMuODk0bC4wMjUuMjI1Yy4xNzUgMS41MzQuMjQ0IDMuMDYxLjI2MiA0LjYwNmwuMDA4LjI4OGMuMDE2LjgzMy0uMDcyIDEuNjQ4LS4xNjggMi40NzVsLS4wOC43MWMtLjIzMiAyLjA1OC0uMjMyIDIuMDU4LS40NzIgMi45Ny0uMDc2LjMxLS4wOTYuNTQzLS4wODguODU3bC4wODItLjE5N2MuOTQ3LTIuMjc2IDEuOTE2LTQuNTQ4IDMuMTE4LTYuNzAzbC4xNS0uMjdjLjMxNS0uNTQyLjY2Ny0xLjA2IDEuMDE5LTEuNThsLjE0NC0uMjE0LjEzOC0uMjAycS4wNi0uMDkuMTI0LS4xOGMuMTI1LS4xNTQuMTI1LS4xNTQuNDI1LS4zNTRhMy41IDMuNSAwIDAgMS0uNDcgMS4wMzFjLS4zOTIuNjQ3LS42NzUgMS4zMzQtLjk2MSAyLjAzMmwtLjE3Mi40MTNhOTkgOTkgMCAwIDAtMS42MDIgNC4xOWMtLjczOCAyLjA0Ny0xLjUgNC4wOTctMi40OTUgNi4wMzRxLS4xOTEuMzgtLjM4MS43NjNsLS4xODMuMzY2LS4xMzYuMjcxYzQuNTMzLS40MSA5LjA2NS0xLjc4IDEyLjctNC42bC4xNzctLjEzN2MxLjE0Ni0uODg0IDEuMTQ2LS44ODQgMS40MDEtMS4xNDUuMTIyLS4xMTguMTIyLS4xMTguMzIyLS4xMThsLjA2OS0uMTY5Yy4xNjgtLjI5Ni4zODUtLjQ5Ny42MzEtLjczMWwuMTY5LS4xODFDNDIgNDUuNSA0MiA0NS41IDQyLjIgNDUuNWwuMDc3LS4xNzFhNCA0IDAgMCAxIC40OTItLjY5MUM0NS4xNDYgNDEuNjk2IDQ2LjIxMiAzOC40OCA0NiAzNC43Yy0uMjExLTEuODI0LTEuMTA0LTMuNjM0LTIuNTQ1LTQuNzk4YTEzIDEzIDAgMCAwLS43NTUtLjUwMmwtLjE4OS0uMTE4Yy0yLjA5LTEuMTctNC45NjgtLjk2My03LjIxLS4zODRhMzkgMzkgMCAwIDAtMS4wMDEuMzAycS0uMzE5LjA5LS42MzcuMTc1bC0uMjcyLjA3My0uMTkxLjA1MmMuMzI0LS4zNTMuNjkyLS41MDMgMS4xMjUtLjY5NGwuMjQzLS4xMDdjMy4yMTItMS4zNzQgNy4yMzQtMS40MTEgOS45OTguOTI2IiBjbGFzcz0ibGlseSIvPjxwYXRoIGQ9Ik0zNi4wNTYgMzIuNjA2Yy41LjI4Mi44Ni42NDQgMS4wNDQgMS4xOTQuMDU0LjYzOC0uMDM1IDEuMDY4LS40IDEuNi0uMzkxLjQyOC0uNzA1LjU3NS0xLjI3LjYwNy0uNjA3LS4wMTgtMS4wOTEtLjE2OC0xLjUzLS42MDctLjQwNy0uNTY3LS4zODYtMS4xMjUtLjMtMS44LjE3NC0uNDg3LjQ4NC0uNzE5LjkzNy0uOTQ0LjU0NS0uMjA5Ljk1Ny0uMjE3IDEuNTItLjA1TTMuMSAzMy40Yy4xODQuMjc1LjI2My40OTQuMzUuODA5LjUyNiAxLjg4OSAxLjYzNCAzLjQ3OSAyLjg1IDQuOTkxbC4yMDUuMjZBMTguMyAxOC4zIDAgMCAwIDkuMSA0Mi4xbC4yMy4xOTdjMS41OTggMS4zNCAzLjMzMSAyLjQ4IDUuMTU2IDMuNDg1cS4yODIuMTU2LjU2MS4zMThjLjk1NS41MzggMS45NTIuOTYzIDIuOTY2IDEuMzc1bC4yMDMuMDgzYzEuMzE2LjUzNSAyLjYzOSAxLjAxMiA0LjAyOCAxLjMyM2wuMjgzLjA2Ni42NzMuMTUzdi4xYy0xLjczNC4wOTUtMy40NDktLjMwOC01LjEtLjhsLS4yNy0uMDc4Yy0yLjI1Ni0uNjY0LTQuNTExLTEuNjQ4LTYuNDMtMy4wMjJsLS4zNC0uMjMxQTIxLjEgMjEuMSAwIDAgMSA2IDQwLjJsLS4xOTItLjI1NEM0Ljc0IDM4LjQ4NCAzLjg0NyAzNi43NiAzLjQgMzVsLS4wODQtLjMxM0MzLjEgMzMuODYgMy4xIDMzLjg2IDMuMSAzMy40bTE1LjIgNi41Yy4xODEuMTE5LjE4MS4xMTkuMy4zLjA0NC4yNS4wNDQuMjUgMCAuNS0uMTY5LjE4OC0uMTY5LjE4OC0uNC4zLS4zMzctLjAyNC0uNDU5LS4wNTktLjctLjMtLjAzMS0uMy0uMDMxLS4zIDAtLjYuMzIzLS4yMTUuNDI1LS4yNDcuOC0uMm0yMS4zIDQuOGMwIC40MS0uMjEuNTc4LS40NzUuODYybC0uMTUuMTYyYy0uNTA3LjUzLTEuMDY1Ljk2Ny0xLjY3NSAxLjM3NmwtLjI3Mi4xODNjLTEuOTY1IDEuMjI3LTQuMTUgMS43MjktNi40MjggMS45MTcuMjc1LS4xODMuMzkyLS4yMzQuNy0uMjk0IDIuNzkyLS41NzYgNi4wMDItMS44MTYgNy45NzctMy45NzguMTIzLS4xMjguMTIzLS4xMjguMzIzLS4yMjhtLTI5LjUgMi42Yy41ODguMzYzLjU4OC4zNjMuNy43bC41LjJjLjI3OS4xOC41NDUuMzc5LjgxMy41NzUuNjQuNDYgMS4yODEuODY5IDEuOTg3IDEuMjI1bC4yNjkuMTRjLjcxNS4zNjUgMS40MzguNjggMi4xODcuOTY2bC4zNDIuMTMxYy44OTEuMzM1IDEuNzg0LjYwMiAyLjcxMS44MTdxLjI0Ny4wNi40OS4xMzJjMS4wNzIuMzA1IDIuMTk3LjM4OSAzLjMwMS41MTQtLjA4MS4yNDQtLjA4MS4yNDQtLjIuNS0uMzc0LjEyNS0uNjguMDc0LTEuMDYyLjAyNWwtLjIzLS4wMjktLjcwOC0uMDk2LS4yMTItLjAzYy0zLjkzMS0uNTcxLTcuNTM4LTIuMjM4LTEwLjM3LTUuMDI2bC0uMTU4LS4xNTZjLS4zNi0uMzYzLS4zNi0uMzYzLS4zNi0uNTg4bTMxLjMxMyAzLjAwNmMuMjg3LjA5NC4yODcuMDk0LjQ4Ny4zOTQuMDM4LjMuMDM4LjMgMCAuNi0uMjEyLjIzNS0uMzQ0LjI5Mi0uNjU2LjMzNy0uMjQ0LS4wMzctLjI0NC0uMDM3LS40MjUtLjE1LS4xNzctLjI3OC0uMTY1LS40NjQtLjExOS0uNzg3LjIyLS4zMy4zMS0uNDAyLjcxMi0uMzk0TTM2LjIgNTMuNGMuMjg4LS4wMTIuMjg4LS4wMTIuNiAwbC4yLjJjLS4wMzcuMzEzLS4wMzcuMzEzLS4xLjYtLjIzMS4wNjktLjIzMS4wNjktLjUuMS0uMTg3LS4xMDYtLjE4Ny0uMTA2LS4zLS4zLjAzMS0uMzE5LjAzMS0uMzE5LjEtLjZtLTMuMSAxLjcuNS4xdi40bC0uNC4yLS4yLS4yYy4wMzgtLjI2My4wMzgtLjI2My4xLS41IiBjbGFzcz0ibGlseSIvPjxnIGNsYXNzPSJsaWx5Ij48Y2lyY2xlIGN4PSIyOSIgY3k9IjciIHI9IjIuOSIvPjxjaXJjbGUgY3g9IjQzIiBjeT0iMjEiIHI9IjMuOSIvPjwvZz48L3N2Zz4=";

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/** Render markdown to HTML, wrapped in a scoped container. */
function md(markdown: string): string {
  return `<div class="md">${renderMarkdown(markdown)}</div>`;
}

/**
 * Truncate text to maxChars, breaking at the last sentence boundary or
 * whitespace before the limit. Appends "..." if truncated.
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  // Try to break at last sentence boundary
  const sentenceEnd = truncated.search(/[.!?]\s[^.!?]*$/);
  if (sentenceEnd > maxChars * 0.5)
    return `${truncated.slice(0, sentenceEnd + 1)} ...`;
  // Fall back to last whitespace
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.5) return `${truncated.slice(0, lastSpace)} ...`;
  return `${truncated}...`;
}

/** Render truncated markdown to HTML for search results. */
function _mdTruncated(markdown: string, maxChars = 500): string {
  return md(truncateText(markdown, maxChars));
}

// ---------------------------------------------------------------------------
// Chat bubble helpers (session conversation view)
// ---------------------------------------------------------------------------

function safeParseJSON(jsonStr: string): Record<string, unknown> | null {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

type MessageChunk =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; output: string }
  | { type: "reasoning"; content: string };

/**
 * Split a temporal message's content into typed chunks.
 * Content uses `"\n\x1f"` (CHUNK_TERMINATOR) between chunks, with tool
 * outputs prefixed `[tool:name] ` and reasoning prefixed `[reasoning] `.
 * Pre-F3b content (no \x1f) is treated as a single text chunk.
 */
function parseMessageChunks(content: string): MessageChunk[] {
  const CHUNK_SEPARATOR = "\n\x1f";
  const raw = content.includes("\x1f")
    ? content.split(CHUNK_SEPARATOR)
    : [content];

  return raw.map((chunk): MessageChunk => {
    if (chunk.startsWith("[tool:")) {
      const closeBracket = chunk.indexOf("] ");
      if (closeBracket >= 0) {
        const name = chunk.slice(6, closeBracket);
        const output = chunk.slice(closeBracket + 2);
        return { type: "tool", name, output };
      }
    }
    if (chunk.startsWith("[reasoning] ")) {
      return { type: "reasoning", content: chunk.slice(12) };
    }
    return { type: "text", content: chunk };
  });
}

/**
 * Render a single temporal message as a chat bubble.
 * User messages are right-aligned (blue), assistant messages left-aligned.
 * Tool calls and reasoning blocks are collapsible within the bubble.
 */
function renderChatBubble(
  msg: {
    role: string;
    content: string;
    tokens: number;
    created_at: number;
    metadata: string;
  },
  index: number,
): string {
  const isUser = msg.role === "user";
  const chunks = parseMessageChunks(msg.content);
  const meta = safeParseJSON(msg.metadata);

  // Build inner content from chunks
  let inner = "";
  for (const chunk of chunks) {
    switch (chunk.type) {
      case "text": {
        const text = truncateText(chunk.content, 2000);
        if (text.trim()) inner += `<div class="bubble-text">${md(text)}</div>`;
        break;
      }
      case "tool": {
        const toolOutput = truncateText(chunk.output, 1000);
        inner += `<details class="bubble-tool">
          <summary><span class="badge badge-toolcall">${esc(chunk.name)}</span></summary>
          <pre class="bubble-tool-output">${esc(toolOutput)}</pre>
        </details>`;
        break;
      }
      case "reasoning": {
        const text = truncateText(chunk.content, 1000);
        inner += `<details class="bubble-reasoning">
          <summary><span class="badge badge-reasoning">reasoning</span></summary>
          <div class="bubble-reasoning-content">${md(text)}</div>
        </details>`;
        break;
      }
    }
  }

  // Build metadata line
  let metaLine = `<span class="bubble-time">${formatDate(msg.created_at)}</span>`;
  if (isUser) {
    const agent = meta?.agent;
    if (agent && typeof agent === "string")
      metaLine = `<span class="bubble-agent">${esc(agent)}</span> &middot; ${metaLine}`;
  } else {
    const modelID = meta?.modelID;
    if (modelID && typeof modelID === "string")
      metaLine =
        `<span class="bubble-model">${esc(modelID)}</span> &middot; ` +
        metaLine;
    if (msg.tokens)
      metaLine += ` &middot; <span class="bubble-tokens">~${formatTokens(msg.tokens)} tokens</span>`;
  }

  const align = isUser ? "bubble-right" : "bubble-left";
  const color = isUser ? "bubble-user" : "bubble-assistant";

  return `<div class="bubble-row ${align}" id="msg-${index}" data-role="${esc(msg.role)}">
    <div class="bubble ${color}">
      ${inner}
      <div class="bubble-meta">${metaLine}</div>
    </div>
  </div>`;
}

function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00";
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * Render a labeled cost progress bar with optional ghost (counterfactual) outline.
 * `title` and `value` are escaped. `detailLeftHtml`/`detailRightHtml` accept
 * pre-sanitized trusted HTML (may contain entities like &times;).
 */
function renderCostBar(opts: {
  title: string;
  value: string;
  percent: number;
  tint?: string;
  ghostPercent?: number;
  detailLeftHtml?: string;
  detailRightHtml?: string;
}): string {
  const pct = Math.max(0, Math.min(100, opts.percent));
  const ghostHtml =
    opts.ghostPercent != null
      ? `<div class="cost-bar-ghost" style="width:${Math.min(100, opts.ghostPercent).toFixed(1)}%"></div>`
      : "";
  const detailHtml =
    opts.detailLeftHtml || opts.detailRightHtml
      ? `<div class="cost-bar-detail"><span>${opts.detailLeftHtml ?? ""}</span><span>${opts.detailRightHtml ?? ""}</span></div>`
      : "";
  return `<div class="cost-bar-container">
    <div class="cost-bar-label"><span class="bar-title">${esc(opts.title)}</span><span class="bar-value">${esc(opts.value)}</span></div>
    <div class="cost-bar">${ghostHtml}<div class="cost-bar-fill ${opts.tint ?? "bar-blue"}" style="width:${pct.toFixed(1)}%"></div></div>
    ${detailHtml}
  </div>`;
}

/** Render an inline mini progress bar for table cells. */
function renderMiniBar(percent: number, tint = "bar-green"): string {
  const pct = Math.max(0, Math.min(100, percent));
  return `<span class="mini-bar"><span class="mini-bar-fill ${tint}" style="width:${pct.toFixed(0)}%"></span></span>`;
}

function renderCostSummary(sessionId: string): string {
  const costs = getSessionCosts(sessionId);
  if (!costs || costs.conversation.turns === 0) return "";

  const actual = totalActualCost(costs);
  const workerCost = totalWorkerCost(costs);
  const savings = totalSavings(costs);
  const withoutLore = costWithoutLore(costs);

  const totalInput =
    costs.conversation.inputTokens +
    costs.conversation.cacheReadTokens +
    costs.conversation.cacheWriteTokens;
  const cacheHitRate =
    totalInput > 0
      ? ((costs.conversation.cacheReadTokens / totalInput) * 100).toFixed(0)
      : "0";

  const savingsPct =
    withoutLore > 0 ? ((savings / withoutLore) * 100).toFixed(0) : "0";

  let html = `<div class="card" style="margin-bottom:1.5em">
    <h2 style="margin-top:0">Cost Intelligence</h2>`;

  // Spend composition bar: conversation vs overhead
  const spendTotal = costs.conversation.cost + workerCost;
  const convPct =
    spendTotal > 0 ? (costs.conversation.cost / spendTotal) * 100 : 100;
  const overheadParts: string[] = [];
  if (costs.workers.distillation.cost > 0)
    overheadParts.push(
      `distill: ${formatUSD(costs.workers.distillation.cost)}`,
    );
  if (costs.workers.curation.cost > 0)
    overheadParts.push(`curate: ${formatUSD(costs.workers.curation.cost)}`);
  if (costs.workers.compaction.cost > 0)
    overheadParts.push(`compact: ${formatUSD(costs.workers.compaction.cost)}`);
  if (costs.workers.warmup.cost > 0)
    overheadParts.push(`warmup: ${formatUSD(costs.workers.warmup.cost)}`);
  if (costs.workers.recall.cost > 0)
    overheadParts.push(`recall: ${formatUSD(costs.workers.recall.cost)}`);
  const overheadDetail = overheadParts.length
    ? ` (${overheadParts.join(", ")})`
    : "";
  html += renderCostBar({
    title: "Your Spend",
    value: formatUSD(actual),
    percent: convPct,
    tint: "bar-green",
    detailLeftHtml: `Conversation: ${formatUSD(costs.conversation.cost)} (${costs.conversation.turns} turns)`,
    detailRightHtml:
      workerCost > 0
        ? `Overhead: ${formatUSD(workerCost)}${overheadDetail}`
        : "",
  });

  // Cache hit rate bar
  if (totalInput > 0) {
    html += renderCostBar({
      title: "Cache Hit Rate",
      value: `${cacheHitRate}%`,
      percent: parseFloat(cacheHitRate),
      tint: "bar-green",
      detailLeftHtml: `${formatTokens(totalInput)} in, ${formatTokens(costs.conversation.outputTokens)} out`,
      detailRightHtml: `${formatTokens(costs.conversation.cacheReadTokens)} cache reads`,
    });
  }

  // Savings ratio bar: actual vs counterfactual
  if (withoutLore > 0) {
    const actualPct = (actual / withoutLore) * 100;
    html += renderCostBar({
      title: "Actual vs Without Lore",
      value: `${formatUSD(actual)} of ${formatUSD(withoutLore)}`,
      percent: actualPct,
      tint: savings >= 0 ? "bar-blue" : "bar-red",
      ghostPercent: 100,
      detailLeftHtml:
        savings >= 0
          ? `Saved: ${formatUSD(savings)} (${savingsPct}%)`
          : `Net overhead: ${formatUSD(-savings)}`,
      detailRightHtml: "",
    });
  }

  // Savings breakdown (compact)
  if (savings > 0) {
    const items: string[] = [];
    if (costs.counterfactual.warmupSavings > 0)
      items.push(
        `Cache warming: ${formatUSD(costs.counterfactual.warmupSavings)} (${costs.counterfactual.warmupHits} hits)`,
      );
    if (costs.counterfactual.ttlSavings > 0)
      items.push(
        `1h TTL: ${formatUSD(costs.counterfactual.ttlSavings)} (${costs.counterfactual.ttlHits} turns)`,
      );
    if (costs.batchSavings > 0)
      items.push(`Batch API: ${formatUSD(costs.batchSavings)}`);
    if (costs.counterfactual.avoidedCompactionCost > 0)
      items.push(
        `Avoided compactions: ${formatUSD(costs.counterfactual.avoidedCompactionCost)} (&times;${costs.counterfactual.avoidedCompactions})`,
      );
    if (items.length) {
      html += `<div style="margin-top:10px;font-size:0.85em;color:var(--fg2)">
        <strong style="color:#10b981">Savings breakdown:</strong> ${items.join(" &middot; ")}
      </div>`;
    }
  } else if (savings < 0) {
    html += `<div style="margin-top:10px;font-size:0.85em;color:#e06c75">
      <strong>Net overhead: ${formatUSD(-savings)}</strong> &mdash; Lore overhead exceeds savings this session
    </div>`;
  }

  // Budget throttle diagnostics
  if (costs.throttle.events > 0) {
    const totalDelaySec = (costs.throttle.totalDelayMs / 1000).toFixed(1);
    html += `<div style="margin-top:10px;font-size:0.85em;color:var(--fg2)">
      <strong style="color:#f59e0b">Budget throttle:</strong> ${costs.throttle.events} event${costs.throttle.events === 1 ? "" : "s"}, ${totalDelaySec}s total delay
    </div>`;
  }

  html += `</div>`;
  return html;
}

function truncate(str: string, max: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}\u2026`;
}

const CSS = `
:root {
  --bg: #ffffff; --bg2: #f5f5f5; --bg3: #e8e8e8;
  --fg: #1a1a1a; --fg2: #555; --fg3: #888;
  --accent: #2563eb; --accent-hover: #1d4ed8;
  --danger: #dc2626; --danger-hover: #b91c1c;
  --border: #d4d4d4; --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111; --bg2: #1a1a1a; --bg3: #2a2a2a;
    --fg: #e5e5e5; --fg2: #aaa; --fg3: #777;
    --accent: #60a5fa; --accent-hover: #93bbfd;
    --danger: #f87171; --danger-hover: #fca5a5;
    --border: #333; 
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font); background: var(--bg); color: var(--fg); line-height: 1.5; }
.container { max-width: 960px; margin: 0 auto; padding: 16px 20px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { margin: 16px 0 8px; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.2em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
nav { padding: 12px 20px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
nav .brand { font-weight: 700; color: var(--fg); font-size: 1.1em; }
nav a { font-size: 0.9em; }
.stats { display: flex; gap: 24px; flex-wrap: wrap; margin: 12px 0; }
.stat { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; min-width: 120px; }
.stat .label { font-size: 0.8em; color: var(--fg3); text-transform: uppercase; }
.stat .value { font-size: 1.4em; font-weight: 600; }
.stat .value .total { font-size: 0.7em; font-weight: 400; color: var(--fg3); }
.stat-filter { cursor: pointer; transition: border-color 0.15s; user-select: none; }
.stat-filter:hover { border-color: var(--accent); }
.stat-filter.active { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.9em; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { background: var(--bg2); font-weight: 600; font-size: 0.85em; color: var(--fg2); text-transform: uppercase; }
tr:hover { background: var(--bg2); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; font-weight: 600;
  background: var(--bg3); color: var(--fg2); }
.badge-architecture { background: #dbeafe; color: #1e40af; }
.badge-pattern { background: #dcfce7; color: #166534; }
.badge-gotcha { background: #fef3c7; color: #92400e; }
.badge-decision { background: #f3e8ff; color: #6b21a8; }
.badge-preference { background: #fce7f3; color: #9d174d; }
.badge-person { background: #dbeafe; color: #1e40af; }
.badge-org { background: #f3e8ff; color: #6b21a8; }
.badge-service { background: #dcfce7; color: #166534; }
.badge-tool { background: #fef3c7; color: #92400e; }
.badge-repo { background: #e0e7ff; color: #3730a3; }
.badge-infra { background: #fce7f3; color: #9d174d; }
@media (prefers-color-scheme: dark) {
  .badge-architecture { background: #1e3a5f; color: #93c5fd; }
  .badge-pattern { background: #14532d; color: #86efac; }
  .badge-gotcha { background: #451a03; color: #fcd34d; }
  .badge-decision { background: #3b0764; color: #d8b4fe; }
  .badge-preference { background: #500724; color: #f9a8d4; }
  .badge-person { background: #1e3a5f; color: #93c5fd; }
  .badge-org { background: #3b0764; color: #d8b4fe; }
  .badge-service { background: #14532d; color: #86efac; }
  .badge-tool { background: #451a03; color: #fcd34d; }
  .badge-repo { background: #1e1b4b; color: #a5b4fc; }
  .badge-infra { background: #500724; color: #f9a8d4; }
}
.btn { display: inline-block; padding: 6px 14px; border-radius: var(--radius); font-size: 0.85em;
  font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--bg2); color: var(--fg); text-decoration: none; }
.btn:hover { background: var(--bg3); text-decoration: none; }
.btn-danger { background: var(--danger); color: white; border-color: var(--danger); }
.btn-danger:hover { background: var(--danger-hover); }
.btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); }
pre { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 0.85em; white-space: pre-wrap; word-break: break-word; }
.field { margin: 6px 0; }
.field .key { font-weight: 600; color: var(--fg2); min-width: 130px; display: inline-block; }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin: 8px 0; }
.card h3 { margin: 0 0 4px; font-size: 1em; }
.card .meta { font-size: 0.8em; color: var(--fg3); }
form.inline { display: inline; }
.search-form { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: end; }
.search-form input[type="text"] { flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.95em; background: var(--bg); color: var(--fg); }
.search-form select { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font-size: 0.9em; }
.result-list { list-style: none; padding: 0; margin: 0; }
.result-item { padding: 8px 12px; margin: 4px 0; background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.9em; line-height: 1.5; }
.result-item .score { float: right; font-size: 0.75em; color: var(--fg3); opacity: 0.6; font-family: var(--mono); }
.result-item .meta { font-size: 0.8em; color: var(--fg3); }
.result-item .id-link { font-size: 0.75em; color: var(--accent); font-family: var(--mono); opacity: 0.7;
  text-decoration: none; margin-left: 4px; }
.result-item .id-link:hover { opacity: 1; text-decoration: underline; }
.result-summary { font-size: 0.9em; color: var(--fg3); margin: 8px 0; }
.cost-table td { padding: 4px 10px; font-size: 0.9em; }
.cost-table .section-header td { padding-top: 0.6em; }
/* --- Cost progress bars (inspired by CodexBar MetricRow) --- */
.cost-bar-container { margin: 8px 0; }
.cost-bar-label {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 0.85em; margin-bottom: 4px;
}
.cost-bar-label .bar-title { font-weight: 600; }
.cost-bar-label .bar-value { color: var(--fg2); font-family: var(--mono); }
.cost-bar {
  position: relative; height: 20px; background: var(--bg3);
  border-radius: 4px; overflow: hidden;
}
.cost-bar-fill {
  height: 100%; border-radius: 4px; transition: width 0.2s; min-width: 2px;
}
.cost-bar-ghost {
  position: absolute; top: 0; left: 0; height: 100%;
  border: 2px dashed var(--fg3); border-radius: 4px;
  opacity: 0.4; box-sizing: border-box;
}
.cost-bar-detail {
  display: flex; justify-content: space-between;
  font-size: 0.8em; color: var(--fg3); margin-top: 3px;
}
/* Tint colors */
.bar-green  { background: #10b981; }
.bar-blue   { background: #60a5fa; }
.bar-amber  { background: #f59e0b; }
.bar-red    { background: #ef4444; }
/* --- Savings hero stat --- */
.savings-hero {
  text-align: center; padding: 16px; margin: 12px 0;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--radius);
}
.savings-hero .big-number {
  font-size: 2.2em; font-weight: 700; line-height: 1.2;
}
.savings-hero .sub-label {
  font-size: 0.9em; color: var(--fg3); margin-top: 2px;
}
/* --- Inline mini bar (for table cells) --- */
.mini-bar {
  display: inline-block; width: 48px; height: 8px;
  background: var(--bg3); border-radius: 3px;
  overflow: hidden; vertical-align: middle; margin-right: 4px;
}
.mini-bar-fill { display: block; height: 100%; border-radius: 3px; }
/* --- Daily cost trend chart --- */
.daily-chart {
  display: flex; align-items: flex-end; gap: 3px;
  height: 120px; padding: 8px 0; margin: 12px 0;
  border-bottom: 1px solid var(--border);
}
.day-col {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end;
  min-width: 0; height: 100%;
}
.day-bar {
  width: 100%; background: #60a5fa; border-radius: 2px 2px 0 0;
  min-height: 2px; flex-shrink: 0;
}
.day-label {
  font-size: 0.65em; color: var(--fg3); margin-top: 4px;
  white-space: nowrap; overflow: hidden; flex-shrink: 0;
}
.actions { margin: 16px 0; display: flex; gap: 8px; }
.empty { color: var(--fg3); font-style: italic; padding: 24px 0; text-align: center; }
.md { font-size: 0.9em; line-height: 1.6; overflow-wrap: break-word; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px; font-weight: 600; }
.md h1 { font-size: 1.3em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; }
.md p { margin: 6px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 24px; }
.md li { margin: 2px 0; }
.md pre { background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 12px; overflow-x: auto; font-family: var(--mono); font-size: 0.9em; margin: 6px 0; }
.md code { font-family: var(--mono); font-size: 0.9em; background: var(--bg3); padding: 1px 4px; border-radius: 3px; }
.md pre code { background: none; padding: 0; font-size: 1em; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 12px; margin: 6px 0; color: var(--fg2); }
.md a { color: var(--accent); }
.md hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.md table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 0.9em; }
.md th, .md td { text-align: left; padding: 6px 8px; border: 1px solid var(--border); }
.md th { background: var(--bg2); font-weight: 600; }
.md img { max-width: 100%; }
th[data-sort] { cursor: pointer; user-select: none; white-space: nowrap; }
th[data-sort]:hover { color: var(--accent); }
th[data-sort]::after { content: " \\21C5"; font-size: 0.7em; opacity: 0.3; }
th[data-sort].asc::after { content: " \\25B2"; opacity: 0.8; }
th[data-sort].desc::after { content: " \\25BC"; opacity: 0.8; }
.table-filter { margin: 8px 0 4px; display: flex; gap: 8px; align-items: center; }
.table-filter input { padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--bg); color: var(--fg);
  font-size: 0.85em; width: 260px; }
.table-filter .count { font-size: 0.8em; color: var(--fg3); }
/* --- Cache warming histogram bars --- */
.histogram { margin: 8px 0; }
.histogram .bin {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.8em; font-family: var(--mono); line-height: 1.8;
}
.histogram .bin-label {
  width: 48px; text-align: right; color: var(--fg3); flex-shrink: 0;
}
.histogram .bin-bars {
  flex: 1; position: relative; height: 14px;
  background: var(--bg3); border-radius: 2px; overflow: hidden;
}
.histogram .bin-bar {
  position: absolute; top: 0; left: 0; height: 100%;
  border-radius: 2px; opacity: 0.7;
}
.histogram .bin-bar.session { background: #60a5fa; z-index: 2; }
.histogram .bin-bar.global  { background: #888; z-index: 1; }
.histogram .bin-bar.blended { background: #34d399; z-index: 3; }
.histogram .bin-pct {
  width: 42px; font-size: 0.75em; color: var(--fg3); flex-shrink: 0;
}
.histogram .bin-ttl-marker {
  color: var(--danger); font-weight: 600; font-size: 0.75em; margin-left: 4px;
}
.histogram-legend {
  display: flex; gap: 16px; font-size: 0.75em; color: var(--fg3); margin: 4px 0 8px;
}
.histogram-legend span::before {
  content: ""; display: inline-block; width: 10px; height: 10px;
  border-radius: 2px; margin-right: 4px; vertical-align: middle;
}
.histogram-legend .leg-session::before { background: #60a5fa; }
.histogram-legend .leg-global::before  { background: #888; }
.histogram-legend .leg-blended::before { background: #34d399; }
/* --- Expandable details --- */
details.warming { margin: 8px 0; }
details.warming summary {
  cursor: pointer; font-weight: 600; font-size: 0.9em;
  color: var(--fg2); padding: 6px 0;
}
details.warming summary:hover { color: var(--accent); }
details.warming[open] summary { margin-bottom: 8px; }
/* --- Circuit breaker bar --- */
.cb-bar {
  display: inline-block; width: 120px; height: 12px;
  background: var(--bg3); border-radius: 6px; overflow: hidden;
  vertical-align: middle; margin: 0 8px;
}
.cb-bar-fill { height: 100%; border-radius: 6px; transition: width 0.3s; }
.cb-ok .cb-bar-fill { background: #34d399; }
.cb-warn .cb-bar-fill { background: #fbbf24; }
.cb-tripped .cb-bar-fill { background: #f87171; }
/* --- Warming status badges --- */
.badge-warming { background: #dcfce7; color: #166534; }
.badge-waiting { background: #dbeafe; color: #1e40af; }
.badge-dead { background: #fef2f2; color: #991b1b; }
.badge-stopped { background: #fef2f2; color: #991b1b; }
.badge-forced { background: #f3e8ff; color: #6b21a8; }
.badge-disabled { background: var(--bg3); color: var(--fg3); }
.badge-toolcall { background: #dbeafe; color: #1e40af; }
@media (prefers-color-scheme: dark) {
  .badge-warming { background: #14532d; color: #86efac; }
  .badge-waiting { background: #1e3a5f; color: #93c5fd; }
  .badge-dead { background: #450a0a; color: #fca5a5; }
  .badge-stopped { background: #450a0a; color: #fca5a5; }
  .badge-forced { background: #3b0764; color: #d8b4fe; }
  .badge-disabled { background: var(--bg3); color: var(--fg3); }
  .badge-toolcall { background: #1e3a5f; color: #93c5fd; }
}
/* --- Warming mode controls --- */
.warming-controls { display: inline-flex; gap: 2px; margin-left: 6px; }
.warming-controls form.inline { margin: 0; }
.btn-sm { display: inline-block; padding: 2px 8px; border-radius: var(--radius); font-size: 0.75em;
  background: var(--bg2); color: var(--fg2); border: 1px solid var(--border); cursor: pointer; }
.btn-sm:hover { background: var(--bg3); }
.btn-sm.btn-active { background: var(--accent); color: white; border-color: var(--accent); }
/* --- Subagent tree rows --- */
.subagent-row { display: none; }
.subagent-row.expanded { display: table-row; }
.subagent-row td:nth-child(2) { padding-left: 1.8em; }
.toggle-btn { cursor: pointer; user-select: none; font-size: 0.8em; margin-right: 4px; opacity: 0.6; }
.toggle-btn:hover { opacity: 1; }
.subagent-count { font-size: 0.75em; color: var(--fg3); margin-left: 4px; }
/* --- Chat bubble conversation view --- */
.chat-header {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 8px; margin: 16px 0 8px;
}
.chat-header h2 { margin: 0; border: none; padding: 0; }
.chat-filter { display: flex; align-items: center; gap: 8px; }
.chat-filter input {
  padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font-size: 0.85em; width: 220px;
}
.chat-filter-count { font-size: 0.8em; color: var(--fg3); }
.chat-container {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 0; max-width: 100%;
}
.bubble-row { display: flex; max-width: 100%; }
.bubble-right { justify-content: flex-end; }
.bubble-left  { justify-content: flex-start; }
.bubble {
  max-width: 80%; padding: 10px 14px; border-radius: 12px;
  font-size: 0.9em; line-height: 1.5; overflow-wrap: break-word; word-break: break-word;
}
.bubble-user {
  background: var(--accent); color: white; border-bottom-right-radius: 4px;
}
.bubble-assistant {
  background: var(--bg2); border: 1px solid var(--border); border-bottom-left-radius: 4px;
}
@media (prefers-color-scheme: dark) {
  .bubble-user { background: #1e40af; }
}
.bubble-text .md { margin: 0; }
.bubble-text .md p:first-child { margin-top: 0; }
.bubble-text .md p:last-child  { margin-bottom: 0; }
/* User bubble overrides for readability on blue background */
.bubble-user .md code { background: rgba(255,255,255,0.15); color: inherit; }
.bubble-user .md pre { background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.15); color: inherit; }
.bubble-user .md pre code { background: none; }
.bubble-user .md a { color: #fff; text-decoration: underline; }
.bubble-user .md blockquote { border-left-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.85); }
/* Tool call blocks (collapsed by default) */
.bubble-tool { margin: 6px 0; }
.bubble-tool summary { cursor: pointer; font-size: 0.85em; list-style: none; }
.bubble-tool summary::-webkit-details-marker { display: none; }
.bubble-tool summary::before { content: "\\25B6 "; font-size: 0.75em; }
.bubble-tool[open] summary::before { content: "\\25BC "; }
.bubble-tool-output {
  margin: 6px 0 0; padding: 8px 10px; font-size: 0.8em;
  max-height: 300px; overflow-y: auto;
  background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius);
}
/* Reasoning blocks (collapsed by default) */
.bubble-reasoning { margin: 6px 0; }
.bubble-reasoning summary { cursor: pointer; font-size: 0.85em; list-style: none; }
.bubble-reasoning summary::-webkit-details-marker { display: none; }
.bubble-reasoning summary::before { content: "\\25B6 "; font-size: 0.75em; }
.bubble-reasoning[open] summary::before { content: "\\25BC "; }
.bubble-reasoning-content {
  margin: 6px 0 0; padding: 8px 12px;
  background: var(--bg3); border-left: 3px solid #a78bfa;
  border-radius: 0 var(--radius) var(--radius) 0;
  font-size: 0.85em; font-style: italic; color: var(--fg2);
}
.badge-reasoning { background: #f3e8ff; color: #6b21a8; }
@media (prefers-color-scheme: dark) {
  .badge-reasoning { background: #3b0764; color: #d8b4fe; }
}
/* Metadata line below bubble content */
.bubble-meta {
  margin-top: 6px; font-size: 0.75em; color: var(--fg3);
  display: flex; gap: 4px; flex-wrap: wrap;
}
.bubble-user .bubble-meta { color: rgba(255,255,255,0.7); }
/* Chat search filter states */
.bubble-row.filtered-out { display: none; }
.bubble-row.search-hit .bubble { box-shadow: 0 0 0 2px var(--accent); }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Lore</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
<style>${CSS}</style>
</head>
<body>
<nav>
  <span class="brand">Lore</span>
  <a href="/ui">Dashboard</a>
  <a href="/ui/knowledge">Knowledge</a>
  <a href="/ui/entities">Entities</a>
  <a href="/ui/search">Search</a>
  <a href="/ui/costs">Costs</a>
  <a href="/ui/warming">Warming</a>
</nav>
<div class="container">
${body}
</div>
<script>
document.addEventListener("DOMContentLoaded",function(){
  function parseNum(s){
    s=s.replace(/[$,]/g,"");
    var m=s.match(/([-\\d.]+)\\s*([KMB])?/i);
    if(!m)return 0;
    var n=parseFloat(m[1])||0;
    if(m[2])n*={K:1e3,M:1e6,B:1e9}[m[2].toUpperCase()]||1;
    return n;
  }
  function parseDateVal(s){
    s=s.trim();
    if(s==="just now")return 0;
    var m=s.match(/^(\\d+)([mhd])\\s+ago$/);
    if(m){var n=parseInt(m[1]);return n*({m:1,h:60,d:1440}[m[2]]||1);}
    var ts=Date.parse(s);
    return isNaN(ts)?Infinity:(Date.now()-ts)/60000;
  }
  // Sorting — treats parent+child rows as a unit so tree adjacency is preserved.
  function sortTable(th,dir){
    var table=th.closest("table");
    var tbody=table.querySelector("tbody")||table;
    var idx=Array.from(th.parentNode.children).indexOf(th);
    var type=th.dataset.sort;
    th.parentNode.querySelectorAll("th").forEach(function(h){h.classList.remove("asc","desc");});
    th.classList.add(dir);
    var allRows=Array.from(tbody.querySelectorAll("tr")).filter(function(r){return!r.querySelector("th");});
    // Separate root rows from child (subagent) rows
    var roots=[];var childMap={};
    allRows.forEach(function(r){
      var p=r.dataset.parent;
      if(p){if(!childMap[p])childMap[p]=[];childMap[p].push(r);}
      else{roots.push(r);}
    });
    // Sort only root rows
    roots.sort(function(a,b){
      var aT=(a.children[idx]||{textContent:""}).textContent.trim();
      var bT=(b.children[idx]||{textContent:""}).textContent.trim();
      var cmp=0;
      if(type==="num"){cmp=parseNum(aT)-parseNum(bT);}
      else if(type==="date"){cmp=parseDateVal(aT)-parseDateVal(bT);}
      else{cmp=aT.localeCompare(bT,undefined,{sensitivity:"base"});}
      return dir==="asc"?cmp:-cmp;
    });
    // Re-append: each root followed by its children (preserving tree adjacency)
    roots.forEach(function(r){
      tbody.appendChild(r);
      // Find session ID from the toggle button or from children that reference this row
      var btn=r.querySelector(".toggle-btn");
      var sid=btn?btn.dataset.sessionId:null;
      if(sid&&childMap[sid]){childMap[sid].forEach(function(c){tbody.appendChild(c);});}
    });
    var tableId=table.dataset.tableId;
    if(tableId){
      try{localStorage.setItem("lore-sort:"+tableId,JSON.stringify({col:idx,dir:dir}));}
      catch(e){}
    }
  }
  document.querySelectorAll("th[data-sort]").forEach(function(th){
    th.addEventListener("click",function(){
      var isAsc=th.classList.contains("asc");
      sortTable(th,isAsc?"desc":"asc");
    });
  });
  // Restore saved sort or apply defaults
  document.querySelectorAll("table[data-table-id]").forEach(function(table){
    var tableId=table.dataset.tableId;
    var headerRow=table.querySelector("tr");
    if(!headerRow)return;
    var ths=headerRow.querySelectorAll("th[data-sort]");
    if(!ths.length)return;
    var saved=null;
    try{
      var raw=localStorage.getItem("lore-sort:"+tableId);
      if(raw)saved=JSON.parse(raw);
    }catch(e){}
    if(saved&&saved.col!=null&&(saved.dir==="asc"||saved.dir==="desc")){
      var allThs=Array.from(headerRow.children);
      var th=allThs[saved.col];
      if(th&&th.dataset&&th.dataset.sort){
        sortTable(th,saved.dir);
        return;
      }
    }
    var defaultTh=headerRow.querySelector("th[data-default-sort]");
    if(defaultTh){
      sortTable(defaultTh,defaultTh.dataset.defaultSort);
    }
  });
  // Subagent tree toggle
  document.addEventListener("click",function(e){
    var btn=e.target.closest(".toggle-btn");
    if(!btn)return;
    var sid=btn.dataset.sessionId;
    if(!sid)return;
    var rows=document.querySelectorAll('tr[data-parent="'+sid+'"]');
    var expanding=rows.length>0&&!rows[0].classList.contains("expanded");
    rows.forEach(function(r){r.classList.toggle("expanded",expanding);});
    btn.textContent=expanding?"\u25BC":"\u25B6";
  });
  // Filtering — respects tree structure: matching a parent shows it (children stay
  // collapsed), matching a child auto-shows the parent and expands the child.
  document.querySelectorAll(".table-filter input").forEach(function(input){
    var wrapper=input.closest(".table-filter");
    var table=wrapper.nextElementSibling;
    if(!table||table.tagName!=="TABLE")return;
    // Skip tables with custom filter logic (e.g. entity stat-filter)
    if(table.dataset.customFilter!==undefined)return;
    var countEl=wrapper.querySelector(".count");
    var allRows=Array.from(table.querySelectorAll("tr")).filter(function(r){return!r.querySelector("th");});
    input.addEventListener("input",function(){
      var q=input.value.toLowerCase();
      if(!q){
        // Reset: show all roots, hide all children (collapsed state)
        allRows.forEach(function(r){
          if(r.dataset.parent){r.style.display="";r.classList.remove("expanded");}
          else{r.style.display="";}
        });
        // Reset toggle buttons
        table.querySelectorAll(".toggle-btn").forEach(function(b){b.textContent="\u25B6";});
        if(countEl)countEl.textContent="";
        return;
      }
      // First pass: determine which rows match the query
      var matchSet=new Set();
      allRows.forEach(function(r){
        if(r.textContent.toLowerCase().indexOf(q)!==-1)matchSet.add(r);
      });
      // Second pass: for matching children, also include their parent
      var parentShowSet=new Set();
      allRows.forEach(function(r){
        if(r.dataset.parent&&matchSet.has(r)){parentShowSet.add(r.dataset.parent);}
      });
      // Third pass: apply visibility
      var shown=0;
      allRows.forEach(function(r){
        var isChild=!!r.dataset.parent;
        if(isChild){
          // Show child if it matches (and auto-expand)
          var show=matchSet.has(r);
          r.style.display=show?"":"none";
          if(show){r.classList.add("expanded");shown++;}
          else{r.classList.remove("expanded");}
        }else{
          // Show root if it matches OR if any of its children match
          var btn=r.querySelector(".toggle-btn");
          var sid=btn?btn.dataset.sessionId:null;
          var show=matchSet.has(r)||(sid&&parentShowSet.has(sid));
          r.style.display=show?"":"none";
          if(show)shown++;
          // Update toggle state if children were auto-expanded
          if(btn&&sid&&parentShowSet.has(sid)){btn.textContent="\u25BC";}
          else if(btn){btn.textContent="\u25B6";}
        }
      });
      if(countEl)countEl.textContent=shown+"/"+allRows.filter(function(r){return!r.dataset.parent;}).length;
    });
  });
  // Stat-card type filter (entity list page): clicking a stat card filters the
  // table to show only entities of that type; clicking again (or "Total") clears.
  // Composes with the text filter above — both must pass for a row to be visible.
  (function(){
    var stats=document.querySelectorAll(".stat-filter");
    if(!stats.length)return;
    var statsContainer=stats[0].parentElement;
    var table=statsContainer?statsContainer.parentElement.querySelector("table[data-table-id]"):null;
    if(!table)return;
    var allRows=Array.from(table.querySelectorAll("tr")).filter(function(r){return!r.querySelector("th");});
    var textInput=statsContainer.parentElement.querySelector(".table-filter input");
    var countEl=statsContainer.parentElement.querySelector(".table-filter .count");
    var activeType=null;
    function applyFilters(){
      var q=textInput?textInput.value.toLowerCase():"";
      var shown=0;var total=allRows.length;
      allRows.forEach(function(r){
        var typeMatch=!activeType||r.dataset.entityType===activeType;
        var textMatch=!q||r.textContent.toLowerCase().indexOf(q)!==-1;
        var show=typeMatch&&textMatch;
        r.style.display=show?"":"none";
        if(show)shown++;
      });
      if(countEl){
        if(q||activeType)countEl.textContent=shown+"/"+total;
        else countEl.textContent="";
      }
    }
    stats.forEach(function(stat){
      stat.addEventListener("click",function(){
        var type=stat.dataset.typeFilter;
        if(type==="all"||activeType===type){
          activeType=null;
          stats.forEach(function(s){s.classList.remove("active");});
        }else{
          activeType=type;
          stats.forEach(function(s){s.classList.remove("active");});
          stat.classList.add("active");
        }
        applyFilters();
      });
    });
    // Override the text filter to use combined logic when a type filter is active
    if(textInput){
      textInput.addEventListener("input",function(){
        applyFilters();
      });
    }
  })();
  // Chat message filter (session page only)
  var chatSearch=document.getElementById("chat-search");
  var chatContainer=document.getElementById("chat-container");
  if(chatSearch&&chatContainer){
    var chatCount=document.getElementById("chat-search-count");
    var bubbleRows=Array.from(chatContainer.querySelectorAll(".bubble-row"));
    var chatDebounce;
    chatSearch.addEventListener("input",function(){
      clearTimeout(chatDebounce);
      chatDebounce=setTimeout(function(){
        var q=chatSearch.value.toLowerCase().trim();
        if(!q){
          bubbleRows.forEach(function(r){r.classList.remove("filtered-out","search-hit");});
          if(chatCount)chatCount.textContent="";
          return;
        }
        var hits=0;
        bubbleRows.forEach(function(r){
          var text=r.textContent.toLowerCase();
          if(text.indexOf(q)!==-1){
            r.classList.remove("filtered-out");
            r.classList.add("search-hit");
            hits++;
          }else{
            r.classList.add("filtered-out");
            r.classList.remove("search-hit");
          }
        });
        if(chatCount)chatCount.textContent=hits+"/"+bubbleRows.length+" messages";
      },150);
    });
  }
});
</script>
</body>
</html>`;
}

function badge(text: string): string {
  const cls = `badge badge-${text.toLowerCase().replace(/[^a-z]/g, "")}`;
  return `<span class="${cls}">${esc(text)}</span>`;
}

function deleteForm(action: string, label: string, confirmMsg: string): string {
  return `<form class="inline" method="POST" action="${esc(action)}" onsubmit="return confirm('${esc(confirmMsg)}')">
    <button type="submit" class="btn btn-danger">${esc(label)}</button>
  </form>`;
}

function breadcrumb(items: Array<{ label: string; href?: string }>): string {
  return `<p style="font-size:0.85em;color:var(--fg3);margin:8px 0;">${items
    .map((item, i) =>
      item.href && i < items.length - 1
        ? `<a href="${esc(item.href)}">${esc(item.label)}</a>`
        : `<span>${esc(item.label)}</span>`,
    )
    .join(" &rsaquo; ")}</p>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: url },
  });
}

// ---------------------------------------------------------------------------
// Cache warming helpers
// ---------------------------------------------------------------------------

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Human-readable histogram bin label. */
function binLabel(index: number): string {
  if (index >= HISTOGRAM_BINS.length) return ">4h";
  const ms = HISTOGRAM_BINS[index];
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Return a TTL boundary label if this bin edge is a TTL boundary. */
function ttlMarker(index: number): string | null {
  if (index >= HISTOGRAM_BINS.length) return null;
  const ms = HISTOGRAM_BINS[index];
  if (ms === 300_000) return "5m TTL";
  if (ms === 3_600_000) return "1h TTL";
  return null;
}

/**
 * Render a CSS bar chart for up to 3 overlaid histograms.
 * Bars are scaled relative to the max count across all provided histograms.
 */
function renderHistogram(opts: {
  session?: InterTurnHistogram;
  global?: InterTurnHistogram;
  blended?: InterTurnHistogram;
}): string {
  let maxCount = 1;
  for (const h of [opts.session, opts.global, opts.blended]) {
    if (!h) continue;
    for (const c of h.counts) {
      if (c > maxCount) maxCount = c;
    }
  }

  const binCount = HISTOGRAM_BINS.length + 1;
  let html = `<div class="histogram">`;

  for (let i = 0; i < binCount; i++) {
    const label = binLabel(i);
    const marker = ttlMarker(i);

    const sPct = opts.session ? (opts.session.counts[i] / maxCount) * 100 : 0;
    const gPct = opts.global ? (opts.global.counts[i] / maxCount) * 100 : 0;
    const bPct = opts.blended ? (opts.blended.counts[i] / maxCount) * 100 : 0;

    const displayHist = opts.blended ?? opts.session ?? opts.global;
    const displayPct =
      displayHist && displayHist.total > 0
        ? `${((displayHist.counts[i] / displayHist.total) * 100).toFixed(0)}%`
        : "";

    html += `<div class="bin">`;
    html += `<span class="bin-label">${esc(label)}</span>`;
    html += `<span class="bin-bars">`;
    if (gPct > 0)
      html += `<span class="bin-bar global" style="width:${gPct.toFixed(1)}%"></span>`;
    if (sPct > 0)
      html += `<span class="bin-bar session" style="width:${sPct.toFixed(1)}%"></span>`;
    if (bPct > 0)
      html += `<span class="bin-bar blended" style="width:${bPct.toFixed(1)}%"></span>`;
    html += `</span>`;
    html += `<span class="bin-pct">${displayPct}</span>`;
    if (marker) html += `<span class="bin-ttl-marker">${esc(marker)}</span>`;
    html += `</div>`;
  }

  html += `</div>`;

  // Legend
  const layers: string[] = [];
  if (opts.session)
    layers.push(
      `<span class="leg-session">Session (${opts.session.total} obs)</span>`,
    );
  if (opts.global)
    layers.push(
      `<span class="leg-global">Global (${opts.global.total} obs)</span>`,
    );
  if (opts.blended) layers.push(`<span class="leg-blended">Blended</span>`);
  if (layers.length > 1) {
    html += `<div class="histogram-legend">${layers.join("")}</div>`;
  }

  return html;
}

/** Render a warming status badge from a snapshot. */
function warmingStatusBadge(snap: WarmingSnapshot): string {
  if (snap.circuitBreaker.tripped)
    return `<span class="badge badge-dead">TRIPPED</span>`;
  if (snap.disabled) return `<span class="badge badge-stopped">stopped</span>`;
  if (snap.toolCallActive)
    return `<span class="badge badge-toolcall">tool call</span>`;
  if (snap.forceKeepWarm)
    return `<span class="badge badge-forced">forced</span>`;
  if (snap.shouldWarmNow)
    return `<span class="badge badge-warming">warming</span>`;
  return `<span class="badge badge-waiting">waiting</span>`;
}

/** Render warming mode toggle buttons (auto/keep/stop) for a live session. */
function warmingModeControls(sessionId: string, snap: WarmingSnapshot): string {
  const modes: Array<{ mode: string; label: string; active: boolean }> = [
    {
      mode: "auto",
      label: "Auto",
      active: !snap.disabled && !snap.forceKeepWarm,
    },
    {
      mode: "keep",
      label: "Keep",
      active: snap.forceKeepWarm && !snap.disabled,
    },
    { mode: "stop", label: "Stop", active: snap.disabled },
  ];
  return `<span class="warming-controls">${modes
    .map(
      (m) =>
        `<form class="inline" method="POST" action="/ui/api/warming/${esc(sessionId)}/${m.mode}">` +
        `<button type="submit" class="btn-sm${m.active ? " btn-active" : ""}">${m.label}</button></form>`,
    )
    .join("")}</span>`;
}

// ---------------------------------------------------------------------------
// Unified live-sessions table (shared by Costs + Warming pages)
// ---------------------------------------------------------------------------

/** A joined row for the unified live-sessions table. */
type LiveSessionRow = {
  sessionId: string;
  projectId: string;
  projectLabel: string;
  turns: number;
  hasCosts: boolean;
  totalCost: number;
  savings: number;
  cacheHitPct: number;
  pReturnsPct: number;
  warmingSnap: WarmingSnapshot | null;
  idleMs: number;
  totalWarmups: number;
  warmupHits: number;
  // Sub-agent tree fields
  parentSessionId: string | null;
  isSubagent: boolean;
  children: LiveSessionRow[];
  /** Cost including children (populated during tree building). */
  rolledUpCost: number;
  /** Savings including children (populated during tree building). */
  rolledUpSavings: number;
};

/**
 * Union-join cost tracker, active sessions, and warming snapshots into rows.
 * Accepts pre-fetched maps so callers avoid redundant data fetching.
 *
 * Returns a **tree**: root rows carry their children in `.children`.
 * Subagent costs are rolled up into the parent row's `rolledUpCost`/`rolledUpSavings`.
 */
function buildLiveSessionRows(
  allCosts: ReadonlyMap<string, SessionCosts>,
  activeSessions: ReadonlyMap<
    string,
    Pick<SessionState, "projectPath" | "isSubagent" | "parentSessionId">
  >,
  snapshots: ReadonlyMap<string, WarmingSnapshot>,
  dbParentMap?: ReadonlyMap<string, string>,
): LiveSessionRow[] {
  // Universe of session IDs from both sources
  const allIds = new Set<string>([
    ...allCosts.keys(),
    ...activeSessions.keys(),
  ]);

  // Merge parent-child info from live sessions and persisted DB state
  if (!dbParentMap) dbParentMap = loadParentChildMap();

  const rowMap = new Map<string, LiveSessionRow>();
  for (const sid of allIds) {
    const costs = allCosts.get(sid) ?? null;
    const snap = snapshots.get(sid) ?? null;
    const sess = activeSessions.get(sid);

    const projPath = sess?.projectPath ?? "";
    const projId = projPath ? lookupProjectId(projPath) : undefined;
    const projLabel = projId ? (projectName(projId) ?? "(unnamed)") : "-";

    // Cache hit ratio: cacheReadTokens / total input tokens
    let cacheHitPct = NaN;
    if (costs) {
      const c = costs.conversation;
      const totalInput = c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
      cacheHitPct = totalInput > 0 ? (c.cacheReadTokens / totalInput) * 100 : 0;
    }

    const ownCost = costs ? totalActualCost(costs) : 0;
    const ownSavings = costs ? totalSavings(costs) : 0;

    // Determine parent from live state first, fall back to persisted DB
    const parentSid = sess?.parentSessionId ?? dbParentMap.get(sid) ?? null;
    const isSub = sess?.isSubagent ?? parentSid != null;

    rowMap.set(sid, {
      sessionId: sid,
      projectId: projId ?? "",
      projectLabel: projLabel,
      turns: costs?.conversation.turns ?? snap?.messageCount ?? 0,
      hasCosts: costs !== null,
      totalCost: ownCost,
      savings: ownSavings,
      cacheHitPct,
      pReturnsPct: snap ? snap.pReturns * 100 : 0,
      warmingSnap: snap,
      idleMs: snap?.idleMs ?? NaN,
      totalWarmups: snap?.totalWarmups ?? 0,
      warmupHits: snap?.warmupHits ?? 0,
      parentSessionId: parentSid,
      isSubagent: isSub,
      children: [],
      rolledUpCost: ownCost,
      rolledUpSavings: ownSavings,
    });
  }

  // Build tree: attach children to parents
  for (const row of rowMap.values()) {
    if (row.parentSessionId) {
      const parent = rowMap.get(row.parentSessionId);
      if (parent) {
        parent.children.push(row);
      }
    }
  }

  // Recursive roll-up: bottom-up so grandchildren costs propagate correctly
  function rollUp(row: LiveSessionRow): void {
    for (const child of row.children) {
      rollUp(child);
      row.rolledUpCost += child.rolledUpCost;
      row.rolledUpSavings += child.rolledUpSavings;
    }
  }

  // Identify roots and roll up
  const roots = [...rowMap.values()].filter(
    (r) => !r.parentSessionId || !rowMap.has(r.parentSessionId),
  );
  for (const root of roots) {
    rollUp(root);
  }

  return roots;
}

/** Render a single session row (used for both root and child rows). */
function renderSessionRow(
  r: LiveSessionRow,
  opts?: { isChild?: boolean; parentId?: string },
): string {
  const isChild = opts?.isChild ?? false;
  const parentId = opts?.parentId;

  const projCell = r.projectId
    ? `<a href="/ui/projects/${esc(r.projectId)}">${esc(r.projectLabel)}</a>`
    : esc(r.projectLabel);

  // For parent rows with children: show toggle + rolled-up cost
  const hasChildren = r.children.length > 0;
  const toggle = hasChildren
    ? `<span class="toggle-btn" data-session-id="${esc(r.sessionId)}">\u25B6</span>`
    : "";
  const childCount = hasChildren
    ? `<span class="subagent-count">(+${r.children.length})</span>`
    : "";
  const prefix = isChild ? `<span style="opacity:0.4">\u21B3</span> ` : "";

  const sessLink = r.projectId
    ? `<a href="/ui/sessions/${esc(r.projectId)}/${esc(r.sessionId)}"><code>${esc(r.sessionId.slice(0, 16))}</code></a>`
    : `<code>${esc(r.sessionId.slice(0, 16))}</code>`;
  const sessCell = `${prefix}${sessLink}${childCount}`;

  // Use rolled-up totals for parent rows with children
  const displayCost = hasChildren ? r.rolledUpCost : r.totalCost;
  const displaySavings = hasChildren ? r.rolledUpSavings : r.savings;
  const savingsColor = displaySavings >= 0 ? "#10b981" : "#e06c75";

  // Status cell: badge + controls + idle duration
  let statusCell: string;
  if (r.warmingSnap) {
    const bdg = warmingStatusBadge(r.warmingSnap);
    const controls = warmingModeControls(r.sessionId, r.warmingSnap);
    const idle = Number.isNaN(r.idleMs) ? "" : ` ${formatDuration(r.idleMs)}`;
    statusCell = `${bdg}${controls}${idle}`;
  } else {
    statusCell = "-";
  }

  const hitsCell = r.warmingSnap ? `${r.warmupHits}/${r.totalWarmups}` : "-";

  const trAttrs = isChild
    ? ` class="subagent-row" data-parent="${esc(parentId ?? "")}"`
    : "";

  // Savings cell with background tint
  const savingsBg =
    r.hasCosts && displaySavings !== 0
      ? displaySavings >= 0
        ? "rgba(16,185,129,0.08)"
        : "rgba(239,68,68,0.08)"
      : "transparent";

  // Cache hit cell with inline mini-bar
  const cacheHitCell = !Number.isNaN(r.cacheHitPct)
    ? `${renderMiniBar(r.cacheHitPct, "bar-green")}${r.cacheHitPct.toFixed(0)}%`
    : "-";

  return `<tr${trAttrs}>
    <td>${toggle}${projCell}</td>
    <td>${sessCell}</td>
    <td>${r.turns}</td>
    <td>${r.hasCosts ? formatUSD(displayCost) : "-"}</td>
    <td style="background:${savingsBg}">${r.hasCosts ? `<span style="color:${savingsColor}">${formatUSD(displaySavings)}</span>` : "-"}</td>
    <td>${cacheHitCell}</td>
    <td>${r.warmingSnap ? `${r.pReturnsPct.toFixed(1)}%` : "-"}</td>
    <td>${statusCell}</td>
    <td>${hitsCell}</td>
  </tr>`;
}

/**
 * Render the unified live-sessions table (filter input + table).
 * Does NOT include headings — callers add their own <h2>/<h3>.
 *
 * 9 columns: Project | Session | Turns | Total | Savings | Cache Hit |
 *            P(returns) | Status | Hits/Warmups
 *
 * Root rows with sub-agent children show a collapsible toggle (▶/▼).
 * Children are hidden by default and shown on click.
 */
function renderLiveSessionsTable(
  rows: LiveSessionRow[],
  emptyMessage?: string,
  tableId?: string,
): string {
  if (rows.length === 0) {
    return `<p class="empty">${esc(emptyMessage ?? "No active sessions.")}</p>`;
  }

  let html = `<div class="table-filter"><input type="text" placeholder="Filter sessions\u2026"><span class="count"></span></div>
  <table${tableId ? ` data-table-id="${tableId}"` : ""}>
    <tr>
      <th data-sort="text">Project</th>
      <th data-sort="text">Session</th>
      <th data-sort="num">Turns</th>
      <th data-sort="num">Total</th>
      <th data-sort="num">Net</th>
      <th data-sort="num">Cache&nbsp;Hit</th>
      <th data-sort="num">P(returns)</th>
      <th data-sort="text">Status</th>
      <th data-sort="num">Hits/Warmups</th>
    </tr>`;

  // Recursively render a row and all its descendants
  function renderTree(row: LiveSessionRow, parentId?: string): void {
    const isChild = parentId != null;
    html += renderSessionRow(
      row,
      isChild ? { isChild: true, parentId } : undefined,
    );
    for (const child of row.children) {
      renderTree(child, row.sessionId);
    }
  }
  for (const r of rows) {
    renderTree(r);
  }

  html += `</table>`;
  return html;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pageDashboard(): string {
  const projects = data.listProjects();
  const stats = data.globalStats();

  let body = `<h1>Dashboard</h1>`;
  // Compute lifetime net savings (live + historical)
  const allCosts = getAllSessionCosts();
  let liveSavings = 0;
  for (const [, c] of allCosts) {
    liveSavings += totalSavings(c);
  }
  const hist = computeHistoricalEstimates(projects).totals;
  const histSavings =
    hist.warmupSavings +
    hist.ttlSavings +
    hist.batchSavings +
    hist.avoidedCompactionCost -
    hist.totalWorkerCost;
  const netSavings = liveSavings + histSavings;

  body += `<div class="stats">
    <div class="stat"><div class="label">Projects</div><div class="value">${stats.project_count}</div></div>
    <div class="stat"><div class="label">Knowledge</div><div class="value">${stats.knowledge_count}</div></div>
    <div class="stat"><div class="label">Sessions</div><div class="value">${allCosts.size}<span class="total">/${stats.session_count}</span></div></div>
    ${
      netSavings > 0
        ? `<div class="stat"><div class="label">Net Savings</div><div class="value" style="color:#10b981">${formatUSD(liveSavings)}<span class="total">/${formatUSD(netSavings)}</span></div></div>`
        : netSavings < 0
          ? `<div class="stat"><div class="label">Net Overhead</div><div class="value" style="color:#e06c75">${formatUSD(Math.abs(liveSavings))}<span class="total">/${formatUSD(Math.abs(netSavings))}</span></div></div>`
          : ""
    }
  </div>`;

  if (!projects.length) {
    body += `<p class="empty">No projects found. Start using Lore with an AI agent to create data.</p>`;
  } else {
    body += `<h2>Projects</h2>
    <div class="table-filter"><input type="text" placeholder="Filter projects\u2026"><span class="count"></span></div>
    <table data-table-id="dashboard-projects">
      <tr><th data-sort="text">Name</th><th data-sort="text">Path</th><th data-sort="text">Git Remote</th><th data-sort="num">Knowledge</th><th data-sort="num">Sessions</th><th data-sort="num">Messages</th><th data-sort="date" data-default-sort="desc">Created</th></tr>`;
    for (const p of projects) {
      const provisional = isUnattributedProjectPath(p.path)
        ? ` <span title="Provisional: created when the gateway couldn't determine a project. Will self-heal or can be consolidated via 'lore data consolidate'." style="font-size:0.72em;padding:1px 5px;border-radius:6px;background:var(--bg3);color:var(--fg3);vertical-align:middle">provisional</span>`
        : "";
      body += `<tr>
        <td><a href="/ui/projects/${esc(p.id)}">${esc(p.name ?? "(unnamed)")}</a>${provisional}</td>
        <td style="font-family:var(--mono);font-size:0.85em">${esc(truncate(p.path, 50))}</td>
        <td style="font-family:var(--mono);font-size:0.85em">${esc(p.git_remote ? truncate(p.git_remote, 40) : "-")}</td>
        <td>${p.knowledge_count}</td>
        <td>${p.session_count}</td>
        <td>${p.message_count}</td>
        <td>${timeAgo(p.created_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  return layout("Dashboard", body);
}

function pageProject(projectId: string): string | null {
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;

  const knowledge = ltm.forProject(project.path, false);
  const sessions = data.listSessions(project.path, 100);
  const distillations = data.listDistillations(project.path, { limit: 100 });

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: project.name ?? project.path },
  ]);
  body += `<h1>${esc(project.name ?? "(unnamed)")}</h1>`;
  body += `<form method="POST" action="/ui/api/rename/project/${esc(projectId)}" style="margin:4px 0 12px;display:flex;gap:8px;align-items:center">
    <input type="text" name="name" value="${esc(project.name ?? "")}" placeholder="Project name"
      style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--fg);font-size:0.9em;width:300px">
    <button type="submit" class="btn btn-primary">Rename</button>
  </form>`;
  body += `<p style="font-family:var(--mono);font-size:0.85em;color:var(--fg2)">${esc(project.path)}</p>`;
  if (project.git_remote) {
    body += `<p style="font-family:var(--mono);font-size:0.85em;color:var(--fg2)">Git: ${esc(project.git_remote)}</p>`;
  }

  // Knowledge section
  body += `<h2>Knowledge (${knowledge.length})</h2>`;
  if (knowledge.length) {
    body += `<div class="table-filter"><input type="text" placeholder="Filter knowledge\u2026"><span class="count"></span></div>
    <table data-table-id="project-knowledge">
      <tr><th data-sort="text">Category</th><th data-sort="text">Title</th><th data-sort="num">Confidence</th><th data-sort="date" data-default-sort="desc">Updated</th></tr>`;
    for (const e of knowledge) {
      body += `<tr>
        <td>${badge(e.category)}</td>
        <td><a href="/ui/knowledge/${esc(e.id)}">${esc(truncate(e.title, 60))}</a></td>
        <td>${e.confidence.toFixed(2)}</td>
        <td>${timeAgo(e.updated_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<p class="empty">No knowledge entries.</p>`;
  }

  // Sessions section — with sub-agent tree grouping
  body += `<h2>Sessions (${sessions.length})</h2>`;
  if (sessions.length) {
    const pMap = loadParentChildMap();

    // Build tree from flat session list
    type SessNode = (typeof sessions)[number] & {
      children: SessNode[];
    };
    const sessNodeMap = new Map<string, SessNode>();
    for (const s of sessions) {
      sessNodeMap.set(s.session_id, { ...s, children: [] });
    }
    for (const [childId, parentId] of pMap) {
      const child = sessNodeMap.get(childId);
      const parent = sessNodeMap.get(parentId);
      if (child && parent) {
        parent.children.push(child);
      }
    }
    const sessRoots = [...sessNodeMap.values()].filter((r) => {
      const parentId = pMap.get(r.session_id);
      return parentId === undefined || !sessNodeMap.has(parentId);
    });

    body += `<table data-table-id="project-sessions">
      <tr><th>Session</th><th data-sort="num">Messages</th><th data-sort="num">Distilled</th><th data-sort="num">Distillations</th><th data-sort="date" data-default-sort="desc">Last Activity</th></tr>`;

    function renderProjSession(s: SessNode, parentSid?: string): void {
      const isChild = parentSid != null;
      const parentSidValue = parentSid ?? "";
      const hasChildren = s.children.length > 0;
      const toggle = hasChildren
        ? `<span class="toggle-btn" data-session-id="${esc(s.session_id)}">\u25B6</span>`
        : "";
      const childCount = hasChildren
        ? `<span class="subagent-count">(+${s.children.length})</span>`
        : "";
      const prefix = isChild ? `<span style="opacity:0.4">\u21B3</span> ` : "";
      const trAttrs = isChild
        ? ` class="subagent-row" data-parent="${esc(parentSidValue)}"`
        : "";
      body += `<tr${trAttrs}>
        <td>${toggle}${prefix}<a href="/ui/sessions/${esc(projectId)}/${esc(s.session_id)}">${esc(s.session_id.slice(0, 12))}</a>${childCount}</td>
        <td>${s.message_count}</td>
        <td>${s.distilled_count}</td>
        <td>${s.distillation_count}</td>
        <td>${timeAgo(s.last_message_at)}</td>
      </tr>`;
      for (const child of s.children) {
        renderProjSession(child, s.session_id);
      }
    }
    for (const s of sessRoots) {
      renderProjSession(s);
    }

    body += `</table>`;
  } else {
    body += `<p class="empty">No sessions.</p>`;
  }

  // Distillations section
  body += `<h2>Distillations (${distillations.length})</h2>`;
  if (distillations.length) {
    body += `<table data-table-id="project-distillations">
      <tr><th>Session</th><th data-sort="num">Gen</th><th data-sort="num">Tokens</th><th data-sort="num">R_comp</th><th data-sort="num">C_norm</th><th data-sort="date" data-default-sort="desc">Created</th></tr>`;
    for (const d of distillations) {
      body += `<tr>
        <td><a href="/ui/distillations/${esc(d.id)}">${esc(d.session_id.slice(0, 12))}</a></td>
        <td>${d.generation}</td>
        <td>${d.token_count}</td>
        <td>${d.r_compression?.toFixed(2) ?? "-"}</td>
        <td>${d.c_norm?.toFixed(2) ?? "-"}</td>
        <td>${timeAgo(d.created_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<p class="empty">No distillations.</p>`;
  }

  // Actions
  body += `<div class="actions">
    ${deleteForm(`/ui/api/clear/project/${esc(projectId)}`, "Clear All Project Data", "This will permanently delete ALL data for this project but keep the project entry. Continue?")}
    ${deleteForm(`/ui/api/delete/project/${esc(projectId)}`, "Delete Project", "This will PERMANENTLY DELETE this project and ALL its data. This cannot be undone. Continue?")}
  </div>`;

  return layout(project.name ?? "Project", body);
}

function pageUserKnowledge(): string {
  const entries = ltm.crossProject();

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Knowledge" },
  ]);
  body += `<h1>User Knowledge (${entries.length})</h1>`;

  if (!entries.length) {
    body += `<p class="empty">No cross-project or global knowledge entries found. These are created automatically when the curator identifies knowledge worth sharing across projects.</p>`;
    return layout("User Knowledge", body);
  }

  // Category breakdown stats
  const cats: Record<string, number> = {};
  for (const e of entries) {
    cats[e.category] = (cats[e.category] || 0) + 1;
  }
  body += `<div class="stats">
    <div class="stat"><div class="label">Total</div><div class="value">${entries.length}</div></div>`;
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    body += `<div class="stat"><div class="label">${esc(cat)}</div><div class="value">${count}</div></div>`;
  }
  body += `</div>`;

  // Batch-load cross-project transfer counts (#506) to avoid N+1 queries.
  const transferCounts = ltm.transferCounts();

  body += `<div class="table-filter"><input type="text" placeholder="Filter knowledge\u2026"><span class="count"></span></div>
  <table data-table-id="user-knowledge">
    <tr><th data-sort="text">Category</th><th data-sort="text">Title</th><th data-sort="text">Source Project</th><th data-sort="num">Confidence</th><th data-sort="num">Recalls</th><th data-sort="date" data-default-sort="desc">Updated</th></tr>`;
  for (const e of entries) {
    const projName = e.project_id ? projectName(e.project_id) : null;
    const projDisplay = e.project_id
      ? `<a href="/ui/projects/${esc(e.project_id)}">${esc(projName ?? "(unknown)")}</a>`
      : "(global)";
    body += `<tr>
      <td>${badge(e.category)}</td>
      <td><a href="/ui/knowledge/${esc(e.id)}">${esc(truncate(e.title, 60))}</a></td>
      <td>${projDisplay}</td>
      <td>${e.confidence.toFixed(2)}</td>
      <td>${transferCounts.get(e.id) ?? 0}</td>
      <td>${timeAgo(e.updated_at)}</td>
    </tr>`;
  }
  body += `</table>`;

  return layout("User Knowledge", body);
}

function pageKnowledge(id: string): string | null {
  const entry = ltm.get(id);
  if (!entry) return null;

  const projName = entry.project_id ? projectName(entry.project_id) : null;

  const isCrossOrGlobal = entry.cross_project || !entry.project_id;
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    ...(isCrossOrGlobal
      ? [{ label: "Knowledge", href: "/ui/knowledge" }]
      : entry.project_id
        ? [
            {
              label: projName ?? "Project",
              href: `/ui/projects/${entry.project_id}`,
            },
          ]
        : []),
    { label: truncate(entry.title, 40) },
  ]);

  body += `<h1>${esc(entry.title)}</h1>`;
  body += `<div class="field"><span class="key">Category:</span> ${badge(entry.category)}</div>`;
  body += `<div class="field"><span class="key">Confidence:</span> ${entry.confidence.toFixed(2)}</div>`;
  body += `<div class="field"><span class="key">ID:</span> <code>${esc(entry.id)}</code></div>`;
  body += `<div class="field"><span class="key">Project ID:</span> ${esc(entry.project_id ?? "(global)")}</div>`;
  body += `<div class="field"><span class="key">Cross-project:</span> ${entry.cross_project ? "Yes" : "No"}</div>`;
  const transfers = ltm.transfersFor(entry.id);
  body += `<div class="field"><span class="key">Recalled in other projects:</span> ${transfers.length}</div>`;
  body += `<div class="field"><span class="key">Source session:</span> ${esc(entry.source_session ?? "(none)")}</div>`;
  body += `<div class="field"><span class="key">Created:</span> ${formatDate(entry.created_at)}</div>`;
  body += `<div class="field"><span class="key">Updated:</span> ${formatDate(entry.updated_at)}</div>`;
  if (entry.metadata) {
    body += `<div class="field"><span class="key">Metadata:</span></div><pre>${esc(entry.metadata)}</pre>`;
  }

  // Cross-project recall breakdown (#506): which foreign projects surfaced this
  // entry, how often, and when last.
  if (transfers.length) {
    body += `<h2>Cross-Project Recalls</h2>
    <table>
      <tr><th>Project</th><th data-sort="num">Hits</th><th data-sort="date">Last recalled</th></tr>`;
    for (const t of transfers) {
      const name = projectName(t.recalled_in_project_id) ?? "(unknown)";
      body += `<tr>
        <td><a href="/ui/projects/${esc(t.recalled_in_project_id)}">${esc(name)}</a></td>
        <td>${t.hit_count}</td>
        <td>${timeAgo(t.last_recalled_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  body += `<h2>Content</h2>${md(entry.content)}`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/knowledge/${esc(entry.id)}`, "Delete Entry", "Delete this knowledge entry?")}
  </div>`;

  return layout(entry.title, body);
}

/** Render cache warming heuristics section for a live session. */
function renderWarmingSection(sessionId: string): string {
  const sessions = getActiveSessions();
  const state = [...sessions.values()].find((s) => s.sessionID === sessionId);
  if (!state) return ""; // historical session — no live warming data

  const snap = computeWarmingSnapshot(state);
  const hitRate =
    snap.totalWarmups > 0
      ? `${snap.warmupHits}/${snap.totalWarmups} (${((snap.warmupHits / snap.totalWarmups) * 100).toFixed(0)}%)`
      : "0";

  let html = `<h2>Cache Warming</h2>`;

  // Stat cards
  html += `<div class="stats">
    <div class="stat"><div class="label">Status</div><div class="value">${warmingStatusBadge(snap)}${warmingModeControls(sessionId, snap)}</div></div>
    <div class="stat"><div class="label">Warmups</div><div class="value">${snap.totalWarmups}</div></div>
    <div class="stat"><div class="label">Hits</div><div class="value">${hitRate}</div></div>
    <div class="stat"><div class="label">P(returns)</div><div class="value">${(snap.pReturns * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="label">P(finished)</div><div class="value">${(snap.pSessionFinished * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="label">S(t)</div><div class="value">${(snap.survivalAtIdle * 100).toFixed(1)}%</div></div>
  </div>`;

  // Expandable decision details
  html += `<details class="warming"><summary>Decision Details</summary>
    <div class="card">
      <div class="field"><span class="key">Idle:</span> ${formatDuration(snap.idleMs)}</div>
      <div class="field"><span class="key">TTL:</span> ${snap.ttl ?? "5m (default)"}</div>
      <div class="field"><span class="key">Phase:</span> ${snap.warmingPhase}</div>
      <div class="field"><span class="key">Turns:</span> ${snap.messageCount}</div>
      <div class="field"><span class="key">Text-only runs:</span> ${snap.consecutiveTextOnlyTurns}</div>
      <div class="field"><span class="key">Break fraction:</span> ${(snap.breakFrac * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">Threshold:</span> ${(snap.threshold * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">P(session finished):</span> ${(snap.pSessionFinished * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">P(returns):</span> ${(snap.pReturns * 100).toFixed(1)}%</div>
      <div class="field"><span class="key">Cycles spent:</span> ${snap.cyclesSpent} / ${snap.maxCycles} max</div>
      <div class="field"><span class="key">Expected cycles:</span> ${snap.expectedCycles.toFixed(1)}</div>
      <div class="field"><span class="key">Session weight:</span> ${snap.sessionWeight.toFixed(2)} (${snap.sessionHistogram.total} obs / ${BLEND_PSEUDOCOUNT} pseudocount)</div>
      ${snap.notWarmingReason ? `<div class="field"><span class="key">Not warming:</span> ${esc(snap.notWarmingReason)}</div>` : ""}
      <div class="field"><span class="key">Circuit breaker:</span> ${snap.circuitBreaker.tripped ? '<span style="color:var(--danger)">TRIPPED</span>' : `OK (${snap.circuitBreaker.failures}/${snap.circuitBreaker.maxFailures})`}</div>
    </div>
  </details>`;

  // Expandable histogram
  html += `<details class="warming"><summary>Survival Histogram</summary>
    ${renderHistogram({
      session: snap.sessionHistogram,
      global: snap.globalHistogram,
      blended: snap.blendedHistogram,
    })}
  </details>`;

  return html;
}

/** Tint class for a utilization percentage (green < 60 < amber < 85 < red). */
function quotaTint(percent: number): string {
  return percent < 60 ? "bar-green" : percent < 85 ? "bar-amber" : "bar-red";
}

/** Render a single quota window as a cost bar, or "" if absent. */
function renderQuotaWindow(
  title: string,
  window: QuotaSnapshot["fiveHour"],
): string {
  if (!window) return "";
  const pct = window.utilization;
  return renderCostBar({
    title,
    value: `${pct.toFixed(1)}% used`,
    percent: pct,
    tint: quotaTint(pct),
    detailRightHtml:
      window.resetsAt != null
        ? `Resets ${esc(formatDate(window.resetsAt))}`
        : "",
  });
}

/**
 * Render the Anthropic OAuth quota section for a live session.
 *
 * Returns "" for historical sessions, non-OAuth sessions, or sessions whose
 * quota hasn't been fetched yet (no snapshot in the per-account cache).
 */
function renderQuotaSection(sessionId: string): string {
  const cred = resolveAuth(sessionId);
  if (!cred) return "";
  const snapshot = getQuotaForCredential(cred);
  if (!snapshot || (!snapshot.fiveHour && !snapshot.sevenDay)) return "";

  let html = `<h2>Anthropic OAuth Quota</h2>`;
  html += renderQuotaWindow("5-hour window", snapshot.fiveHour);
  html += renderQuotaWindow("7-day window", snapshot.sevenDay);
  html += `<div class="field"><span class="key">Updated:</span> ${formatDate(snapshot.fetchedAt)}</div>`;
  return html;
}

function pageSession(pid: string, sessionId: string): string | null {
  // Find the project path from the project ID
  const projects = data.listProjects();
  const project = projects.find((p) => p.id === pid);
  if (!project) return null;

  const messages = temporal.bySession(project.path, sessionId);
  const dists = data.listDistillations(project.path, { sessionId });

  if (!messages.length && !dists.length) return null;

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: project.name ?? "Project", href: `/ui/projects/${esc(pid)}` },
    { label: `Session ${sessionId.slice(0, 12)}` },
  ]);

  body += `<h1>Session ${esc(sessionId.slice(0, 12))}</h1>`;
  body += `<div class="field"><span class="key">Full ID:</span> <code>${esc(sessionId)}</code></div>`;
  body += `<div class="field"><span class="key">Messages:</span> ${messages.length}</div>`;
  body += `<div class="field"><span class="key">Distillations:</span> ${dists.length}</div>`;
  if (messages.length) {
    body += `<div class="field"><span class="key">Time range:</span> ${formatDate(messages[0].created_at)} &mdash; ${formatDate(messages[messages.length - 1].created_at)}</div>`;
  }

  // Cost intelligence
  body += renderCostSummary(sessionId);

  // Anthropic OAuth quota (live OAuth sessions only)
  body += renderQuotaSection(sessionId);

  // Cache warming heuristics (live sessions only)
  body += renderWarmingSection(sessionId);

  // Conversation (chat bubble view)
  body += `<div class="chat-header">
    <h2>Conversation (${messages.length} messages)</h2>
    <div class="chat-filter">
      <input type="text" id="chat-search" placeholder="Filter messages..." autocomplete="off">
      <span class="chat-filter-count" id="chat-search-count"></span>
    </div>
  </div>`;
  body += `<div class="chat-container" id="chat-container">`;
  for (let i = 0; i < messages.length; i++) {
    body += renderChatBubble(messages[i], i);
  }
  body += `</div>`;

  // Distillations
  if (dists.length) {
    body += `<h2>Distillations (${dists.length})</h2>`;
    for (const d of dists) {
      const detail = data.getDistillation(d.id);
      body += `<div class="card">
        <h3><a href="/ui/distillations/${esc(d.id)}">Gen ${d.generation}</a>
          <span style="color:var(--fg3);font-size:0.8em;font-weight:normal">${formatDate(d.created_at)} &middot; ${d.token_count} tokens</span></h3>
        ${detail ? `<pre>${esc(truncate(detail.observations, 400))}</pre>` : ""}
      </div>`;
    }
  }

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/session/${esc(pid)}/${esc(sessionId)}`, "Delete Session", "Delete all messages and distillations for this session?")}
  </div>`;

  return layout(`Session ${sessionId.slice(0, 12)}`, body);
}

function pageDistillation(id: string): string | null {
  const dist = data.getDistillation(id);
  if (!dist) return null;

  const projName = projectName(dist.project_id);

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    {
      label: projName ?? "Project",
      href: `/ui/projects/${esc(dist.project_id)}`,
    },
    { label: `Distillation` },
  ]);

  body += `<h1>Distillation</h1>`;
  body += `<div class="field"><span class="key">ID:</span> <code>${esc(dist.id)}</code></div>`;
  body += `<div class="field"><span class="key">Session:</span> <a href="/ui/sessions/${esc(dist.project_id)}/${esc(dist.session_id)}">${esc(dist.session_id.slice(0, 12))}</a></div>`;
  body += `<div class="field"><span class="key">Generation:</span> ${dist.generation}</div>`;
  body += `<div class="field"><span class="key">Tokens:</span> ${dist.token_count}</div>`;
  body += `<div class="field"><span class="key">R_compression:</span> ${dist.r_compression?.toFixed(3) ?? "-"}</div>`;
  body += `<div class="field"><span class="key">C_norm:</span> ${dist.c_norm?.toFixed(3) ?? "-"}</div>`;
  body += `<div class="field"><span class="key">Archived:</span> ${dist.archived ? "Yes" : "No"}</div>`;
  body += `<div class="field"><span class="key">Created:</span> ${formatDate(dist.created_at)}</div>`;
  body += `<div class="field"><span class="key">Source IDs:</span></div><pre>${esc(dist.source_ids)}</pre>`;
  body += `<h2>Observations</h2>${md(dist.observations)}`;

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/distillation/${esc(dist.id)}`, "Delete Distillation", "Delete this distillation?")}
  </div>`;

  return layout("Distillation", body);
}

/** Format a relative age string from a timestamp. */
function relativeAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Build an ID link for a search result. */
function idLink(prefix: string, id: string): string {
  const short = id.slice(0, 8);
  return `<a href="/ui/search/detail/${esc(prefix)}:${esc(id)}" class="id-link" title="${esc(prefix)}:${esc(id)}">${esc(prefix)}:${esc(short)}</a>`;
}

/** Format a single search result as a compact snippet with ID link. */
function formatSearchResult(tagged: TaggedResult, score?: number): string {
  const scoreStr =
    score != null
      ? `<span class="score" title="RRF score">${score.toFixed(4)}</span>`
      : "";
  switch (tagged.source) {
    case "knowledge":
    case "cross-knowledge": {
      const k = tagged.item;
      const prefix = tagged.source === "cross-knowledge" ? "xk" : "k";
      const from =
        tagged.source === "cross-knowledge"
          ? ` <span class="meta">from: ${esc(tagged.projectLabel)}</span>`
          : "";
      return `<li class="result-item">
        ${scoreStr}${badge(k.category)}${from}
        <strong><a href="/ui/knowledge/${esc(k.id)}">${esc(k.title)}</a></strong>:
        ${esc(truncateText(k.content, 200))}
        ${idLink(prefix, k.id)}
      </li>`;
    }
    case "distillation": {
      const d = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge("distilled")}
        <span class="meta">gen ${d.generation} &middot; ${relativeAge(d.created_at)}</span>
        ${esc(truncateText(d.observations, 250))}
        ${idLink("d", d.id)}
      </li>`;
    }
    case "temporal": {
      const m = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge(m.role)}
        <span class="meta">${relativeAge(m.created_at)} &middot; ${esc(m.session_id.slice(0, 8))}</span>
        ${esc(truncateText(m.content, 200))}
        ${idLink("t", m.id)}
      </li>`;
    }
    case "lat-section": {
      const s = tagged.item;
      return `<li class="result-item">
        ${scoreStr}${badge("lat.md")}
        <strong>${esc(s.file)} &sect; ${esc(s.heading)}</strong>:
        ${esc(truncateText(s.content, 200))}
        ${idLink("lat", s.id)}
      </li>`;
    }
  }
}

async function pageSearch(url: URL): Promise<string> {
  const query = url.searchParams.get("q") ?? "";
  const projectFilter = url.searchParams.get("project") ?? "";
  const scope = (url.searchParams.get("scope") ?? "all") as
    | "all"
    | "session"
    | "project"
    | "knowledge";

  const projects = data.listProjects();

  let body = `<h1>Search</h1>`;
  body += `<form class="search-form" method="GET" action="/ui/search">
    <input type="text" name="q" placeholder="Search query..." value="${esc(query)}" autofocus>
    <select name="project">
      <option value="">All projects</option>
      ${projects.map((p) => `<option value="${esc(p.path)}"${p.path === projectFilter ? " selected" : ""}>${esc(p.name ?? p.path)}</option>`).join("")}
    </select>
    <select name="scope">
      ${(["all", "project", "knowledge"] as const).map((s) => `<option value="${s}"${s === scope ? " selected" : ""}>${s}</option>`).join("")}
    </select>
    <button type="submit" class="btn btn-primary">Search</button>
  </form>`;

  if (query) {
    const projectPath = projectFilter || projects[0]?.path;
    if (!projectPath) {
      body += `<p class="empty">No projects found. Cannot search without a project context.</p>`;
    } else {
      try {
        const searchConfig = {
          ...config().search,
          recallLimit: 20,
          queryExpansion: false,
        };
        const rawResults = await searchRecall({
          query,
          scope,
          projectPath,
          searchConfig,
        });

        // Apply relevance floor: drop results below 15% of top score.
        const topScore = rawResults[0]?.score ?? 0;
        const floor = topScore * 0.15;
        const results =
          topScore > 0
            ? rawResults.filter((r) => r.score >= floor)
            : rawResults;

        const displayed = results.slice(0, 30);

        if (!displayed.length) {
          body += `<p class="empty">No results found for this query.</p>`;
        } else {
          const scoreRange =
            displayed.length > 1
              ? `score: ${displayed[0].score.toFixed(4)}–${displayed[displayed.length - 1].score.toFixed(4)}`
              : "";
          body += `<p class="result-summary">Found ${rawResults.length} results, showing ${displayed.length}${scoreRange ? ` (${scoreRange})` : ""}.</p>`;

          // Group into tiers by relative score (same thresholds as recall)
          const strong = displayed.filter((r) => r.score >= topScore * 0.6);
          const supporting = displayed.filter(
            (r) => r.score >= topScore * 0.3 && r.score < topScore * 0.6,
          );
          const peripheral = displayed.filter((r) => r.score < topScore * 0.3);

          if (strong.length) {
            body += `<h3>Strong Matches</h3><ul class="result-list">`;
            for (const { item: tagged, score } of strong)
              body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
          if (supporting.length) {
            body += `<h3>Supporting</h3><ul class="result-list">`;
            for (const { item: tagged, score } of supporting)
              body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
          if (peripheral.length) {
            body += `<h3>Peripheral</h3><ul class="result-list">`;
            for (const { item: tagged, score } of peripheral)
              body += formatSearchResult(tagged, score);
            body += `</ul>`;
          }
        }
      } catch (err) {
        body += `<p style="color:var(--danger)">Search error: ${esc(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
  }

  return layout("Search", body);
}

/** Detail page for a search result by source-prefixed ID (e.g. k:019e..., d:019e...). */
function pageSearchDetail(fullId: string): string | null {
  const result = recallById(fullId);
  if (
    result.startsWith("No entry found") ||
    result.startsWith("Unknown source")
  ) {
    return null;
  }

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Search", href: "/ui/search" },
    { label: fullId },
  ]);

  body += `<div class="card">${md(result)}</div>`;

  return layout(`Detail: ${fullId}`, body);
}

// ---------------------------------------------------------------------------
// Cache Warming page
// ---------------------------------------------------------------------------

function pageWarming(): string {
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Cache Warming" },
  ]);
  body += `<h1>Cache Warming</h1>`;

  const activeSessions = getActiveSessions();
  const cbStatus = getCircuitBreakerStatus();

  // Build warming snapshots once — used for both stat cards and table
  const snapshotMap = new Map<string, WarmingSnapshot>();
  for (const [sid, state] of activeSessions) {
    snapshotMap.set(sid, computeWarmingSnapshot(state));
  }

  // Build unified rows (shared with Costs page)
  const rows = buildLiveSessionRows(
    getAllSessionCosts(),
    activeSessions,
    snapshotMap,
  );

  // Aggregate stats from rows (consistent with table content).
  // Walk roots + children to count all sessions and warming stats.
  let totalWarmups = 0;
  let totalHits = 0;
  let warmingNow = 0;
  let deadCount = 0;
  let totalSessionCount = 0;
  function accumulateStats(r: LiveSessionRow): void {
    totalSessionCount++;
    if (r.warmingSnap) {
      totalWarmups += r.totalWarmups;
      totalHits += r.warmupHits;
      if (r.warmingSnap.shouldWarmNow) warmingNow++;
      if (r.warmingSnap.disabled) deadCount++;
    }
    for (const child of r.children) accumulateStats(child);
  }
  for (const r of rows) accumulateStats(r);

  // Summary stat cards
  body += `<div class="stats">
    <div class="stat"><div class="label">Live Sessions</div><div class="value">${totalSessionCount}</div></div>
    <div class="stat"><div class="label">Warming Now</div><div class="value">${warmingNow}</div></div>
    <div class="stat"><div class="label">Dead</div><div class="value">${deadCount}</div></div>
    <div class="stat"><div class="label">Total Warmups</div><div class="value">${totalWarmups}</div></div>
    <div class="stat"><div class="label">Hit Rate</div><div class="value">${totalWarmups > 0 ? `${((totalHits / totalWarmups) * 100).toFixed(0)}%` : "N/A"}</div></div>
    <div class="stat"><div class="label">Circuit Breaker</div><div class="value">${
      cbStatus.tripped
        ? '<span style="color:var(--danger)">TRIPPED</span>'
        : `OK <span style="color:var(--fg3)">${cbStatus.failures}/${cbStatus.maxFailures}</span>`
    }</div></div>
  </div>`;

  // Circuit breaker detail (if non-zero failures or tripped)
  if (cbStatus.failures > 0 || cbStatus.tripped) {
    const cls = cbStatus.tripped
      ? "cb-tripped"
      : cbStatus.failures > 1
        ? "cb-warn"
        : "cb-ok";
    const pct = (cbStatus.failures / cbStatus.maxFailures) * 100;
    body += `<div class="card ${cls}">
      <strong>Circuit Breaker:</strong> ${cbStatus.failures}/${cbStatus.maxFailures} uncached warmups
      <span class="cb-bar"><span class="cb-bar-fill" style="width:${pct}%"></span></span>
      ${cbStatus.tripped ? '<strong style="color:var(--danger)">ALL WARMING DISABLED</strong>' : ""}
    </div>`;
  }

  // Live sessions table (unified: cost + warming columns)
  body += `<h2>Live Sessions</h2>`;
  body += renderLiveSessionsTable(
    rows,
    "No active sessions. Cache warming data appears when sessions are processed through the gateway.",
    "warming-live-sessions",
  );

  // Global histograms
  const globalHists = getGlobalHistogramsSnapshot();
  if (globalHists.size > 0) {
    body += `<h2>Global Histograms</h2>`;
    body += `<p style="color:var(--fg3);font-size:0.9em">
      Per-project inter-turn gap distributions from all historical sessions.
      Used as Bayesian prior for sessions with few observations.
    </p>`;

    for (const [pid, hist] of globalHists) {
      const name = projectName(pid) ?? pid;
      body += `<details class="warming">
        <summary>${esc(name)} &mdash; ${hist.total} observations</summary>`;
      if (hist.total > 0) {
        body += renderHistogram({ global: hist });
      }
      body += `</details>`;
    }
  }

  return layout("Cache Warming", body);
}

// ---------------------------------------------------------------------------
// Global Costs page
// ---------------------------------------------------------------------------

function pageCosts(): string {
  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Costs" },
  ]);

  body += `<h1>Cost Intelligence</h1>`;

  // Pre-fetch parent-child map once for both live and historical sections
  const parentMap = loadParentChildMap();

  // --- Live session costs ---
  const allCosts = getAllSessionCosts();
  let liveTotalSpend = 0;
  let liveTotalSavings = 0;
  let liveTotalWithout = 0;
  let liveTotalWorker = 0;
  let liveTotalConversation = 0;
  let liveTotalTurns = 0;
  let liveBatchSavings = 0;
  let liveWarmupSavings = 0;
  let liveTtlSavings = 0;
  let liveAvoidedCompactions = 0;
  let liveAvoidedCompactionCost = 0;
  let liveDistillCost = 0;
  let liveCurateCost = 0;
  let liveCompactCost = 0;
  let liveWarmupCost = 0;
  let liveRecallCost = 0;
  let liveCacheReadTokens = 0;
  let liveTotalInputTokens = 0;

  for (const [, c] of allCosts) {
    liveTotalSpend += totalActualCost(c);
    const s = totalSavings(c);
    liveTotalSavings += s;
    liveTotalWithout += costWithoutLore(c);
    liveTotalWorker += totalWorkerCost(c);
    liveTotalConversation += c.conversation.cost;
    liveTotalTurns += c.conversation.turns;
    liveBatchSavings += c.batchSavings;
    liveWarmupSavings += c.counterfactual.warmupSavings;
    liveTtlSavings += c.counterfactual.ttlSavings;
    liveAvoidedCompactions += c.counterfactual.avoidedCompactions;
    liveAvoidedCompactionCost += c.counterfactual.avoidedCompactionCost;
    liveDistillCost += c.workers.distillation.cost;
    liveCurateCost += c.workers.curation.cost;
    liveCompactCost += c.workers.compaction.cost;
    liveWarmupCost += c.workers.warmup.cost;
    liveRecallCost += c.workers.recall.cost;
    liveCacheReadTokens += c.conversation.cacheReadTokens;
    liveTotalInputTokens +=
      c.conversation.inputTokens +
      c.conversation.cacheReadTokens +
      c.conversation.cacheWriteTokens;
  }

  // --- Historical (backdated) estimates ---
  const historical = computeHistoricalEstimates(data.listProjects());
  const hist = historical.totals;

  // --- Combined totals ---
  // Use totalWorkerCost (persisted real API data where available, heuristic
  // distillation estimate as fallback) instead of distillationCost alone.
  const combinedWorkerCost = liveTotalWorker + hist.totalWorkerCost;
  const combinedAvoidedCompactions =
    liveAvoidedCompactions + hist.avoidedCompactions;
  const combinedAvoidedCompactionCost =
    liveAvoidedCompactionCost + hist.avoidedCompactionCost;
  const combinedWarmupSavings = liveWarmupSavings + hist.warmupSavings;
  const combinedTtlSavings = liveTtlSavings + hist.ttlSavings;
  const combinedBatchSavings = liveBatchSavings + hist.batchSavings;
  // Net savings = counterfactual savings - worker overhead
  const combinedNetSavings =
    combinedWarmupSavings +
    combinedTtlSavings +
    combinedBatchSavings +
    combinedAvoidedCompactionCost -
    combinedWorkerCost;
  const combinedSessionCount = allCosts.size + hist.sessionCount;
  const combinedTotalSpend =
    liveTotalSpend + hist.persistedConversationCost + hist.totalWorkerCost;

  // --- Savings hero stat ---
  const combinedCounterfactual = combinedTotalSpend + combinedNetSavings;
  const savingsPctCombined =
    combinedCounterfactual > 0
      ? ((combinedNetSavings / combinedCounterfactual) * 100).toFixed(0)
      : "0";
  if (combinedNetSavings > 0) {
    body += `<div class="savings-hero">
      <div class="big-number" style="color:#10b981">${formatUSD(combinedNetSavings)} saved (${savingsPctCombined}%)</div>
      <div class="sub-label">Total spend: ${formatUSD(combinedTotalSpend)} &middot; Overhead: ${formatUSD(combinedWorkerCost)} &middot; Without Lore: ${formatUSD(combinedCounterfactual)}</div>
    </div>`;
  } else if (combinedNetSavings < 0) {
    body += `<div class="savings-hero">
      <div class="big-number" style="color:#e06c75">Net overhead: ${formatUSD(Math.abs(combinedNetSavings))}</div>
      <div class="sub-label">Total spend: ${formatUSD(combinedTotalSpend)} &middot; Overhead: ${formatUSD(combinedWorkerCost)} &middot; Savings will grow as sessions continue</div>
    </div>`;
  } else if (combinedTotalSpend > 0) {
    // Exactly zero net savings — overhead equals savings
    body += `<div class="savings-hero">
      <div class="big-number" style="color:var(--fg2)">Breaking even</div>
      <div class="sub-label">Total spend: ${formatUSD(combinedTotalSpend)} &middot; Lore overhead exactly matches savings</div>
    </div>`;
  }

  // --- Daily budget status + settings ---
  const currentBudget = getDailyBudget();
  {
    const { spend, date } = getDailySpend();
    const rate = getCostRate();

    body += `<div class="card" style="margin-bottom:1em">
      <h3 style="margin-top:0;margin-bottom:0.5em">Daily Budget</h3>`;

    if (currentBudget > 0) {
      const budgetPct = Math.min((spend / currentBudget) * 100, 100);

      // Count total throttle events across live sessions
      let totalThrottleEvents = 0;
      let totalThrottleDelayMs = 0;
      for (const [, c] of allCosts) {
        totalThrottleEvents += c.throttle.events;
        totalThrottleDelayMs += c.throttle.totalDelayMs;
      }

      body += renderCostBar({
        title: `Budget (${date})`,
        value: `${formatUSD(spend)} / ${formatUSD(currentBudget)}`,
        percent: budgetPct,
        tint:
          budgetPct < 60
            ? "bar-green"
            : budgetPct < 85
              ? "bar-amber"
              : "bar-red",
        detailLeftHtml: `Rate: ${formatUSD(rate)}/hr`,
        detailRightHtml:
          totalThrottleEvents > 0
            ? `Throttled: ${totalThrottleEvents} req, ${(totalThrottleDelayMs / 1000).toFixed(1)}s delay`
            : "",
      });
    } else {
      body += `<p style="color:var(--fg2);margin:0 0 8px">No daily budget set. Configure one to automatically throttle spending.</p>`;
    }

    // Budget settings form
    const envOverride = process.env.LORE_DAILY_BUDGET;
    if (envOverride) {
      body += `<div style="margin-top:8px;font-size:0.85em;color:var(--fg2)">
        Overridden by env var <code>LORE_DAILY_BUDGET=${esc(envOverride)}</code>
      </div>`;
    } else {
      body += `<form method="POST" action="/ui/api/budget" style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <label style="font-size:0.85em;color:var(--fg2)">Budget (USD/day):</label>
        <input type="number" name="budget" step="0.01" min="0" value="${currentBudget || ""}"
          placeholder="e.g. 10.00" style="width:100px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--fg)">
        <button type="submit" class="btn">Save</button>
        ${currentBudget > 0 ? `<button type="submit" name="action" value="disable" class="btn" style="background:var(--bg2);color:var(--fg2)">Disable</button>` : ""}
      </form>`;
    }

    body += `</div>`;
  }

  // Summary stats (compact pills for secondary metrics)
  // Trend arrow: compare live savings rate vs historical average.
  // Both rates use the same formula: netSavings / counterfactual,
  // where counterfactual = actualSpend + netSavings.
  const liveSavingsRate =
    liveTotalWithout > 0 ? liveTotalSavings / liveTotalWithout : 0;
  const histNetSavings =
    hist.warmupSavings +
    hist.ttlSavings +
    hist.batchSavings +
    hist.avoidedCompactionCost -
    hist.totalWorkerCost;
  const histActualSpend = hist.persistedConversationCost + hist.totalWorkerCost;
  const histWithoutLore = histActualSpend + histNetSavings;
  const histSavingsRate =
    histWithoutLore > 0 ? histNetSavings / histWithoutLore : 0;
  let trendArrow = "";
  if (allCosts.size > 0 && hist.sessionCount > 0) {
    if (liveSavingsRate > histSavingsRate + 0.02) {
      trendArrow = ` <span title="Live savings rate above historical average" style="color:#10b981;font-size:0.7em">\u25B2</span>`;
    } else if (liveSavingsRate < histSavingsRate - 0.02) {
      trendArrow = ` <span title="Live savings rate below historical average" style="color:#e06c75;font-size:0.7em">\u25BC</span>`;
    }
  }

  body += `<div class="stats">
    <div class="stat"><div class="label">Sessions</div><div class="value">${allCosts.size}<span class="total">/${combinedSessionCount}</span></div></div>
    <div class="stat"><div class="label">Spend${trendArrow}</div><div class="value">${formatUSD(liveTotalSpend)}<span class="total">/${formatUSD(combinedTotalSpend)}</span></div></div>
    <div class="stat"><div class="label">Avoided Compactions</div><div class="value">${liveAvoidedCompactions}<span class="total">/${combinedAvoidedCompactions}</span></div></div>
  </div>`;

  // --- Daily cost trend chart ---
  const dailyCosts = computeDailyCosts(14);
  const maxDayCost = Math.max(...dailyCosts.map((d) => d.cost), 0.001);
  if (dailyCosts.some((d) => d.cost > 0)) {
    body += `<h3>Daily Cost Trend (last 14 days)</h3>`;
    body += `<div class="daily-chart">`;
    const barMaxPx = 90; // max bar height in pixels (leaves room for label)
    for (const day of dailyCosts) {
      const barPx = Math.max(2, (day.cost / maxDayCost) * barMaxPx);
      const label = day.date.slice(5); // "MM-DD"
      const tooltip = `${day.date}: ${formatUSD(day.cost)}`;
      body += `<div class="day-col" title="${esc(tooltip)}">
        <div class="day-bar" style="height:${barPx.toFixed(0)}px"></div>
        <div class="day-label">${esc(label)}</div>
      </div>`;
    }
    body += `</div>`;
  }

  // =====================================================
  // LIVE SESSIONS section
  // =====================================================
  body += `<h2>Live Sessions (since gateway start)</h2>`;

  if (allCosts.size === 0) {
    body += `<p class="empty">No active sessions yet. Cost tracking begins when the first conversation turn is processed.</p>`;
  } else {
    // --- Visual cost bars ---
    body += `<div class="card">`;

    // Spend composition bar: conversation vs overhead
    const spendTotal = liveTotalConversation + liveTotalWorker;
    const convPct =
      spendTotal > 0 ? (liveTotalConversation / spendTotal) * 100 : 100;
    const overheadParts: string[] = [];
    if (liveDistillCost > 0)
      overheadParts.push(`distill: ${formatUSD(liveDistillCost)}`);
    if (liveCurateCost > 0)
      overheadParts.push(`curate: ${formatUSD(liveCurateCost)}`);
    if (liveCompactCost > 0)
      overheadParts.push(`compact: ${formatUSD(liveCompactCost)}`);
    if (liveWarmupCost > 0)
      overheadParts.push(`warmup: ${formatUSD(liveWarmupCost)}`);
    if (liveRecallCost > 0)
      overheadParts.push(`recall: ${formatUSD(liveRecallCost)}`);
    const overheadDetail = overheadParts.length
      ? ` (${overheadParts.join(", ")})`
      : "";
    body += renderCostBar({
      title: "Spend Composition",
      value: formatUSD(liveTotalSpend),
      percent: convPct,
      tint: "bar-green",
      detailLeftHtml: `Conversation: ${formatUSD(liveTotalConversation)} (${liveTotalTurns} turns)`,
      detailRightHtml: `Overhead: ${formatUSD(liveTotalWorker)}${overheadDetail}`,
    });

    // Savings ratio bar: actual vs counterfactual
    if (liveTotalWithout > 0) {
      const actualPct = (liveTotalSpend / liveTotalWithout) * 100;
      body += renderCostBar({
        title: "Actual vs Without Lore",
        value: `${formatUSD(liveTotalSpend)} of ${formatUSD(liveTotalWithout)}`,
        percent: actualPct,
        tint: liveTotalSavings >= 0 ? "bar-blue" : "bar-red",
        ghostPercent: 100,
        detailLeftHtml:
          liveTotalSavings >= 0
            ? `Saved: ${formatUSD(liveTotalSavings)}`
            : `Overhead: ${formatUSD(-liveTotalSavings)}`,
        detailRightHtml:
          liveTotalWithout > 0
            ? liveTotalSavings >= 0
              ? `${(100 - actualPct).toFixed(0)}% saved`
              : `${(actualPct - 100).toFixed(0)}% overhead`
            : "",
      });
    }

    // Cache hit rate bar
    const liveCacheHitPct =
      liveTotalInputTokens > 0
        ? (liveCacheReadTokens / liveTotalInputTokens) * 100
        : 0;
    if (liveTotalInputTokens > 0) {
      body += renderCostBar({
        title: "Cache Hit Rate",
        value: `${liveCacheHitPct.toFixed(0)}%`,
        percent: liveCacheHitPct,
        tint: "bar-green",
        detailLeftHtml: `${formatTokens(liveCacheReadTokens)} cache reads`,
        detailRightHtml: `${formatTokens(liveTotalInputTokens)} total input`,
      });
    }

    // Savings breakdown (compact list)
    if (liveTotalSavings !== 0) {
      const savingsItems: string[] = [];
      if (liveWarmupSavings > 0)
        savingsItems.push(`Cache warming: ${formatUSD(liveWarmupSavings)}`);
      if (liveTtlSavings > 0)
        savingsItems.push(`1h TTL: ${formatUSD(liveTtlSavings)}`);
      if (liveBatchSavings > 0)
        savingsItems.push(`Batch API: ${formatUSD(liveBatchSavings)}`);
      if (liveAvoidedCompactionCost > 0)
        savingsItems.push(
          `Avoided compactions: ${formatUSD(liveAvoidedCompactionCost)} (&times;${liveAvoidedCompactions})`,
        );
      if (savingsItems.length) {
        const netLabel = liveTotalSavings >= 0 ? "Net savings" : "Net overhead";
        const netValue =
          liveTotalSavings >= 0
            ? formatUSD(liveTotalSavings)
            : formatUSD(Math.abs(liveTotalSavings));
        body += `<div style="margin-top:10px;font-size:0.85em;color:var(--fg2)">
          <strong style="color:${liveTotalSavings >= 0 ? "#10b981" : "#e06c75"}">${netLabel}: ${netValue}</strong>
          &mdash; ${savingsItems.join(" &middot; ")}
        </div>`;
      }
    }
    body += `</div>`;

    // Per-session table (unified: cost + warming columns)
    const activeSessions = getActiveSessions();
    const snapshotMap = new Map<string, WarmingSnapshot>();
    for (const [sid, state] of activeSessions) {
      snapshotMap.set(sid, computeWarmingSnapshot(state));
    }
    body += `<h3>Per Session</h3>`;
    body += renderLiveSessionsTable(
      buildLiveSessionRows(allCosts, activeSessions, snapshotMap, parentMap),
      "No active sessions yet. Cost tracking begins when the first conversation turn is processed.",
      "costs-live-sessions",
    );
  }

  // =====================================================
  // HISTORICAL (BACKDATED) section
  // =====================================================
  body += `<h2>Historical Estimates (from stored data)</h2>`;
  body += `<p style="color:var(--fg3);font-size:0.9em">
    Aggregated from ${hist.sessionCount} sessions (${hist.messageCount.toLocaleString()} messages).
    Worker overhead and savings use persisted live-session data where available,
    with heuristic estimates as fallback for sessions without a snapshot.
  </p>`;

  if (hist.sessionCount === 0) {
    body += `<p class="empty">No historical sessions found in the database.</p>`;
  } else {
    const histNetSavings =
      hist.avoidedCompactionCost +
      hist.warmupSavings +
      hist.ttlSavings +
      hist.batchSavings -
      hist.totalWorkerCost;
    body += `<div class="card">
      <table class="cost-table">`;
    if (hist.persistedConversationCost > 0) {
      body += `<tr class="section-header"><td colspan="2"><strong>Historical Spend</strong></td></tr>
        <tr><td>Conversation</td><td>${formatUSD(hist.persistedConversationCost)}</td></tr>`;
    }
    body += `<tr class="section-header"><td colspan="2"${hist.persistedConversationCost > 0 ? ' style="padding-top:0.8em"' : ""}><strong>Lore Overhead</strong></td></tr>
        <tr><td>Total worker cost</td><td>${formatUSD(hist.totalWorkerCost)}`;
    if (hist.totalWorkerCost !== hist.distillationCost) {
      body += ` <span style="color:var(--fg3);font-size:0.85em">(distillation-only estimate: ${formatUSD(hist.distillationCost)})</span>`;
    }
    body += `</td></tr>
        <tr class="section-header"><td colspan="2" style="padding-top:0.8em"><strong>Estimated Savings</strong></td></tr>
        <tr><td>Avoided compactions</td><td>${formatUSD(hist.avoidedCompactionCost)} <span style="color:var(--fg3);font-size:0.85em">(&times;${hist.avoidedCompactions})</span></td></tr>
        ${hist.warmupSavings > 0 ? `<tr><td>Cache warming</td><td>${formatUSD(hist.warmupSavings)} <span style="color:var(--fg3);font-size:0.85em">(${hist.warmupHits} hits)</span></td></tr>` : ""}
        ${hist.ttlSavings > 0 ? `<tr><td>1h TTL extension</td><td>${formatUSD(hist.ttlSavings)} <span style="color:var(--fg3);font-size:0.85em">(${hist.ttlHits} hits)</span></td></tr>` : ""}
        ${hist.batchSavings > 0 ? `<tr><td>Batch API discount</td><td>${formatUSD(hist.batchSavings)}</td></tr>` : ""}
        <tr style="border-top:1px solid var(--border)"><td><strong>${histNetSavings >= 0 ? "Net estimated savings" : "Net estimated overhead"}</strong></td><td><strong style="color:${histNetSavings >= 0 ? "#10b981" : "#e06c75"}">${histNetSavings >= 0 ? formatUSD(histNetSavings) : formatUSD(Math.abs(histNetSavings))}</strong></td></tr>
      </table>
    </div>`;

    // Per-session historical table (top 50) — with sub-agent tree grouping
    // (parentMap already loaded above for the live table)

    // Build tree: group children under parents, roll up worker costs
    type HistRow = (typeof historical.sessions)[number] & {
      children: HistRow[];
      rolledUpWorkerCost: number;
    };
    const histRowMap = new Map<string, HistRow>();
    for (const s of historical.sessions) {
      histRowMap.set(s.sessionId, {
        ...s,
        children: [],
        rolledUpWorkerCost: s.persisted?.workerCost ?? s.distillationCost,
      });
    }
    for (const [childId, parentId] of parentMap) {
      const child = histRowMap.get(childId);
      const parent = histRowMap.get(parentId);
      if (child && parent) {
        parent.children.push(child);
      }
    }
    // Recursive roll-up (bottom-up)
    function histRollUp(row: HistRow): void {
      for (const child of row.children) {
        histRollUp(child);
        row.rolledUpWorkerCost += child.rolledUpWorkerCost;
      }
    }
    // Root rows: not a child of any known parent in the set
    const histRoots = [...histRowMap.values()].filter((r) => {
      const parentId = parentMap.get(r.sessionId);
      return parentId === undefined || !histRowMap.has(parentId);
    });
    for (const root of histRoots) histRollUp(root);

    const displayed = histRoots.slice(0, 50);
    body += `<h3>Per Session (top ${displayed.length} by recency)</h3>
    <div class="table-filter"><input type="text" placeholder="Filter sessions\u2026"><span class="count"></span></div>
    <table data-table-id="costs-historical-sessions">
      <tr><th data-sort="text">Project</th><th>Session</th><th data-sort="num">Messages</th><th data-sort="text">Model</th><th data-sort="num">Worker Cost</th><th data-sort="num">Avoided Compactions</th><th data-sort="date" data-default-sort="desc">Last Active</th></tr>`;

    // Recursive rendering for historical rows
    function renderHistRow(s: HistRow, parentSid?: string): void {
      const isChild = parentSid != null;
      const parentSidValue = parentSid ?? "";
      const hasChildren = s.children.length > 0;
      const toggle =
        hasChildren && !isChild
          ? `<span class="toggle-btn" data-session-id="${esc(s.sessionId)}">\u25B6</span>`
          : hasChildren
            ? `<span class="toggle-btn" data-session-id="${esc(s.sessionId)}">\u25B6</span>`
            : "";
      const childCount = hasChildren
        ? `<span class="subagent-count">(+${s.children.length})</span>`
        : "";
      const prefix = isChild ? `<span style="opacity:0.4">\u21B3</span> ` : "";
      const trAttrs = isChild
        ? ` class="subagent-row" data-parent="${esc(parentSidValue)}"`
        : "";
      const displayCost = hasChildren
        ? s.rolledUpWorkerCost
        : (s.persisted?.workerCost ?? s.distillationCost);

      const savingsBg =
        s.avoidedCompactions > 0 ? "rgba(16,185,129,0.08)" : "transparent";
      body += `<tr${trAttrs}>
        <td>${toggle}<a href="/ui/projects/${esc(s.projectId)}">${esc(s.projectName ?? "(unnamed)")}</a></td>
        <td>${prefix}<a href="/ui/sessions/${esc(s.projectId)}/${esc(s.sessionId)}"><code>${esc(s.sessionId.slice(0, 12))}</code></a>${childCount}</td>
        <td>${s.messageCount}</td>
        <td style="font-size:0.85em">${esc(s.model.replace("claude-", "").slice(0, 20))}</td>
        <td>${formatUSD(displayCost)}</td>
        <td style="background:${savingsBg}">${s.avoidedCompactions > 0 ? `${s.avoidedCompactions} (${formatUSD(s.avoidedCompactionCost)})` : "-"}</td>
        <td>${timeAgo(s.lastMessage)}</td>
      </tr>`;
      for (const child of s.children) {
        renderHistRow(child, s.sessionId);
      }
    }
    for (const s of displayed) {
      renderHistRow(s);
    }

    body += `</table>`;
    if (histRoots.length > 50) {
      body += `<p style="color:var(--fg3);font-size:0.85em">Showing 50 of ${histRoots.length} sessions.</p>`;
    }
  }

  return layout("Costs", body);
}

// ---------------------------------------------------------------------------
// Route matching helpers
// ---------------------------------------------------------------------------

type RouteParams = Record<string, string>;

function matchRoute(pathname: string, pattern: string): RouteParams | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Entities pages
// ---------------------------------------------------------------------------

async function pageEntities(): Promise<string> {
  const all = entities.listAll();

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Entities" },
  ]);
  body += `<h1>Entities (${all.length})</h1>`;

  if (!all.length) {
    body += `<p class="empty">No entities found. Entities are created automatically when the curator detects recurring people, services, tools, and other named references in conversations.</p>`;
    return layout("Entities", body);
  }

  // Merge suggestions (#462): surface duplicate candidates as a dry-run banner.
  // Only compute when embeddings are available (the primary signal); cheap for
  // typical registry sizes. Non-fatal — failures just omit the section.
  if (embedding.isAvailable() && all.length >= 2) {
    try {
      const dupes = await entities.deduplicateEntities(undefined, {
        dryRun: true,
      });
      // Filter out pairs the user has already dismissed via the dashboard.
      const dismissed = entities.getDismissedEntityPairs();
      const clusters = [...dupes.merged, ...dupes.suggested]
        .map((c) => ({
          ...c,
          merged: c.merged.filter(
            (m) => !dismissed.has(`${m.name}\x1f${c.surviving.name}`),
          ),
        }))
        .filter((c) => c.merged.length > 0);
      if (clusters.length > 0) {
        const pairCount = clusters.reduce((n, c) => n + c.merged.length, 0);
        body += `<div class="banner" style="border:1px solid #d0a000;background:#fffbe6;padding:12px 16px;border-radius:6px;margin:12px 0;">`;
        body += `<strong>${pairCount} possible duplicate ${pairCount === 1 ? "entity" : "entities"} found.</strong> Review and merge below, or run <code>lore entity dedup</code>.`;
        body += `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">`;
        const MAX_SUGGESTIONS = 25;
        let shown = 0;
        for (const c of clusters) {
          for (const m of c.merged) {
            if (shown >= MAX_SUGGESTIONS) break;
            shown++;
            body += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">`;
            body += `<span><a href="/ui/entities/${esc(m.id)}">${esc(truncate(m.name, 40))}</a> → <a href="/ui/entities/${esc(c.surviving.id)}">${esc(truncate(c.surviving.name, 40))}</a></span>`;
            body += `<span class="muted" style="color:#888;">[sim: ${m.similarity.toFixed(3)}]</span>`;
            body += `<form method="POST" action="/ui/api/merge/entity/${esc(c.surviving.id)}/${esc(m.id)}" style="display:inline;" onsubmit="return confirm('Merge &quot;${esc(m.name)}&quot; into &quot;${esc(c.surviving.name)}&quot;?');">`;
            body += `<input type="hidden" name="similarity" value="${m.similarity}">`;
            body += `<input type="hidden" name="nameA" value="${esc(m.name)}">`;
            body += `<input type="hidden" name="nameB" value="${esc(c.surviving.name)}">`;
            body += `<button type="submit" style="font-size:12px;padding:2px 8px;">Merge</button>`;
            body += `</form>`;
            body += `<form method="POST" action="/ui/api/dismiss/entity/${esc(m.id)}/${esc(c.surviving.id)}" style="display:inline;">`;
            body += `<input type="hidden" name="similarity" value="${m.similarity}">`;
            body += `<button type="submit" style="font-size:12px;padding:2px 8px;" title="Not duplicates — don\u2019t suggest again">Dismiss</button>`;
            body += `</form>`;
            body += `</div>`;
          }
          if (shown >= MAX_SUGGESTIONS) break;
        }
        if (pairCount > shown) {
          body += `<span class="muted" style="color:#888;">…and ${pairCount - shown} more. Use <code>lore entity dedup</code>.</span>`;
        }
        body += `</div></div>`;
      }
    } catch (err) {
      log.warn("entity dedup suggestions failed (non-fatal):", err);
    }
  }

  // Type breakdown stats — fold "self" into "person" (there's at most one self
  // entity so a separate stat is noise; mirrors formatForPrompt() grouping).
  const types: Record<string, number> = {};
  for (const e of all) {
    const displayType = e.entity_type === "self" ? "person" : e.entity_type;
    types[displayType] = (types[displayType] || 0) + 1;
  }
  body += `<div class="stats">
    <div class="stat stat-filter" data-type-filter="all"><div class="label">Total</div><div class="value">${all.length}</div></div>`;
  for (const [type, count] of Object.entries(types).sort(
    (a, b) => b[1] - a[1],
  )) {
    body += `<div class="stat stat-filter" data-type-filter="${esc(type)}"><div class="label">${esc(type)}</div><div class="value">${count}</div></div>`;
  }
  body += `</div>`;

  // Batch-load knowledge ref counts to avoid N+1 queries
  const knowledgeCounts = new Map<string, number>();
  {
    const rows = db()
      .query(
        "SELECT entity_id, COUNT(*) as cnt FROM knowledge_entity_refs GROUP BY entity_id",
      )
      .all() as Array<{ entity_id: string; cnt: number }>;
    for (const r of rows) knowledgeCounts.set(r.entity_id, r.cnt);
  }

  body += `<div class="table-filter"><input type="text" placeholder="Filter entities\u2026"><span class="count"></span></div>
  <table data-table-id="entities" data-custom-filter>
    <tr><th data-sort="text">Type</th><th data-sort="text">Name</th><th data-sort="num">Aliases</th><th data-sort="num">Knowledge</th><th data-sort="text">Cross</th><th data-sort="date" data-default-sort="desc">Updated</th></tr>`;
  for (const e of all) {
    const aliasCount = e.aliases.filter(
      (a) => a.alias_value !== e.canonical_name,
    ).length;
    const knowledgeCount = knowledgeCounts.get(e.id) ?? 0;
    const rowType = e.entity_type === "self" ? "person" : e.entity_type;
    body += `<tr data-entity-type="${esc(rowType)}">
      <td>${badge(e.entity_type)}</td>
      <td><a href="/ui/entities/${esc(e.id)}">${esc(truncate(e.canonical_name, 50))}</a></td>
      <td>${aliasCount}</td>
      <td>${knowledgeCount}</td>
      <td>${e.cross_project ? "yes" : "no"}</td>
      <td>${timeAgo(e.updated_at)}</td>
    </tr>`;
  }
  body += `</table>`;

  return layout("Entities", body);
}

function pageEntity(id: string): string | null {
  const entity = entities.getWithAliases(id);
  if (!entity) return null;

  const projName = entity.project_id ? projectName(entity.project_id) : null;

  let body = breadcrumb([
    { label: "Dashboard", href: "/ui" },
    { label: "Entities", href: "/ui/entities" },
    { label: truncate(entity.canonical_name, 40) },
  ]);

  body += `<h1>${esc(entity.canonical_name)}</h1>`;
  body += `<div class="field"><span class="key">Type:</span> ${badge(entity.entity_type)}</div>`;
  body += `<div class="field"><span class="key">ID:</span> <code>${esc(entity.id)}</code></div>`;
  body += `<div class="field"><span class="key">Project:</span> ${
    entity.project_id
      ? `<a href="/ui/projects/${esc(entity.project_id)}">${esc(projName ?? "(unknown)")}</a>`
      : "(global)"
  }</div>`;
  body += `<div class="field"><span class="key">Cross-project:</span> ${entity.cross_project ? "Yes" : "No"}</div>`;
  body += `<div class="field"><span class="key">Created:</span> ${formatDate(entity.created_at)}</div>`;
  body += `<div class="field"><span class="key">Updated:</span> ${formatDate(entity.updated_at)}</div>`;
  // Metadata section
  let parsedMeta: Record<string, unknown> = {};
  if (entity.metadata) {
    try {
      parsedMeta = JSON.parse(entity.metadata);
    } catch {
      /* ignore */
    }
  }
  const hasMetadata = Object.keys(parsedMeta).length > 0;
  if (hasMetadata) {
    body += `<h2>Metadata</h2>`;
    if (typeof parsedMeta.role === "string" && parsedMeta.role) {
      body += `<div class="field"><span class="key">Role:</span> ${esc(parsedMeta.role)}</div>`;
    }
    if (typeof parsedMeta.description === "string" && parsedMeta.description) {
      body += `<div class="field"><span class="key">Description:</span> ${esc(parsedMeta.description)}</div>`;
    }
    if (typeof parsedMeta.notes === "string" && parsedMeta.notes) {
      body += `<div class="field"><span class="key">Notes:</span> ${esc(parsedMeta.notes)}</div>`;
    }
    // Show any extra keys as raw JSON
    const { role, description, notes, ...extra } = parsedMeta as Record<
      string,
      unknown
    >;
    if (Object.keys(extra).length > 0) {
      body += `<div class="field"><span class="key">Other:</span></div><pre>${esc(JSON.stringify(extra, null, 2))}</pre>`;
    }
  }

  // Metadata edit form
  body += `<h2>Edit Metadata</h2>`;
  body += `<form method="POST" action="/ui/api/update/entity/${esc(entity.id)}/metadata" style="display:flex;flex-direction:column;gap:8px;max-width:500px;">`;
  body += `<label>Role: <input name="role" value="${esc(String(parsedMeta.role ?? ""))}" style="width:100%;" /></label>`;
  body += `<label>Description: <input name="description" value="${esc(String(parsedMeta.description ?? ""))}" style="width:100%;" /></label>`;
  body += `<label>Notes: <textarea name="notes" rows="3" style="width:100%;">${esc(String(parsedMeta.notes ?? ""))}</textarea></label>`;
  body += `<button type="submit">Save Metadata</button>`;
  body += `</form>`;

  // Aliases
  const displayAliases = entity.aliases.filter(
    (a) => a.alias_value !== entity.canonical_name,
  );
  if (displayAliases.length > 0) {
    body += `<h2>Aliases (${displayAliases.length})</h2>`;
    body += `<table data-table-id="entity-aliases">
      <tr><th data-sort="text">Type</th><th data-sort="text">Value</th><th data-sort="text">Source</th><th data-sort="date">Added</th></tr>`;
    for (const a of displayAliases) {
      body += `<tr>
        <td>${badge(a.alias_type)}</td>
        <td><code>${esc(a.alias_value)}</code></td>
        <td>${esc(a.source ?? "(auto)")}</td>
        <td>${timeAgo(a.created_at)}</td>
      </tr>`;
    }
    body += `</table>`;
  } else {
    body += `<h2>Aliases</h2><p class="empty">No additional aliases (only the canonical name).</p>`;
  }

  // Relationships
  const relations = entities.relationsFor(entity.id);
  if (relations.length > 0) {
    body += `<h2>Relationships (${relations.length})</h2>`;
    body += `<table data-table-id="entity-relations">
      <tr><th data-sort="text">Relation</th><th data-sort="text">Entity</th><th data-sort="text">Type</th></tr>`;
    for (const r of relations) {
      body += `<tr>
        <td>${badge(r.relation)}</td>
        <td><a href="/ui/entities/${esc(r.other_id)}">${esc(r.other_name)}</a></td>
        <td>${badge(r.other_type)}</td>
      </tr>`;
    }
    body += `</table>`;
  }

  // Linked knowledge entries
  const knowledgeIds = entities.knowledgeForEntity(entity.id);
  if (knowledgeIds.length > 0) {
    body += `<h2>Linked Knowledge (${knowledgeIds.length})</h2>`;
    body += `<table data-table-id="entity-knowledge">
      <tr><th data-sort="text">Category</th><th data-sort="text">Title</th></tr>`;
    for (const kid of knowledgeIds) {
      const entry = ltm.get(kid);
      if (entry) {
        body += `<tr>
          <td>${badge(entry.category)}</td>
          <td><a href="/ui/knowledge/${esc(entry.id)}">${esc(truncate(entry.title, 60))}</a></td>
        </tr>`;
      }
    }
    body += `</table>`;
  }

  body += `<div class="actions">
    ${deleteForm(`/ui/api/delete/entity/${esc(entity.id)}`, "Delete Entity", "Delete this entity and all its aliases?")}
  </div>`;

  return layout(entity.canonical_name, body);
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export async function handleUIRequest(
  req: Request,
  url: URL,
): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // --- GET routes ---
  if (method === "GET") {
    // Dashboard
    if (pathname === "/ui" || pathname === "/ui/") {
      return htmlResponse(pageDashboard());
    }

    // Project detail
    const projectMatch = matchRoute(pathname, "/ui/projects/:id");
    if (projectMatch) {
      const html = pageProject(projectMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Project not found</h1>`), 404);
    }

    // User knowledge list (cross-project + global entries)
    if (pathname === "/ui/knowledge") {
      return htmlResponse(pageUserKnowledge());
    }

    // Knowledge detail
    const knowledgeMatch = matchRoute(pathname, "/ui/knowledge/:id");
    if (knowledgeMatch) {
      const html = pageKnowledge(knowledgeMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(
            layout("Not Found", `<h1>Knowledge entry not found</h1>`),
            404,
          );
    }

    // Session detail
    const sessionMatch = matchRoute(
      pathname,
      "/ui/sessions/:projectId/:sessionId",
    );
    if (sessionMatch) {
      const html = pageSession(sessionMatch.projectId, sessionMatch.sessionId);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Session not found</h1>`), 404);
    }

    // Distillation detail
    const distMatch = matchRoute(pathname, "/ui/distillations/:id");
    if (distMatch) {
      const html = pageDistillation(distMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(
            layout("Not Found", `<h1>Distillation not found</h1>`),
            404,
          );
    }

    // Costs
    if (pathname === "/ui/costs") {
      return htmlResponse(pageCosts());
    }

    // Cache warming
    if (pathname === "/ui/warming") {
      return htmlResponse(pageWarming());
    }

    // Entity list
    if (pathname === "/ui/entities") {
      return htmlResponse(await pageEntities());
    }

    // Entity detail
    const entityMatch = matchRoute(pathname, "/ui/entities/:id");
    if (entityMatch) {
      const html = pageEntity(entityMatch.id);
      return html
        ? htmlResponse(html)
        : htmlResponse(layout("Not Found", `<h1>Entity not found</h1>`), 404);
    }

    // Search detail (by source-prefixed ID)
    const searchDetailMatch = matchRoute(pathname, "/ui/search/detail/:fullId");
    if (searchDetailMatch) {
      const html = pageSearchDetail(searchDetailMatch.fullId);
      return html
        ? htmlResponse(html)
        : htmlResponse(
            layout(
              "Not Found",
              `<h1>Entry not found</h1><p>No entry found for ID: ${esc(searchDetailMatch.fullId)}</p>`,
            ),
            404,
          );
    }

    // Search
    if (pathname === "/ui/search") {
      return htmlResponse(await pageSearch(url));
    }
  }

  // --- POST routes (mutations) ---
  if (method === "POST") {
    // Delete entity
    const delEntity = matchRoute(pathname, "/ui/api/delete/entity/:id");
    if (delEntity) {
      entities.remove(delEntity.id);
      return redirect("/ui/entities");
    }

    // Merge entity (dedup suggestion): keep target, absorb source (#462)
    const mergeEntity = matchRoute(
      pathname,
      "/ui/api/merge/entity/:targetId/:sourceId",
    );
    if (mergeEntity) {
      const target = entities.get(mergeEntity.targetId);
      const source = entities.get(mergeEntity.sourceId);
      // Allow same-type merges + self↔person (self is conceptually a person)
      const selfPersonSet = new Set(["self", "person"]);
      const typesCompatible =
        target &&
        source &&
        (target.entity_type === source.entity_type ||
          (selfPersonSet.has(target.entity_type) &&
            selfPersonSet.has(source.entity_type)));
      if (target && source && target.id !== source.id && typesCompatible) {
        // Parse form data before merge — source entity is deleted by merge().
        const formData = await req.formData();
        const similarity = Number.parseFloat(
          (formData.get("similarity") as string) || "",
        );
        entities.merge(target.id, source.id);
        // Record accept feedback — the similarity score is the real cosine
        // value from the dedup dry-run, passed through as a hidden form field.
        if (Number.isFinite(similarity)) {
          entities.recordEntityDedupFeedback({
            projectId: null,
            entryATitle:
              (formData.get("nameA") as string) || source.canonical_name,
            entryBTitle:
              (formData.get("nameB") as string) || target.canonical_name,
            similarity,
            accepted: true,
            source: "dashboard",
          });
        }
      }
      return redirect("/ui/entities");
    }

    // Dismiss entity merge suggestion: record reject feedback (#462)
    const dismissEntity = matchRoute(
      pathname,
      "/ui/api/dismiss/entity/:entityAId/:entityBId",
    );
    if (dismissEntity) {
      const entityA = entities.get(dismissEntity.entityAId);
      const entityB = entities.get(dismissEntity.entityBId);
      const formData = await req.formData();
      const similarity = Number.parseFloat(
        (formData.get("similarity") as string) || "",
      );
      if (Number.isFinite(similarity) && entityA && entityB) {
        entities.recordEntityDedupFeedback({
          projectId: null,
          entryATitle: entityA.canonical_name,
          entryBTitle: entityB.canonical_name,
          similarity,
          accepted: false,
          source: "dashboard",
        });
      }
      return redirect("/ui/entities");
    }

    // Update entity metadata
    const updateEntityMeta = matchRoute(
      pathname,
      "/ui/api/update/entity/:id/metadata",
    );
    if (updateEntityMeta) {
      const entity = entities.get(updateEntityMeta.id);
      if (!entity) return redirect("/ui/entities");
      const formData = await req.formData();
      const existing = entity.metadata ? JSON.parse(entity.metadata) : {};
      const role = (formData.get("role") as string)?.trim() || undefined;
      const description =
        (formData.get("description") as string)?.trim() || undefined;
      const notes = (formData.get("notes") as string)?.trim() || undefined;
      const metadata: Record<string, unknown> = { ...existing };
      // Update known fields — set to value or remove if empty
      if (role !== undefined) metadata.role = role;
      else delete metadata.role;
      if (description !== undefined) metadata.description = description;
      else delete metadata.description;
      if (notes !== undefined) metadata.notes = notes;
      else delete metadata.notes;
      entities.update(updateEntityMeta.id, {
        metadata: Object.keys(metadata).length > 0 ? metadata : {},
      });
      return redirect(`/ui/entities/${updateEntityMeta.id}`);
    }

    // Delete knowledge
    const delKnowledge = matchRoute(pathname, "/ui/api/delete/knowledge/:id");
    if (delKnowledge) {
      const entry = ltm.get(delKnowledge.id);
      data.deleteKnowledge(delKnowledge.id);
      if (entry?.cross_project || !entry?.project_id) {
        return redirect("/ui/knowledge");
      }
      return redirect(`/ui/projects/${entry.project_id}`);
    }

    // Delete session
    const delSession = matchRoute(
      pathname,
      "/ui/api/delete/session/:projectId/:sessionId",
    );
    if (delSession) {
      const projects = data.listProjects();
      const project = projects.find((p) => p.id === delSession.projectId);
      if (project) {
        data.deleteSession(project.path, delSession.sessionId);
      }
      return redirect(`/ui/projects/${delSession.projectId}`);
    }

    // Delete distillation
    const delDist = matchRoute(pathname, "/ui/api/delete/distillation/:id");
    if (delDist) {
      const dist = data.getDistillation(delDist.id);
      data.deleteDistillation(delDist.id);
      const pid = dist?.project_id;
      return redirect(pid ? `/ui/projects/${pid}` : "/ui");
    }

    // Clear project
    const clearProject = matchRoute(pathname, "/ui/api/clear/project/:id");
    if (clearProject) {
      const projects = data.listProjects();
      const project = projects.find((p) => p.id === clearProject.id);
      if (project) {
        data.clearProject(project.path);
      }
      return redirect("/ui");
    }

    // Delete project (full removal)
    const delProject = matchRoute(pathname, "/ui/api/delete/project/:id");
    if (delProject) {
      data.deleteProject(delProject.id);
      return redirect("/ui");
    }

    // Rename project
    const renameProjectMatch = matchRoute(
      pathname,
      "/ui/api/rename/project/:id",
    );
    if (renameProjectMatch) {
      const formData = await req.formData();
      const newName = formData.get("name");
      if (typeof newName === "string" && newName.trim()) {
        data.renameProject(renameProjectMatch.id, newName);
      }
      return redirect(`/ui/projects/${renameProjectMatch.id}`);
    }

    // Set daily budget
    if (pathname === "/ui/api/budget") {
      const formData = await req.formData();
      if (formData.get("action") === "disable") {
        setDailyBudget(0);
      } else {
        const budgetStr = formData.get("budget");
        const budgetVal =
          parseFloat(typeof budgetStr === "string" ? budgetStr : "0") || 0;
        setDailyBudget(budgetVal);
      }
      return redirect("/ui/costs");
    }

    // Set warming mode for a live session
    const warmingMode = matchRoute(
      pathname,
      "/ui/api/warming/:sessionId/:mode",
    );
    if (warmingMode) {
      const { sessionId, mode } = warmingMode;
      if (mode !== "keep" && mode !== "stop" && mode !== "auto") {
        return htmlResponse(
          layout("Bad Request", `<h1>Unknown warming mode: ${esc(mode)}</h1>`),
          400,
        );
      }
      const sessions = getActiveSessions();
      const state = [...sessions.values()].find(
        (s) => s.sessionID === sessionId,
      );
      if (state) {
        if (!state.warmup) {
          state.warmup = {
            lastWarmupAt: 0,
            warmupCount: 0,
            totalWarmups: 0,
            warmupHits: 0,
            disabled: false,
          };
        }
        if (mode === "keep") {
          state.warmup.forceKeepWarm = true;
          state.warmup.disabled = false;
        } else if (mode === "stop") {
          state.warmup.disabled = true;
          state.warmup.forceKeepWarm = false;
        } else {
          state.warmup.disabled = false;
          state.warmup.forceKeepWarm = false;
        }
        state._dirty = true;
      }
      const referer = req.headers.get("referer");
      return redirect(referer ?? "/ui/warming");
    }
  }

  // 404
  return htmlResponse(
    layout(
      "Not Found",
      `<h1>Page not found</h1><p><a href="/ui">Back to dashboard</a></p>`,
    ),
    404,
  );
}

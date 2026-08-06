import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  cellKey,
  createMatrixState,
  hasMatchingTerminalResult,
  readMatrixState,
  returnCellToPending,
  startCell,
  writeMatrixState,
} from "./matrix-state.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { force: true, recursive: true });
});

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const cell = {
  task: "iterative-orders",
  model: "sonnet-5",
  runtime: "opencode",
  arm: "lore",
  repetition: 1,
  out: "iterative-orders-sonnet-5-opencode-lore-r1",
};

test("writes state atomically and recognizes an unchanged terminal result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-state-"));
  dirs.push(root);
  const state = createMatrixState({
    manifestSha: "manifest",
    runManifestSha: "run-manifest",
    cells: [cell],
  });
  const record = state.cells[cellKey(cell)];
  const resultPath = path.join(root, cell.out, "result.json");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, '{"valid":true}\n');
  record.state = "terminal";
  record.terminalOutcome = "completed";
  record.resultSha256 = sha(fs.readFileSync(resultPath));

  const statePath = path.join(root, "matrix-state.json");
  writeMatrixState(statePath, state);

  expect(fs.existsSync(`${statePath}.${process.pid}.tmp`)).toBe(false);
  expect(readMatrixState(statePath)).toEqual(state);
  expect(hasMatchingTerminalResult(root, record, sha)).toBe(true);
});

test("reruns terminal records whose result is missing or changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-state-"));
  dirs.push(root);
  const state = createMatrixState({
    manifestSha: "manifest",
    runManifestSha: "run-manifest",
    cells: [cell],
  });
  const record = state.cells[cellKey(cell)];
  const resultPath = path.join(root, cell.out, "result.json");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, '{"valid":true}\n');
  record.state = "terminal";
  record.resultSha256 = sha(fs.readFileSync(resultPath));

  fs.writeFileSync(resultPath, '{"valid":false}\n');
  expect(hasMatchingTerminalResult(root, record, sha)).toBe(false);
  fs.rmSync(resultPath);
  expect(hasMatchingTerminalResult(root, record, sha)).toBe(false);
});

test("retries an interrupted cell without preserving its terminal claim", () => {
  const state = createMatrixState({
    manifestSha: "manifest",
    runManifestSha: "run-manifest",
    cells: [cell],
  });
  const record = state.cells[cellKey(cell)];

  startCell(record);
  expect(record).toMatchObject({
    state: "running",
    attempts: 1,
    resultSha256: null,
    terminalOutcome: null,
  });
  record.resultSha256 = "stale";
  returnCellToPending(record);
  startCell(record);
  expect(record).toMatchObject({
    state: "running",
    attempts: 2,
    resultSha256: null,
  });
});

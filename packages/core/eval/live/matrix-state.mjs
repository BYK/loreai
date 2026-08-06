import fs from "node:fs";
import path from "node:path";

export const MATRIX_STATE_FILE = "matrix-state.json";

export function cellKey(cell) {
  return [
    cell.task,
    cell.model,
    cell.runtime,
    cell.arm,
    `r${cell.repetition}`,
  ].join("/");
}

export function createMatrixState({
  manifestSha,
  runManifestSha,
  shard,
  cells,
}) {
  const createdAt = new Date().toISOString();
  return {
    version: 1,
    manifestSha,
    runManifestSha,
    shard,
    createdAt,
    cells: Object.fromEntries(
      cells.map((cell) => [
        cellKey(cell),
        {
          input: cell,
          state: "pending",
          terminalOutcome: null,
          resultSha256: null,
          attempts: 0,
          updatedAt: createdAt,
        },
      ]),
    ),
  };
}

export function readMatrixState(file) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.version !== 1 || !state.cells || typeof state.cells !== "object") {
    throw new Error(`invalid matrix state: ${file}`);
  }
  return state;
}

export function writeMatrixState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}

export function hasMatchingTerminalResult(root, record, sha) {
  if (record.state !== "terminal" || !record.resultSha256) return false;
  const resultPath = path.join(root, record.input.out, "result.json");
  if (!fs.existsSync(resultPath)) return false;
  return sha(fs.readFileSync(resultPath)) === record.resultSha256;
}

export function startCell(record) {
  record.state = "running";
  record.terminalOutcome = null;
  record.resultSha256 = null;
  record.attempts = (record.attempts || 0) + 1;
  record.updatedAt = new Date().toISOString();
}

export function returnCellToPending(record) {
  record.state = "pending";
  record.updatedAt = new Date().toISOString();
}

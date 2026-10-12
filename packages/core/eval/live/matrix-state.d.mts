export interface MatrixCell {
  task: string;
  model: string;
  runtime: string;
  arm: string;
  repetition: number;
  out: string;
  factMapId?: string;
}

export interface MatrixRecord {
  input: MatrixCell;
  state: "pending" | "running" | "terminal";
  terminalOutcome: string | null;
  resultSha256: string | null;
  attempts: number;
  updatedAt: string;
}

export interface MatrixState {
  version: number;
  manifestSha: string;
  runManifestSha: string;
  shard: { index: number; count: number };
  createdAt: string;
  cells: Record<string, MatrixRecord>;
}

export const MATRIX_STATE_FILE: string;
export function scoreTrack(result: {
  expectedCheckpoints?: number;
  checkpoints?: unknown[];
  terminalOutcome?: string | null;
}): "workflow" | "retention";
export function cellKey(cell: MatrixCell): string;
export function createMatrixState(input: {
  manifestSha: string;
  runManifestSha: string;
  shard: { index: number; count: number };
  cells: MatrixCell[];
}): MatrixState;
export function readMatrixState(file: string): MatrixState;
export function writeMatrixState(file: string, state: MatrixState): void;
export function hasMatchingTerminalResult(
  root: string,
  record: MatrixRecord,
  sha: (value: Buffer) => string,
): boolean;
export function startCell(record: MatrixRecord): void;
export function returnCellToPending(record: MatrixRecord): void;

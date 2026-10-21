// Messages between the Studio and its test worker.

export interface RunRequest {
  files: Record<string, string>;
}

export interface LoadedHeuristic {
  id: string;
  /** A fact (derived state): watches are what it reads, owns is empty. */
  kind: "rule" | "decider" | "fact";
  owns: string[] | null;
  watches: string[] | null;
  /** Why owns/watches are unknown: a heuristic that needs params from heuristics.json. */
  note?: string;
}

export type LoadResult =
  | { file: string; ok: true; heuristics: LoadedHeuristic[] }
  | { file: string; ok: false; error: string };

export interface TestResult {
  file: string;
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface RunResult {
  loads: LoadResult[];
  tests: TestResult[];
  ms: number;
}

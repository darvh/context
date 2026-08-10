export interface Telemetry {
  cmd: string;
  totalMs: number;
  scanMs: number;
  parseMs: number;
  refreshMs: number;
  files: number;
  parsed: number;
  reused: number;
  symbols: number;
  edges: number;
  capsuleTokens: number;
  outputTokens: number;
  sourceCacheMiss: boolean;
}

export function emit(t: Partial<Telemetry>, opts: { json: boolean }): void {
  const line = "context:telemetry " + JSON.stringify(t);
  if (opts.json) {
    console.error(line);
  } else {
    console.error(line);
  }
}

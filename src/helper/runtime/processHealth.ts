export interface ProcessHealthLike {
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: string | null;
  stdin?: {
    destroyed?: boolean;
    writableEnded?: boolean;
  };
}

export function isProcessAlive(process: ProcessHealthLike | null): boolean {
  return !!(
    process &&
    !process.killed &&
    process.exitCode === null &&
    process.signalCode === null &&
    !process.stdin?.destroyed &&
    !process.stdin?.writableEnded
  );
}

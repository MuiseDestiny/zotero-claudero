import process from "node:process";

/** Helpers belong to Zotero's process lifetime, including crashes and app shutdown. */
export function watchParentProcess(
  parentPid: number,
  onExit: () => void,
  intervalMs = 2_000,
): () => void {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) return () => {};
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      // EPERM means the process exists. Only ESRCH proves that it has exited.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      clearInterval(timer);
      onExit();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Abort-aware sleep shared by the single-project and product watch loops.
// Resolves either after `ms` OR the moment `signal` aborts — no dangling timer,
// so a SIGINT/SIGTERM ends the poll interval immediately instead of hanging for
// the remainder of the sleep.

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

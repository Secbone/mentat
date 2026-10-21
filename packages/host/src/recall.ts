/** Cancel waiting for a read without dispatching a model request or retrying it. */
export async function awaitRecall<T>(
  operation: () => T | Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("turn cancelled before dispatch"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => reject(new Error("turn timed out before dispatch")),
        Math.max(0, deadline - Date.now()),
      );
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw new Error("turn cancelled before dispatch");
          return operation();
        })
        .then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

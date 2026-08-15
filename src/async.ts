/** Run `fn` over `items` with `n` concurrent workers, preserving order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Bound a stage with a hard timeout; on expiry return `fallback` so the
 * pipeline still emits valid fail-open output. Note: a timer cannot preempt
 * SYNC work (tree-sitter parse), it only bounds async stages (anydoc
 * conversion, model inference) — ponytail: real parse preemption needs worker
 * threads; the timeout guarantees valid output, not promptness.
 */
export async function withTimeout<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((res) => {
        timer = setTimeout(() => res(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}


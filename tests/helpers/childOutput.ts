// A real child's output as the runner programs read it: `observeOutput` awaits
// an observable signal on a still-running child, and `collectText` drains a
// stream to its end.

export function observeOutput(stream: AsyncIterable<Uint8Array>): {
  readonly waitFor: (expected: string) => Promise<void>;
  readonly text: () => string;
} {
  let text = "";
  let closed = false;
  const waiters = new Set<{
    readonly expected: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  void (async () => {
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      for (const waiter of waiters) {
        if (!text.includes(waiter.expected)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    closed = true;
    for (const waiter of waiters) {
      waiter.reject(
        new Error(
          `child closed before emitting ${JSON.stringify(waiter.expected)}`,
        ),
      );
    }
    waiters.clear();
  })().catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  });
  return {
    text: () => text,
    waitFor(expected) {
      if (text.includes(expected)) return Promise.resolve();
      if (closed) {
        return Promise.reject(
          new Error(`child closed before emitting ${JSON.stringify(expected)}`),
        );
      }
      return new Promise((resolve, reject) => {
        waiters.add({ expected, resolve, reject });
      });
    },
  };
}

export async function collectText(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

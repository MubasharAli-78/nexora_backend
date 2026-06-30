/** Minimal JSON-over-HTTP helper for AI providers, with an abort timeout. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`AI request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Retries `fn` up to `attempts` times with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  onRetry?: (err: Error, attempt: number) => void,
): Promise<T> {
  let lastErr: Error = new Error('withRetry: no attempts');
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (i < attempts) {
        onRetry?.(lastErr, i);
        await new Promise((r) => setTimeout(r, 400 * i));
      }
    }
  }
  throw lastErr;
}

import type { ClientConfig } from "../src/index.js";

export type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A `fetch` that records what it was asked and answers from a queue. No network, no timing, no surprises. */
export function recorder(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }> = []) {
  const calls: Call[] = [];
  const queue = [...responses];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(next.body ?? {}), {
      status,
      headers: next.headers,
    });
  }) as typeof fetch;

  return { impl, calls };
}

export const config = (over: Partial<ClientConfig> = {}): ClientConfig => ({
  projectId: "proj-1",
  baseUrl: "https://api.example.test",
  ...over,
});

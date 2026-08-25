import type { TokenStorage } from "./storage.js";

/** Any non-2xx answer from the API. `status` is the HTTP code; 0 means the request never left the client. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export type Requester = {
  <T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A GET that also returns the delta cursor (the `X-Fab-Now` header) used by polling. */
  poll<T>(path: string): Promise<{ data: T; cursor: string | null }>;
  /** The absolute URL of a project-scoped path — for links the browser must follow itself (OAuth, downloads). */
  url(path: string): string;
};

export function createRequester(opts: {
  baseUrl: string;
  projectId: string;
  storage: TokenStorage;
  fetchImpl: typeof fetch;
}): Requester {
  const root = `${opts.baseUrl}/projects/${opts.projectId}`;

  const headers = (body?: unknown): Record<string, string> => {
    const token = opts.storage.get();
    return {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const parse = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  };

  const req = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await opts.fetchImpl(root + path, {
      method,
      headers: headers(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const payload = await parse(res);
    if (!res.ok) throw new ApiError(res.status, (payload as { detail?: string })?.detail ?? res.statusText);
    return payload as T;
  };

  const requester = req as Requester;
  requester.poll = async <T>(path: string) => {
    const res = await opts.fetchImpl(root + path, { method: "GET", headers: headers() });
    const payload = await parse(res);
    if (!res.ok) throw new ApiError(res.status, (payload as { detail?: string })?.detail ?? res.statusText);
    return { data: payload as T, cursor: res.headers.get("X-Fab-Now") };
  };
  requester.url = (path: string) => root + path;
  return requester;
}

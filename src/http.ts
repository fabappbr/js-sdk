import type { TokenStorage } from "./storage.js";

/** Any non-2xx answer from the API. `status` is the HTTP code; 0 means the request never left the client. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a request is aborted — by a `signal` you passed, or by the client's `timeout`. */
export class AbortError extends Error {
  constructor(message = "the request was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export type RequestOptions = { signal?: AbortSignal };

export type Requester = {
  <T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /** A GET that also returns the delta cursor (the `X-Fab-Now` header) used by polling. */
  poll<T>(path: string, opts?: RequestOptions): Promise<{ data: T; cursor: string | null }>;
  /** The absolute URL of a project-scoped path — for links the browser must follow itself (OAuth, downloads). */
  url(path: string): string;
};

/**
 * Turns an error body into something a person can read.
 *
 * A gateway answering 502 sends HTML, not JSON, and the naive `JSON.parse` threw a SyntaxError with no status on it
 * — so every `if (e instanceof ApiError && e.status === 403)` in every caller silently stopped matching at exactly
 * the moment things were going wrong. And FastAPI's own request validation answers with `detail` as a LIST of
 * objects, which stringified to the literal text `[object Object]`.
 */
function readableDetail(payload: unknown, fallback: string): string {
  const detail = (payload as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string" && detail) return detail;

  if (Array.isArray(detail)) {
    const parts = detail.map((entry) => {
      if (typeof entry === "string") return entry;
      const item = entry as { loc?: unknown[]; msg?: string };
      // `loc` is ["body", "field", …] — the leading segment names the request part and helps nobody.
      const where = Array.isArray(item.loc) ? item.loc.slice(1).join(".") : "";
      if (item.msg) return where ? `${where}: ${item.msg}` : item.msg;
      return JSON.stringify(entry);
    }).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }

  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return fallback;
}

/** An HTML error page reduced to the sentence a person needs. */
function summarize(text: string, limit = 160): string {
  const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return "";
  return stripped.length > limit ? stripped.slice(0, limit - 1) + "…" : stripped;
}

/**
 * One signal out of up to two.
 *
 * `AbortSignal.any` would do this, but it only reached Safari in 17.4 — too recent to require of a package that
 * runs in every end user's browser.
 */
function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const controller = new AbortController();
  const stop = (reason: unknown) => controller.abort(reason);
  for (const signal of [a, b]) {
    if (signal.aborted) { stop(signal.reason); break; }
    signal.addEventListener("abort", () => stop(signal.reason), { once: true });
  }
  return controller.signal;
}

export function createRequester(opts: {
  baseUrl: string;
  projectId: string;
  storage: TokenStorage;
  fetchImpl: typeof fetch;
  /** Milliseconds before a request is aborted. Undefined or 0 means it waits as long as the server takes. */
  timeout?: number;
  /** A signal every request of this client obeys — one client per screen, cancelled on unmount. */
  signal?: AbortSignal;
}): Requester {
  const root = `${opts.baseUrl}/projects/${opts.projectId}`;

  const headers = (body?: unknown): Record<string, string> => {
    const token = opts.storage.get();
    return {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const signalFor = (perCall?: AbortSignal): AbortSignal | undefined => {
    const deadline = opts.timeout && opts.timeout > 0 ? AbortSignal.timeout(opts.timeout) : undefined;
    return combineSignals(combineSignals(opts.signal, perCall), deadline);
  };

  /** Every fetch failure that is not an HTTP answer: a dropped connection, a blocked origin, an abort. */
  const send = async (path: string, init: RequestInit, perCall?: AbortSignal): Promise<Response> => {
    try {
      return await opts.fetchImpl(root + path, { ...init, signal: signalFor(perCall) });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        throw new AbortError(name === "TimeoutError"
          ? `the request took longer than ${opts.timeout}ms`
          : "the request was aborted");
      }
      throw new ApiError(0, `the request never reached the API: ${(e as Error)?.message ?? String(e)}`);
    }
  };

  /** The single place a response becomes either a value or an ApiError. Nothing else parses a body. */
  const finish = async <T>(res: Response): Promise<T> => {
    if (res.status === 204) return undefined as T;
    const text = await res.text();

    let payload: unknown;
    let isJson = true;
    if (text) {
      try { payload = JSON.parse(text); } catch { isJson = false; }
    }

    if (!res.ok) {
      throw new ApiError(res.status, isJson
        ? readableDetail(payload, res.statusText)
        : summarize(text) || res.statusText || `HTTP ${res.status}`);
    }
    if (!isJson) {
      // A 2xx that is not JSON is still a broken answer — usually a captive portal or a proxy interstitial.
      throw new ApiError(res.status, `the API answered with a non-JSON body: ${summarize(text, 80)}`);
    }
    return payload as T;
  };

  /**
   * Renews the session once and says whether it worked.
   *
   * ⚠️ ONE ATTEMPT AT A TIME, which the shared promise is what guarantees. A screen fires several calls at once;
   * if each 401 asked for its own renewal, the first rotation would invalidate the refresh the others are still
   * using, and the server's reuse detection would take the whole lineage down — trading one sign-out an hour for
   * an immediate one.
   */
  let renewing: Promise<boolean> | undefined;
  const renew = (): Promise<boolean> => {
    if (renewing) return renewing;
    renewing = (async () => {
      const refresh = opts.storage.getRefresh?.();
      if (!refresh) return false;                 // a storage without support, or a session with no renewal
      try {
        const res = await send("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refresh }),
        });
        if (!res.ok) {
          // An explicit refusal is final: that refresh is spent. Clearing it stops the attempt repeating on
          // every following call and lets the client fall into the signed-out state, which is the honest one.
          opts.storage.set(undefined);
          opts.storage.setRefresh?.(undefined);
          return false;
        }
        const data = (await res.json()) as { access_token?: string; refresh_token?: string };
        if (!data.access_token) return false;
        opts.storage.set(data.access_token);
        if (data.refresh_token) opts.storage.setRefresh?.(data.refresh_token);
        return true;
      } catch {
        return false;      // a network failure is not an invalid session: nothing is cleared
      } finally {
        renewing = undefined;
      }
    })();
    return renewing;
  };

  const req = async <T>(method: string, path: string, body?: unknown, callOpts?: RequestOptions,
                        retried = false): Promise<T> => {
    const res = await send(path, {
      method,
      headers: headers(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    }, callOpts?.signal);
    // ⚠️ A 401 WITH A SESSION IN HAND DESERVES A SECOND CHANCE. Without it the client answers "not
    // authenticated" to somebody whose session is alive on the server, with only the access token past its
    // deadline. One attempt only: if the repeat also comes back 401 the session really is over, and insisting
    // would become two requests per call, for ever.
    if (res.status === 401 && !retried && opts.storage.get() && await renew()) {
      return req<T>(method, path, body, callOpts, true);
    }
    return finish<T>(res);
  };

  const requester = req as Requester;
  requester.poll = async <T>(path: string, callOpts?: RequestOptions) => {
    const res = await send(path, { method: "GET", headers: headers() }, callOpts?.signal);
    const data = await finish<T>(res);
    return { data, cursor: res.headers.get("X-Fab-Now") };
  };
  requester.url = (path: string) => root + path;
  return requester;
}

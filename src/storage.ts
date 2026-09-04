/**
 * Where the session token lives.
 *
 * The generated SPA keeps it in a cookie so the session survives a reload; Node and any server rendering have no
 * cookie jar at all and must not share one process-wide, so they get memory. Both sides implement the same two
 * methods, and `createClient` picks the default by looking at the environment rather than by being told.
 */
export interface TokenStorage {
  get(): string | undefined;
  set(token: string | undefined): void;
  /**
   * The REFRESH token, when this storage knows how to keep one.
   *
   * ⚠️ OPTIONAL ON PURPOSE, and not out of indecision: `TokenStorage` is public, and whoever already wrote their
   * own implementation keeps compiling. Without the two methods the client simply does not renew — which is the
   * previous behaviour, not a break.
   *
   * ⚠️ WHY IT EXISTS. The access token has a deadline; with no renewal there comes a moment when the client is
   * still sending a credential the server has stopped accepting, and the app shows "session expired" to somebody
   * whose session is alive. Measured in production on 04/09/2026: 552 refusals in one day, across 50 apps.
   */
  getRefresh?(): string | undefined;
  setRefresh?(token: string | undefined): void;
}

/** A per-client token held in a closure. The default off the browser — one client, one session. */
export function memoryStorage(initial?: string): TokenStorage {
  let token = initial;
  let refresh: string | undefined;
  return {
    get: () => token,
    set: (t) => { token = t || undefined; },
    getRefresh: () => refresh,
    setRefresh: (t) => { refresh = t || undefined; },
  };
}

const THIRTY_DAYS = 60 * 60 * 24 * 30;

/**
 * A cookie plus an in-memory shadow.
 *
 * The shadow is not redundancy: an app embedded in a CROSS-SITE iframe (the Studio preview) cannot write a
 * third-party cookie — Safari's ITP and Chrome's third-party cookie rules drop it silently — so the write appears to
 * succeed and the next read comes back empty. Inside a frame the memory is therefore the source of truth. At the top
 * level the cookie is, because a logout in one tab has to tear down the other, and a memory copy would survive it.
 */
export function cookieStorage(name: string): TokenStorage {
  const inFrame = () => typeof window !== "undefined" && window.parent !== window;
  let shadow: string | undefined;
  let shadowRefresh: string | undefined;
  return {
    get() {
      const stored = readCookie(name);
      if (stored) return stored;
      return inFrame() ? shadow : undefined;
    },
    set(token) {
      shadow = token || undefined;
      write(name, token);
    },
    // The refresh goes in a SEPARATE cookie: the access one travels on every request, the renewal one only on a
    // renewal. Together, the long-lived one would wander along on every call for nothing.
    getRefresh() {
      const stored = readCookie(`${name}_refresh`);
      if (stored) return stored;
      return inFrame() ? shadowRefresh : undefined;
    },
    setRefresh(token) {
      shadowRefresh = token || undefined;
      write(`${name}_refresh`, token);
    },
  };
}

function write(name: string, token: string | undefined): void {
  if (typeof document === "undefined") return;
  document.cookie = token
    ? `${name}=${encodeURIComponent(token)}; path=/; max-age=${THIRTY_DAYS}; samesite=lax`
    : `${name}=; path=/; max-age=0; samesite=lax`;
}

/**
 * The cookie jar, parsed properly. Exported because the failure it fixes is invisible: a token that cannot be read
 * does not raise — the person is simply logged out, onto a screen identical to a first visit.
 *
 * Two things the obvious one-liner gets wrong. `split("; ")` requires the space, and while a browser normally
 * writes one, nothing guarantees it — anything setting `document.cookie` by hand can produce `a=1;token=…`, and the
 * session vanishes. And `split("=")[1]` cuts the value at the first `=`, which a JWT never has, so it holds right
 * up until something else is stored there.
 */
export function readCookie(name: string, jar?: string): string | undefined {
  const source = jar ?? (typeof document !== "undefined" ? document.cookie : "");
  if (!source) return undefined;
  for (const pair of source.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    // A value written before this escaped nothing, and a JWT survives a decode untouched — so decoding is safe for
    // what is already out there. A malformed escape throws, and the raw value beats no value at all.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}

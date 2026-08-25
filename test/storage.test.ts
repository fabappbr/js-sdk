/**
 * The session cookie. Every case here is a way a signed-in person used to be shown the logged-out screen with
 * nothing raised and nothing logged — which is the same screen a first-time visitor sees, so it never looked
 * like a bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cookieStorage, memoryStorage, readCookie } from "../src/index.js";

const NAME = "fab_token_abc";

/** A minimal cookie jar: `document.cookie` reads the whole jar and writes one pair at a time. */
function fakeDocument(initial = "") {
  const jar = new Map<string, string>();
  for (const pair of initial.split(";").filter(Boolean)) {
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(pair: string) {
      const [assignment, ...attrs] = pair.split(";");
      const eq = assignment.indexOf("=");
      const key = assignment.slice(0, eq).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(key);
      else jar.set(key, assignment.slice(eq + 1).trim());
    },
  };
}

/** A browser that DROPS the cookie write — what a cross-site iframe actually does. */
function refusingDocument() {
  return { get cookie() { return ""; }, set cookie(_pair: string) { /* the browser dropped it */ } };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

describe("readCookie", () => {
  it("reads a pair separated by '; ' and one separated by a bare ';'", () => {
    expect(readCookie(NAME, `a=1; ${NAME}=TOKEN; b=2`)).toBe("TOKEN");
    expect(readCookie(NAME, `a=1;${NAME}=TOKEN;b=2`)).toBe("TOKEN");
  });

  it("keeps a value that contains '='", () => {
    expect(readCookie(NAME, `${NAME}=aa=bb=cc`)).toBe("aa=bb=cc");
  });

  it("does not match a cookie whose name merely overlaps", () => {
    expect(readCookie(NAME, `${NAME}_preview=WRONG; ${NAME}=RIGHT`)).toBe("RIGHT");
    expect(readCookie(NAME, `x${NAME}=WRONG`)).toBeUndefined();
  });

  it("survives a pair with no '=' and an empty jar", () => {
    expect(readCookie(NAME, `broken; ${NAME}=TOKEN`)).toBe("TOKEN");
    expect(readCookie(NAME, "")).toBeUndefined();
    expect(readCookie(NAME, "a=1")).toBeUndefined();
  });

  it("decodes an escaped value and leaves a malformed escape alone", () => {
    expect(readCookie(NAME, `${NAME}=a%20b`)).toBe("a b");
    expect(readCookie(NAME, `${NAME}=100%`)).toBe("100%");
  });
});

describe("cookieStorage", () => {
  it("round-trips a JWT unchanged", () => {
    (globalThis as { document?: unknown }).document = fakeDocument();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.7-_aBcD";
    const storage = cookieStorage(NAME);
    storage.set(jwt);
    expect(storage.get()).toBe(jwt);
  });

  it("round-trips a value that is not a JWT", () => {
    (globalThis as { document?: unknown }).document = fakeDocument();
    const storage = cookieStorage(NAME);
    storage.set("weird value=with; bits");
    expect(storage.get()).toBe("weird value=with; bits");
  });

  it("clears the cookie on an empty set", () => {
    (globalThis as { document?: unknown }).document = fakeDocument(`${NAME}=TOKEN`);
    const storage = cookieStorage(NAME);
    expect(storage.get()).toBe("TOKEN");
    storage.set(undefined);
    expect(storage.get()).toBeUndefined();
  });

  it("falls back to memory inside a frame, where a third-party cookie cannot be written", () => {
    // The Studio preview embeds the app cross-site, and the browser drops the cookie write SILENTLY — the
    // assignment appears to succeed and the next read comes back empty. `refusingDocument` is that browser; a
    // plain `{ cookie: "" }` is not, because assigning to it stores the string and the test then passes without
    // the shadow ever being consulted.
    (globalThis as { window?: unknown }).window = { parent: {} };      // window.parent !== window → framed
    (globalThis as { document?: unknown }).document = refusingDocument();
    const storage = cookieStorage(NAME);
    storage.set("FRAMED");
    expect(storage.get()).toBe("FRAMED");
  });

  it("does not use the memory shadow at the top level", () => {
    // A logout in one tab has to tear down the other, and a surviving memory copy would defeat that.
    const self = {} as { parent?: unknown };
    self.parent = self;                                                // window.parent === window → top level
    (globalThis as { window?: unknown }).window = self;
    (globalThis as { document?: unknown }).document = refusingDocument();
    const storage = cookieStorage(NAME);
    storage.set("SHOULD-NOT-SURVIVE");
    expect(storage.get()).toBeUndefined();
  });
});

describe("memoryStorage", () => {
  it("holds a token and clears it", () => {
    const storage = memoryStorage("initial");
    expect(storage.get()).toBe("initial");
    storage.set("next");
    expect(storage.get()).toBe("next");
    storage.set(undefined);
    expect(storage.get()).toBeUndefined();
  });
});

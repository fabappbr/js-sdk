import { describe, expect, it } from "vitest";

import { createClient } from "../src/index.js";
import { memoryStorage } from "../src/storage.js";
import { config, recorder } from "./helpers.js";

/**
 * Session renewal.
 *
 * ⚠️ WHAT THIS GUARDS IS A PRODUCTION OUTAGE. The access token had a deadline and there was no renewal: past it,
 * the client kept sending a credential the server already refused, and the app showed "session expired" to
 * somebody whose session was alive. Measured on 04/09/2026: 552 refusals in one day, across 50 distinct apps.
 */

describe("the session renews itself", () => {
  it("a 401 renews and repeats the call", async () => {
    const storage = memoryStorage("token-velho");
    storage.setRefresh?.("refresh-1");
    const { impl, calls } = recorder([
      { status: 401, body: { detail: "token inválido" } },          // the original call
      { status: 200, body: { access_token: "token-novo", refresh_token: "refresh-2" } },  // the renewal
      { status: 200, body: { id: "r1" } },                          // the repeat
    ]);
    const fab = createClient(config({ fetch: impl, storage }));

    await expect(fab.collection("post").get("r1")).resolves.toMatchObject({ id: "r1" });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.test/projects/proj-1/api/post/r1",
      "https://api.example.test/projects/proj-1/auth/refresh",
      "https://api.example.test/projects/proj-1/api/post/r1",
    ]);
    // the repeat already carries the new token
    expect(calls[2].headers.Authorization).toBe("Bearer token-novo");
    expect(storage.getRefresh?.()).toBe("refresh-2");
  });

  it("tries to renew ONCE per call", async () => {
    // Repeating without a limit would become two requests per call, for ever, against a server that said no.
    const storage = memoryStorage("token-velho");
    storage.setRefresh?.("refresh-1");
    const { impl, calls } = recorder([
      { status: 401, body: {} },
      { status: 200, body: { access_token: "token-novo" } },
      { status: 401, body: { detail: "não autenticado" } },
    ]);
    const fab = createClient(config({ fetch: impl, storage }));

    await expect(fab.collection("post").get("r1")).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(3);
  });

  it("simultaneous renewals become ONE", async () => {
    // ⚠️ A SCREEN FIRES SEVERAL CALLS AT ONCE. If each 401 asked for its own renewal, the first rotation would
    // invalidate the refresh the others are still using, and the server's reuse detection would take the whole
    // lineage down — trading one sign-out an hour for an immediate one.
    const storage = memoryStorage("token-velho");
    storage.setRefresh?.("refresh-1");
    const { impl, calls } = recorder([
      { status: 401, body: {} }, { status: 401, body: {} }, { status: 401, body: {} },
      { status: 200, body: { access_token: "token-novo", refresh_token: "refresh-2" } },
      { status: 200, body: { id: "a" } }, { status: 200, body: { id: "b" } }, { status: 200, body: { id: "c" } },
    ]);
    const fab = createClient(config({ fetch: impl, storage }));

    await Promise.all([
      fab.collection("post").get("a"),
      fab.collection("post").get("b"),
      fab.collection("post").get("c"),
    ]);

    const renewals = calls.filter((c) => c.url.endsWith("/auth/refresh"));
    expect(renewals).toHaveLength(1);
  });

  it("a refused renewal clears the session; a network failure does not", async () => {
    const storage = memoryStorage("token-velho");
    storage.setRefresh?.("refresh-1");
    const { impl } = recorder([{ status: 401, body: {} }, { status: 401, body: {} }]);
    const fab = createClient(config({ fetch: impl, storage }));

    await expect(fab.collection("post").get("r1")).rejects.toMatchObject({ status: 401 });
    expect(storage.get()).toBeUndefined();
    expect(storage.getRefresh?.()).toBeUndefined();

    // now with the network failing: the refresh must NOT be discarded because of a lift
    const storage2 = memoryStorage("token-velho");
    storage2.setRefresh?.("refresh-1");
    let call = 0;
    const failing = (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({}), { status: 401 });
      throw new TypeError("network down");
    }) as typeof fetch;
    const fab2 = createClient(config({ fetch: failing, storage: storage2 }));

    await expect(fab2.collection("post").get("r1")).rejects.toBeTruthy();
    expect(storage2.getRefresh?.()).toBe("refresh-1");
  });

  it("with no refresh in the storage, nothing changes from before", async () => {
    // `getRefresh` is optional on the public `TokenStorage`: whoever wrote their own implementation keeps
    // compiling, and the client simply does not renew.
    const withoutRefresh = { get: () => "token-velho", set: () => { /* noop */ } };
    const { impl, calls } = recorder([{ status: 401, body: { detail: "token inválido" } }]);
    const fab = createClient(config({ fetch: impl, storage: withoutRefresh }));

    await expect(fab.collection("post").get("r1")).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });
});

describe("signing out ends the session on the server", () => {
  it("tells the server and clears the client before waiting on the network", async () => {
    const storage = memoryStorage("token-velho");
    storage.setRefresh?.("refresh-1");
    const { impl, calls } = recorder([{ status: 200, body: { ok: true } }]);
    const fab = createClient(config({ fetch: impl, storage }));

    fab.auth.logout();

    // the local state drops at once, without waiting for an answer
    expect(storage.get()).toBeUndefined();
    expect(storage.getRefresh?.()).toBeUndefined();

    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0].url).toBe("https://api.example.test/projects/proj-1/auth/logout");
    expect(calls[0].body).toEqual({ refresh_token: "refresh-1" });
  });

  it("everywhere drops all the devices", async () => {
    const storage = memoryStorage("token-velho");
    const { impl, calls } = recorder([{ status: 200, body: { ok: true } }]);
    const fab = createClient(config({ fetch: impl, storage }));

    fab.auth.logout(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls[0].body).toEqual({ everywhere: true });
  });

  it("with no token, it does not bother the server", async () => {
    const { impl, calls } = recorder([]);
    const fab = createClient(config({ fetch: impl, storage: memoryStorage() }));

    fab.auth.logout();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(0);
  });
});

describe("sign-in by a code sent to the email", () => {
  it("asks for the code with the address and nothing else", async () => {
    const { impl, calls } = recorder([{ body: { ok: true } }]);
    const fab = createClient(config({ fetch: impl, storage: memoryStorage() }));

    await expect(fab.auth.sendEmailCode("ana@x.com")).resolves.toMatchObject({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.test/projects/proj-1/auth/email/send-code",
      body: { email: "ana@x.com" },
    });
  });

  it("exchanges the code for a session and loads the person", async () => {
    const storage = memoryStorage();
    const { impl, calls } = recorder([
      { body: { access_token: "tok-1", refresh_token: "ref-1" } },   // the verify
      { body: { id: "u1", email: "ana@x.com" } },                    // /auth/me
    ]);
    const fab = createClient(config({ fetch: impl, storage }));

    await expect(fab.auth.loginWithEmailCode("ana@x.com", "123456")).resolves.toMatchObject({ id: "u1" });

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.test/projects/proj-1/auth/email/verify",
      body: { email: "ana@x.com", code: "123456" },
    });
    expect(storage.get()).toBe("tok-1");
    expect(storage.getRefresh?.()).toBe("ref-1");
  });
});

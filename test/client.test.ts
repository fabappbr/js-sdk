import { describe, expect, it } from "vitest";
import { ApiError, buildListQuery, createClient, memoryStorage } from "../src/index.js";
import { config, recorder } from "./helpers.js";

describe("createClient", () => {
  it("refuses to build without a project", () => {
    expect(() => createClient({ projectId: "" })).toThrow(/projectId/);
  });

  it("scopes every request to the project and trims a trailing slash off the base", async () => {
    const { impl, calls } = recorder([{ body: [] }]);
    const fab = createClient(config({ baseUrl: "https://api.example.test/", fetch: impl }));
    await fab.collection("task").list();
    expect(calls[0].url).toBe("https://api.example.test/projects/proj-1/api/task");
  });

  it("sends the bearer token only once there is one", async () => {
    const { impl, calls } = recorder([{ body: [] }, { body: [] }]);
    const fab = createClient(config({ fetch: impl }));
    await fab.collection("task").list();
    expect(calls[0].headers.Authorization).toBeUndefined();

    fab.auth.setToken("tok-abc");
    await fab.collection("task").list();
    expect(calls[1].headers.Authorization).toBe("Bearer tok-abc");
  });

  it("keeps two clients on separate sessions", async () => {
    // The reason this package is a factory and not a module singleton. The old client held the token in a module
    // variable, so a second project — or a second user in one Node process — silently reused the first one's session.
    const a = createClient(config({ fetch: recorder().impl, storage: memoryStorage() }));
    const b = createClient(config({ projectId: "proj-2", fetch: recorder().impl, storage: memoryStorage() }));
    a.auth.setToken("token-a");
    expect(b.auth.getToken()).toBeUndefined();
    expect(a.auth.getToken()).toBe("token-a");
  });

  it("turns a non-2xx into an ApiError carrying the server's detail", async () => {
    const detail = { status: 403, body: { detail: "you may not read this record" } };
    const { impl } = recorder([detail, detail]);
    const fab = createClient(config({ fetch: impl }));
    await expect(fab.collection("task").list()).rejects.toMatchObject({
      name: "ApiError", status: 403, message: "you may not read this record",
    });
    await expect(fab.collection("task").list()).rejects.toBeInstanceOf(ApiError);
  });

  it("reads a 204 as undefined instead of choking on an empty body", async () => {
    const { impl } = recorder([{ status: 204 }]);
    const fab = createClient(config({ fetch: impl }));
    await expect(fab.collection("task").remove("t1")).resolves.toBeUndefined();
  });

  it("fetches the public config once, however many callers ask", async () => {
    const { impl, calls } = recorder([{ body: { phoneLogin: true } }]);
    const fab = createClient(config({ fetch: impl }));
    const [first, second] = await Promise.all([fab.publicConfig(), fab.publicConfig()]);
    expect(first).toEqual(second);
    expect(calls).toHaveLength(1);
  });
});

describe("buildListQuery", () => {
  it("reads a primitive as equality, an array as any-of, and an object as operators", () => {
    expect(buildListQuery({ filter: { status: "open" } })).toBe("?filter.status=open");
    expect(buildListQuery({ filter: { status: ["open", "done"] } })).toBe("?filter.status.in=open%2Cdone");
    expect(buildListQuery({ filter: { price: { gte: 50, lt: 100 } } }))
      .toBe("?filter.price.gte=50&filter.price.lt=100");
  });

  it("carries sort, pagination and the projection", () => {
    expect(buildListQuery({ sort: "-created_at", limit: 20, offset: 40, fields: ["id", "title"] }))
      .toBe("?sort=-created_at&limit=20&offset=40&fields=id%2Ctitle");
  });

  it("drops an operator whose value is null rather than sending the word null", () => {
    expect(buildListQuery({ filter: { price: { gte: undefined, lt: 10 } } })).toBe("?filter.price.lt=10");
  });

  it("returns nothing at all when there is nothing to ask for", () => {
    expect(buildListQuery()).toBe("");
    expect(buildListQuery({})).toBe("");
  });
});

describe("collection", () => {
  it("polls from the epoch first and from the given cursor afterwards", async () => {
    const { impl, calls } = recorder([
      { body: [], headers: { "X-Fab-Now": "2026-08-25T00:00:00Z" } },
      { body: [] },
    ]);
    const fab = createClient(config({ fetch: impl }));

    const first = await fab.collection("task").poll();
    expect(calls[0].url).toContain("updated_since=1970-01-01T00%3A00%3A00Z");
    expect(first.cursor).toBe("2026-08-25T00:00:00Z");

    await fab.collection("task").poll({ since: first.cursor, sort: "-created_at" });
    expect(calls[1].url).toContain("?sort=-created_at&updated_since=2026-08-25T00%3A00%3A00Z");
  });

  it("counts without transferring rows", async () => {
    const { impl, calls } = recorder([{ body: { count: 7 } }]);
    const fab = createClient(config({ fetch: impl }));
    expect(await fab.collection("task").count({ done: false })).toBe(7);
    expect(calls[0].url).toBe("https://api.example.test/projects/proj-1/api/task/_count?filter.done=false");
  });

  it("escapes an id that would otherwise change the path", async () => {
    const { impl, calls } = recorder([{ body: {} }]);
    const fab = createClient(config({ fetch: impl }));
    await fab.collection("task").get("a/../b");
    expect(calls[0].url).toBe("https://api.example.test/projects/proj-1/api/task/a%2F..%2Fb");
  });
});

describe("auth", () => {
  it("stores the token, loads the user and tells its subscribers", async () => {
    const { impl, calls } = recorder([
      { body: { access_token: "tok-1" } },
      { body: { id: "u1", email: "a@b.test" } },
    ]);
    const fab = createClient(config({ fetch: impl }));
    const seen: Array<string | null> = [];
    fab.auth.subscribe((u) => seen.push(u?.id ?? null));

    const user = await fab.auth.login("a@b.test", "pw");

    expect(user.id).toBe("u1");
    expect(fab.auth.user?.id).toBe("u1");
    expect(seen).toEqual(["u1"]);
    expect(calls[0].body).toEqual({ email: "a@b.test", password: "pw" });
    expect(calls[1].headers.Authorization).toBe("Bearer tok-1");
  });

  it("maps the camelCase signup input onto the API's field names", async () => {
    const { impl, calls } = recorder([{ body: { access_token: "t" } }, { body: { id: "u1" } }]);
    const fab = createClient(config({ fetch: impl }));
    await fab.auth.signup({ email: "a@b.test", password: "pw", passwordConfirmation: "pw", profile: { id: "x" } });
    expect(calls[0].body).toMatchObject({ password_confirmation: "pw", profile: { id: "x" } });
  });

  it("drops the token and the user on logout", async () => {
    const { impl } = recorder([{ body: { access_token: "t" } }, { body: { id: "u1" } }]);
    const fab = createClient(config({ fetch: impl }));
    await fab.auth.login("a@b.test", "pw");

    const seen: Array<string | null> = [];
    fab.auth.subscribe((u) => seen.push(u?.id ?? null));
    fab.auth.logout();

    expect(fab.auth.hasToken()).toBe(false);
    expect(fab.auth.user).toBeNull();
    expect(seen).toEqual([null]);
  });

  it("stops calling a listener that unsubscribed", async () => {
    const { impl } = recorder([{ body: { access_token: "t" } }, { body: { id: "u1" } }]);
    const fab = createClient(config({ fetch: impl }));
    let calls = 0;
    fab.auth.subscribe(() => { calls++; })();
    await fab.auth.login("a@b.test", "pw");
    expect(calls).toBe(0);
  });

  it("splits a profile patch into the name and everything else", async () => {
    const { impl, calls } = recorder([{ body: { id: "u1" } }]);
    const fab = createClient(config({ fetch: impl }));
    await fab.auth.updateProfile({ name: "Ana", avatar: "https://img.test/a.png" });
    expect(calls[0].body).toEqual({ name: "Ana", profile: { avatar: "https://img.test/a.png" } });
  });

  it("builds an OAuth start URL with the return address escaped", () => {
    const fab = createClient(config({ fetch: recorder().impl }));
    expect(fab.auth.oauthStartUrl("google", "https://app.test/back?x=1")).toBe(
      "https://api.example.test/projects/proj-1/auth/oauth/google/start"
      + "?redirect=https%3A%2F%2Fapp.test%2Fback%3Fx%3D1");
  });

  it("answers null from completeOAuth when there is no session to establish", async () => {
    const fab = createClient(config({ fetch: recorder().impl }));
    await expect(fab.auth.completeOAuth()).resolves.toBeNull();
  });
});

describe("uploadFile", () => {
  it("refuses anything that is not a File or Blob", async () => {
    const fab = createClient(config({ fetch: recorder().impl }));
    await expect(fab.uploadFile("https://img.test/already-uploaded.png" as unknown as Blob))
      .rejects.toMatchObject({ status: 0 });
  });

  it("presigns, PUTs the bytes straight to storage, then reports completion", async () => {
    const { impl, calls } = recorder([
      { body: { file_id: "f1", upload_url: "https://storage.test/put/f1", url: "https://cdn.test/f1.png" } },
      { body: {} },
      { body: {} },
    ]);
    const fab = createClient(config({ fetch: impl }));
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

    const result = await fab.uploadFile(file);

    expect(result).toEqual({ id: "f1", url: "https://cdn.test/f1.png", visibility: "public" });
    expect(calls[0].body).toMatchObject({ filename: "a.png", content_type: "image/png", visibility: "public" });
    expect(calls[1]).toMatchObject({ url: "https://storage.test/put/f1", method: "PUT" });
    expect(calls[1].headers["Content-Type"]).toBe("image/png");
    expect(calls[2].url).toContain("/api/_upload/f1/complete");
  });

  it("still returns the file when the completion call fails, because the bytes are already stored", async () => {
    const { impl } = recorder([
      { body: { file_id: "f1", upload_url: "https://storage.test/put/f1", url: "https://cdn.test/f1.png" } },
      { body: {} },
      { status: 500, body: { detail: "boom" } },
    ]);
    const fab = createClient(config({ fetch: impl }));
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    await expect(fab.uploadFile(file)).resolves.toMatchObject({ id: "f1" });
  });
});

describe("formatting", () => {
  it("uses the app's locale, not the runtime's", () => {
    const fab = createClient(config({ fetch: recorder().impl, currency: "BRL", locale: "pt-BR" }));
    // A non-breaking space separates the symbol in pt-BR; comparing on the digits keeps this stable across ICU builds.
    expect(fab.formatMoney(4500)).toContain("4.500,00");
    expect(fab.formatDate("2026-03-02")).toBe("02/03/2026");
  });

  it("reads a date-only string as local midnight, so it never shows the day before", () => {
    const fab = createClient(config({ fetch: recorder().impl, locale: "en-US" }));
    expect(fab.formatDate("2026-03-02")).toBe("3/2/26");
  });

  it("falls back to a readable string when the currency code is not one", () => {
    const fab = createClient(config({ fetch: recorder().impl, currency: "NOTACURRENCY" }));
    expect(fab.formatMoney(10)).toBe("NOTACURRENCY 10.00");
  });

  it("returns an empty string for a date it cannot parse", () => {
    const fab = createClient(config({ fetch: recorder().impl }));
    expect(fab.formatDate("not a date")).toBe("");
  });
});

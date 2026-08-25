/**
 * The transport, against a server that misbehaves.
 *
 * The rest of the suite uses a fake `fetch` that always answers valid JSON, always answers quickly, and always
 * answers at all — which is why four real defects shipped through 28 green tests. Everything here uses a REAL
 * server, and every case is one a proxy, a gateway or a dropped connection actually produces.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbortError, ApiError, createClient, memoryStorage } from "../src/index.js";

type Reply = (url: string) => { status: number; body?: string; type?: string; hang?: boolean };

let server: Server;
let baseUrl: string;
let reply: Reply = () => ({ status: 200, body: "[]" });

beforeAll(async () => {
  server = createServer((request, response) => {
    const answer = reply(request.url ?? "");
    if (answer.hang) return;                       // a connection that is accepted and never answered
    response.writeHead(answer.status, { "content-type": answer.type ?? "application/json" });
    response.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => { server.closeAllConnections?.(); server.close(); });

const client = (over: { timeout?: number; signal?: AbortSignal } = {}) =>
  createClient({ projectId: "p", baseUrl, storage: memoryStorage(), ...over });

describe("a body that is not JSON", () => {
  it("reads a gateway's HTML 502 as an ApiError carrying the status", async () => {
    // The defect this replaces: `JSON.parse` ran before the status was consulted, so a 502 arrived as a
    // SyntaxError with no `status` — and every documented `e instanceof ApiError && e.status === …` stopped
    // matching at exactly the moment the platform was in trouble.
    reply = () => ({ status: 502, type: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" });
    const error = await client().collection("t").list().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toContain("502 Bad Gateway");
    expect(error.message).not.toContain("<");     // the tags are stripped, the sentence survives
  });

  it("falls back to the status text when the error body is empty", async () => {
    reply = () => ({ status: 500, body: "" });
    await expect(client().collection("t").list()).rejects.toMatchObject({ status: 500 });
  });

  it("refuses a 2xx that is not JSON instead of returning garbage", async () => {
    reply = () => ({ status: 200, type: "text/html", body: "<html>captive portal</html>" });
    const error = await client().collection("t").list().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("non-JSON");
  });
});

describe("the error message", () => {
  it("unpacks a validation detail that arrives as a list", async () => {
    // FastAPI's own request validation answers `detail: [{loc, msg, type}]`, which stringified to the literal
    // text `[object Object]` — while the documentation tells the caller to read the message.
    reply = () => ({ status: 422, body: JSON.stringify({ detail: [
      { loc: ["body", "title"], msg: "field required", type: "missing" },
      { loc: ["body", "price"], msg: "must be a number", type: "type" },
    ] }) });
    const error = await client().collection("t").create({}).catch((e) => e);
    expect(error.status).toBe(422);
    expect(error.message).toBe("title: field required; price: must be a number");
  });

  it("keeps a plain string detail exactly as the server wrote it", async () => {
    reply = () => ({ status: 403, body: JSON.stringify({ detail: "sem permissão de leitura" }) });
    await expect(client().collection("t").list()).rejects.toMatchObject({ message: "sem permissão de leitura" });
  });

  it("serialises an object detail rather than printing [object Object]", async () => {
    reply = () => ({ status: 400, body: JSON.stringify({ detail: { message: "bad", field: "x" } }) });
    const error = await client().collection("t").list().catch((e) => e);
    expect(error.message).not.toContain("[object Object]");
    expect(error.message).toContain("bad");
  });
});

describe("a request that does not complete", () => {
  it("gives up after the client's timeout, and says so", async () => {
    reply = () => ({ status: 200, hang: true });
    const error = await client({ timeout: 250 }).collection("t").list().catch((e) => e);
    expect(error).toBeInstanceOf(AbortError);
    expect(error.message).toContain("250ms");
  });

  it("obeys a signal, so a screen can take its requests with it when it unmounts", async () => {
    reply = () => ({ status: 200, hang: true });
    const controller = new AbortController();
    const pending = client({ signal: controller.signal }).collection("t").list().catch((e) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(AbortError);
  });

  it("waits as long as the server takes when no timeout is set", async () => {
    reply = () => ({ status: 200, body: "[]" });
    await expect(client().collection("t").list()).resolves.toEqual([]);
  });

  it("reports a connection that never reached the API as an ApiError, not a raw TypeError", async () => {
    const unreachable = createClient({ projectId: "p", baseUrl: "http://127.0.0.1:1", storage: memoryStorage() });
    const error = await unreachable.collection("t").list().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("never reached the API");
  });
});

describe("the public config", () => {
  it("retries after a failure instead of staying empty for the client's lifetime", async () => {
    // The defect this replaces: the failed promise was cached, so one dropped connection at boot left push unable
    // to enable and phone sign-in invisible, permanently and silently.
    reply = () => ({ status: 503, body: "" });
    const fab = client();
    await expect(fab.publicConfig()).rejects.toBeInstanceOf(ApiError);

    reply = () => ({ status: 200, body: JSON.stringify({ phoneLogin: true }) });
    await expect(fab.publicConfig()).resolves.toEqual({ phoneLogin: true });
  });

  it("still asks only once when it succeeds", async () => {
    let calls = 0;
    reply = () => { calls++; return { status: 200, body: JSON.stringify({ phoneLogin: false }) }; };
    const fab = client();
    await Promise.all([fab.publicConfig(), fab.publicConfig(), fab.publicConfig()]);
    expect(calls).toBe(1);
  });
});

describe("a subscriber that throws", () => {
  it("does not stop the other subscribers, and does not make logout throw", async () => {
    const fab = client();
    const seen: string[] = [];
    fab.auth.subscribe(() => { throw new Error("a screen crashed in its own listener"); });
    fab.auth.subscribe(() => seen.push("second"));
    fab.auth.subscribe(() => seen.push("third"));

    expect(() => fab.auth.logout()).not.toThrow();
    expect(seen).toEqual(["second", "third"]);
  });
});

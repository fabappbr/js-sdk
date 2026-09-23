/**
 * `@fabappai/sdk` — the Fabapp API from any JavaScript runtime.
 *
 * It is deliberately framework-agnostic: no React, no bundler assumption, no build-time environment variable. A
 * client is CONSTRUCTED with the project it talks to, which is what lets the same package serve a generated Fabapp
 * app, a Next.js route handler, a CLI and a test.
 *
 *   const fab = createClient({ projectId: "..." });
 *   await fab.auth.login(email, password);
 *   const tasks = await fab.collection("task").list({ filter: { done: false }, sort: "-created_at" });
 */
import { createAuth, type Auth } from "./auth.js";
import { createCollection, type Collection } from "./collection.js";
import { createFormat } from "./format.js";
import { createRequester, type Requester } from "./http.js";
import { createPush, type Push, type PublicConfig } from "./push.js";
import {
  callConnector, callIntegration, createAI, createAdmin, createAgent, createGoogle, createOrgs,
  createPaymentMethods, notify, uploadFile,
  type Admin, type AI, type Google, type NotifyChannel, type Orgs, type PaymentMethods, type UploadedFile,
} from "./resources.js";
import { cookieStorage, memoryStorage, type TokenStorage } from "./storage.js";
import type { Row } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.fabapp.ai";

export type ClientConfig = {
  /** The Fabapp project this client talks to. Required — it scopes every request and the session cookie. */
  projectId: string;
  /** The API root. Point it at a local control-plane during development. */
  baseUrl?: string;
  /** A token to start with — a server-side handoff, a service token, a fixture. */
  token?: string;
  /** Override where the session lives. Defaults to a cookie in the browser and to memory everywhere else. */
  storage?: TokenStorage;
  /** Override `fetch` — for a proxy, for retries, or for a test that never touches the network. */
  fetch?: typeof fetch;
  /**
   * Milliseconds before a request is abandoned. Off by default, because nothing here is uniformly fast: a
   * `tier: "smart"` model call legitimately runs for a minute, and a timeout short enough to protect a list read
   * would cut it off. Set it per client — one for reads, another for the AI — rather than globally low.
   */
  timeout?: number;
  /**
   * A signal every request of this client obeys. One client per screen, aborted on unmount, and the in-flight
   * requests go with it — which is also how you stop a response arriving after the component is gone.
   */
  signal?: AbortSignal;
  /** ISO 4217, for `formatMoney`. The app's currency, not the visitor's. */
  currency?: string;
  /** BCP-47, for the date and money formatters. Empty means "follow the browser". */
  locale?: string;
};

export type FabClient = {
  readonly projectId: string;
  readonly baseUrl: string;

  /** CRUD, filtering, bulk operations and delta polling over one model of the project schema. */
  collection<T extends Row = Row>(model: string): Collection<T>;
  auth: Auth;
  ai: AI;
  admin: Admin;
  orgs: Orgs;
  google: Google;
  push: Push;
  /** Saved cards. The card itself is tokenized by the gateway in the browser and never reaches this package. */
  paymentMethods: PaymentMethods;

  uploadFile(file: File | Blob, opts?: { visibility?: "public" | "private"; filename?: string }):
    Promise<UploadedFile>;
  /** Calls one of the app's backend functions. It runs isolated on the server and may use secrets the client cannot. */
  callFunction<T = unknown>(name: string, payload?: unknown): Promise<T>;
  /** An app-side AI agent, acting under the CALLER's permissions. */
  agent(name: string): { run(input: string): Promise<{ answer: string; credits: number; steps: number }> };
  notify(channel: NotifyChannel, opts: { message: string; to?: string; subject?: string; link?: string }):
    Promise<{ ok: boolean; channel: string; credits: number | null }>;
  integrations: {
    call<T = unknown>(provider: string, action: string, params: Record<string, unknown>):
      Promise<{ ok: boolean; provider: string; action: string; credits: number | null; result: T }>;
  };
  callConnector<T = unknown>(connectorId: string, operationId: string, opts?: {
    path_params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown;
  }): Promise<{ status: number; data: T }>;

  /** The project's public configuration. Cached per client; nothing secret is in it. */
  publicConfig(): Promise<PublicConfig>;

  formatMoney(value: number, currency?: string): string;
  formatDate(value: Date | string | number, opts?: Intl.DateTimeFormatOptions): string;
  formatDateTime(value: Date | string | number, opts?: Intl.DateTimeFormatOptions): string;

  /** An escape hatch for an endpoint this package does not wrap yet. Same auth, same project scope. */
  request: Requester;
};

export function createClient(config: ClientConfig): FabClient {
  if (!config.projectId) throw new Error("createClient requires a projectId");
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const projectId = config.projectId;

  const storage = config.storage
    ?? (typeof document !== "undefined" ? cookieStorage(`fab_token_${projectId}`) : memoryStorage());
  if (config.token) storage.set(config.token);

  const fetchImpl = config.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error("createClient found no fetch — pass one (Node 18+ has it built in)");

  const req = createRequester({ baseUrl, projectId, storage, fetchImpl,
                                timeout: config.timeout, signal: config.signal });
  const format = createFormat({ currency: config.currency, locale: config.locale });

  // One in-flight promise, reused: the public config is fetched by push, by billing and by the auth screens, and
  // three boots of the same app should not be three requests.
  //
  // It caches the SUCCESS and never the failure. Swallowing the error into `{}` and keeping it looked harmless and
  // was not: one dropped connection at boot left the client permanently configless for its whole lifetime — push
  // could never enable (no VAPID key) and phone sign-in never appeared, with nothing logged and no way back.
  let configPromise: Promise<PublicConfig> | null = null;
  const publicConfig = (): Promise<PublicConfig> => {
    if (!configPromise) {
      configPromise = req<PublicConfig>("GET", "/api/_config").catch((e) => {
        configPromise = null;    // let the next caller try again
        throw e;
      });
    }
    return configPromise;
  };

  return {
    projectId,
    baseUrl,
    collection: <T extends Row = Row>(model: string) => createCollection<T>(req, model),
    auth: createAuth(req, storage),
    ai: createAI(req),
    admin: createAdmin(req),
    orgs: createOrgs(req),
    google: createGoogle(req),
    push: createPush(req, publicConfig),
    paymentMethods: createPaymentMethods(req),
    uploadFile: (file, opts) => uploadFile(req, fetchImpl, file, opts),
    callFunction: <T = unknown>(name: string, payload?: unknown) =>
      req<T>("POST", `/fn/${encodeURIComponent(name)}`, payload ?? {}),
    agent: (name: string) => createAgent(req, name),
    notify: (channel, opts) => notify(req, channel, opts),
    integrations: {
      call: (provider, action, params) => callIntegration(req, provider, action, params),
    },
    callConnector: (connectorId, operationId, opts) => callConnector(req, connectorId, operationId, opts),
    publicConfig,
    ...format,
    request: req,
  };
}

export { AbortError, ApiError } from "./http.js";
export { cookieStorage, memoryStorage, readCookie } from "./storage.js";
export { buildListQuery } from "./collection.js";
export type { Auth, AuthListener, SignupInput } from "./auth.js";
export type { Collection } from "./collection.js";
export type { Requester, RequestOptions } from "./http.js";
export type { Push, PublicConfig } from "./push.js";
export type { Admin, AI, BulkCreateResult, Google, NewUser, NotifyChannel, Orgs, PaymentMethods, UploadedFile } from "./resources.js";
export type { TokenStorage } from "./storage.js";
export type {
  AppUser, FilterOps, FilterPrimitive, FilterValue, InvokeResult, ListOptions, Notification, OrgRef, PayMethod, Row,
} from "./types.js";

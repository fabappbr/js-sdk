/**
 * The remaining capabilities, each a thin, honest wrapper over one endpoint.
 *
 * They share a rule worth stating once: the credential never reaches this code. AI keys, connector secrets, SMS and
 * e-mail providers and the payment gateway all live on the platform, and every call here names an operation rather
 * than carrying the means to perform it.
 */
import { ApiError, type Requester } from "./http.js";
import type { AppUser, InvokeResult, OrgRef, PayMethod } from "./types.js";

// ---- files ----------------------------------------------------------------------------------------------------

export type UploadedFile = { id: string; url: string; visibility: "public" | "private" };

/**
 * Uploads through a presigned PUT: the bytes go straight from the caller to storage, never through the API.
 *
 * `public` returns a stable URL — use it for anything the app displays. `private` returns an opaque id, and the API
 * swaps it for a signed, expiring URL on read, only for whoever is allowed to read the record holding it.
 */
export async function uploadFile(
  req: Requester,
  fetchImpl: typeof fetch,
  file: File | Blob,
  opts?: { visibility?: "public" | "private"; filename?: string },
): Promise<UploadedFile> {
  if (!(file instanceof Blob)) {
    throw new ApiError(0, "uploadFile requires a File or Blob (for example e.target.files[0]).");
  }
  const contentType = file.type || "application/octet-stream";
  const visibility = opts?.visibility === "private" ? "private" : "public";
  const filename = opts?.filename ?? (file as File).name ?? "upload";
  const { file_id, upload_url, url } = await req<{ file_id: string; upload_url: string; url: string }>(
    "POST", "/api/_upload", { filename, content_type: contentType, size_bytes: file.size, visibility });

  // Only the Content-Type is signed. Adding a Content-Disposition here would force every caller to repeat it byte for
  // byte or get a 403 that surfaces as a CORS error; the forced download for non-inline types is applied on read.
  const put = await fetchImpl(upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
  if (!put.ok) throw new ApiError(put.status, "the file could not be uploaded");

  // Nothing else tells the server the PUT finished, and for a video this is what triggers the adaptive-quality
  // derivation. Best effort on purpose: the file is already stored, so a failure here must not fail the upload.
  try { await req("POST", `/api/_upload/${file_id}/complete`, {}); } catch { /* stored; the derivation is optional */ }
  return { id: file_id, url, visibility };
}

// ---- runtime AI -----------------------------------------------------------------------------------------------

export type AI = {
  /** With a `schema` the answer comes back structured in `data`; without one, as `text`. */
  invokeLLM(input: {
    prompt: string;
    system?: string;
    schema?: Record<string, unknown>;
    tier?: "fast" | "smart";
    maxOutput?: number;
  }): Promise<InvokeResult>;
  generateImage(prompt: string): Promise<{ url: string; credits: number | null }>;
  /** Reads an uploaded file — a document or an image — and returns text, or structured data when given a schema. */
  extractData(input: { fileId: string; schema?: Record<string, unknown>; prompt?: string }): Promise<InvokeResult>;
};

export function createAI(req: Requester): AI {
  return {
    invokeLLM: (input) => req<InvokeResult>("POST", "/api/_ai/invoke", {
      prompt: input.prompt,
      system: input.system,
      schema: input.schema,
      tier: input.tier ?? "fast",
      max_output: input.maxOutput,
    }),
    generateImage: (prompt) => req<{ url: string; credits: number | null }>("POST", "/api/_ai/image", { prompt }),
    extractData: (input) => req<InvokeResult>("POST", "/api/_ai/extract", {
      file_id: input.fileId, schema: input.schema, prompt: input.prompt,
    }),
  };
}

/** An agent reasons and acts on the app's data under the CALLER's permissions — never elevated ones. */
export function createAgent(req: Requester, name: string) {
  return {
    run: (input: string) => req<{ answer: string; credits: number; steps: number }>(
      "POST", `/api/_agents/${encodeURIComponent(name)}/run`, { input }),
  };
}

// ---- messaging and third parties ------------------------------------------------------------------------------

export type NotifyChannel = "sms" | "slack" | "discord" | "discord_dm" | "email";

/**
 * `email` needs nothing configured — it leaves through the platform's sender. In exchange the platform writes the
 * message: pass plain text with no HTML and no URL inside it, and put the destination in `link`.
 */
export function notify(
  req: Requester,
  channel: NotifyChannel,
  opts: { message: string; to?: string; subject?: string; link?: string },
): Promise<{ ok: boolean; channel: string; credits: number | null }> {
  return req("POST", "/api/_notify/send", { channel, ...opts });
}

export function callIntegration<T = unknown>(
  req: Requester, provider: string, action: string, params: Record<string, unknown>,
): Promise<{ ok: boolean; provider: string; action: string; credits: number | null; result: T }> {
  return req("POST", `/api/_integrations/${encodeURIComponent(provider)}/call`, { action, params });
}

export function callConnector<T = unknown>(
  req: Requester,
  connectorId: string,
  operationId: string,
  opts?: { path_params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown },
): Promise<{ status: number; data: T }> {
  return req("POST", `/api/_connectors/${encodeURIComponent(connectorId)}/call`, {
    operationId, path_params: opts?.path_params, query: opts?.query, body: opts?.body,
  });
}

export type Google = {
  /** Any *.googleapis.com endpoint. The platform injects the connected account's token server-side. */
  call<T = unknown>(url: string, opts?: { method?: string; query?: Record<string, unknown>; body?: unknown }):
    Promise<{ status: number; data: T }>;
  sheetsAppend(spreadsheetId: string, range: string, values: unknown[][]): Promise<{ status: number; data: unknown }>;
  calendarInsert(calendarId: string, event: Record<string, unknown>): Promise<{ status: number; data: unknown }>;
};

export function createGoogle(req: Requester): Google {
  const call: Google["call"] = (url, opts) => req("POST", "/api/_google/call", {
    url, method: opts?.method ?? "GET", query: opts?.query, body: opts?.body,
  });
  return {
    call,
    sheetsAppend: (spreadsheetId, range, values) => call(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
      + `/values/${encodeURIComponent(range)}:append`,
      { method: "POST", query: { valueInputOption: "USER_ENTERED" }, body: { values } }),
    calendarInsert: (calendarId, event) => call(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: "POST", body: event }),
  };
}

// ---- administration -------------------------------------------------------------------------------------------

/** Only works for a signed-in user holding the `admin` role. This is what an app's own admin screen calls. */
export type NewUser = { email: string; name?: string; role?: string; profile?: Record<string, unknown> };
export type BulkCreateResult = {
  created: number; skipped: number; errors: number;
  results: { email: string | null; status: "created" | "skipped" | "error"; id?: string; detail?: string }[];
};

export type Admin = {
  listUsers(): Promise<AppUser[]>;
  updateUser(id: string, patch: { roles?: string[]; plan?: string }): Promise<AppUser>;
  /**
   * Creates an account at once: active, the email taken as verified, no password anybody knows (the person signs in
   * by an emailed code, or sets one through "forgot password"). Sends no email. Rejects with 409 when the address
   * already has an account. For a list the owner already holds, whose records must point at an account before the
   * person's first sign-in.
   */
  createUser(input: NewUser): Promise<AppUser>;
  /**
   * Up to 200 accounts in one call — an imported list. Row by row: an address that already exists is `skipped`, a
   * refused row is an `error` with its reason, the rest is created — so the same file can be imported twice safely.
   */
  createUsers(users: NewUser[]): Promise<BulkCreateResult>;
  /** A complimentary subscription: it unlocks the paid plan with no charge and never touches the gateway. */
  grantSubscription(userId: string, opts?: { planId?: string; expiresAt?: string }):
    Promise<{ mode: string; user_id: string; plan: string; expires_at: string | null }>;
  /** A checkout link bound to one user, for them to subscribe themselves. */
  subscriptionLink(userId: string, opts: {
    planId?: string; priceId?: string; coupon?: string;
    successUrl: string; cancelUrl: string; paymentMethods?: string[];
  }): Promise<{ mode: string; user_id: string; redirect_url: string }>;
  createCoupon(opts: {
    name?: string; percentOff?: number; amountOff?: number; duration?: "once" | "repeating" | "forever";
  }): Promise<{ id: string; provider: string }>;
};

export function createAdmin(req: Requester): Admin {
  return {
    listUsers: () => req<AppUser[]>("GET", "/admin/users"),
    updateUser: (id, patch) => req<AppUser>("PATCH", `/admin/users/${encodeURIComponent(id)}`, patch),
    createUser: (input) => req<AppUser>("POST", "/admin/users", input),
    createUsers: (users) => req<BulkCreateResult>("POST", "/admin/users/bulk", { users }),
    grantSubscription: (userId, opts) => req("POST", "/admin/subscriptions", {
      user_id: userId, mode: "comp", plan_id: opts?.planId, expires_at: opts?.expiresAt,
    }),
    subscriptionLink: (userId, opts) => req("POST", "/admin/subscriptions", {
      user_id: userId, mode: "link", plan_id: opts.planId, price_id: opts.priceId, coupon: opts.coupon,
      success_url: opts.successUrl, cancel_url: opts.cancelUrl, payment_methods: opts.paymentMethods,
    }),
    createCoupon: (opts) => req("POST", "/admin/coupons", {
      name: opts.name, percent_off: opts.percentOff, amount_off: opts.amountOff, duration: opts.duration ?? "once",
    }),
  };
}

// ---- shared spaces --------------------------------------------------------------------------------------------

export type Orgs = {
  /** Creates a shared space and returns its invite code. The caller becomes owner and first member. */
  create(name: string, opts?: { orgModel?: string; membershipModel?: string }): Promise<OrgRef>;
  /** Joins by code — the code IS the authorization, so treat it like one. */
  joinByCode(code: string, opts?: { maxMembers?: number; orgModel?: string; membershipModel?: string }):
    Promise<OrgRef>;
};

export function createOrgs(req: Requester): Orgs {
  return {
    create: (name, opts) => req<OrgRef>("POST", "/api/_org/create", { name, ...opts }),
    joinByCode: (code, opts) => req<OrgRef>("POST", "/api/_org/join", { code, ...opts }),
  };
}

// ---- saved payment methods ------------------------------------------------------------------------------------

/**
 * The card itself never passes through here. `add` takes a token the gateway's own script produced in the browser;
 * what comes back is the brand and the last four digits, which is all that is ever stored.
 */
export type PaymentMethods = {
  list(): Promise<PayMethod[]>;
  setup(): Promise<{ mode: string; client_secret?: string; customer_id: string }>;
  add(token: string): Promise<PayMethod>;
  remove(id: string): Promise<void>;
};

export function createPaymentMethods(req: Requester): PaymentMethods {
  return {
    list: () => req<PayMethod[]>("GET", "/me/payment-methods"),
    setup: () => req("POST", "/me/payment-methods/setup"),
    add: (token) => req<PayMethod>("POST", "/me/payment-methods", { token }),
    remove: (id) => req<void>("DELETE", `/me/payment-methods/${encodeURIComponent(id)}`),
  };
}

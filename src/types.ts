/** The shared shapes of the Fabapp API. Types only — nothing here runs. */

/** A record in a project collection. `id` is always present; the remaining fields come from the project schema. */
export type Row = { id: string; created_at?: string; [k: string]: unknown };

/** An authenticated END USER of the app (never a Fabapp platform account). */
export type AppUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  roles?: string[];
  plan?: string | null;
  email_verified?: boolean;
  must_change_password?: boolean;
  [k: string]: unknown;
};

export type FilterPrimitive = string | number | boolean;

/** Server-side operators. Anything omitted is simply not applied. */
export type FilterOps = {
  eq?: FilterPrimitive;
  ne?: FilterPrimitive;
  gt?: FilterPrimitive;
  gte?: FilterPrimitive;
  lt?: FilterPrimitive;
  lte?: FilterPrimitive;
  in?: FilterPrimitive[];
  nin?: FilterPrimitive[];
  /** Case-insensitive substring match on a text field. */
  contains?: string;
  starts?: string;
  null?: boolean;
};

/** A primitive means EQUALITY, an array means "any of these", an object applies the operators above. */
export type FilterValue = FilterPrimitive | FilterPrimitive[] | FilterOps;

export type ListOptions = {
  filter?: Record<string, FilterValue>;
  /** `field` ascending, `-field` descending. */
  sort?: string;
  limit?: number;
  offset?: number;
  /** A projection: only these fields come back (plus `id`, always). */
  fields?: string[];
};

/** The result of any runtime AI call. `data` is filled when a JSON schema was supplied, `text` otherwise. */
export type InvokeResult = {
  text: string | null;
  data: Record<string, unknown> | null;
  credits: number | null;
};

export type Notification = Row & {
  title?: string;
  body?: string;
  read?: boolean;
  link?: string | null;
};

export type OrgRef = { id: string; name?: string; code?: string; owner?: string; members?: string[] };

/** A saved payment method. Only what is safe to display — no card number is ever stored or returned. */
export type PayMethod = { id: string; brand: string; last4: string; exp_month?: number; exp_year?: number };

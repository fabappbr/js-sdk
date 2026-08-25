import type { Requester } from "./http.js";
import type { FilterValue, ListOptions, Row } from "./types.js";

/** The cursor for a first poll — everything changed since then, which is everything. */
const EPOCH = "1970-01-01T00:00:00Z";

export function buildListQuery(opts?: ListOptions): string {
  if (!opts) return "";
  const p = new URLSearchParams();
  if (opts.filter) {
    for (const [field, value] of Object.entries(opts.filter)) {
      if (Array.isArray(value)) {
        p.set(`filter.${field}.in`, value.join(","));
      } else if (value !== null && typeof value === "object") {
        for (const [op, val] of Object.entries(value)) {
          if (val != null) p.set(`filter.${field}.${op}`, Array.isArray(val) ? val.join(",") : String(val));
        }
      } else {
        p.set(`filter.${field}`, String(value));
      }
    }
  }
  if (opts.sort) p.set("sort", opts.sort);
  if (opts.limit != null) p.set("limit", String(opts.limit));
  if (opts.offset != null) p.set("offset", String(opts.offset));
  if (opts.fields?.length) p.set("fields", opts.fields.join(","));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export type Collection<T extends Row> = {
  list(opts?: ListOptions): Promise<T[]>;
  /** The total under the same access rules and filter, without transferring the rows. */
  count(filter?: Record<string, FilterValue>): Promise<number>;
  get(id: string, opts?: { fields?: string[] }): Promise<T>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  /** The same patch applied to several ids in one call. Records you cannot update are skipped, not rejected. */
  updateMany(ids: string[], data: Partial<T>): Promise<{ updated: number }>;
  /** Everything that matches the filter. */
  updateWhere(filter: Record<string, FilterValue>, data: Partial<T>): Promise<{ updated: number }>;
  /** One transaction, all or nothing. Capped at 200 items. */
  bulkCreate(items: Partial<T>[]): Promise<{ created: T[] }>;
  /** A soft delete of everything matching. The filter is mandatory on purpose. Capped at 200. */
  deleteMany(filter: Record<string, FilterValue>): Promise<{ deleted: number }>;
  remove(id: string): Promise<void>;
  /**
   * A delta fetch. With no `since` it returns everything; afterwards pass back the `cursor` you were given and only
   * what changed comes across. It does not consume the monthly request quota.
   */
  poll(opts?: ListOptions & { since?: string | null }): Promise<{ data: T[]; cursor: string | null }>;
};

export function createCollection<T extends Row = Row>(req: Requester, model: string): Collection<T> {
  const root = `/api/${model}`;
  const one = (id: string) => `${root}/${encodeURIComponent(id)}`;
  return {
    list: (opts) => req<T[]>("GET", root + buildListQuery(opts)),
    count: (filter) =>
      req<{ count: number }>("GET", `${root}/_count${buildListQuery(filter ? { filter } : undefined)}`)
        .then((r) => r.count),
    get: (id, opts) =>
      req<T>("GET", one(id) + (opts?.fields?.length ? `?fields=${opts.fields.map(encodeURIComponent).join(",")}` : "")),
    create: (data) => req<T>("POST", root, data),
    update: (id, data) => req<T>("PATCH", one(id), data),
    updateMany: (ids, data) => req<{ updated: number }>("POST", `${root}/_bulk_update`, { ids, data }),
    updateWhere: (filter, data) => req<{ updated: number }>("POST", `${root}/_bulk_update`, { filter, data }),
    bulkCreate: (items) => req<{ created: T[] }>("POST", `${root}/_bulk_create`, { items }),
    deleteMany: (filter) => req<{ deleted: number }>("POST", `${root}/_bulk_delete`, { filter }),
    remove: (id) => req<void>("DELETE", one(id)),
    poll(opts) {
      const qs = buildListQuery(opts);
      return req.poll<T[]>(`${root}${qs}${qs ? "&" : "?"}updated_since=${encodeURIComponent(opts?.since || EPOCH)}`);
    },
  };
}

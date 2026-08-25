# Changelog

## 0.1.2

Six defects, all found by a code review that probed the transport instead of reading it, and all of them shipped
through 28 green tests. The tests were the root cause: the fake `fetch` they used always answered valid JSON,
always answered quickly, and always answered.

**Fixed**

- **A non-JSON error body threw a `SyntaxError` instead of an `ApiError`.** `JSON.parse` ran before the status was
  consulted, so a gateway's HTML 502 arrived with no `status` on it — and every documented
  `e instanceof ApiError && e.status === 403` silently stopped matching at exactly the moment the platform was in
  trouble. HTML is now reduced to its sentence, an empty body falls back to the status text, and a 2xx that is not
  JSON is refused rather than returned as garbage.
- **`publicConfig()` cached its own failure forever.** One dropped connection at boot left the client permanently
  configless: push could never enable (no VAPID key) and phone sign-in never appeared, with nothing logged and no
  way back. It now caches the success and retries the failure.
- **A `detail` that arrived as a list printed `[object Object]`.** FastAPI's own request validation answers that
  way, while the documentation tells the caller to read the message. It now reads `title: field required`.
- **One subscriber that threw stopped all the others**, and made `logout()` throw. Each listener is now isolated.
- **A connection that never reached the API surfaced as a raw `TypeError`.** It is an `ApiError` with `status: 0`.
- **Nothing could be cancelled and nothing timed out.** A hung request hung forever, and a screen could not take
  its requests with it when it unmounted.

**Added**

- `timeout` and `signal` on `createClient`. There is no default timeout on purpose: a `tier: "smart"` call
  legitimately runs for a minute, and a limit short enough to protect a list read would cut it off.
- `AbortError`, exported. An abandoned request never became an answer, so it has no status to branch on.
- `./package.json` in `exports` — tooling that reads a dependency's version was getting
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

**Documented**

- A comma separates the values of an `in` filter and nothing escapes it: `["a,b", "c"]` matches three values, not
  two. That is the wire protocol, not something the client can fix on its own.

**Tests**

- A transport suite against a real server that misbehaves — HTML error pages, empty bodies, list details, hung
  connections, a refused port. Each case was verified to fail against the code it replaces.

## 0.1.1

The first release published through the OIDC pipeline, so the first one carrying a provenance attestation.

**Documentation.** Three things an agent needed and `AGENTS.md` did not say, all three found by writing a real screen
against a real project rather than by review:

- **How to discover a project's schema.** This client deliberately cannot tell you — it holds an end user's session,
  and an end user has no business enumerating the database. The three ways that do work are now written down.
- **What every record carries.** `created_by`, `created_at`, and a `<field>__label` beside every `ref` — the label
  is why a second query is usually unnecessary, and nobody could have guessed it.
- **422.** The error table stopped at 404 and skipped the status that guessing actually produces. The three messages
  it returns are now quoted, along with the one thing that fails quietly (a projection naming a field that is not
  there just drops it).

No API change.

## 0.1.0

The first release: the Fabapp API as a framework-agnostic client. Data, auth, files, AI, backend functions,
connectors, notifications, admin, shared spaces, push and saved payment methods, with no dependencies.

Published by hand, before Trusted Publishing was configured, so **this version has no provenance attestation**.
Nothing else distinguishes it from what the pipeline would have produced; the tarball was verified against source.

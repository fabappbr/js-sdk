# Changelog

## 0.1.4

**A Skill.** The package now ships `skill/SKILL.md`, with the header that lets a tool decide when to load it. It
is **derived** from `AGENTS.md` by `npm run skill`, and CI fails if the two drift — three copies of the same
teaching drift in three directions, and this one already had two possible homes.

The codegen prompt is deliberately NOT the source, and the reason is not duplication: it is that this file is
PUBLIC. That prompt talks to a model running inside the platform — it emits `fab.schema.json` as its channel, calls
`set_schema`, and has never heard of `@fabappai/sdk` or `createClient`. An agent on somebody's laptop is in the
opposite situation. Copying those instructions would hand over advice that is precise, production-tested, and wrong
for whoever reads it.

## 0.1.3

**Fixed — the session cookie.** Two ways a signed-in person was shown the logged-out screen with nothing raised and
nothing logged, which is the same screen a first-time visitor sees:

- `split("; ")` required the space after the `;`. A browser normally writes one, but nothing guarantees it —
  anything that sets `document.cookie` by hand can produce `a=1;fab_token_x=…`, and the session vanished.
- `split("=")[1]` cut the value at the first `=`. A JWT has none, so it held right up until something else was
  stored there.

The value is now escaped on write and unescaped on read, which makes an arbitrary `auth.setToken(…)` safe. A JWT is
unchanged by either, so cookies written by earlier versions keep working.

**Added.** `readCookie(name, jar?)`, exported — the parsing is worth being able to test, and worth reusing.

**Documented.** A backend function's `ctx` now offers the same API as this client, under the same names. It used to
expose five data methods against this client's twelve, and `notify`, `generateImage` and `extractData` did not exist
server-side at all.

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

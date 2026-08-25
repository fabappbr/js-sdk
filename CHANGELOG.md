# Changelog

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

# Security

## Reporting a vulnerability

Email **security@fabapp.com**. Please do not open a public issue for a vulnerability — a report in the tracker is
readable by everyone, including whoever would use it, before there is a fix to install.

Include what you can: the version, what you did, what happened, and what you expected. If you have a proof of
concept, send it; if you only have a suspicion, send that too. We would rather read ten reports that turn out to be
nothing than miss the one that is not.

We acknowledge within **two business days** and give you an initial assessment within **seven**, and we keep you
posted until it closes. You decide whether you want public credit. There is no bug bounty at the moment, and we
would rather say so plainly than leave the question open.

Please do not disclose before a fix is available, and if you find a credential or customer data, do not download or
keep it — describe the path and we will verify it.

## What this package is, in terms of risk

`@fabappai/sdk` runs in the browser of every end user of every app built on Fabapp. That is what makes its supply
chain the thing worth protecting most:

- **Trusted Publishing (OIDC).** No long-lived npm token exists — not in a repository secret, not on anyone's
  machine. Publication happens only from a tagged release through this repository's `publish` workflow.
- **Provenance attestation.** Every release is published with `--provenance`, so you can verify the tarball came
  from a specific commit of this repository rather than taking our word for it.
- **2FA** is required on every account with permission to publish.
- The release workflow refuses to publish a tarball containing an internal route or anything shaped like a
  credential.

Verify a release yourself:

```bash
npm audit signatures
npm view @fabappai/sdk dist.integrity
```

## What this package deliberately does not do

- **It holds no credential.** Model keys, connector secrets, SMS and email providers and the payment gateway all live
  on the platform. The package names an operation; it never carries the means to perform it.
- **It contains no payment form.** Card details are collected by the gateway's own script in the app layer, never by
  anything installed from a registry. What this package sees is a token, a brand and four digits.
- **It is not the authorization boundary.** Access rules are evaluated on the server, per record, on every request.
  Nothing you pass to this client can widen what a session is allowed to read or write.

## Session tokens

In a browser the session lives in a cookie readable by JavaScript — the same exposure as `localStorage`, chosen so a
session survives a reload. Anywhere else it lives in memory, scoped to one client instance: two clients never share
a session, which is what makes it safe to construct one per request on a server.

Pass a token explicitly when you have one:

```ts
const fab = createClient({ projectId, token: tokenFromTheRequest });
```

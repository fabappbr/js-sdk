# @fabappai/sdk

The [Fabapp](https://fabapp.ai) API from any JavaScript runtime — a browser, Node, a serverless handler, a test.

It is the data, auth, files, AI, backend functions, connectors and admin surface of a Fabapp project, and nothing
else: no React, no components, no hooks, no bundler assumption. Bring your own framework, or bring none.

```bash
npm install @fabappai/sdk
```

```ts
import { createClient } from "@fabappai/sdk";

const fab = createClient({ projectId: "your-project-id" });

await fab.auth.login("ana@example.com", "••••••••");
const open = await fab.collection("task").list({ filter: { done: false }, sort: "-created_at", limit: 20 });
await fab.collection("task").update(open[0].id, { done: true });
```

## Typing your data

Every collection is generic. Declare the shape once and the whole surface follows it.

```ts
type Task = { id: string; title: string; done: boolean; due?: string };

const tasks = fab.collection<Task>("task");
const overdue = await tasks.list({ filter: { done: false, due: { lt: new Date().toISOString() } } });
```

## Reading and writing

```ts
await tasks.list({ filter: { status: "open" } });            // a primitive means equality
await tasks.list({ filter: { status: ["open", "blocked"] } }); // an array means any of these
await tasks.list({ filter: { price: { gte: 50, lt: 100 } } }); // an object applies operators
await tasks.list({ fields: ["id", "title"] });               // a projection, for a lighter list

await tasks.count({ done: false });                          // the total, without the rows
await tasks.get(id);
await tasks.create({ title: "Write the docs" });
await tasks.update(id, { done: true });
await tasks.updateMany([id1, id2], { done: true });
await tasks.updateWhere({ done: false }, { priority: "high" });
await tasks.bulkCreate(rows);                                // one transaction, up to 200
await tasks.deleteMany({ done: true });                      // the filter is required on purpose
await tasks.remove(id);
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` `in` `nin` `contains` `starts` `null`. `sort: "field"` ascends,
`sort: "-field"` descends.

**Access rules run on the server**, per record, for every one of these calls. A list returns what the caller may
read, and a write the caller may not perform fails — there is no client-side flag that changes that.

### Live-ish reads

`poll` returns only what changed since a cursor, and does not consume the project's monthly request quota.

```ts
let cursor: string | null = null;
const tick = async () => {
  const { data, cursor: next } = await tasks.poll({ since: cursor });
  cursor = next;
  merge(data);          // by id — a poll returns changes, not the whole list
};
```

## Auth

```ts
await fab.auth.login(email, password);
await fab.auth.signup({ email, name, password, profile: { avatar } });
await fab.auth.me();
fab.auth.logout();

await fab.auth.updateProfile({ name: "Ana", avatar: url });   // this is how a profile is edited
await fab.auth.changePassword(next, current);
await fab.auth.forgotPassword(email, `${location.origin}/reset`);
await fab.auth.resetPassword(token, password);
await fab.auth.acceptInvite(token, name, password);

fab.auth.subscribe((user) => render(user));                   // returns the unsubscribe function
```

Social sign-in is two steps: send the browser to `fab.auth.oauthStartUrl("google")`, and call
`await fab.auth.completeOAuth()` on the page the provider returns to.

Sign-in by SMS — `sendPhoneCode`, `loginWithPhone`, `linkPhone`, `verifyPhoneLink` — works once the app owner has
connected an SMS provider; `(await fab.publicConfig()).phoneLogin` says whether to offer it.

## Files

```ts
const { id, url } = await fab.uploadFile(file);                        // a stable, public URL
const secret = await fab.uploadFile(file, { visibility: "private" });  // an opaque id, signed on read
```

Save the returned `url` in a field. The bytes go straight from the caller to storage through a presigned PUT — they
never pass through the API.

## AI, functions and agents

```ts
const { text } = await fab.ai.invokeLLM({ prompt: "Summarise this thread", tier: "fast" });
const { data } = await fab.ai.invokeLLM({ prompt, schema });        // a JSON Schema returns structured data
const { url } = await fab.ai.generateImage("a flat illustration of a calendar");
const { data } = await fab.ai.extractData({ fileId: id, schema });  // a document or an image

const result = await fab.callFunction("issue-refund", { orderId });  // runs isolated, server-side
const { answer } = await fab.agent("support").run("cancel order 123");
```

The model keys belong to the platform. Your code never holds one, and never can.

## Notifications, integrations, connectors

```ts
await fab.notify("email", { to, subject, message, link });   // plain text; put the URL in `link`
await fab.notify("sms", { to, message });
await fab.integrations.call("whatsapp", "sendMessage", { to, body });
await fab.callConnector(connectorId, "listContacts", { query: { limit: 10 } });
await fab.google.sheetsAppend(spreadsheetId, "Sheet1!A1", [[name, email]]);
```

## Administration

Only for a signed-in user holding the `admin` role.

```ts
await fab.admin.listUsers();
await fab.admin.updateUser(id, { roles: ["staff"] });
await fab.admin.grantSubscription(userId, { planId });        // complimentary; no gateway involved
await fab.admin.subscriptionLink(userId, { planId, successUrl, cancelUrl });
```

## Configuration

```ts
createClient({
  projectId,          // required
  baseUrl,            // defaults to https://api.fabapp.ai
  token,              // start from a token you already hold
  storage,            // where the session lives — see below
  fetch,              // your own fetch, for a proxy, retries, or a test
  currency, locale,   // for formatMoney / formatDate
});
```

The session lives in a cookie in the browser and in memory everywhere else. Two clients never share a session, which
is what makes this safe to use on a server — one client per request, one token per user.

```ts
// A server route acting as the signed-in visitor.
const fab = createClient({ projectId, token: tokenFromTheRequest });
```

## Errors

Every non-2xx throws an `ApiError` carrying the HTTP `status` and the server's message.

```ts
import { ApiError } from "@fabappai/sdk";

try {
  await tasks.create({ title });
} catch (e) {
  if (e instanceof ApiError && e.status === 403) showPermissionNotice();
  else throw e;
}
```

`401` means no session, `403` means the access rules said no, `402` means the account is out of credits, `429` means
a rate limit.

## Not in this package

**React components and hooks.** Generated Fabapp apps get those seeded as editable source in `src/lib` and
`src/components` — they are app code, not a dependency.

**The card form.** A payment form is deliberately absent from anything published to a registry: a compromised
package that reaches the field where someone types a card number is a different order of damage from one that
reaches a session.

**Starting a checkout.** Not an oversight. Inside a native shell, a gateway checkout is a payment link inside the
app — the literal example in Google Play's payments policy, and apps get pulled for it with subscribers inside. The
guard that decides between the gateway and store billing has to see which shell it is running in, which this package
cannot. It stays in the app layer, where `useSubscribe` and `<SubscribeGate>` enforce it. From a server, where no
store policy applies, call the endpoint deliberately:

```ts
await fab.request("POST", "/checkout", { mode: "subscription", items, success_url, cancel_url });
```

## License

MIT

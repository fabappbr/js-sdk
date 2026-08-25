# Building on Fabapp — a reference for coding agents

You are writing code against a **Fabapp project**: a hosted backend with a schema, per-record access rules, end-user
auth, file storage, server-side AI, backend functions and connectors. `@fabappai/sdk` is how any JavaScript reaches
it.

Read the first section before writing anything. It is short, and every rule in it comes from a real app that shipped
broken.

---

## 1. The rules that cost the most

### Access defaults are FAIL-CLOSED

Omit `access` on a model and: read requires login, create requires login, update and delete require ownership.
**Nothing is public by default.**

This does not raise an error. The page simply renders **empty** for a logged-out visitor, which reads as a broken app
— a store with no products. Anything a visitor must see before signing in (catalogue, storefront, menu, feed, blog,
landing copy, pricing, testimonials) needs `{"read": "public"}` stated explicitly.

The mirror rule: **write is never public.** Keep create/update/delete on `authenticated`, `owner` or `role:` unless
anonymous writing was actually asked for.

### A bare ownership rule locks the browse screen

```jsonc
{ "access": { "owner_field": "owner_id" } }        // ✗ applies to EVERY action, read included
```

On any model people browse — a venue, a listing, a restaurant, a store — only the record's owner can even see it.
Split per action instead:

```jsonc
{ "access": {
    "read":   "public",
    "create": "authenticated",
    "update": { "owner_field": "owner_id" },
    "delete": { "owner_field": "owner_id" } } }
```

### A dotted path in an ownership rule matches nobody

```jsonc
{ "owner_field": "venue.owner_id" }                // ✗ silently denies everyone but the admin
{ "owner_in":    "conversation.participants" }     // ✗ same
```

There are no joins in access rules. The value is looked up as a literal key on **this** record's data, so the rule is
false for every record. `owner_field` and `owner_in` must name a field **of this model**.

For a child owned through its parent — `cart_item → cart`, `order_item → order`, `message → conversation`,
`comment → post`, `venue_schedule → venue` — use:

```jsonc
{ "owner_via": "<refField>" }
```

Ownership is **delegated** to the parent's own rule. Never restate the parent's rule on the child, and never point an
`owner_field` at a ref field — that is the classic mistake and every write fails with 403.

`owner_via` resolves **one hop**, so the parent must declare ownership of its own (`owner`, `owner_field` or
`owner_in`). And when the parent is publicly browsable, the child rows that the public screen reads — schedules,
slots, photos — are almost always `"read": "public"` too.

Two more things about `owner_via`, both of which have broken production:

- It is **never a bare string**. `"access": "owner_via"` is not a rule; it is a validation error. The same goes for
  `owner_field` and `owner_in` — all three are objects, always.
- The API rejects an invalid rule rather than guessing what you meant. You get a 400 naming the exact path.

### Creator ≠ owner

When one person assigns a record **to another** — a trainer sends a workout to a student — the model carries an
assignment field: a `ref` for one owner, or a `list` of app-user ids for many.

Read uses ownership on that field. **Create and update cannot.** Under an ownership rule a regular user has the owner
field *forced* to their own id, and gets a 403 for trying to write anyone else's — which locks the very assignment the
feature exists for. Create and update therefore use a role:

```jsonc
// workout, with a `student` ref field
{ "read":   { "any": ["role:trainer", { "owner_field": "student" }] },
  "create": "role:trainer",
  "update": "role:trainer",
  "delete": "role:trainer" }
```

For many students: a `students` field of type `list`, and `{"owner_in": "students"}` in read.

### An admin already overrides every rule

A user holding an admin or owner role sees and edits everything. To give the admin edit power, do **not** loosen a
rule to `authenticated` — that hands every user write access to every record. Keep the ownership rule; the admin
passes it anyway.

### Canonical model ids are fixed English, never localised

Even in a Portuguese, Spanish or German app. The platform's own code — checkout, webhooks, automations — writes these
records and only knows these ids.

| Purpose | Ids |
|---|---|
| Billing | `plan`, `subscription`, `product`, `order` |
| Courses | `course`, `module`, `lesson`, `lesson_content`, `lesson_progress` |
| In-app | `notification` |

`plano`, `produto`, `curso`, `aula`, `signature`, `enrollment`, `course_purchase` are all wrong. Localise the
**labels**, never the ids. Canonical field ids are fixed too: `plan` has `name, price, interval (month|year),
currency, active, provider_price_id` — the billing period **is** `interval`, not a second `billing_cycle` field.

Any extra field you add to a canonical model must be **optional**. The platform creates these records knowing only the
canonical fields; a required field it does not know about makes the app unable to sell.

---

## 2. The schema

### First, find out what it is

You cannot write against models you have not seen, and **this client cannot tell you.** Deliberately: it holds an
end user's session, and an end user has no business enumerating the shape of the database. Three ways to find out,
in the order you should try them:

1. **Inside a generated Fabapp app, read the code.** The app already queries its own models — `collection("…")` calls
   and the types beside them are the schema, stated by something that works.
2. **From the platform, with the project owner's own credential:** `GET /projects/{projectId}` returns every model
   with its fields and its access rules. It requires a Studio token, not an app-user one, and it is not reachable
   through this package.
3. **Ask the person.** Faster than guessing, and guessing is expensive: a model id that does not exist answers 404,
   and an invented field answers 422.

Guessing has one mercy — it fails loudly. See §7.

### The shape

A project's schema is a list of models:

```jsonc
{ "models": [{
    "id": "task",                    // snake_case, English, canonical where one exists
    "name": "Task",
    "labelField": "title",           // what represents the record anywhere it is referenced
    "access": { "read": "public", "create": "authenticated",
                "update": { "owner_field": "owner" }, "delete": { "owner_field": "owner" } },
    "fields": [
      { "id": "title",   "type": "text",   "required": true },
      { "id": "status",  "type": "enum",   "options": ["open", "doing", "done"] },
      { "id": "owner",   "type": "ref",    "to": "app_user" },
      { "id": "due",     "type": "date" },
      { "id": "photos",  "type": "list",   "of": "image" }
    ] }],
  "roles": [{ "slug": "trainer", "name": "Trainer", "permissions": ["lesson.manage"] }] }
```

Storage is schemaless — merging by id, no migrations. Models you do not mention stay as they are.

**Field types:** `text` `richtext` `number` `money` `boolean` `enum(options)` `ref(to)` `date` `datetime` `time`
`image` `file` `video` `url` `email` `phone` `color` `icon` `list` `geo` `autonumber`.

Type choices that are wrong more often than not:

- An image is `image` and a file is `file` — never `url` or `text`. `url` is for external links only.
- Several images is `{"type": "list", "of": "image"}`, not several `image` fields.
- A clock time is `time`, not `text`.
- A Lucide icon name is `icon`, not `text`.
- `autonumber` is a human-readable sequence the platform emits on create — order and invoice numbers. It is not the
  record id, which stays a UUID.

**Relations are 1-N and live on the child only.** `order_item.order = {type: "ref", to: "order"}`. Never put an array
of child ids on the parent — it is a second copy of the same relation that nothing keeps in sync. To show a parent's
children, query them:

```ts
await fab.collection("order_item").list({ filter: { order: orderId } });
```

**`labelField` must point at something a human reads** — a name, a title, a code. Point it at `id` and every relation
picker shows a raw UUID. For a record with no readable field (an order, an invoice), add a short `code` and use that.

**Access rule grammar**, in full:

```
"public" | "authenticated" | "owner" | "role:<slug>" | "perm:<x>" | "plan:<tier>"
| { "owner_field": "<field>" }     // one owner:   data[field] === user.id
| { "owner_in": "<listField>" }    // many owners: user.id ∈ data[listField]
| { "owner_via": "<refField>" }    // the parent's rule decides
| { "any": [ ... ] }               // OR
| { "all": [ ... ] }               // AND
```

Applied per action (`read`, `create`, `update`, `delete`) or as one rule covering all four.

---

## 3. Talking to the project

```ts
import { createClient } from "@fabappai/sdk";
const fab = createClient({ projectId: "..." });
```

Full API in the README. The shape in one screen:

```ts
fab.collection<T>(model)      // list, count, get, create, update, updateMany, updateWhere,
                              // bulkCreate, deleteMany, remove, poll
fab.auth                      // login, signup, logout, me, updateProfile, changePassword,
                              // forgotPassword, resetPassword, acceptInvite, oauthStartUrl,
                              // completeOAuth, phone sign-in, subscribe(listener)
fab.uploadFile(file)          // presigned; public or private
fab.ai                        // invokeLLM, generateImage, extractData
fab.callFunction(name, body)  // a backend function, isolated, server-side
fab.agent(name).run(input)    // an AI agent acting under the CALLER's permissions
fab.notify(channel, opts)     // email, sms, slack, discord
fab.integrations.call(...)    // a connected provider
fab.callConnector(...)        // an imported OpenAPI operation
fab.google                    // Sheets, Calendar, any googleapis endpoint
fab.admin                     // users, roles, complimentary subscriptions — role:admin only
fab.orgs                      // shared spaces by invite code
fab.paymentMethods            // saved cards; the card never touches this package
```

**Never write `fetch` against the API by hand, and never hardcode a URL or a project id.** Everything the client
sends is scoped and authorised; a hand-rolled request is how a rule gets bypassed by accident and how an app breaks
when a route moves.

**Every AI key, connector secret and gateway credential lives on the platform.** Your code names an operation; it
never carries the means to perform it. There is no place to put an API key in an app, and no need for one.

### What comes back on every record

Three fields you did not declare, on every row of every model:

```jsonc
{ "id": "77ab6b32-…",
  "created_at": "2026-08-25T04:28:35Z",
  "created_by": "9f565d85-…",        // the app-user who created it — stamped by the server
  "code": "REG-001",
  "event": "fafc1d7a-…",
  "event__label": "Meetup de engenharia" }   // ← the label of every ref field, resolved for you
```

**`<field>__label` is why you rarely need a second query.** Every `ref` field arrives with the referenced record's
`labelField` beside it. To show "you are registered for *Meetup de engenharia*", read `registration.event__label` —
do not fetch the event.

`created_by` is the creator, which is **not** the same as the owner. On a model with an ownership field, the owner is
that field; `created_by` merely records who made the row. See creator ≠ owner in §1.

---

## 4. Inside a generated Fabapp app

An app generated by the Fabapp Studio is a React + Vite SPA with React Router. There, the client is **already
wired**: import from `@/lib/fab-sdk` (or `@/lib/fab-client`, which re-exports it) rather than constructing one.

```ts
import { collection, useAuth, uploadFile, invokeLLM } from "@/lib/fab-sdk";
```

Alongside the client, the app is seeded with a React layer that is **editable app code, not a dependency**:

- Hooks — `useAuth`, `useLive`, `useNotifications`, `useEntitlement`, `useSubscribe`, `useCheckout`, `useQuota`,
  `useSpace`, `usePush`, `useLocale`, `useSeo`
- Screens and guards — `FabProvider`, `RequirePlan`, `QuotaGate`, `SubscribeGate`, `ChangePassword`, `AcceptInvite`
- Pieces — `Logo`, `Chat`, `Feed`, `Rating`, `Chart`, `SlotPicker`, `AgendaBoard`, `AvailabilityManager`,
  `RichText`, `RichTextEditor`, `VideoPlayer`, `PdfReader`, `QRCode`, `QRScanner`, `TwoFactor`, `MagicLink`,
  `CsvImport`, `CsvExport`, `DocTemplate`, `Members`, `OrgSwitcher`, `InviteCode`, `PairingGate`, `PaymentMethods`,
  `InstallPrompt`

**Check this list before building any of them.** They handle states that are invisible until production: an expired
signed URL, a resumed video, a partitioned cookie in a preview iframe, a payment gateway that differs by country.

Specifically:

- `<Logo/>` for the app's own brand, never a hardcoded icon and text. The owner uploads a logo in the Brand panel and
  every `<Logo/>` in the app updates with no code change.
- `<VideoPlayer/>` for any `video` field. It covers adaptive HLS, plain MP4, YouTube and Vimeo, resume, expiry and
  error states, and its `onProgress` is how you gate a quiz or mark a lesson complete.
- `<RichText/>` to display and `<RichTextEditor/>` to edit a `richtext` field.

---

## 5. Traps that look right

**Selling something does not unlock a paywall.** Marking an `order` paid grants no entitlement. Anything gated by
`plan:premium` still answers 403 after a successful payment, with nothing in any log to explain it. To sell *access*,
sell a `plan` through `useSubscribe`/`useCheckout`. A one-off `order` is for buying a **thing**, not a permission.

**A course's syllabus and its content are two collections.** An access rule covers the whole record and there is no
per-field access, so "show the titles, sell the videos" cannot live on one model. `lesson` is the public syllabus;
`lesson_content` holds the video and materials and is `plan:premium`. Put nothing in `lesson` you would not show a
stranger. Do not invent a `free_preview` flag — the grammar has no predicate over a field's value, so it renders a
"watch free" button the API answers 403 to. A genuine sample is its own public collection.

**One app is one entitlement.** `plan:premium` is a single flag; several courses in one app all unlock together. For
courses sold separately, generate one app per course.

**Email verification is a setting, not a screen.** Accounts are created already verified and no email is sent unless
the project's auth setting says so. Writing a "check your inbox" notice changes nothing on its own.

**A `date` field is a date-only string.** `new Date("2026-03-02")` parses it as UTC midnight, which is the previous
day anywhere west of Greenwich. Use the client's `formatDate`, which reads it as local midnight.

**Money follows the app's currency and locale, not the visitor's.** `fab.formatMoney` handles it; an
`Intl.NumberFormat` with an undefined locale prints the right symbol with the wrong separators.

---

## 6. A screen, end to end

```tsx
import { useEffect, useState } from "react";
import { collection, useAuth } from "@/lib/fab-sdk";

type Task = { id: string; title: string; done: boolean; owner?: string };

export default function Tasks() {
  const { user, isLoading } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    collection<Task>("task")
      .list({ filter: { done: false }, sort: "-created_at", limit: 50 })
      .then(setTasks)
      .catch((e) => setError(e.message));
  }, []);

  const complete = async (task: Task) => {
    setTasks((all) => all.map((t) => (t.id === task.id ? { ...t, done: true } : t)));  // optimistic
    try {
      await collection<Task>("task").update(task.id, { done: true });
    } catch (e) {
      setTasks((all) => all.map((t) => (t.id === task.id ? { ...t, done: false } : t)));
      setError((e as Error).message);
    }
  };

  if (isLoading) return <Skeleton />;
  if (!user) return <SignInPrompt />;
  if (error) return <ErrorState message={error} onRetry={() => location.reload()} />;
  if (!tasks.length) return <EmptyState />;      // an empty list is a state, not an accident

  return <ul>{tasks.map((t) => <TaskRow key={t.id} task={t} onComplete={() => complete(t)} />)}</ul>;
}
```

Four states every screen needs: loading, empty, error, and the happy path. An empty list after a failed authorisation
looks identical to an empty list with no data — which is exactly why the fail-closed default above is the most
expensive rule on this page.

---

## 7. Errors

Every non-2xx throws an `ApiError` with the HTTP `status` and the server's message.

| Status | Meaning | Usually |
|---|---|---|
| 400 | Invalid input | A malformed access rule, naming the exact path |
| 401 | No session | Sign in |
| 402 | Out of credits | An AI or integration call on an exhausted account |
| 403 | The access rules said no | A missing `"read": "public"`, or an ownership rule pointed at the wrong field |
| 404 | Not there, or not yours | Also `modelo inexistente no projeto: <id>` — a model id that does not exist |
| 422 | The schema disagrees | A field that is not there. This is what guessing produces |
| 429 | Rate limited | Back off and retry |
| 0 | It never reached the API | A dropped connection, a blocked origin, DNS |

The 422s name the offender, so read the message rather than retrying:

```
campo não filtrável: nope              ← list({ filter: { nope: … } })
campo não ordenável: nope              ← list({ sort: "-nope" })
campos desconhecidos: ['inventado']    ← create({ inventado: 1 })
```

A request you abandoned rejects with `AbortError` rather than `ApiError` — it never became an answer, so it has no
status to branch on.

One thing fails quietly instead: a projection naming a field that does not exist just drops it, and you get the
valid ones back. So does a comma inside an `in` filter: `{ tag: ["a,b", "c"] }` travels as `a,b,c` and matches
three values, not two. And writing an ownership field to someone else's id answers `403 — não pode atribuir 'attendee' a
outro usuário`, which is the creator ≠ owner rule refusing at runtime.

A 403 on a screen that *should* be public is the fail-closed default. A 403 on a write that should belong to the user
is almost always `owner_field` pointing at a ref field where `owner_via` was needed.

# SelfHive Bills invitations, protocol 1 — local Android continuation

`GET /api/health` advertises `capabilities.billsInviteProtocol: 1`. This is a
read-only guest Bills projection plus a separate invitation lifecycle. It never
changes financial assignments, monthly amounts, collection checklist outcomes,
or dated payment requests. Acceptance records that the bearer invitation was
accepted; it does not identify a unique device or prove a payment.

Owner routes use the existing authentication and `X-BillHive-User` guard:

| Route | Behavior |
| --- | --- |
| `GET /api/bills/invite/:personId/sync/snapshot` | Atomic household identity/revision, person existence/name, invitation revision, active token/creation/acceptance, and `inviteUrl`. |
| `POST /api/bills/invite/:personId/sync/commit` | Protected `create`, `rotate`, or `revoke` with an atomic durable receipt. |
| `GET /public/bills/invite/:token/sync/snapshot` | Atomic public preview/current summary for the single invited person. |
| `POST /public/bills/invite/:token/sync/accept` | Protected acceptance with a durable receipt. |

Both commands contain `serverInstanceId`, `householdId`, `personId`,
`baseRevision`, `baseInviteRevision`, and `mutationId`. The owner adds `kind`.
Acceptance adds the reviewed `shareId` (SHA-256 of the bearer token) and
`monthKey`. Identifiers/revisions follow the household protocol. New commands
require `SYNC_REQUIRE_PRECONDITIONS=1`; a frozen matching receipt can still replay
after that policy changes. Commands contain no money, bearer token, or payment
outcome. Retain exact request bytes/ID before networking; do not silently generate
a new command after an uncertain response.

`bills_invite_revisions` follows token creation, rotation, revocation and acceptance,
including legacy SQL writers and other SQLite connections. Household revision
continues to cover people, bills, currency, monthly amounts and collection metadata.
Each mutation and its receipt commit together in an immediate SQLite transaction.
Person removal revokes access in the same transaction; restoring the same person
ID cannot reactivate that token. Creation/acceptance/revocation fields and token
ownership are permanent. Safe-integer revision overflow rolls the entire mutation
back. Existing invitation rows migrate without replacing tokens or receipt hashes;
orphan links are permanently closed.

An owner receipt has `committedInviteRevision`, `resultToken`, `replayed`, and a
current owner snapshot. The historical result token may have since been rotated
or revoked. Only `snapshot.invite.token` and its matching `inviteUrl` represent
current access. Routing metadata may change without changing the invitation
revision. A guest receipt includes `joinedAt`, `committedInviteRevision`, `access`,
`replayed`, and a current public snapshot. After revocation, an already committed
acceptance can replay with `access: "revoked"` and `snapshot: null`, confirming its
historical result without granting current access. A different request under the
same ID returns `MUTATION_ID_REUSED`.

Public snapshots include protocol/household/person/share identity, both revisions,
creation/acceptance, owner/person display names, explicit month/currency, exact
signed total and bill breakdown, `received`, `requestedAt`, and `ownerPayment`.
They exclude owner user ID, other people, email addresses, guest payment profiles,
raw household documents, tokens, private bill metadata and unrelated records.
The bearer link already grants preview access to this summary before acceptance.
`received` is the host's recorded collection checklist status. `ownerPayment`
identifies the host; the invited person's profile would be a request destination
in the opposite direction. Provider handoffs require separate native validation
and explicit user action; no action has been implemented by this protocol alone.

Currency allocations use the exact decimal implementation, including 0/3/4-digit
currencies and negative net balances. Snapshots declare `decimalJSONProtocol: 1`.
The live month uses the server's calendar/time zone. A month rollover can change
the projection without a saved household mutation, so acceptance pins the month
and ETags include it. Refresh must validate identity and nondecreasing revisions;
at the same household revision/month, financial projection values must agree.

Existing owner create/delete and public join routes now use atomic lifecycle
operations. In strict mode they require a current `If-Match` ETag from the owner
snapshot/public preview. In compatibility mode they continue accepting omitted
preconditions; native protected commands remain blocked. Unmodified older Swift
Bills writers do not yet implement these strict invitation preconditions and
require a companion migration before strict mixed-client release qualification.
Legacy read payloads retain their existing shape/payment-profile semantics.
The new native snapshot supplies the host recipient explicitly. Public responses
remain `no-store`; rate limits are unchanged. No deployment or external sharing
occurred. Native encrypted journals, UI, process recovery, hosted ownership,
physical-device and mixed-client acceptance remain unfinished.

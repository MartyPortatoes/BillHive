# Checks sharing protocol v1

This additive SelfHive protocol protects owner link commands and public guest
declarations. A claim does not change the host's participants, item assignments,
payment state or financial totals. The host must review and apply claims through
a separate household edit. Public responses deliberately omit private notes,
person links, payment metadata, email addresses and unknown host fields.

`GET /api/health` advertises `capabilities.checkShareProtocol: 1` and
`capabilities.checkShareGuardProtocol: 1`. The existing
`revisionPreconditionsRequired` flag controls legacy enforcement. This work does
not turn that flag on in any deployment.

## Snapshots and commands

| Endpoint | Authentication | Result |
| --- | --- | --- |
| `GET /api/share/check/:checkId/sync/snapshot` | Owner | Owner, server, household and check identity; household `revision`; `shareRevision`; check existence/completion; active `share` and `shareUrl`, or null. |
| `POST /api/share/check/:checkId/sync/commit` | Owner | Durable receipt for `create`, `rotate` or `revoke`, plus the current owner snapshot. |
| `GET /public/share/check/:token/sync/snapshot` | Bearer link | Public check, currency, claims, creation time, server/household/check/share identities and both revisions. No owner user ID. |
| `POST /public/share/check/:token/sync/claim` | Bearer link and private claimant header | Durable claim receipt and current public snapshot, or a receipt-only replay after revocation. |

Owner commands contain exactly `serverInstanceId`, `householdId`, `checkId`,
`baseRevision`, `baseShareRevision`, `mutationId` and `kind`. Mutation IDs are
16–128 URL-safe identifier characters. Revisions are nonnegative safe integers.
Clients requiring protected writes send `X-BillHive-Require-Protection: 1`.
The owner account is authenticated by the existing middleware; native writes
also pin it with `X-BillHive-User`.

Owner snapshots and the snapshot in owner receipts include `shareUrl`. It uses
`PUBLIC_BASE_URL`, including any path prefix, or the existing request-derived
public base when no override is configured. After rotation/replay the URL always
refers to `snapshot.share.token`, never the historical `resultToken`. It is null
without an active share and absent from guest responses. Routing configuration
can change without advancing the sharing revision; `shareUrl` is outside `share`.
Clients must validate the URL and its token before presenting it.

Guest commands replace `kind` with `shareId`, `claimantId` and
`claim: {claimerName, itemIds}`. The name is trimmed, nonblank and at most 80
UTF-16 code units; item IDs must be unique, valid, current and at most 200.
An empty selection is an explicit withdrawal or name-only join.

Each new native guest creates a cryptographically random 32-byte key encoded
as 64 lowercase hex characters. Send it only as `X-BillHive-Claimant-Key`:

- `shareId = SHA256(token)`
- `claimantId = SHA256("check-claimant\0" + token + "\0" + claimantKey)`

The private key must be encrypted at rest separately from the immutable pending
request. The server stores the derived claimant ID and never stores the private key.
Display names are never guest identities. Two guests named Alex remain distinct;
one guest's later submission replaces only that guest's latest declaration.
The server preserves legacy claims and unknown stored claim fields, while public
projections expose only name, item IDs, time and optional claimant ID. Legacy
claims without an identity still require explicit host mapping. At 500 claims,
new entries are rejected; updates of an existing native claimant remain possible.
Older declarations are never silently evicted to make room.

## Atomicity, retry and lifetime

Each new command checks identity, both revisions, completion/access state, and
the write inside one SQLite immediate transaction. The receipt is inserted in
that same transaction. A failure rolls back content, revocation and revisions.
Sharing has its own monotonically increasing revision because claims live
outside the household JSON document. Household edits still invalidate stale
sharing commands. SQLite triggers also observe legacy and other-connection writes.

After a timeout, retry the same persisted mutation ID and exact payload. A matching
receipt returns `replayed: true` without executing the mutation again. Reusing the
ID with different content returns `MUTATION_ID_REUSED`. The current snapshot can
be newer than the acknowledged request. For owner receipts, `resultToken` is the
historical result: use only `snapshot.share.token` as the currently active link.
For guest receipts, `committedShareRevision` identifies the acknowledged write.
After revocation a matching committed claim can still be acknowledged, with
`access: "revoked"` and `snapshot: null`; new commands cannot read or write through
that link. Receipts do not disclose current private check data.

Completion keeps the public check readable but rejects new claims and new or
rotated links. Reopening allows claims again. Revocation is permanent. Deleting a
check revokes all its links in the same transaction, including legacy JSON writes,
whole-state replacement and deleting the checks state. Restoring the same check
ID does not reactivate old links. Startup migration also revokes orphaned legacy
links. Share identity cannot be changed in place and revoked rows cannot be
unrevoked. New sharing requires a newly issued token.

Backups and server recovery must preserve instance/household identity, both
revision tables and both receipt tables along with `share_checks`. There is no
receipt expiry contract yet: do not prune receipts or physically delete their
share rows while a client could have an uncertain request. A portable household
records restore does not import or resurrect public credentials.

## Applying reviewed claims to household assignments

Guest claims have a separate revision stream. A household-only `baseRevision`
cannot prove that the declarations still match the host's review. Clients that
have negotiated `checkShareGuardProtocol: 1` can include this optional field in
an ordinary `/api/sync/commit` request:

```json
{"checkSharePreconditions":[{"checkId":"dinner","shareId":"<SHA256 of active token>","shareRevision":7}]}
```

Each guard has exactly these three fields. `shareId` is a lowercase 64-character
hex digest, or null when the host reviewed the absence of an active link.
`shareRevision` is a nonnegative safe integer. There must be 1–100 guards with
unique valid check IDs. Omit the field for ordinary unguarded writes; omission
keeps the existing request hash and receipt behavior unchanged.

The server checks every guard and the household revision inside the same SQLite
immediate transaction as the financial edit and its receipt. A changed claim,
rotation, revocation, newly created link or legacy/other-connection share write
rejects the whole save with `CHECK_SHARE_CONFLICT`; nothing is partially applied.
Malformed guards return `INVALID_COMMIT`. Guarded new writes require revision
protection, and a SyncStore without sharing support fails closed with
`CHECK_SHARE_GUARD_UNSUPPORTED`.

Matching receipt lookup precedes these revision checks. A retry acknowledges the
old commit even after later claims or rotation; changing the guards under the
same mutation ID is `MUTATION_ID_REUSED`. The existing HTTP protection requirement
still applies if an administrator turns strict mode off. Clients preserve the
exact request and draft on unknown outcomes; a validated `CHECK_SHARE_CONFLICT`
can release a guarded request for explicit review.

This mechanism protects a host-chosen household edit. It does not map claimants,
calculate assignments, accept claims automatically or upgrade old clients that
omit the guards. Native host mapping, split preview and explicit confirmation,
including withdrawals and legacy declarations, remain required client work.

## Compatibility and remaining client work

The legacy read/create/claim/revoke routes retain their response shapes and now
return a sharing ETag. Legacy writes validate supplied `If-Match`; strict mode
requires it. Owner and public ETags are different scopes and include both revision
values. Default compatibility mode accepts an omitted tag, so old clients keep
their weaker retry semantics. Legacy rotation/claims do not receive durable
receipts. Migrate them to v1 before relying on protected retries.

Android has typed snapshots, exact commands, receipt validation, encrypted guest
credentials, durable guest journals, link import/selection/review UI and isolated
HTTP interoperability tests. It now validates public owner addresses and can
freeze sharing guards into a financial commit. Native owner journals/link controls,
host review and claimant-to-participant mapping remain to be connected. Browser
and Swift sharing clients still require migration and mixed
client acceptance before strict rollout. Hosted BillHive/Supabase ownership is
separate unfinished work. Native link presentation must use the validated owner
`shareUrl`, so a private API connection does not override the configured public
address. Legacy URLs also continue to use `PUBLIC_BASE_URL`.

The [mutation inventory](mutation-coverage.md) remains the server-wide boundary.
This protocol alone does not complete invitations, email, account configuration,
attachment retention or the Android release plan.

## Verification

Run Node 24 `node --test`. The current suite has 73 passing cases, including 19
Checks cases covering HTTP projection/authentication, same-name guests, concurrent
claims/rotations, exact replay, stale check edits, completion, permanent deletion,
legacy strict/default behavior, malformed requests, capacity, rollback, revision
exhaustion, another database connection and startup migration. Evidence is in
`docs/evidence/2026-09-27/check-sharing/tests.xml` for the initial 68-test protocol
checkpoint. The additional guarded-save cases cover changed claims without a
household edit, concurrent host/guest commits, replay after rotation, strict input
validation, absent-link guards, another SQLite connection and transactional
rollback of household edits and revocation. Current evidence is in
`docs/evidence/2026-09-27/check-host-guards/verification.md`.

The initial run passed 11 Checks cases, then two cases hit the unchanged 60/hour
public limiter. The fixture now assigns a distinct synthetic client address per
scenario through its explicitly trusted loopback proxy. No production rate limit
was changed. No server was deployed by this work.

# SelfHive revision protocol, version 1

The Android continuation now also requires the compatible
[exact decimal JSON protocol](decimal-json-protocol.md) for new financial writes
and frozen-request submission. That document covers capability negotiation,
versioned receipt hashes, older-client guards and migration limits.

This protocol supports the separate native Android app while retaining the
existing Swift and web clients. It covers the household JSON in `user_state`
and `monthly_data`. It is an additive local implementation, not a production
rollout approval or proof that every server feature is revision-protected.

[Bills invitations](bills-invite-protocol.md) now have their own revision stream,
protected owner/acceptance commands and receipts. They do not mutate household
financial state. Native UI/journals and older strict-mode Bills clients remain
separate implementation/rollout work.

## Capability and identity

`GET /api/health` returns `capabilities.syncProtocol: 1` and
`capabilities.revisionPreconditionsRequired`. Existing authentication applies;
the `user` field must agree with the subsequent snapshot's `userId`.

`GET /api/sync/snapshot` returns one atomic SQLite snapshot:

```json
{
  "protocolVersion": 1,
  "userId": "local",
  "serverInstanceId": "persistent-server-uuid",
  "householdId": "persistent-household-id",
  "revision": 42,
  "state": {},
  "monthly": {}
}
```

The server ID persists in `app_settings.syncInstanceId`; household IDs and
revisions persist in `sync_revisions`. Revision is an opaque, monotonic, safe
integer in `0..9007199254740991`. A multi-row transaction can advance it more
than once. It is not a timestamp or an API-call counter. The snapshot ETag is
`"bh1:<serverInstanceId>:<householdId>:<revision>"`, including quotes.

Clients pin all three identity fields. A URL or device key alone does not prove
that the same household is still behind an endpoint. A changed ID, a decreasing
revision, or different data at the same revision requires explicit recovery;
never replace the old cache or apply its drafts automatically.

## Atomic commit

`POST /api/sync/commit` accepts:

```json
{
  "serverInstanceId": "persistent-server-uuid",
  "householdId": "persistent-household-id",
  "baseRevision": 42,
  "mutationId": "a-new-uuid-for-this-request",
  "state": {"settings": {"currencyCode": "USD"}},
  "monthly": {"2026-09": {"totals": {}, "amounts": {}}},
  "deleteStateKeys": [],
  "deleteMonths": []
}
```

State entries and month entries are upserts. Each supplied value replaces that
entire key's value; this is not a field-level merge. Omitted keys are retained.
Deletion is explicit; a key cannot be both supplied and deleted. Preserve
unknown fields when editing an existing value. IDs must match the protocol's
identifier validation; mutation IDs contain 16–128 ASCII letters, digits,
underscores or hyphens.

Clients send `X-BillHive-User` to guard against a changed authenticated session.
Clients that require all covered JSON writers to use preconditions also send
`X-BillHive-Require-Protection: 1`. Android always sends this header; the server
returns 428 `PROTECTION_DISABLED` when strict mode is off.

Validation, identity check, receipt lookup, revision comparison, data writes,
revision increments and receipt insertion use one immediate SQLite transaction.
The server rejects corrupt existing JSON rather than silently replacing it.
The response is the current complete snapshot plus `mutationId`,
`committedRevision` and `replayed`.

Persist the exact request before networking. For a lost response, resend the
same mutation ID and body. Receipts are scoped to the authenticated owner. A
matching retry returns `replayed: true` without another write, even after a
later mutation. Reusing an ID with different data returns 409
`MUTATION_ID_REUSED`. Receipts must not be pruned within an instance's lifetime
without a new protocol retention/expiry contract.

On replay, `revision` can exceed `committedRevision`: another device changed the
household after the original save. Accept that current snapshot, but never
promote a newer stale whole-document draft just because the first request was
acknowledged. The web client blocks that follow-up and offers an unsaved JSON
download. Android retains separate drafts and applies draft-level validation
against confirmed data before creating another request.

## Failures and durable Android state

| Outcome | Client behavior |
| --- | --- |
| Successful validated receipt | Atomically record the receipt, update confirmed cache, consume the matching submitted draft, remove the pending request. |
| 409 `REVISION_CONFLICT` | Receipt lookup already proved this request did not commit. Keep the draft; refresh and review before creating a new request. |
| 409 `HOUSEHOLD_CHANGED` | Keep old identity, cache, draft and request. The original server may have committed it. |
| 409 `MUTATION_ID_REUSED` | Keep the request for diagnosis. Do not invent a new ID and retry blindly. |
| 428 `PROTECTION_DISABLED` / `PRECONDITION_REQUIRED` | Restore compatible server protection. These responses do not prove the original attempt was never committed. |
| Timeout, cancellation, connection error, 5xx, malformed receipt | Outcome remains uncertain. Keep the original request and retry it unchanged. |

Android Room schema 2 adds identity bindings, one pending request per partition,
and receipt records. Preparing a request does not change the confirmed cache.
The submitted draft is locked while its outcome is uncertain. A delayed receipt
cannot roll back a newer confirmed cache; unexpectedly newer draft text is
retained. The migration preserves version-1 household, local outbox and draft
tables. Android's current basic editors and check/trip actions use this journal
when connected to a protected server. Legacy servers remain read-only.

The Android UI exposes pending-save retry and retained drafts. A rejected or
locally conflicting draft can refresh a comparison, adopt the latest values,
or apply only its changed fields to the reviewed snapshot. Applying a review
does not submit it; Save performs another current-state validation. Currency
changes, removed members, changed share-line structure and stale settlements
cannot bypass the domain checks. A changed comparison is rejected atomically.
Uncertain requests stay frozen and are retried with their original bytes/ID.

## Swift owner compatibility

The companion Swift/SwiftUI implementation (`iOS_App` commit `2094893`) negotiates the atomic owner
protocol and retains its Apple UI. On capable servers, state/month loading,
ordinary saves, and explicit JSON import/reset use coherent snapshots and
atomic commits. It checks the authenticated user, pins the server/household,
rejects protocol redirects and refuses a later downgrade to legacy writes.
Older servers retain the existing legacy path. Swift does not require the
strict flag while compatible clients are being shipped; unguarded older clients
can still overwrite data until enforcement is enabled.

A private, backup-excluded file journal retains the confirmed wire document,
its stable typed projection, the latest working draft, and immutable pending
request bytes. Disk persistence precedes sending and acknowledgement. Unknown
wire fields survive edits, including inside ID-bearing records. Missing fields
that Swift decoders synthesize are not written simply because another field
changed. Explicit import/reset deliberately replaces the JSON keys and months.

After a stale rejection, the owner can export a records-only recovery JSON and
explicitly load current server values. Pending uncertain requests must first be
resolved by replay. Export and discard are checked against the current draft;
a changed comparison cannot discard newer edits. Swift currently offers export
and reload, rather than Android's field-by-field conflict application. Recovery
copies do not include attachment bytes. An API-key change selects a different
journal partition; the prior files are retained, but cross-credential recovery
UI remains unfinished.

Local evidence is in the companion iOS repository at
`docs/audits/2026-09-26-selfhive-owner-sync.md`. This implementation has not been
released to Apple users. Native guest compatibility and the server coverage
boundary below remain open, so this checkpoint does not enable strict rollout.

## Existing routes and coverage boundary

The existing state PUT/PATCH, monthly PUT/DELETE, import and reset endpoints
accept `If-Match`. Supplied preconditions are always checked. With
`SYNC_REQUIRE_PRECONDITIONS=1`, an omitted precondition returns 428. Reads and
successful writes return a coherent ETag. SQLite triggers advance revisions for
every insert/update/delete of either covered JSON table, including legacy
writers and writes through another SQLite connection.

Public trip reads and joins return the owner's ETag. Legacy guest expense creation,
update and deletion, and settlement writes check that ETag, invitation state,
membership and archive status inside the transaction. These mutations advance
the owner's revision, preventing a stale owner snapshot from erasing a guest's
change. The new [guest trip protocol](guest-sync-protocol.md) adds invitation-scoped
receipts and a public-trip-only snapshot for updated native clients. Legacy guest
routes retain no receipts. Guest clients still need durable local retry/review
integration; existing Swift guest clients require compatibility updates before
strict rollout.

Separate check-share/claim rows, invitation metadata, attachment bytes,
authentication/device keys and email configuration are **outside this JSON
revision stream**. The [Checks sharing protocol](check-sharing-protocol.md) now
gives share links and claims their own revisions, receipts and deletion lifecycle;
client UI/journals and rollout remain open. Other separate-resource contracts
remain unfinished work. In particular, don't describe this as complete
server-wide mutation coverage. See the [route inventory](mutation-coverage.md).

## Rollout and rollback

The flag defaults to off. Default mode preserves older Swift clients that do
not send preconditions, but cannot guarantee protection against stale legacy
overwrites. Android permits draft submission only against a protected server
and repeats that requirement on each commit.

Before enabling strict mode on a real server:

1. Back up the SQLite database using a consistent SQLite backup operation and
   back up its attachment directory; verify restoration on an isolated server.
2. Deploy the additive server schema and the matching web assets together.
   Confirm legacy reads/writes and authenticated user isolation with the flag off.
3. Release the implemented Swift owner compatibility, finish guest compatibility and the remaining
   mutation-coverage audit. Complete release QA for the Android recovery/conflict
   flows. Test mixed clients and real
   proxy/device-key authentication. This repository has not completed that gate.
4. In an isolated environment, enable the flag and exercise owner/guest writes,
   lost-response replay, stale rejection, offline drafts, server restart, and
   account switching. Use physical devices before release certification.
5. Enable strict mode during a controlled rollout only after clients are ready.
   Read back the capability and verify an unguarded covered write returns 428.

Code/schema rollback and data restoration are distinct. The new tables/triggers
are additive; keep receipts/revisions/IDs with the corresponding data. Reverting
server code or disabling strict mode removes its protection and is not a safe
way to resolve a pending Android save. Export retained drafts before any manual
reconciliation. Do not run two independent writable databases as one household.

When restoring an older database or creating an independent writable clone,
stop its server and rotate `app_settings.syncInstanceId` to a fresh UUID before
restarting. The server loads this value at startup. A restored database must not
reuse the former identity with older revisions or missing receipts: that could
make an already committed request appear new. Existing clients will need an
explicit cache/draft recovery path; do not automatically bind their old drafts
to the restored instance. A backup endpoint is valid only when it represents
the same authoritative database, identity and receipt history.

## Verification

Use Node 24 and run `npm test`. `test/sync.test.js` exercises concurrent writers,
atomic state/month commits, deletion, lost-response replay, receipt isolation,
all covered legacy mutation routes, guest-owner conflicts, persistence/reopen,
corrupt JSON, revision overflow and web-client retry ordering. This local suite
does not certify production proxy configuration, Docker/Alpine, attachment
recovery, physical devices or Swift compatibility.

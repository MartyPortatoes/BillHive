# SelfHive revision protocol, version 1

This protocol supports the separate native Android app while retaining the
existing Swift and web clients. It covers the household JSON in `user_state`
and `monthly_data`. It is an additive local implementation, not a production
rollout approval or proof that every server feature is revision-protected.

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
tables. These operations are implemented below the UI; Android's current
SelfHive editing screens remain read-only pending recovery/conflict UI wiring.

## Existing routes and coverage boundary

The existing state PUT/PATCH, monthly PUT/DELETE, import and reset endpoints
accept `If-Match`. Supplied preconditions are always checked. With
`SYNC_REQUIRE_PRECONDITIONS=1`, an omitted precondition returns 428. Reads and
successful writes return a coherent ETag. SQLite triggers advance revisions for
every insert/update/delete of either covered JSON table, including legacy
writers and writes through another SQLite connection.

Public trip reads and joins return the owner's ETag. Guest expense creation,
update and deletion, and settlement writes check that ETag, invitation state,
membership and archive status inside the transaction. These mutations advance
the owner's revision, preventing a stale owner snapshot from erasing a guest's
change. Guest endpoints do not yet use the owner commit receipt journal; guest
clients need their own retry/review treatment. Existing Swift guest clients
still require compatibility updates before strict rollout.

Separate check-share/claim rows, invitation metadata, attachment bytes,
authentication/device keys and email configuration are **outside this JSON
revision stream**. Their concurrency, ownership and lifecycle contracts remain
separate unfinished work. In particular, don't describe this as complete
server-wide mutation coverage.

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
3. Finish and ship Swift owner/guest compatibility, Android recovery/conflict
   flows, and the remaining mutation-coverage audit. Test mixed clients and real
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

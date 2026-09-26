# SelfHive guest trip protocol, version 1

This additive protocol supports native guest expense and settlement editing.
It uses the same SQLite household revision as owner commits, with separate
receipts scoped to a specific invitation. It does not grant an invite bearer
access to `/api/sync/snapshot` or the owner's other records.

## Read and join

Accept the invitation with the existing idempotent
`POST /public/trip/invite/:token/join`. Then use
`GET /public/trip/invite/:token/sync/snapshot`:

```json
{
  "protocolVersion": 1,
  "serverInstanceId": "server-uuid",
  "householdId": "household-uuid",
  "invitationId": "sha256-of-the-invitation-token",
  "tripId": "trip-id",
  "memberId": "invited-member-id",
  "revision": 42,
  "revisionPreconditionsRequired": true,
  "trip": {}
}
```

The invitation ID is 64 lowercase hexadecimal characters. Pin the server,
household, invitation, trip and member together. URL/token partitions must remain
separate, including different tokens for the same member. Reject rollback or
different trip data at the same revision. Protection capability can change
without a trip mutation. Health advertises `capabilities.guestSyncProtocol: 1`.

The read requires a joined, unrevoked invitation and current trip membership.
Archived trips remain readable. The result contains only the public trip shape:
no owner email/settings/months, linked person IDs, attachment references, import
metadata or unknown private record fields. Settlement/checklist output now also
uses explicit public-field lists. The ETag is the owner's revision ETag.

## Commit

`POST /public/trip/invite/:token/sync/commit` receives an immutable request:

```json
{
  "serverInstanceId": "server-uuid",
  "householdId": "household-uuid",
  "invitationId": "sha256-of-the-invitation-token",
  "tripId": "trip-id",
  "memberId": "invited-member-id",
  "baseRevision": 42,
  "mutationId": "unique-request-uuid",
  "operation": {
    "kind": "upsertExpense",
    "expense": {
      "id": "expense-id",
      "name": "Dinner",
      "amount": 20,
      "paidByAmounts": {"host": 20},
      "splitBetweenIds": ["host", "invited-member-id"]
    }
  }
}
```

Supported operations are `upsertExpense` with an `expense`, `deleteExpense` with
an `expenseId`, and `recordSettlement` with a `settlement`. Required expense
fields are shown above. Existing public date/category/FX/note fields are optional.
A settlement requires `id`, `fromMemberId`, `toMemberId`, and positive `amount`;
timestamp, notes and source action ID are optional. Member references must refer
to the current trip, and a settlement cannot pay oneself. Expense amounts are
nonnegative and bounded at 1e12; payer values are nonnegative and bounded, with a
positive payer required for a positive expense. Split members must be nonempty
and unique. Existing payer-weight behavior is retained; this endpoint does not
independently certify an entire trip's financial ledger or impose owed-balance
limits on recorded payments.

Guest expense upserts merge only allowed public fields into an existing expense,
preserving its host attachments, import metadata and future fields. Unknown
request fields, attachment changes, invalid references and malformed operations
are rejected. Settlement IDs are immutable: reuse with different data is rejected.
Deleting an expense removes its JSON record; physical attachment garbage
collection remains a separate server lifecycle requirement.

Android always sends `X-BillHive-Require-Protection: 1`. New writes return 428
`PROTECTION_DISABLED` if enforcement is off. A previously committed request can
still be acknowledged after enforcement is disabled; replay does not write data.

Identity, receipt lookup, current authorization, revision check, JSON mutation
and receipt insertion share one immediate SQLite transaction. Guest writes
advance the owner stream, so an old owner commit cannot erase them. Receipts
store a SHA-256 token scope and canonical request hash; the receipt table does
not store plaintext tokens. Never prune receipts without a replacement retention
contract, and retain them with the database/instance identity during backups.

## Receipts and access changes

An active result contains the request's identity fields plus:

```json
{
  "protocolVersion": 1,
  "mutationId": "unique-request-uuid",
  "committedRevision": 43,
  "replayed": false,
  "access": "active",
  "snapshot": {"protocolVersion": 1, "revision": 43, "trip": {}}
}
```

The example omits repeated identity fields; the actual envelope and nested
snapshot both contain them. On replay, the current snapshot may have a later
revision than `committedRevision`. Do not automatically apply a newer stale
draft after acknowledging that receipt. Preserve it for a fresh comparison.

When an already committed request is retried after revocation, member removal
or trip removal, the server can return its original receipt with `replayed:true`,
`snapshot:null`, and `access:revoked|memberRemoved|tripRemoved`. A `notJoined`
status is reserved for a retained receipt whose current invitation is no longer
joined. These results reveal no current trip or current household revision.
They acknowledge only the original matching request. A different body using
that mutation ID is rejected, and a new write still requires current access.

Persist the exact bytes and partition before sending; retain them after network
failure, invalid receipts or uncertain errors. Validate both receipt identity
and revision bounds before consuming a draft. `REVISION_CONFLICT` is definitive
only because receipt lookup precedes it. An unavailable invitation or changed
server is not blanket proof that an earlier request never committed.

## Verification and remaining integration

The complete Node suite passes 34 tests. Six added HTTP/store cases cover public
projection, preserved host fields, owner/guest conflicts, deletion/settlements,
replay after intervening edits, database reopen, revoked/member-removed replay,
invitation isolation, archive/join checks, bad operations and transactional
rollback when receipt insertion fails. Existing legacy, auth and owner tests
remain included. Docker packaging now includes `guest-sync-store.js`; a live
Docker/Alpine build is not claimed by this checkpoint.

Android implements typed snapshots/requests/receipts and join/read/commit
transport. Its JVM integration test uses the real isolated Node server to join,
save, replay after an owner edit, reject a stale write and acknowledge a revoked
request. It also tests exact bytes, credential isolation, redirects and invalid
receipts. The companion Android evidence is
`docs/evidence/2026-09-26/guest-protocol/verification.md`.

Guest Room journals, Android editor/recovery UI, invitation management, browser
guest editing, and Swift guest protocol integration remain unfinished. Legacy
guest mutation routes still have revision preconditions but no receipt journal;
new clients should use this protocol. This checkpoint does not enable strict
production rollout or finish [server-wide mutation coverage](mutation-coverage.md).

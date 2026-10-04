# Protected household reset protocol 1

This local companion change supports Android's reset protocol foundation. It is
not deployed. Android has no household-reset screen or durable reset-cleanup
coordinator yet; local/Drive reset and hosted deletion also remain open.

`GET /api/health` advertises `householdResetProtocol: 1`. A fresh review requires
revision protection and exact decimal support. `GET /api/sync/reset/preview`
returns the authenticated owner's complete sync snapshot plus `householdReset`:
`protocolVersion`, an opaque SHA-256 `guard`, and `summary`. Counts cover state
keys, history months, active Checks/Trips/Bills links, managed files/bytes and
legacy disk files/bytes. The guard binds the entire snapshot, all owned link
rows and their separate revisions/claims/acceptance, staged and purged attachment
metadata, and exact original disk-file identities/digests. Preview publishes no
financial edit, link revocation or file deletion.

The client freezes the following extra field in an ordinary `/api/sync/commit`
request, using the preview's owner/server/household identity and base revision:

```json
{
  "householdReset": {
    "protocolVersion": 1,
    "guard": "<64 lowercase hexadecimal characters from preview>",
    "summary": {
      "stateKeys": 2, "months": 1,
      "checkLinks": 3, "tripLinks": 1, "billsLinks": 2,
      "managedFiles": 1, "managedBytes": 100,
      "legacyFiles": 2, "legacyBytes": 20
    }
  }
}
```

The counts shown are examples; copy the actual unchanged summary from preview.
The replacement `state` and `monthly` must both be raw empty objects, and their
deletion lists must explicitly contain every current key/month. Mixed per-check
guards, partial deletion, automatic setup defaults and additional reset fields
are rejected. The server verifies the original guard and summary before writing.
Changed household JSON gives `REVISION_CONFLICT`; changed invitations, claims or
files give `RESET_REVIEW_CHANGED`. Both leave the original household intact.

One SQLite transaction removes owned records/history, permanently revokes all
three owned link kinds, purges managed BLOB bytes, advances the household revision
even when it was already empty, and saves both the exact-request sync receipt and
reset report/legacy cleanup tasks. Unknown records are explicitly removed too.
The reset receipt includes its original guard/summary and current cleanup counts.
Checks claims, revoked link identities, sync/audit receipts, attachment identity
reservations, device keys and email configuration remain as recovery/audit or
connection state. Other owners are outside the reset scope.

An exact commit replay checks its stored hash before current protection, revision
or resource preconditions. It returns the original committed revision/report and
the actual current owner snapshot. It never reapplies empty records, re-revokes
newer invitations, purges restored bytes or re-enqueues disk files. Changing any
frozen request field under the same mutation ID gives `MUTATION_ID_REUSED`.

Legacy disk cleanup is a separate explicit action:
`POST /api/sync/reset/:mutationId/cleanup`, authenticated as the same owner and
pinned with `X-BillHive-User`, `X-BillHive-Server`, and `X-BillHive-Household`.
The client must retain a durable cleanup obligation after accepting the financial
receipt; accepting a reset is not proof that disk cleanup finished. The server
does not currently run this queue automatically on startup.

Cleanup operates only on the original recorded paths below the owner's receipt
and itinerary roots. It holds the SQLite write lock, checks current references,
then compares each original file's device/inode, size, modification/change times
and streamed SHA-256 before unlinking. A current restored reference, including
identical original bytes, or a changed/replaced file is marked `retained`.
An already missing file is `removed`; unsafe paths or I/O errors are `failed` and
retryable. A crash/rollback after unlink but before status persistence is safe to
retry. Directory/file symlinks are rejected. Scans are bounded to 10,000 record
directories, 10,000 files, 2 MiB per receipt/10 MiB per itinerary file, and 256 MiB
total legacy bytes; unsupported collections fail before reset. Empty directories
remain. The host's configured data root is trusted; concurrent external host
filesystem replacement races and physical disk failure are not qualified.

Managed attachment reservations retain their original identity after byte purge.
They consume no active quota and downloads return `ATTACHMENT_PURGED` (410).
Only the exact reserved content can be rehydrated. Restore staging pins the fresh
revision; a legacy managed descriptor without content identity fails restore
preflight honestly rather than promising unavailable bytes. After the first
reset, new ordinary managed uploads require `X-BillHive-Revision` and current
parents. Exact already-active byte replays remain harmless. Legacy raw uploads
and deletes require a fresh `If-Match` plus a current, active parent after reset;
older clients without that proof receive 428. Legacy reads after reset require
current metadata references. Android now sends the reviewed revision for managed
uploads; Apple raw-upload compatibility after reset still needs implementation.

This is logical household reset, not secure account erasure. SQLite free pages,
WAL/journals, server backups, external exports, credentials and audit metadata
may retain prior information. No external account, email, payment, deployment or
store operation occurs.

The complete sequential server suite passes **233 tests**, including 14 reset
cases and a real server started from the Dockerfile's staged COPY set. The latter
uses the local Node 24/native dependencies; Docker CLI is unavailable here, so
Docker/Alpine execution is unverified. The Dockerfile now includes the previously
missing decimal/Bills modules and the new reset store. See
[server evidence](evidence/2026-10-04/household-reset-protocol/server-tests.log)
and [pinned inputs/result](evidence/2026-10-04/household-reset-protocol/result.json).

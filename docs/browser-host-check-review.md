# Browser host review engine and journal

`public/check-claim-review.js` implements explicit guest mapping, manual/guest
assignment provenance and exact minor-unit previews compatible with Android's
`CheckClaimReview`. `public/check-review-client.js` persists reviews and guarded
financial requests. These modules are verified but **not loaded by the production
owner page yet**. The legacy Pull Claims control still needs its full replacement.

## Review behavior

Names never identify guests or participants. A source ID binds the sharing ID to
the native claimant ID. Legacy rows instead bind exact content and occurrence,
using Android-compatible date normalization. Same-name guests remain independent.

Each source requires Apply, Keep previous or Remove. Apply needs an explicit
existing/new participant, and removed item selections require acknowledgement.
Old-link contributions remain until handled explicitly. Manual assignments are
stored separately, so a withdrawal cannot erase overlapping manual/other-guest
contributions. Adding a participant freezes prior Everyone assignments before
the addition. An empty explicit result cannot accidentally mean Everyone.

The version 1 `claimApplications` ledger is read/written in the native format.
Malformed/unsupported provenance cannot authorize overwriting the saved history.
Changed manual assignments require scoped review. Guest ordering cannot move
remainder pennies. New household links must be valid and unique.

Calculations use decimal strings and BigInt largest-remainder allocation, with
stable participant tie ordering, capped credits and the native allocation bounds.
Minor units are returned as strings. Before/proposed totals and payment flags to
clear are explicit; confirmation is required before producing a saveable proposal.
Unknown check/item/participant and household fields remain intact.

## Durable review and save

The browser database is `billhive-host-check-reviews-v1`. Origin, API prefix,
signed-in account, server and household scope each record. It contains drafts
for multiple checks and one pending financial request. A draft holds the original
household, token-free sharing comparison, raw plan and retained obsolete sources.
Opening existing reviews never silently rebases choices. Compare-and-set protects
against stale tabs. Backwards/contradictory revisions are rejected.

The prepare step requires the exact reviewed preview and fresh household/sharing
state. The complete immutable request includes `checkSharePreconditions` and is
stored before HTTP. Both revision streams are checked in the server transaction.
The transport requires the expected owner and protection headers, bounded bodies
and no redirects. Unknown outcomes keep the original request and lock editing;
definite conflicts permit explicit comparison or discard. Account changes do not
make a request safe to discard or send under another identity.

Acknowledgement, matching draft consumption and receipt storage happen in one
IndexedDB transaction. Replay can return newer household data; that confirmed
snapshot is retained without applying the old split twice. UI integration must
adopt it only after accounting for ordinary unsaved household edits.

Recovery export whitelists check/review data and raw choices. It omits bearer
links, unrelated household records, authentication identity, payment addresses
and the full request payload, which may contain legacy bearer metadata. It records
the mutation ID/hash for diagnostics; it is not a portable retry/import format.
Original exact retry remains attached to the original browser/account journal.

## Required UI integration

1. Hydrate the journal during owner loading, show retained drafts/pending actions
   on startup, including removed/completed checks, and handle unreadable storage.
2. Replace Pull Claims with actual mapping, manual-item review, before/proposed
   totals, changed-source comparison and explicit payment-reset confirmation.
3. Order raw edits and keep unsaved text exportable on storage failure. Protect
   navigation, keyboard access, focus return and large-text primary actions.
4. Coordinate ordinary household saves, link actions and review saves. Do not
   prepare from a stale in-memory page; do not overwrite unrelated unsaved edits
   with a replay snapshot. A pending review must remain discoverable after reload.
5. Exercise actual controls, offline/reload/process recovery, multi-tab edits,
   removed/completed records and account switching before claiming the UI complete.
6. Finish reviewed browser deletion and Swift migration, then deployed mixed-client
   acceptance. Do not enable server enforcement or replace missing flows with
   disabled controls as a substitute for implementing them.

See [verification](evidence/browser-host-check-review/verification.md).

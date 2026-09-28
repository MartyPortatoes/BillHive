# Reviewed browser check deletion

The Checks page's Delete action opens a durable review for active or completed
checks. It lists items, participants, adjustments, payment tracking, current link
status and guest declarations. A saved checkbox confirmation is required before
the destructive action. Closing preserves the review for startup recovery.

Deletion reviews live in the existing account/server/household-scoped financial
IndexedDB journal under `removals`. Old split-review records remain compatible.
Both actions share one pending request, so separate tabs cannot prepare a split
save and deletion independently. Ordinary household writes consult this same
journal and retain unsaved edits while a financial result is uncertain. Startup
navigation routes to the actual pending action even if the user selects another
saved review for that check.

## Comparison and submission

The review compares the entire check wire object, currency, sharing revision and
guest declarations. Unknown check fields participate in that comparison. A
changed check requires explicit comparison, adoption and renewed confirmation.
Adopting the comparison fetches again and rejects a second change. A missing check
retains its review/export rather than treating absence as proof that this request
succeeded. Completed or uncalculable splits can still be deleted.

Independent household changes do not invalidate confirmation. Preparation removes
only the reviewed check from the latest validated household and preserves other
checks, root/container metadata and monthly records. Both household and sharing
revisions are guarded in the existing server transaction. An unfinished link
action prevents preparation. The server permanently revokes the removed check's
links; restoring its ID does not reactivate them.

The exact request is persisted before sending. Unknown outcomes retain that
request and lock confirmation. Retry bypasses new-action preparation and sends
the original mutation ID/payload. A replay can acknowledge deletion while returning
a newer restored check; the restored check and new link are retained. Only the
matching deletion draft is consumed. Other unfinished split reviews remain.

## Recovery and sharing cleanup

Failed storage and stale-tab changes keep the visible confirmation available for
export, retry or explicit saved reload. Existing reviews reopen offline in an
already authenticated page. Account replacement hides the old household/dialog
without moving its journal into another account. Corrupt records remain intact.

Recovery exports whitelist descriptive check data, confirmation, token-free
sharing guards and guest declarations. They omit unknown private fields, bearer
links and the full immutable request. Exports are diagnostic/review copies, not a
portable retry format; exact retry remains in the original browser journal.

Receipt acknowledgement atomically consumes the matching draft and records a
durable sharing-cleanup marker when the confirmed check is absent. Cleanup runs
against the separate owner-link database, then acknowledges its exact marker.
These two databases do not share one transaction: a crash between their writes
repeats harmless cleanup. Markers survive later financial receipts and remain
visible for retry on storage failure. Pending link requests, corrupt records and
newer restored sharing state are preserved. A current restored check prevents
removal of its sharing cache.

## Acceptance boundaries

The actual browser tests cover IndexedDB, strict local HTTP, checkbox/keyboard
interaction, process replacement, offline reopening, concurrent changes, exact
retry, restoration, cleanup failure, completed/removed checks and account changes.
Phone, tablet and doubled-text screenshots are retained. Physical browsers,
system accessibility settings, broad contrast/TalkBack and deployed mixed-client
qualification remain open. Swift sharing compatibility is the next companion
client step. No server enforcement configuration is enabled by this change.

See [verification](evidence/browser-check-removal/verification.md).

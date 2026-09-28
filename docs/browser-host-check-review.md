# Browser host review and guarded saves

`public/check-claim-review.js` implements explicit guest mapping, manual/guest
assignment provenance and exact minor-unit previews compatible with Android's
`CheckClaimReview`. `public/check-review-client.js` persists reviews and guarded
financial requests. The owner page now loads these modules and replaces Pull
Claims with the Review guest split dialog, using `check-review-session.js` for
ordered intent and `check-review-page.js` for the actual controls.

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
snapshot is retained without applying the old split twice. The page adopts it
only after accounting for ordinary unsaved household edits. A pending financial
review blocks ordinary saves while preserving their unsaved content. New reviews
flush ordinary writes and check unfinished link actions before preparing a save.

Persisted owner receipts are checked before the current server protection policy.
An exact retry can therefore acknowledge a previous save after protection is
disabled; a new protected write is still rejected. Request hashes and household
binding remain mandatory for receipt replay.

Recovery export whitelists check/review data and raw choices. It omits bearer
links, unrelated household records, authentication identity, payment addresses
and the full request payload, which may contain legacy bearer metadata. It records
the mutation ID/hash for diagnostics; it is not a portable retry/import format.
Original exact retry remains attached to the original browser/account journal.

## Owner flow

Startup recovery lists saved reviews, including removed checks, and surfaces
unreadable storage without replacing it. Existing reviews can reopen offline in
an already authenticated page. The Guests, Items and Totals steps provide explicit
claimant mapping, manual assignments, before/proposed totals and payment-reset
confirmation. Same-name guests have separate references and choices.

Changed household or sharing data opens a saved/current comparison. Keep choices
and Start a new review both fetch again before adopting the comparison. Neither
action saves financial changes. Removed/completed checks retain export/recovery
access while preventing a new application.

Raw text is saved in order; preview calculations run in a worker. Payment-reset
confirmation waits until the current choices are saved and calculated. Local
storage failures and stale-tab conflicts retain on-screen text for recovery
export and explicit reload. Unknown financial outcomes lock editing and expose
exact retry, including after browser process replacement. Account changes hide
the previous review and household while keeping their original journal intact.

The native dialog retains keyboard focus, input selection and scroll position.
Its footer keeps the primary action visible at short viewport heights and with
enlarged text. Ordinary Checks participant amounts now use the same exact
minor-unit formatter and allocation engine as the review.

[Reviewed browser deletion](browser-check-removal.md) now shares the financial
journal and retains unfinished split reviews after removal. Swift sharing
migration, physical-browser and deployed mixed-client acceptance remain open.
These changes do not enable enforcement.

See [engine/journal verification](evidence/browser-host-check-review/verification.md)
and [actual UI verification](evidence/browser-host-check-review-ui/verification.md).

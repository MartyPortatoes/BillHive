# Browser owner check-link journal

`public/check-owner-client.js` implements the owner protocol and IndexedDB journal
for protected create/rotate/revoke actions. `check-owner-session.js` now connects
the actual owner controls to the journal. Startup attention and Checks recovery
retain unfinished actions, including removed checks. Guarded host review of guest
declarations and reviewed deletion remain required for the full browser migration.

## Contract

The client binds records to the current origin, API prefix, signed-in user,
server instance, household and check. The authenticated transport sends the
expected user header and same-origin cookies, refuses redirects, bounds response
bodies and requires protection for new commands. It does not retain a device key
or generate a new owner identity. An account switch cannot redirect a saved action
into another user's household.

Owner snapshots must match the loaded household's exact revision. Preparing a
command requires the exact reviewed snapshot, an unchanged local record and the
same loaded owner revision. A complete request is stored before HTTP; unknown
outcomes retain the original payload and mutation ID. Another tab's rejected and
dismissed request cannot subsequently be sent from a stale client instance.

Definite protocol rejections retain the action until explicit dismissal. Changed
or corrupt records never authorize replacement of saved state. Recovery listing
keeps an unavailable entry for an unreadable record, including a removed check.
Listings expose state and check IDs rather than bearer tokens or guest contents.

Validated acknowledgement and pending-request consumption are one transaction.
An older response cannot roll back household/sharing revisions, resurrect a
revoked link, or replace a fresher public address/protection policy at equal
revisions. A replay's `resultToken` describes its historical outcome: only the
current snapshot token and validated `shareUrl` may be offered to the owner.
No-op create/revoke receipts legitimately retain the same sharing revision.

Completed/removed checks cannot create or replace links; they can resolve prior
actions and revoke. URL validation accepts HTTP/HTTPS public addresses with a
supported path prefix and current token, and rejects credentials, queries,
fragments, encoded routing ambiguity and unsupported prefixes.

Recovery exports include identities, revisions, pending intent and receipt
metadata, but exclude user names, link tokens, public URLs and guest declarations.
The browser's private IndexedDB retains link data under its origin; this is not
an Android Keystore encryption claim or a cross-browser credential-transfer flow.

## Owner controls

New link actions flush household edits, refresh the signed-in household and load
matching sharing state. Replacement/revocation confirmation requires an unchanged
fresh comparison. Cancellation resolves without preparing a request. Copy/Open
refresh first and use only the current validated public URL. Link metadata no
longer gets written into the financial household document.

Unknown outcomes expose exact retry; definite rejections require explicit clearing.
Reopen, sanitized export and unreadable-record recovery remain available after
reload. Changing accounts hides the old household and presents an explicit reload
control; original saved actions stay bound to their original account.

Guest declarations are displayed independently, including identical names.
**Review guest split** now provides explicit claimant mapping, provenance, split
preview and an atomic household/share revision guard; see
[host review](browser-host-check-review.md). Reviewed browser deletion and Swift
sharing migration are still open.
No deployment enforcement is enabled at this checkpoint.

See [journal verification](evidence/browser-owner-check-links/verification.md).
See [actual control verification](evidence/browser-owner-check-ui/verification.md)
for process recovery, phone layout checks and remaining acceptance limits.

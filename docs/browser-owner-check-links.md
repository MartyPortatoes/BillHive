# Browser owner check-link journal

`public/check-owner-client.js` implements the owner protocol and IndexedDB journal
for protected create/rotate/revoke actions. It is verified as a data module;
**the existing controls in `index.html` are not connected to it yet**. The full
browser owner migration still requires that integration, recovery navigation and
guarded host review of guest declarations. No legacy feature was disabled or
replaced with a placeholder in this checkpoint.

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

## Remaining integration

1. Load the module in the owner application and bind it to the validated owner
   snapshot. Reconcile household saves before preparing new link actions.
2. Replace legacy link POST/GET/DELETE calls and stop copying link metadata into
   the financial household document. Show the journal's current validated link.
3. Confirm replacement/revocation against freshly reviewed state. Present saved
   retry, definite rejection, recovery export and corrupt-record outcomes.
4. Surface pending actions on startup and for checks removed from the ordinary
   list; maintain account isolation during reload and authentication changes.
5. Replace name-based Pull Claims with explicit claimant mapping, provenance,
   split preview and an atomic household/share revision guard. This remains
   required, not replaced by a disabled control or warning.
6. Verify actual owner UI, process recovery, large text, keyboard behavior and
   mixed-client flows before enabling strict protection in a deployment.

See [journal verification](evidence/browser-owner-check-links/verification.md).

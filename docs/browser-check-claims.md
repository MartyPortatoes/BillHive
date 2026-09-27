# Public browser check selections

The public `/share/:token` page uses the same revision-protected check protocol
as Android. It sends guest declarations to the host for review; its selected-item
subtotal is not a promised final share or a payment authorization. Household
financial assignments are never changed by this page.

## Identity and saved intent

`public/check-claim-client.js` separates protocol/storage behavior from
`public/check-claim-page.js`. Each origin, proxy prefix and link has one random
private guest key in IndexedDB. A deterministic public claimant ID identifies
that guest independently of their display name. Another guest named Alex is
never merged with the current browser, and changing the name updates the same
identity. Legacy declarations remain independent.

The page saves raw name/item choices, the reviewed public snapshot, exact pending
request bytes and acknowledgement metadata. IndexedDB read/write transactions
and comparison with the loaded record prevent an older tab from replacing newer
work. A stale tab must reopen the saved selection; its unsaved input can first be
exported. Corrupt stored identities are retained rather than silently regenerated.
Clearing browser site data or using another browser creates a different identity;
recovery exports deliberately cannot transfer authentication credentials.

## Review and retry

New submissions require a protected, open check. The client refreshes before
preparing the immutable request. Changed check values, currency or guest
declarations require an explicit previous/current comparison. Removed selected
items remain visible and must be unchecked. Unrelated household revision changes
can advance without falsely reporting a check conflict.

The original request is committed to local storage before transmission. A lost
response locks editing and offers exact retry, including after closing the
browser. Known definite rejections retain the draft for review. Unknown failures
never generate a new mutation ID or discard the saved selection. Submitting also
checks the authoritative stored request so an old tab cannot retry an intent
that another tab has rejected and discarded.

Validated receipts cannot roll cached revisions backwards, revive revoked access
or consume a different draft. After revocation, the server can acknowledge an
earlier commit without returning current check data. The page shows the confirmed
selection even when the cached public snapshot predates that acknowledgement,
and labels the check as the last available copy. Empty selections support joining
without items and withdrawing previously selected items.

## Browser behavior and boundaries

- Requests stay on the page's origin and validated proxy prefix, omit cookies,
  reject redirects, time out and bound both success/error bodies. Owner credentials
  are not used. SHA-256 also works on LAN HTTP without SubtleCrypto; identity
  creation still requires `crypto.getRandomValues`.
- Recovery downloads include the public snapshot, saved/unsaved choices and exact
  pending intent, but exclude the link token and private guest key.
- Storage failures preserve visible raw input, disable sending and expose recovery
  export. Leaving unsaved work triggers the browser's unload warning.
- Native labeled checkboxes and name input support keyboard navigation. The fixed
  action stays visible on tested narrow and enlarged-text layouts. Calendar-only
  dates do not shift to the previous day in negative UTC offsets.
- Both normal and trailing-slash links load correctly through a proxy prefix.
  Script loading remains compatible with the server's existing CSP hashes.

The page does not enable strict server protection itself. Compatibility-mode
servers remain readable, but new selections require protection. Browser owner
link management/host split review and Swift sharing migration are separate
remaining work before the mixed-client enforcement rollout. Hosted Google/Supabase
ownership is also outside this self-hosted browser checkpoint.

See [verification and limits](evidence/browser-check-claims/verification.md).

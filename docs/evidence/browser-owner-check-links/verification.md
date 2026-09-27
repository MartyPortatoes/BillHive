# Browser owner-link journal verification — 2026-09-27

Web parent: `66e4f06`. Android parent: `a22a140`; Apple: `25d3ed2`.
The new owner data module is not loaded by `index.html` yet. These checks prove
its protocol/storage behavior, not completion of the owner UI or the full Android
goal. No production configuration, push, deployment or store action occurred.

## Final evidence

- **107 Node tests pass**, zero failures/skips: the existing 90 plus 17 owner
  journal/transport tests. [Output](node-tests.txt).
- **21 Chrome browser checks pass**, consisting of 17 existing guest-page flows
  and four owner-module checks. [Output](browser-tests.txt),
  [structured results](results.json).
- The owner module was loaded from the real server into an isolated browser,
  used its production IndexedDB adapter and sent real HTTP to the strict fixture.
  The test supplies synthetic trusted-proxy identity headers; it does not connect
  to a user's live proxy, cookie session or Google account.
- A guest update rejected an owner command prepared against an older sharing
  revision. After explicit dismissal/review, a lost response left the next exact
  action durable. The owned Chrome process group was killed and restarted with
  the same profile. Replaying after another owner rotation acknowledged the old
  command while retaining the newer active link.
- A simulated proxy-account switch could not apply the saved request to either
  the wrong household or the original one. The action remained pending, then
  resolved in the original account. A corrupt pending record was retained and
  listed as unavailable rather than silently replaced.
- Cleanup awaited owned Chrome/server exits, closed the proxy and removed the
  disposable profile, SQLite database and downloads.

The Node tests also cover account/server/household/path partitions, no-op receipts,
completed/removed checks, stale tabs, local storage failure before transmission
and after server commit, malformed receipts, revision rollback, late policy/URL
responses, revocation, sanitized exports, URL binding, bounded bodies and owner
authentication headers. Same-name and legacy declarations remain independent.

## Findings and verification boundaries

The first URL validation test caught URL-parser normalization of encoded dot
segments. Validation now checks raw routing syntax as well as the parsed address.
The first owner browser POST was correctly rejected by the server's existing
origin protection: the disposable proxy had rewritten Host to its backend port.
The fixture now preserves the incoming Host, as a correctly configured reverse
proxy would. Production origin/authentication checks were not weakened.

All screenshots in this folder are the rerun **guest page** matrix, not owner
controls. They were retained to accompany the guest regression path; this
checkpoint makes no new owner visual/accessibility acceptance claim. The same
phone/tablet, light/dark, doubled-text and synthetic-data limits documented in the
[guest verification](../browser-check-claims/verification.md) apply.

The owner UI, owner authentication/session experience, long-lived browser storage,
physical browsers, Safari/Firefox and large owner records remain unverified.
Host claimant mapping/application, guarded deletion from the browser and Swift
sharing migration remain required before mixed-client enforcement rollout.

## Reproduction

With the supported Node 24 runtime and a local Chrome binary:

```sh
node --test
CLAIM_EVIDENCE_DIR=docs/evidence/browser-owner-check-links node tools/verify-browser-check-claims.mjs
git diff --check
```

`CHROME_PATH` overrides the default macOS Chrome path. Every fixture and browser
profile is disposable. Production app data and the user's existing browser are
not opened or cleared.

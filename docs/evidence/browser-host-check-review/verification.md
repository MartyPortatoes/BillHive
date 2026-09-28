# Browser host review foundation — 2026-09-27

Web parent: `4661554`; Android parent: `1757a97`; Apple: `25d3ed2`.
The preceding Web checkpoint integrates actual owner link controls. This new
checkpoint supplies the financial review engine and durable save journal. The
host review screen is not integrated, and existing Pull Claims remains legacy.

## Evidence

- **149 Node tests pass**, zero failures/skips: [output](node-tests.log).
  Twenty engine cases and thirteen journal/transport cases were added.
- **241 Android domain tests pass**, zero failures/skips:
  [build output](android-domain.log), [suite summary](android-domain-summary.json).
  The new JVM case exercises nine shared fixtures; native app source is unchanged.
- Identical JSON fixtures in the Web and Android test resources verify native/
  browser source IDs, explicit assignments, stable penny recipients, payment
  resets, same-name and legacy identities, credits and USD/JPY/KWD/CLF precision.
  Hashes and the focused JVM XML are retained alongside this report.
- **Six real Chrome checks pass** against strict Express/SQLite with actual
  IndexedDB: [output](browser-tests.log), [results](browser-results.json).
  A newer guest selection rejects a prepared financial save without changing
  household data. Explicit same-name mappings apply once and preserve unknown
  fields. Public snapshots omit private provenance and financial assignment IDs.
- An actual browser process kill/restart retains the exact pending request;
  replay after another owner edit keeps the newer confirmed snapshot and does
  not duplicate participants. Unsubmitted raw choices also survive replacement.
  Proxy account switching cannot send/discard an original-account request, and
  corrupt records remain intact. The recovery export excludes bearer tokens and
  unrelated private fields. The retained sample uses disposable synthetic data.
- Cleanup awaited owned browser/server exits, closed the proxy and removed all
  disposable profiles, databases and downloads. No live account was contacted.

## Findings and boundaries

Both engines rejected the initial hand-calculated credit fixture expectation.
For a 900-unit negative adjustment split 750:450, the tied extra deducted penny
goes to the first sorted participant: the final totals are 187 and 113. Applying
an overlapping guest contribution changes neither balance, so payment flags are
retained. The fixture was corrected; the initial JVM failure is retained under
`initial/`. Another test assertion was corrected to catch synchronous preflight
errors through the asynchronous assertion helper; production validation did not
need weakening.

Code review also aligned the native allocation-weight bound, rejected unknown
provenance/plan fields and added backwards/contradictory-revision checks. Response
receipt metadata is excluded from baseline comparisons so a successfully saved
household is compared by its actual revision and document.

These are calculation/storage/protocol checks, not host-screen acceptance. No
new owner UI screenshots, accessibility or phone-layout claim is made. The runner
injects the served modules into the real owner page under its CSP and calls their
APIs. It does not click a host review screen. Broad currency parity, large records,
physical browsers, live authentication and mixed-client deployment remain open.
No Android APK, emulator or Swift suite was rerun because native app sources were
unchanged; only the new shared-fixture JVM test was added. Nothing was pushed,
deployed or submitted. The full Android v1 goal remains active.

## Reproduction

```sh
node --test
node tools/verify-browser-host-review.mjs
```

Use Node 24 and Chrome. `HOST_REVIEW_EVIDENCE_DIR` and `CHROME_PATH` override the
default output directory and executable. In Android_App run
`tools/gradle-local.sh :core:domain:test` using JDK 21. Both repositories must
retain the identical `check-claim-review-parity.json` fixture when it changes.

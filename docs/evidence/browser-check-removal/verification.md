# Browser check deletion — 2026-09-27

Web parent: `cb30d21`; Android: `4e2f724`; Apple: `25d3ed2`.
The actual Delete control now opens a durable reviewed deletion instead of
immediately removing a check from an ordinary household snapshot.

## Final evidence

- **181 Node tests pass**, zero failures/skips: [output](node-tests.log).
  Seventeen new deletion/journal/session cases and two sharing-cache cases cover
  exact wire comparison, independent newer data, completed/uncalculable checks,
  confirmation, one shared financial queue, storage failure, stale tabs, unknown
  responses, restored checks, retained drafts and cleanup across later receipts.
- **18 actual Chrome deletion scenarios pass**:
  [output](browser-tests.log), [results](results.json).
  Real IndexedDB and strict local HTTP are used. Tests click the actual Delete,
  confirmation, comparison, recovery and retry controls. Keyboard Space retains
  checkbox focus and ordered persistence.
- Saved confirmation survives a real browser process kill/restart. Existing
  reviews reopen offline inside an authenticated page. Changed check data and
  guest declarations require new review. A guest write after preparation rejects
  the financial request before it can delete the check.
- Lost-response retry survives a second process replacement and uses the exact
  original request. Unrelated ordinary edits and unfinished split drafts remain
  intact. Public snapshots return **410 Gone** after permanent link revocation.
  Restoring the same ID creates a different link; replay of the older deletion
  retains the restored check and that newer link.
- A sharing-storage failure injected after financial confirmation leaves a
  durable cleanup marker. The marker remains visible and completes on reload.
  Separate unit tests retain pending, corrupt and newer sharing rows and prove
  that cleanup markers survive replacement of the latest financial receipt.
- Regression groups pass: **18 host split UI scenarios**
  ([output](split-regression.log)), **13 owner-link UI scenarios**
  ([output](owner-regression.log)), **21 guest/owner-module scenarios**
  ([output](guest-regression.log)), and **six host-journal scenarios**
  ([output](journal-regression.log)). Counts describe scenario executions, not
  unique requirements or overall release readiness.
- Final phone review/comparison/pending, tablet/light and 390×480 doubled-text
  screenshots were inspected. The primary action remains visible; the comparison
  body does not overflow horizontally. Its action geometry is recorded in
  [comparison-layout.json](comparison-layout.json). Screenshots wait for fonts,
  frame layout and running animations before capture.
- Every runner awaited owned browser/server exits, closed its proxy and removed
  disposable profiles, databases and downloads. Synthetic authentication and
  isolated fixtures were used; no live credentials or service configuration changed.

## Findings and limitations

An initial unit fixture represented a removed check with an active link, which
production snapshot validation correctly rejected. The fixture now models the
server's automatic revocation. The first browser revocation assertion expected
404; the actual protocol correctly returns 410 Gone. The split UI regression
also needed to await the new asynchronous saved-action routing before inspecting
the opened session. Initial browser diagnostics are retained separately under
`initial-diagnostics/`; none is a current unresolved failure.

Financial acknowledgement and the cleanup marker commit atomically in the
financial database. Removing obsolete link cache and acknowledging that marker
use separate database transactions with safe repetition. This is not a claim of
one atomic transaction spanning both IndexedDB databases.

Browser evidence uses desktop Chrome mobile emulation and injected doubled
computed text sizes. It does not qualify real phone keyboards, OS scaling,
screen readers, broad contrast/accessibility, other browsers or deployed
mixed-client behavior. Offline cold-start hosting is not tested. Native Android
and Swift sources were unchanged, so their builds and device suites were not
rerun for this browser-only checkpoint.

Swift sharing compatibility, hosted Google/Supabase ownership, remaining Android
features, purchases/free limits, background sync/recovery, privacy/reminders,
ten languages, physical-device acceptance and Play delivery remain open. No
push, deployment, enforcement change or store submission occurred.

## Reproduction

With Node 24 and local Chrome:

```sh
node --test
node tools/verify-browser-check-removal.mjs
node tools/verify-browser-host-review-ui.mjs
node tools/verify-browser-owner-ui.mjs
node tools/verify-browser-check-claims.mjs
node tools/verify-browser-host-review.mjs
```

The deletion runner accepts `CHECK_REMOVAL_EVIDENCE_DIR` and `CHROME_PATH`.
The regression runners retain their documented evidence-directory overrides.
Source hashes identify the exact implementation and runners used here.

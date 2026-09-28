# Browser host review UI — 2026-09-27

Web parent: `1bc4a14`; Android: `2a391ff`; Apple: `25d3ed2`.
This checkpoint connects the protected review engine and journal to the actual
owner page. It replaces name-based Pull Claims with explicit guest mapping,
manual-item review, before/proposed totals and confirmed payment-status resets.

## Final verification

- **162 Node tests pass**, zero failures/skips: [output](node-tests.log).
  Eleven session cases cover ordered raw edits, failed storage, changed reviews,
  unknown outcomes, ordinary-save/link coordination and account replacement.
  The exact formatter also covers very large four-decimal values without Number
  conversion. A new HTTP test verifies receipt replay after a protection-policy
  change while rejecting new protected writes, changed payloads and wrong owners.
- **18 actual host-review Chrome scenarios pass**:
  [output](browser-tests.log), [results](results.json).
  Real controls and IndexedDB cover same-name guests, rapid manual changes,
  payment confirmation during delayed calculation, raw recovery after process
  loss, failed storage, two tabs, keyboard Tab/Enter/Space, changed selections,
  lost-response exact retry, retained ordinary edits, withdrawal, offline reopen,
  completed/removed checks, account replacement and corrupt storage.
- The ordinary Checks page displays the same exact penny allocations as the
  reviewed split. It no longer independently divides participant shares using
  floating-point arithmetic.
- Existing regressions pass: **13 owner-control scenarios**
  ([output](owner-regression.log)), **21 guest/owner-module scenarios**
  ([output](guest-regression.log)), and **six host-journal scenarios**
  ([output](journal-regression.log)). These are separate scenario groups, not
  unique feature counts or an estimate of release readiness.
- Phone guest/item/totals/comparison/pending screenshots are retained. The final
  short-phone image uses a 390×480 viewport and every rendered descendant's
  computed font size doubled; the primary action remains visible. Tablet/light
  and normal phone/dark images were also inspected.
- All runners awaited their owned browser/server processes, closed proxy servers
  and removed disposable profiles, data and downloads. They used synthetic
  authentication and isolated local Express/SQLite fixtures.

## Findings and limits

The offline navigation fixture initially switched networking while the close
action's ordinary page reload was still active. It now waits for that reload
before testing saved-review reopening offline. The existing owner runner also
sampled click coordinates during smooth scrolling; its scrolling now completes
instantly before sending the actual pointer click. Those initial failures are
retained in `initial-diagnostics/`, separately from the final passing evidence.

Final review found that the owner commit route checked protection before looking
up an exact persisted receipt. A previously committed request could then be
misreported as rejected after protection was disabled. Policy validation now
follows receipt/hash/household validation inside the transaction. New protected
writes remain blocked; no enforcement configuration was changed.

These are desktop Chrome tests with mobile viewport emulation and injected text
sizes, not real phone keyboards, OS font scaling, TalkBack, physical-device or
other-browser acceptance. Broad contrast/accessibility, performance/large-record
and deployed mixed-client qualification remain open. Offline reopening is tested
inside an already authenticated loaded page, not a fully offline cold start.

Reviewed browser deletion and Swift sharing migration remain next. No Android
app or Swift source changed in this checkpoint, so native APK/emulator/Swift
suites were not rerun. The prior 241-test Android domain result remains recorded
in the engine checkpoint. Nothing was pushed, deployed or submitted; hosted
identity, purchases and the rest of full Android v1 remain open.

## Reproduction

Use Node 24 and local Chrome:

```sh
node --test
node tools/verify-browser-host-review-ui.mjs
node tools/verify-browser-owner-ui.mjs
node tools/verify-browser-check-claims.mjs
node tools/verify-browser-host-review.mjs
```

The runners accept `HOST_REVIEW_UI_EVIDENCE_DIR`, `OWNER_UI_EVIDENCE_DIR`,
`CLAIM_EVIDENCE_DIR` and `HOST_REVIEW_EVIDENCE_DIR` respectively, plus `CHROME_PATH`.
Recorded source hashes identify the implementation used for these results.

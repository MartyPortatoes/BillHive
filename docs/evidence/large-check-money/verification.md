# Large Check amounts — 2026-09-28

The browser allocator now distinguishes relative minor-unit weights from bounded
major-unit monetary inputs. Valid large receipts retain their exact totals; input
and aggregate limits remain. Four new shared fixtures cover maximum USD, the last
minor unit of a large CLF total, and positive/negative adjustment ties. All thirteen
fixtures are byte-identical across Android, Swift and this repository.

`node --test test/browser-check-review.test.js` first reproduced four failures
against the old allocator (`before-fix.log`). After the fix, the complete Node 24
suite passes **187 tests**, zero failures/skips (`node-tests.log`).

`HOST_REVIEW_UI_EVIDENCE_DIR=docs/evidence/large-check-money/browser node
tools/verify-browser-host-review-ui.mjs` passes **23 Chrome scenarios**, with no
runtime errors. These include the existing owner-review/recovery regression flows
and exact ordinary receipt/participant rendering. The new large CLF case checks
the visible Checks page, exact text and amount bounds within their containers;
the header screenshot was inspected. Currency render cases inject synthetic
in-memory state, so they do not prove raw form entry, persistence or export.

An initial screenshot stayed on the Bills tab despite checking the rendered
Checks DOM. The harness now navigates to Checks and asserts visible, bounded
amount elements. The final `browser.log`, `browser/results.json` and screenshots
are the accepted evidence. The harness's owned Chrome, server and proxy exited
and its disposable profile/database were removed.

This uses desktop Chrome mobile emulation and a synthetic authenticated local
proxy. Other browsers, physical devices, provider/email precision, raw input
precision, exports and deployed mixed-client acceptance remain unqualified.
No production service or browser profile was changed.

# Browser owner check controls — 2026-09-27

Web parent: `54fda39`; Android: `1757a97`; Apple: `25d3ed2`.
This checkpoint integrates protected link controls and recovery into the actual
owner page. Host claim application and reviewed deletion are still incomplete.

## Recorded evidence

- 116 Node tests pass, zero failures/skips: [output](node-tests.log). Nine new
  session cases cover confirmation, account changes, freshness, retained requests,
  storage failures and household-save ordering.
- 13 owner UI scenarios pass: [results](results.json). They exercise actual
  buttons, IndexedDB and strict local HTTP, guest edits during confirmation,
  definite rejection, canceled clearing, lost replies, recovery export, process
  kill/restart, replay after another rotation, removed/completed checks, corrupt
  records and switching accounts with an explicit reload.
- 21 guest/owner-module browser regressions pass: [output](guest-regression.log),
  [results](guest-regression/results.json). Cleanup reports owned process exits,
  closed proxies and removed disposable profiles/databases/downloads.
- The owner screenshots at 390×844 show current links, saved actions and doubled
  rendered sharing text. Sharing content fits horizontally and controls wrap.
  This is desktop Chrome mobile emulation, not physical-device or OS text scaling.

The runner blocks remote fonts/Chart.js; trend charts are outside its scope.
Synthetic trusted-proxy identities substitute for a live authenticated account.
No production services or existing user browser profile are opened or changed.
The Android/Swift sources did not change, so their builds were not rerun.

## Findings and limits

Testing found and fixed a confirmation cancellation that left the operation busy,
a busy-state rendering race, unreadable-record errors exposing raw parse messages,
and an account-change path that hid the app without a visible recovery control.
The final test run also corrected a syntax error in the test-only fixture restore;
its earlier diagnostic is retained as `initial-fixture-failure.txt`.

Browser host review, guarded deletion, Swift sharing migration and deployed
mixed-client acceptance remain required. Full owner-page keyboard/focus, TalkBack/
screen-reader, Safari/Firefox, tablet and physical-browser acceptance are not
claimed by these targeted checks. Existing narrow-phone navigation crowding is
outside the sharing control's layout checks and remains part of broader UI QA.

## Reproduction

```sh
node --test
node tools/verify-browser-owner-ui.mjs
CLAIM_EVIDENCE_DIR=docs/evidence/browser-owner-check-ui/guest-regression node tools/verify-browser-check-claims.mjs
git diff --check
```

Use Node 24. `CHROME_PATH` selects Chrome, and `OWNER_UI_EVIDENCE_DIR` selects
owner evidence output. Every fixture is disposable. No push, deployment, Google
configuration or store action occurred.

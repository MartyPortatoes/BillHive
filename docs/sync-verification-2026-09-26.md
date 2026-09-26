# Revision protocol checkpoint — 2026-09-26

Local checkpoint based on `380699e`. This is an additive server/web protocol
implementation for Android; no production server was deployed or configured.
Swift/SwiftUI remains the Apple implementation and has no source changes at
this checkpoint.

## Automated evidence

Executed with Node 24, matching the installed `better-sqlite3` native module:

```sh
npx --yes --package=node@24 --call 'npm test'
git diff --check
```

All 28 tests passed, with zero failures, errors, cancellations or skips. The
original security/validation tests remain included. New cases cover atomic
state/month commits, deletion validation, two concurrent HTTP writers, persisted
receipts/reopen, ID reuse, authenticated household isolation, stale writes,
strict legacy route coverage, guest-owner revision conflicts, corrupt state,
overflow rollback, web retry ordering and replay after an intervening edit.
Default-mode compatibility and Android's strict-protection header were also
tested. See `test/sync.test.js` and `test/security.test.js` for the actual scope.

The Android API 37 emulator used an isolated strict server on localhost:18322,
restarted after the latest server edits. Native HTTP tests committed a change,
replayed it and rejected a stale write. Room journal tests simulated a committed
request whose response was lost, reopened storage, then replayed after another
device changed the household. A separate prepare/force-stop/recover test verified
replay from a different Android process. Android owns those source tests and
their recorded XML/log evidence.

## Browser verification

The Android repository's `tools/selfhive-fixtures.mjs` successfully started two
fresh local test servers on ports 18323/18324, with separate temporary databases,
compatibility/strict flags and a synthetic September rent fixture. They were
stopped and their temporary data removed after inspection.

In the strict fixture's actual browser UI:

1. Opened the rent editor at 1600 and kept its amount input focused.
2. An independent API client renamed the bill to “Other device rent”.
3. Entered 1700 in the still-open browser editor.
4. Observed “Not saved”, Retry save, Download unsaved copy, and the explanation
   that another device changed the household. The 1700 draft stayed in the UI.
5. Read the server snapshot: the independent name change and original 1600
   amount remained; the stale browser edit did not overwrite them.
6. Inspected the rendered 1280×720 conflict layout: the banner occupies its own
   header row, leaving branding, actions and navigation unobscured.
7. Clicked Download unsaved copy and observed its completion toast. The downloaded
   file's contents were not separately inspected in this browser check.

## Limits and next gates

See [the protocol and rollout contract](sync-protocol.md). This is not complete
server-wide mutation coverage. Attachment bytes, separate share/claim/invite
records and configuration have separate unfinished concurrency contracts.
Android subsequently wired its basic native editors, check completion, trip
settlement/archive, pending retry and conflict comparison to the journal. The
Android repository records its UI/server assertions and recovery evidence in
`docs/evidence/2026-09-26/server-editing/verification.md`. This does not change
the server's coverage boundary or default-off protection flag.

Swift owner compatibility was subsequently implemented in companion iOS commit
`2094893`: atomic load/save/import/reset, durable retry bytes, preserved unknown
wire fields, stale rejection, recovery export and explicit reload. Its separate
audit is `iOS_App/docs/audits/2026-09-26-selfhive-owner-sync.md`; the Node suite
above is not evidence for that Swift behavior. The Apple app changes are local
and have not been released. Guest compatibility, broader mutation coverage and
Android release QA must be completed before strict production rollout.
Docker/Alpine, live reverse proxies,
physical devices and production backups/restores have not been certified.

## Subsequent guest protocol checkpoint

The [guest protocol](guest-sync-protocol.md) adds invitation-scoped snapshots,
commands and persisted receipts. The complete Node suite now passes 34 tests,
including six new guest cases. Android's companion JVM/HTTP integration test
uses the actual isolated server to join/save/replay/reject stale writes and
acknowledge a request after revocation. Its evidence is in
`Android_App/docs/evidence/2026-09-26/guest-protocol/verification.md`.

This does not complete guest client UI/durable storage, Swift/browser guest
integration or [remaining mutation contracts](mutation-coverage.md). The default
strict flag and production/release boundaries are unchanged.

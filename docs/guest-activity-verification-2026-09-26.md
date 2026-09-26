# Protected guest activity — 2026-09-26

This extends `38e53b1`. Protected guest expense additions, edits, deletions and
new settlements now add a compatible Apple-format entry to the owner's trip
activity. Settlement detail retains payer/payee names and currency amount.
Attribution comes from the invitation's member, not a request-supplied actor.

The entry, trip change, revision and receipt commit atomically. Receipt replay
returns before applying the operation. The event ID is a SHA-256 digest of the
invitation/request pair, without storing the token in the activity entry. A new
event retains itself and the newest 99 previous records, preserving unknown
metadata. This retains the committed event even if imported timestamps lie in
the future. Timestamps use UTC whole seconds for the existing Swift formatter.

An unchanged expense upsert, missing-expense deletion or identical existing
settlement adds no entry. Rejected/stale/forged operations add none. The public
trip projection still excludes activity; guest snapshots and receipts do not
reveal private owner history. Owner history is a display feature, not a
tamper-evident audit system.

`npx --yes --package=node@24 --call 'npm test'` passed all **35 tests**. The HTTP
and direct-store cases verify attribution, amounts and settlement names,
whole-second timestamps, private projection, retention with future timestamps,
opaque metadata, no-op saves, replay, forged actor rejection and transactional
rollback when receipt insertion fails. The sanitized output is
`guest-activity-test-results-2026-09-26.txt`.

Android's real isolated Node fixture test verifies guest creation, owner-visible
history, absence of guest-visible history, replay following another owner save,
stale rejection and revoked receipt recovery. Android records its own results in
`Android_App/docs/evidence/2026-09-26/trip-activity/verification.md`.

No browser UI, Apple source or production server was changed or deployed here.
Legacy guest HTTP routes do not gain activity recording. Remaining writer and
attachment/configuration coverage in `mutation-coverage.md`, production rollout,
Docker/Alpine and real-device verification remain open.

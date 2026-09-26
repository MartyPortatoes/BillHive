# Protected portable backup restore, version 1

`GET /api/health` advertises `backupRestoreProtocol: 1`. This is an owner-only
extension for the native Android backup flow; it does not add a browser import
screen or change Apple's Swift implementation. These changes are local and have
not been deployed. Revision protection must be enabled for restore preflight and
file staging, even while ordinary compatibility-mode clients can still read.

## Review and preflight

The client reads a fresh protected snapshot, retains a private before-copy,
reviews the replacement and creates an immutable `api/sync/commit` request. It
includes all replacement state/months and explicit deletion arrays for removed
keys/months. Existing authentication and the pinned server, household and user
identity apply throughout.

`POST /api/sync/restore/validate` accepts that exact commit body and
`X-BillHive-User`. In one SQLite transaction it checks the identity, revision,
validity of the current and proposed records, and complete deletion coverage.
It checks prospective managed attachment references, immutable reservations and
available managed quota. No household records, files or commit receipts are
published. The response contains `protocolVersion: 1`, the pinned identity,
`baseRevision`, `mutationId` and a `missing` array. Each entry has `kind`,
`tripId`, `recordId` and the exact managed descriptor fields. Clients verify
every requested file belongs to their frozen proposed document.

An unversioned legacy reference makes no claim that bytes are available. Managed
version 1 references in a records-only backup can reuse already retained server
blobs, including files whose references were previously removed. Missing managed
files require a verified local copy; the client must fail before persisting a
pending request when it cannot provide one. Preflight is advisory: another write
or upload can change the revision or available quota after it returns.

The two owner commit/preflight routes accept at most 10 MiB of JSON, allowing the
portable format's 8 MiB of metadata plus the commit envelope. Other JSON routes
retain their previous 2 MiB limit. File bytes never enter this JSON envelope.

## Stage files and commit

`PUT /api/sync/restore/attachments/:kind/:tripId/:recordId/:filename` accepts
the same binary body and identity/attachment headers as the ordinary managed
attachment route, plus `X-BillHive-Revision` containing the reviewed revision.
The authenticated owner can stage bytes for absent or archived parents. It is
not a guest route and does not create or unarchive any records.

Content, digest, MIME, JPEG signature, size, immutable identity and the 256 MiB
managed quota use the existing attachment checks. New uploads additionally check
the revision in the same transaction as the insert. A valid exact blob replay
can still succeed after the revision advances. Ordinary uploads continue to
require an existing, active parent. Newly staged files remain inaccessible until
a valid current reference is committed.

After staging, the client sends the original `POST /api/sync/commit` request.
Its existing transaction checks every managed reference and commits all records,
history, deletions and mutation receipt together. Missing files or stale revisions
roll the whole replacement back. Partial file uploads may remain as private
unreferenced blobs; they do not change household records.

## Recovery

Retry the original metadata commit first. Its receipt lookup precedes the
revision check, so an acknowledged restore can be recovered without local bytes
and without overwriting later edits. An upload's `REVISION_CONFLICT` is only a
staging rejection: it does **not** prove an earlier metadata request failed.
The client must resolve that case by retrying the original commit before
unlocking its retained draft. Network, identity, quota and unknown errors keep
the exact request pending.

Managed bytes have no automatic purge; retained or abandoned uploads count
toward quota. Quota recovery/retention, old disk-file migration, browser/Swift
restore UX, operational disaster recovery and deployment remain open. The
preflight cannot reserve quota against another later upload.

## Verification

`test/attachments.test.js` now tests new/archived parent restore, atomic
replacement and rollback, exact replay after later writes, missing/duplicate/
invalid descriptors, explicit removed keys/months, pinned identity, stale
staging, immutable collisions, records-only references, protection mode and
retained quota. A 3 MiB metadata request exercises the expanded route limit.
The quota test uses an explicitly synthetic accounting row rather than claiming
to stream 256 MiB of actual bytes. The full 48-test Node 24 suite passes; see
`restore-protocol-test-results-2026-09-26.txt`.

Companion Android tests use actual HTTP plus Room reopen and force-stop phases
to verify lost-acknowledgement recovery in both flavors. They do not establish
real-device, Docker/Alpine, proxy or deployed-server readiness.

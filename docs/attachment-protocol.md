# Immutable trip attachment protocol, version 1

The Android plan requires recoverable file uploads alongside revision-checked
household saves. New managed files use `attachmentProtocol: 1`, advertised in
`/api/health`. Existing Apple descriptor fields and legacy files remain supported.
This protocol is implemented locally; it has not been deployed.

## Stage and publish

`PUT /api/sync/attachments/:kind/:tripId/:recordId/:filename` accepts raw
`application/octet-stream` bytes. `kind` is `expenses` or `itinerary`. An owner
must provide `X-BillHive-User`, `X-BillHive-Server`, `X-BillHive-Household`,
`X-Attachment-Id`, `X-Attachment-Type` and `X-Attachment-SHA256`. Authentication
still comes from the normal owner middleware; identity headers only pin the
expected authenticated household. Server revision protection must be enabled.

The initial upload requires an existing, active trip and the named expense/event.
Receipt files must have a `.jpg` filename, `image/jpeg` MIME and JPEG signature,
and are limited to 2 MiB. Itinerary files are limited to 10 MiB. The server checks
the complete digest; a signature check is not full image decoding or malware
analysis. Safe IDs/filenames, MIME syntax and a 256 MiB per-owner managed-byte
quota are enforced. Legacy disk files are outside that managed quota.

The `trip_attachment_blobs` SQLite table stores bytes and their immutable manifest
in one transaction, separate from household JSON. A filename and attachment ID
are reserved within owner/kind/trip/record. An exact repeated upload returns the
same identity with `replayed: true`, including after a later parent removal. A
different payload, MIME or attachment ID cannot overwrite the reservation.
Uploads do not advance the household revision or add a visible attachment.

The response contains the pinned identity, location, `replayed` and descriptor
fields: `id`, `filename`, `mimeType`, `storageVersion: 1`, `sha256`, `sizeBytes`.
Clients retain Apple's `createdAtISO` and `displayName` fields in their descriptor.
They then publish that descriptor using the existing atomic household commit.
Managed references are checked inside the owner, legacy and protected guest JSON
write transactions. Missing, altered or duplicate managed references roll back
the complete write and do not create a commit receipt. Opaque unmanaged legacy
descriptors survive unrelated saves.

## Read and remove

`GET` at the same managed URL requires the pinned identity headers and current
owner authorization. The current trip/parent must still contain the registered
reference. A staged or removed file is not downloadable. The response uses an
attachment disposition, sandbox CSP, `application/octet-stream`, digest ETag and
`X-Attachment-SHA256`. Stored length and digest are checked again before serving.

Apple's existing expense and itinerary GET paths also resolve a managed file
through its current parent/reference. Descriptors retaining only the known Apple
fields remain readable if their ID, filename and MIME match the registered file.
Legacy POST/DELETE cannot overwrite or physically delete a registered managed
file, even after its metadata has been removed. Unmanaged legacy endpoints retain
their previous behavior and weaker lifecycle guarantees.

Remove a visible attachment by removing its descriptor in a revision-checked
household commit. A stale commit is rejected normally, and the file becomes
inaccessible after confirmed removal. The bytes and identity reservation are
retained. Garbage collection, staged-upload expiry, reclaimed quota and an
explicit physical purge policy remain required work; no automatic deletion may
invalidate a pending reference save. This checkpoint does not claim complete
attachment lifecycle coverage.

## Recovery and operations

An upload failure leaves metadata unchanged; the client retains its local file
and exact descriptor for retry. The client must freeze its metadata mutation
before transmission, upload matching bytes, then send the exact household
request. Existing owner receipts handle a lost metadata acknowledgement. A file
receipt is not proof that the household reference was committed.

Managed content and reservations are included in a consistent SQLite backup.
Use an online SQLite backup or a stopped-server copy that includes consistent
WAL state; copying a live main database file alone is insufficient. Existing
`trip-receipts/` and `trip-itinerary-attachments/` trees still need filesystem
backup. JSON `/api/export` does not contain any attachment bytes. Portable backup
restore, staged restore into an empty household, retention/purge and disaster
recovery exercises remain open. `Dockerfile` now includes `attachment-store.js`;
the Docker/Alpine image has not been runtime-tested for this checkpoint.

`test/attachments.test.js` exercises real HTTP staging/publication/replay,
identity and parent isolation, immutable content, transaction rollback, legacy
download protection, removed references, upload bounds, opaque legacy records
and database reopen. The full server suite passes 42 tests; the output is in
`attachment-protocol-test-results-2026-09-26.txt`. No public guest attachment API
or native Apple runtime certification is implied. Android native controls,
durable editor integration, legacy migration and all-client rollout remain open.

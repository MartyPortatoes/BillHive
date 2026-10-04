# Optional Android Play merchant

`POST /api/play/verify` is disabled by default and returns a sanitized 503. It is
independent of household credentials and is intended only for the official
merchant pinned into an Android release. A person's SelfHive installation cannot
grant access to a client trusting a different signing key.

Activation requires `PLAY_VERIFY_ENABLED=1`, `PLAY_PUBLISHER_ACCOUNT_JSON` and
`PLAY_RECEIPT_SIGNING_KEY` in the host's secret environment. Both private keys
must be RSA with at least 2048 bits. The service account must have the authorized
Google Play Publisher permissions; this local implementation has not verified an
actual account, deployment or catalog. Never put private credentials in Android
build properties or source control. Android receives only the merchant HTTPS
origin and Base64 X.509 DER receipt public key.

The fixed catalog accepts `com.billhive.app` / `com.billhive.app.unlock` and
`com.billhive.selfhive` / `com.billhive.selfhive.unlock`. Debug package suffixes
are excluded. Requests bind installation and nonce to the package, product and
purchase token. Google OAuth and Publisher destinations are fixed; redirects and
unbounded responses are refused. Completed purchases are acknowledged and read
back before ACTIVE access is signed. Pending and canceled purchases receive
non-active states; network/API failures cannot become revocation or success.

Receipts use RSA/SHA-256 and a 24-hour maximum lease. The optional
`play_purchase_audit` table stores token digests, product and checked state only;
raw tokens, installation/nonce and private credentials are not persisted there.
The Docker image includes the module even when the optional service is disabled.

The focused suite uses generated memory-only keys, fake Google responses and an
owned local disabled-route server. The full Node suite also stages the actual
Docker COPY set. No real purchase, store acknowledgement, Publisher API or
merchant HTTPS transport is qualified by those tests. Real-time developer
notifications and unattended acknowledgement/revocation recovery are still open,
as are refund, license-account, cross-device and physical-device acceptance.

Local qualification on 2026-10-04: all **245 Node tests pass**, including 12
focused merchant cases. The full suite uses Node 24.19.0; all 49 selected runtime
and test files match before/after the terminal-success run. The first staged
Docker test exposed the missing module COPY; the corrected Docker tree passes.
Android keeps the source hashes and raw logs in its `play-access` evidence
checkpoint. This is local code qualification; the service remains disabled.

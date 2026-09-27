# Reviewed-check save guards — 2026-09-27

Node 24 `node --test` passed all 73 cases with no failures or skips. The exact
output is retained in `tests.log`. This extends the previous 68-case protocol
checkpoint with five HTTP/database cases; existing URL/capability assertions were
also extended.

The new cases prove that a changed guest claim rejects a reviewed financial save
even when the household revision is unchanged; simultaneous host/guest requests
cannot both commit against their old snapshots; and exact retries still
acknowledge committed requests after later claims and link rotation. They also
cover malformed/duplicate guards, share identity and absence, another SQLite
connection, receipt failure rolling back household changes and share revocation,
unchanged unguarded receipt behavior, unsupported guard storage and disabled
revision protection.

Owner HTTP snapshots and owner receipt snapshots return the configured public
URL with a path prefix. Replay uses the current active token in that URL while
retaining the historical `resultToken`. Revocation returns a null URL; public
guest projections never receive the owner URL field.

Tests use isolated temporary SQLite databases and local Node child servers, with
synthetic authenticated owners/guest identities. Their cleanup hooks close the
servers/databases and remove the temporary directories. Production enforcement,
rate limits and external services were unchanged; nothing was deployed.

This is the transaction primitive for host-reviewed assignments. Native owner
link controls, durable owner sharing journals, stable claimant mapping, financial
preview/confirmation and browser/Swift migration remain open. These tests do not
certify those client flows, production proxies, real devices or the Android
release. See [the protocol](../../../check-sharing-protocol.md).

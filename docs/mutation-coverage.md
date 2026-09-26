# Server mutation coverage inventory — 2026-09-26

This inventory follows the current Express routes and SQLite writes. A guarded
owner JSON API is not proof that all server resources share that contract.
The strict flag remains off by default until compatible clients and the remaining
contracts are verified. Existing deployed services have not been changed.

| Mutation surface | Current contract | Remaining implementation / evidence |
| --- | --- | --- |
| `/api/sync/commit` | Atomic household identity/revision check and durable owner receipt. | Shipped compatible clients, real proxy/device-key/mixed-version QA and rollout. |
| State PUT/PATCH, month PUT/DELETE, import, reset-setup | `If-Match` checked inside transaction; required in strict mode. SQLite triggers cover JSON writes. Reset revokes links in its transaction. | Legacy writers have no general receipt journal. Updated clients use atomic owner commits for ordinary JSON saves. |
| Guest `/sync/commit` | Invitation-scoped receipts, current authorization, owner revision and write in one transaction. | Android durable storage/editor UI and Swift/browser client integration. |
| Legacy guest expense POST/DELETE and settlement POST | Owner ETag precondition and current authorization inside transaction. | No receipts; old native guest methods do not send the required precondition. Migrate clients to the guest protocol. |
| Check share create/rotate/revoke | Owner authentication; active token reuse, explicit rotation/revocation. | Rotation/create atomicity, concurrent commands and exact retry outcome; stale check/link lifecycle. |
| Public check claim | Token authorization and rate limiting; claims live outside household JSON. | Claim command identity/retry, concurrent claims, item/member changes and revocation races. |
| Trip and bills invitation create/rotate/revoke | Owner authentication; active-token reuse and separate revocation rows. | Atomic rotation, concurrent invite commands and retries; guest receipts already isolate each distinct trip token. |
| Public trip/bills join | Idempotent joined timestamp; trip join is in a transaction with membership read. | Bills join lifecycle consistency and complete native/browser ownership flows. Join is not a financial mutation receipt. |
| Email configuration PUT | Owner-scoped masked read/merge/write. | Resource revision to prevent stale overwrites, secret-preserving concurrent update tests. |
| Email send/test POST | Owner authentication and separate rate limit; external relay side effect. | Stable operation/outcome record and explicit handling of delivery uncertainty; a database receipt alone cannot prove mail delivery. |
| API key create/delete | Owner-scoped key issue/revocation; session invalidation on revoke. | Retry semantics for issuance and credential recovery; multi-device management lifecycle tests. |
| Server authentication settings PUT | Admin authorization; server-wide configuration outside household stream. | Configuration revision/concurrent admin update and rollout/recovery evidence. |
| Expense and itinerary attachment POST/DELETE | Owner namespace, validated paths, upload bounds and isolated download behavior. | Parent-record ownership/lifecycle, content identity, idempotent upload/delete, interruption recovery and garbage collection. File bytes are outside SQLite JSON commits. |
| `/api/session` | Device-key exchange into HTTP-only browser session. | Deployment cookie/proxy checks; this is authentication state, not a household revision write. |

Existing tests are useful within their assertions. In particular, current
attachment tests check namespace/path/download safety, not parent-record or
cross-resource consistency. Guest receipt tests do not certify check claims,
invitation rotation, attachment bytes, SMTP delivery or production topology.

Next implementation work should complete guest local journals and recovery,
then give separate resources their own explicit concurrency/idempotency contracts.
Do not force file bytes or external mail delivery into an owner JSON snapshot,
and do not mark the Android plan's server-wide mutation requirement complete
until each surface above has authoritative implementation and verification.

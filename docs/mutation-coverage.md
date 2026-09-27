# Server mutation coverage inventory — 2026-09-26

This inventory follows the current Express routes and SQLite writes. A guarded
owner JSON API is not proof that all server resources share that contract.
The strict flag remains off by default until compatible clients and the remaining
contracts are verified. Existing deployed services have not been changed.

| Mutation surface | Current contract | Remaining implementation / evidence |
| --- | --- | --- |
| `/api/sync/commit` | Atomic household identity/revision check and durable owner receipt. Optional `checkSharePreconditions` also guard reviewed claims/link identity in the same transaction. | Native host claim mapping/application, shipped compatible clients, real proxy/device-key/mixed-version QA and rollout. |
| State PUT/PATCH, month PUT/DELETE, import, reset-setup | `If-Match` checked inside transaction; required in strict mode. SQLite triggers cover JSON writes. Reset revokes links in its transaction. | Legacy writers have no general receipt journal. Updated clients use atomic owner commits for ordinary JSON saves. |
| Guest `/sync/commit` | Invitation-scoped receipts, current authorization, owner revision and write in one transaction. | Android durable storage/editor UI and Swift/browser client integration. |
| Legacy guest expense POST/DELETE and settlement POST | Owner ETag precondition and current authorization inside transaction. | No receipts; old native guest methods do not send the required precondition. Migrate clients to the guest protocol. |
| Check share create/rotate/revoke | [Protocol v1](check-sharing-protocol.md) atomically pins household and sharing revisions, persists receipts and permanently revokes links on check deletion. Owner snapshots include the current public URL. Legacy writes share the revision stream and require an ETag in strict mode. | Native owner durable journal/UI and public-address presentation, browser/Swift migration and mixed-client rollout. |
| Public check claim | Protocol v1 uses link-scoped guest credentials, separate revisions and exact receipts; same-name guests remain distinct. Android guest credentials/drafts and native selection/review/recovery exist. Claims remain declarations outside household JSON. | Explicit host mapping/application and withdrawal handling, browser/Swift migration and hosted ownership. |
| Trip and bills invitation create/rotate/revoke | Owner authentication; active-token reuse and separate revocation rows. | Atomic rotation, concurrent invite commands and retries; guest receipts already isolate each distinct trip token. |
| Public trip/bills join | Idempotent joined timestamp; trip join is in a transaction with membership read. | Bills join lifecycle consistency and complete native/browser ownership flows. Join is not a financial mutation receipt. |
| Email configuration PUT | Owner-scoped masked read/merge/write. | Resource revision to prevent stale overwrites, secret-preserving concurrent update tests. |
| Email send/test POST | Owner authentication and separate rate limit; external relay side effect. | Stable operation/outcome record and explicit handling of delivery uncertainty; a database receipt alone cannot prove mail delivery. |
| API key create/delete | Owner-scoped key issue/revocation; session invalidation on revoke. | Retry semantics for issuance and credential recovery; multi-device management lifecycle tests. |
| Server authentication settings PUT | Admin authorization; server-wide configuration outside household stream. | Configuration revision/concurrent admin update and rollout/recovery evidence. |
| Managed expense/itinerary attachment PUT and reference commits | Protocol v1 pins owner/server/household, stages immutable bytes, validates managed references inside JSON transactions and serves only current references. Exact uploads replay; legacy paths cannot overwrite managed files. | Legacy byte migration, expiry/garbage collection, physical purge and rollout. See [attachment protocol](attachment-protocol.md). |
| Restore preflight and managed restore attachment PUT | Complete replacement preflight is read-only; missing files are staged with a pinned revision, including absent/archived parents. Final replacement uses the existing atomic owner commit/receipt. | Native backup screen, quota recovery after preflight, retention, browser/Swift restore UX and deployed mixed-client verification. See [restore protocol](restore-protocol.md). |
| Unmanaged legacy attachment POST/DELETE | Owner namespace, validated paths, upload bounds and isolated download behavior. | These retain weaker parent/lifecycle and overwrite behavior; managed protocol coverage does not certify old files. |
| `/api/session` | Device-key exchange into HTTP-only browser session. | Deployment cookie/proxy checks; this is authentication state, not a household revision write. |

Existing tests are useful within their assertions. In particular, current
managed attachment tests now check staging/publication, parent lifecycle and
rollback of invalid managed references; they do not certify unmanaged legacy
file lifecycle or every separate resource. Guest receipt tests do not certify check claims,
invitation rotation, attachment bytes, SMTP delivery or production topology.

Remaining implementation work must give separate resources their own explicit
concurrency/idempotency contracts and verify mixed-client guest compatibility.
Do not force file bytes or external mail delivery into an owner JSON snapshot,
and do not mark the Android plan's server-wide mutation requirement complete
until each surface above has authoritative implementation and verification.

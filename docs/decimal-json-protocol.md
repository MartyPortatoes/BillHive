# Exact decimal JSON compatibility — 2026-10-03

The Node 24 server advertises `capabilities.decimalJSONProtocol: 1`. Atomic
owner snapshots and guest Trip snapshots/receipts include `decimalJSONProtocol: 1`.
New Android owner/guest requests also include that field and send
`X-BillHive-Decimal-JSON: 1`. The field makes a new request fail validation on
the preceding server, whose request schema rejects unknown fields.

Financial documents keep JSON numbers, preserving Swift/native numeric decoding.
Express uses the original numeric token supplied by the Node 24 JSON reviver.
Tokens that would change decimal value through a JavaScript Number are retained
as private scalar wrappers; `JSON.rawJSON` emits numeric literals for responses
and SQLite storage. Normal browser numbers retain their ordinary JavaScript type.
State, history, restore validation, exports, private unknown numeric fields,
public Check/Trip projections and attachment reference inspection use the same
lossless parser. Source amounts and rates retain their own precision.

Owner/guest request hashes now use normalized exact decimal values, sorted object
keys and stable array order. `hash_version` is added to the two receipt tables:
existing rows retain version 1 and their bytes/hashes; new receipts use version 2.
Ordinary old requests still replay against their original version-1 hash. Old
requests containing lossy tokens, more than 15 significant digits, or amounts
whose four-digit minor units exceed the safe JavaScript range are refused with
`409 LEGACY_DECIMAL_RECEIPT_AMBIGUOUS`. This is a conservative migration policy;
old hashes cannot recover digits that were discarded before storage. Such drafts
must stay pending for review. Already rounded historical values cannot be repaired
from the server database alone.

Receipt lookup precedes current protection/revision checks. Exact version-2
replays may return a newer snapshot without reapplying the operation, including
after protection is disabled or an invitation is revoked. Distinct large decimals
cannot reuse a mutation ID. Household isolation, transactions, reference checks,
deletion guards, body limits and rate limits retain their existing contracts.

Clients without the decimal header are refused with `428 DECIMAL_CLIENT_REQUIRED`
when an owner write would touch a precise household, or a guest expense replacement
would touch precise values. Ordinary households remain compatible. Owner snapshots
expose `requiresDecimalClient`; the current browser revision client refuses such
a snapshot before accepting a rounded editable baseline. Existing older browser
and Swift builds are protected against overwrites by the server gate, but their
display/calculation behavior for these values is not qualified. A header is a
client capability declaration, not authentication.

Guest activity formatting and Bills invite calculations use decimal/BigInt minor
units. Bills use the household currency, exact fixed remainders, native equal-share
remainder ordering, and weighted largest remainders with stable ties. Public Bills
data and preview metadata include `currencyCode`. Imported weights with an exponent
below -4096 remain storable but return `BILL_PRECISION_UNSUPPORTED` during the
read-only Bills invite calculation, avoiding an unbounded BigInt allocation.

Android checks the server capability before posting a frozen owner/guest request.
New preparation requires a negotiated capability. Receipt acknowledgement requires
the decimal protocol; if the snapshot describes that committed revision, Android
also compares saved values in decimal space. A newer replay snapshot is allowed.
Room version 12 preserves frozen requests, raw drafts and old receipts; cached
version-11 write capability is disabled until a fresh server load verifies support.
No pending payload or mutation ID is rewritten by the migration.

`node --test` currently passes 207 tests, including exact HTTP owner/guest writes,
adjacent-amount rejection, lossless export/restore preflight, private/public
projection boundaries, ordinary browser compatibility, old receipt migration,
and safe calculation formatting. Native acceptance is recorded in the separate
Android repository under `docs/evidence/2026-10-03/decimal-transport`.

These changes are local. Production rollout, real Swift/browser mixed-device
acceptance and full release qualification remain open.

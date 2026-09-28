# Checks currency browser checkpoint — 2026-09-28

The SelfHive browser now resolves empty household currency to USD, matching the
server public snapshot and Android decoder. The picker says Auto (USD). Amounts
and the stored setting are not converted. Explicit currency choices still win.

Receipt headers and the combined Checks total use the same exact decimal parsing
and half-up currency rounding as protected review. The aggregate sums integer
minor units, not binary floating-point display amounts. A receipt can show its
total before participants exist; its allocation still rejects missing recipients.
Checks amount inputs permit fractional digits beyond two and changing currency
refreshes the Checks display.

Validation: 183 Node tests pass, zero failures/skips. The real Chrome host-review
harness passes all 18 prior cases plus four rendered ordinary Checks cases for
blank/USD, JPY, KWD and CLF. It reads actual page headers and small-share rows after
rendering under a Japanese Intl locale override. Those four cases set synthetic
in-memory records; they do not certify user entry, persistence or production
accounts. The prior 18 cases retain their actual interaction, strict-server and
process-loss evidence. See browser/results.json and browser-ui.log.

Commands: Node 24 `--test`, followed by
`HOST_REVIEW_UI_EVIDENCE_DIR=docs/evidence/check-currency/browser node tools/verify-browser-host-review-ui.mjs`.
The harness owns and cleans its temporary server, Chrome profile and data. No
production browser profile, service or account was used.

Known remaining currency work includes large amounts/weight limits, provider
handoffs and server email formatting. Decimal strings are exact in the financial
engine, while the ordinary editor still uses Number for input. Full mobile browser,
other-browser, localization and deployed mixed-client acceptance remain open.

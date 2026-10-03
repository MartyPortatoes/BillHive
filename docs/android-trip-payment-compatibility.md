# Android Trip payment compatibility — 2026-10-02

Protected guest expense edits now retire dated payment requests when amounts,
payers or effective split members change. A note/name-only edit, or replacement
of an empty all-member split with its equivalent explicit list, retains them.
Deleting an existing expense also clears its previous request dates.

A newly recorded guest settlement clears only its `fromMemberId_toMemberId`
request date. Replaying an already recorded settlement leaves newer request
history intact. These mutations remain inside the existing revision/receipt
transaction and retain private attachment/import fields and unrelated settlements.
No endpoint, receipt schema, guest permission or rate-limit setting changed.

Validation: all **188** web/server tests passed under Node 24, including the new
financial-context and settlement-replay regression. Actual protected guest
settlement review and lost-response retry also passed in both Android flavors on
API 37; the Android evidence is recorded in the sibling checkout at
`Android_App/docs/evidence/2026-10-02/trip-payment-native/`.

This is local compatibility work. Deployment, older-client request-history
invalidation and physical/mixed-client acceptance remain open. The Apple
implementation remains Swift/SwiftUI and is unchanged by this checkpoint.

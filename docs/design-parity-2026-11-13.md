# iOS design parity — November 13, 2026

Applied the approved iOS navigation restoration and readability refinements to the interactive SelfHive web app (`Web_App`). The sibling `Website` repository is the marketing site and was not the target.

## Changes

- A separate gear opens Bills, Checks, Trips, and Settings as individual buttons. Bills retains Summary, Pay & Collect, and Trends in its task capsule. Checks and Trips retain their existing complete workspace screens; Bills-only task destinations are hidden while either is active.
- Opening the gear, closing it, or selecting the current workspace preserves the current screen. The menu supports arrow keys, Home/End, Enter, Escape, outside dismissal, focus return, and a visible current-workspace state. It remains within the viewport and scrolls when vertical space is limited. The narrowest layout uses two rows of task controls.
- Summary and collection balances use neutral text colors. Personal colors remain on identity dots. Financial cards use opaque honey surfaces with a single border, and the background motif is quieter. Existing light/dark/system appearance and reduced-effects support remain.
- Missing email addresses now expose Add email with a labeled inline form, validation, Save, and Cancel. Saving uses the existing household persistence path and does not send email.
- Payment links use explicit Add/Edit payment link forms with Save and Cancel. Unsafe URLs are rejected. Saved links expose Open payment website separately. Existing website-opening/checklist behavior is retained.
- Receive-card expansion has a named button with an expanded state; marking payment received is a keyboard-operable button. Actions wrap at narrow sizes. Duplicate top-level workspace tabs are removed from the task row.

## Verification

- Node 24: `node --test` — **259 passed, zero failed**.
- `node tools/verify-design-parity.mjs` — **8 grouped browser checks passed**, using disposable SQLite storage and a temporary Chrome profile. These cover menu/navigation and focus, all workspaces, email validation and persisted saving, HTTPS payment-link validation and saving/cancellation, no email request or payment marking during setup, outside dismissal, responsive layout and target sizes, neutral amounts/opaque surfaces, reduced motion, and no JavaScript runtime errors.
- Checked 320, 390, 768, and 1280 px viewports; visually inspected desktop light/dark, mobile dark, the open menu, and a 320 px viewport at 125% CSS zoom with inline email setup. Narrow-layout crowding and the Checks-menu left edge were corrected in the confirmation pass.
- Inline-script syntax, updated browser-test script syntax, and `git diff --check` passed. Existing browser sharing test navigation helpers now use the gear; those full sharing scenarios were not rerun for this UI change.
- Screenshots and the source hash are in `docs/evidence/design-parity-2026-11-13/`. The fixture contains invented people and amounts. No real email was sent, payment website opened, or deployed database modified.

These are local changes. No deployment, physical-device browser test, Safari/Firefox run, or screen-reader session was performed.

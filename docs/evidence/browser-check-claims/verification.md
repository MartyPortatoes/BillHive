# Browser check selections — 2026-09-27

Web parent: `769cee5`. Android implementation remains `b35548a`, with subsequent
status documentation at `22cd2dd`; Apple remains `25d3ed2`. No server protocol,
Android or Swift source changed in this checkpoint. All runtime traffic used
disposable localhost servers, databases, browser profiles and synthetic records.
No push, deployment, Google configuration, store submission or user browser
profile was involved.

## Final verification

- **90 Node tests pass**, zero failures or skips: the existing 73 plus 17 browser
  engine/transport tests. [Complete output](node-tests.txt).
- **17 real-browser checks pass** in Chrome 151.0.7922.110 headless, using actual
  IndexedDB, DOM input, keyboard events, downloads and the strict Express/SQLite
  server. [Output](browser-tests.txt), [structured results](results.json).
- The phone viewport was 390×844; the tablet viewport was 1024×768. Light/dark,
  long escaped names and doubled rendered text were exercised. Screenshots were
  inspected; native controls have accessible names in Chrome's accessibility tree.
- Owned Chrome processes were killed as a process group and restarted with the
  same isolated profile. The pending request and identity survived. Retries sent
  identical bytes and credentials after newer server changes, without a second
  logical mutation.
- A dropped-response proxy loses every response for the chosen mutation because
  Chrome may transparently retry a disconnected POST. The server commits normally;
  the test later restores responses and checks acknowledgement.
- Actual recovery downloads preserve both an older saved draft and newer unsaved
  text after an injected IndexedDB write failure. Pending exports preserve the
  original intent and exclude credentials/link tokens.
- Final cleanup awaited exit of the owned Chrome and server processes, closed
  the proxy, and removed the disposable profile/database/download directory.

The engine suite independently compares SHA-256 against Node crypto vectors and
covers same-name/legacy identity isolation, storage rollback, concurrent tabs,
stale-tab submission, malformed/forged receipts, revocation, monotonic revisions,
removed-item review, corrupt saved records, response limits and request policy.
The browser suite adds the real HTTP/storage/UI path, withdrawal, process loss,
revoked receipt-only replay, before-unload warning, completed-check read-only
behavior, keyboard selection and layout evidence.

## Findings resolved during verification

- A trailing slash changed relative script resolution. The CSP-authorized loader
  now derives a validated same-origin prefix for both scripts.
- An unrelated household update could leave pending-draft revisions behind the
  actual request. Preparation now pins the pending copy to the sent revisions.
- Long unbroken titles expanded the mobile viewport and hid the fixed action.
  Wrapping now keeps the action on screen, including doubled rendered text.
- Calendar-only dates initially displayed the previous date in the local timezone;
  they now use local calendar components.
- A stale tab could otherwise transmit an already-discarded old request. A stored
  pending-request check now precedes network transmission.
- Receipt-only withdrawal acknowledgement initially displayed the older cached
  selection. Confirmed intent now takes precedence when its sharing revision is
  newer, without fabricating a fresh public snapshot.
- The browser runner originally matched Node's automatic `test-*` discovery.
  Its name is now `verify-browser-check-claims.mjs`, and the two suites run
  explicitly and independently. Browser tests also handle the expected unload
  confirmation in their isolated profile.

## Reproduction

Use the repository's supported Node 24 runtime:

```sh
node --test
node tools/verify-browser-check-claims.mjs
git diff --check
```

The browser runner defaults to the macOS Chrome application; `CHROME_PATH` can
select another local Chrome binary. `CLAIM_EVIDENCE_DIR` changes the output
directory. No extra browser-testing dependency is installed.

## Scope and limits

This completes the public browser guest check-selection migration locally, not
the full cross-client sharing rollout or Android v1. Browser owner controls,
Swift sharing compatibility, hosted ownership and deployment remain open.
Physical Android/iPhone browsers, Safari/Firefox, TalkBack/VoiceOver, actual OS
text settings, virtual-keyboard behavior, full language coverage, production
proxies, maximum-size browser records and long-term storage eviction remain
unverified. Injected doubled rendered text is layout evidence, not native OS
accessibility certification. Full Android feature, sync, commerce, privacy,
device and Play release requirements remain active.

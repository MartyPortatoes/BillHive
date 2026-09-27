# Explicit-zero carry-forward compatibility — 2026-09-27

The browser now protects a destination bill when a total or any saved share is
present, including zero and retired lines. Zero sources and fixed-only sources
copy; empty sources do not create a month. Missing totals/amounts containers are
initialized when needed. Other month fields, checklist and request dates remain
unchanged, source maps do not alias destination maps, and repeating the operation
does not save again. Only the immediately preceding calendar month is eligible.

`test/bill-months.test.js` executes the actual browser function extracted from
`index.html`, using six regression cases that exercise these behaviors. The full
Node 24 suite passed **54 tests, zero failures or skips**, recorded in `tests.log`.

```sh
npx --yes --package=node@24 --call 'node --test'
git diff --check
```

The same presence rule is implemented in Android and the companion Swift fix.
This verification covers browser logic and the existing server regression suite;
it does not claim browser click-through, a deployed mixed-client test or release.
No remote push or deployment occurred.

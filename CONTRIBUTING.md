# Contributing

Bin Picker is two static files and has no dependencies. To work on it:

```bash
npm start           # serves the page at http://127.0.0.1:8765
npm test            # offline tests: core scoring and 24 user scenarios
npm run test:live   # every window × horizon × strategy on live Metric pools
npm run test:ui     # the page in headless Chrome for several shareable links (set CHROME= if it is not found)
```

- Scoring and allocation live in `core.js` as pure functions; the page (`index.html`) only renders them. Put logic in `core.js`
  and cover it in `test/scenarios.test.js`.
- A change to how bins are scored or picked needs a line in `CHANGELOG.md` and, if users see it, in the README.
- Keep the page read-only: no wallet connection, no signing, no keys, no tracking.

Open an issue first for anything larger than a fix.

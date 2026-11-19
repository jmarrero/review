# Agents

`npm run check` typechecks, runs the unit tests and builds the app.

## UI changes

The unit tests render with jsdom, which shows no layout. For any change to
what the app draws (`src/github/*view.ts`, `static/`, anything that changes
a page's markup), also run the browser test:

    npx playwright install chromium   # once per environment
    npm run test:browser

It loads the built app in Chromium against the fixtures, offline, fails on
any console error, and writes `dist/screenshots/{inbox,status}-{desktop,phone}.png`.
Look at the screenshots, and attach the ones your change affects to the
pull request. If the change needs data the fixtures don't have, extend
`test/e2e/fixture-api.ts` or pick other data with `BROWSER_DATA` (see
`test/browser/app.spec.ts`). `REVIEW_LIVE_TOKEN` runs it against live
data instead; those screenshots are private, so don't attach them.

If Chromium can't be installed, say so in the pull request rather than
leaving the screenshots out silently.

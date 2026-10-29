# Colorado Emissions Atlas

A small, public dashboard for facility-reported air emissions in Colorado using EPA's ECHO Air Emissions dataset through the EDGI ECHO-Pipeline API. The frontend is a static React + TypeScript + Vite site for GitHub Pages; GitHub Actions refreshes the public data snapshot weekly.

## What the dashboard shows

- Colorado facilities with reported emissions and reporting records
- Filters for reporting year, EPA program, pollutant, and emissions unit
- Annual reported values and facility totals

Different programs and pollutants use different units and reporting schedules. The dashboard keeps unit-specific values separate and does not rank facilities across different units. ECHO values are reported or estimated emissions, not direct measurements or a measure of exposure, compliance, or health risk. See the [EPA Air Emissions dataset documentation](https://echo.epa.gov/tools/data-downloads/air-emissions-download-summary).

## Run locally

Requirements: Node.js 22 or newer and Python 3.

```sh
npm ci
npm run data:download
npm run dev
```

`npm run data:download` copies the latest published public data snapshot to `public/data/colorado-emissions.json` without requiring an API token. To fetch from another published dashboard, set `DASHBOARD_SNAPSHOT_URL` to its JSON snapshot URL before running the command.

To refresh directly from the API instead, run `npm run data:refresh` in a terminal; it prompts for the API token without echoing the input. The refresh is long-running and rate-limited, so downloading the latest published snapshot is the recommended path for UI/layout work. Start Vite after either command to view the local app with that data. `npm test` checks offline data normalization and snapshot safeguards; it does not call the authenticated ECHO API.

## Configure publishing and weekly refresh

1. Publish this project in a GitHub repository and ensure its default deployment branch is `main`.
2. Obtain an ECHO API bearer token using the [ECHO_modules instructions](https://github.com/edgi-govdata-archiving/ECHO_modules/tree/echo-modules-delta#basic-usage). Do not commit the token or put it in frontend configuration.
3. In the repository, open **Settings → Secrets and variables → Actions**, create a repository secret named `ECHO_API_TOKEN`, and add the token there.
4. Open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
5. Run **Actions → Refresh data and deploy dashboard → Run workflow** once. Confirm it succeeds before relying on weekly updates.

The workflow refreshes weekly on Monday at 10:17 UTC, and can also be started manually. Pushes to `main` download the already-published public snapshot and deploy code changes without repeating the API refresh; scheduled and manual runs call ECHO and publish fresh data. It publishes only after the API requests and validation all succeed; an expired/rejected token fails the workflow and does not deploy an empty snapshot. The workflow never prints the token or puts it in the browser bundle. The generated `public/data/colorado-emissions.json` is public, so it contains only the facility and emissions fields needed by this dashboard.

The API token's expiration and unattended renewal behavior have not been established. If the scheduled workflow later fails with an authentication error, update the Actions secret with a valid token or arrange unattended API credentials; do not make the API token public to avoid refresh failures.

The workflow uses Node-24-compatible GitHub Actions and pins `ubuntu-26.04` instead of the moving `ubuntu-latest` alias. The app itself is still built with Node.js 22.

## Data pipeline

The refresh starts by selecting Colorado facilities from `ECHO_EXPORTER`. It then counts and samples nationwide `POLL_RPT_COMBINED_EMISSIONS` rows from 2016 onward to estimate response size. If the estimate is below 50 MB, it requests the nationwide result once and filters to Colorado locally. The response has a hard 50 MB limit. If the estimate is larger (or the response exceeds the limit), it falls back to Colorado registry-ID batches sized to fit safe request URLs. Requests are spaced to respect the API's documented rate limit. The script logs request durations, row counts, byte counts, request totals, and overall refresh time, and atomically replaces the public snapshot only after the complete refresh succeeds. Records before 2016 are excluded from the snapshot.

Use the `[preflight]` log line to see the nationwide row count and estimated size. Each `[api]` line reports a single request's rows, downloaded bytes, and time; the final `[refresh]` line reports request count and total run time. The 2016 cutoff reduces rows and payload, but the national query path is what can reduce API calls from many batches to a single data request. If preflight chooses the batched fallback, the logs show how many requests remain; do not reduce the six-second pacing below the API's published limit.

The API base defaults to `https://portal.gss.stonybrook.edu/api`. The optional `ECHO_API_BASE_URL` environment variable can be used to point the script at an approved API deployment.

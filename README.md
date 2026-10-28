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
npm run dev
```

The local dashboard starts with an empty snapshot until a successful refresh is run. `npm test` checks the offline data normalization and snapshot safeguards; it does not call the authenticated ECHO API.

## Configure publishing and weekly refresh

1. Publish this project in a GitHub repository and ensure its default deployment branch is `main`.
2. Obtain an ECHO API bearer token using the [ECHO_modules instructions](https://github.com/edgi-govdata-archiving/ECHO_modules/tree/echo-modules-delta#basic-usage). Do not commit the token or put it in frontend configuration.
3. In the repository, open **Settings → Secrets and variables → Actions**, create a repository secret named `ECHO_API_TOKEN`, and add the token there.
4. Open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
5. Run **Actions → Refresh data and deploy dashboard → Run workflow** once. Confirm it succeeds before relying on weekly updates.

The workflow refreshes weekly on Monday at 10:17 UTC, and can also be started manually. It publishes only after the API requests and validation all succeed; an expired/rejected token fails the workflow and does not deploy an empty snapshot. The workflow never prints the token or puts it in the browser bundle. The generated `public/data/colorado-emissions.json` is public, so it contains only the facility and emissions fields needed by this dashboard.

The API token's expiration and unattended renewal behavior have not been established. If the scheduled workflow later fails with an authentication error, update the Actions secret with a valid token or arrange unattended API credentials; do not make the API token public to avoid refresh failures.

## Data pipeline

The refresh script first selects Colorado facilities from `ECHO_EXPORTER`, then fetches `POLL_RPT_COMBINED_EMISSIONS` rows for those facility IDs in small batches. Requests are spaced to respect the API's documented rate limit. The script validates and atomically replaces the public snapshot only after the complete refresh succeeds.

The API base defaults to `https://portal.gss.stonybrook.edu/api`. The optional `ECHO_API_BASE_URL` environment variable can be used to point the script at an approved API deployment.

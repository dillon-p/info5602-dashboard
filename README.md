# Work, recharted

A public React + TypeScript dashboard exploring projected employment growth, median wages, and relative AI exposure across occupations. It is a static Vite site and reads its data from `public/data/bls_ai_exposure.json`.

## What the dashboard shows

- One bubble per occupation, positioned by projected employment change (2025–35) and 2025 median annual wage
- Bubble color for relative AI exposure and bubble area scaled to 2025 employment
- Mean and median projected employment change by AI-exposure group, using the supplied `metrics` array

AI exposure is a category in the supplied dataset, not a forecast that a job will disappear or a measure of an individual worker's risk. Missing numeric source values may be `null` or an em dash; both are treated as unavailable in the chart.

## Run the dashboard locally

Requirements: Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Run `npm run build` to type-check and create the production site in `dist/`.

## Legacy ECHO data tooling

The existing Python tooling and notebook workspace for Colorado ECHO emissions is retained, but it does not supply data to this dashboard. Its snapshot download and refresh commands still write `public/data/colorado-emissions.json`.

### Refresh from local Delta tables

The refresh requires local ECHO Delta tables and the Docker/PySpark environment described in the [ECHO_modules local Delta Lake instructions](https://github.com/edgi-govdata-archiving/ECHO_modules/tree/echo-modules-delta#using-the-echo-tables-in-a-local-delta-lake-system). It reads `ECHO_EXPORTER` and `POLL_RPT_COMBINED_EMISSIONS` from the configured Delta table directory, filters to Colorado and reporting years from 2016 onward, then writes the legacy emissions snapshot.

1. Follow the linked ECHO_modules setup to prepare the local Delta tables and schemas.
2. In the ECHO_modules checkout's `.env`, set `DELTA_TABLES_HOST_PATH` and `SCHEMA_HOST_PATH` to those local directories. Set `WORK_DIR_HOST_PATH` to the root of this dashboard repository.
3. Build and start the ECHO_modules service:

   ```sh
   docker compose -f docker-compose.yaml build
   docker compose -f docker-compose.yaml up
   ```

4. In another terminal, run the refresh script in the container:

   ```sh
   docker exec -it echo-modules-delta bash
   cd /opt/spark/work-dir
   python -m analytics.scripts.refresh_data
   ```

The container exposes the tables at `DELTA_TABLES_MOUNT_PATH`. To use another reporting-year floor, set `ECHO_MIN_YEAR` in the container environment. The script refuses to replace the snapshot if either table is missing, a read fails, or the result is empty or invalid. Review the generated `public/data/colorado-emissions.json`, then commit it and push to `main` to publish it. The snapshot contains only the facility and emissions fields used by the dashboard.

`npm test` checks offline normalization, Delta refresh orchestration, and snapshot safeguards; it does not require PySpark or local Delta data. The existing snapshot remains usable for dashboard development if you have not configured a local Delta source.

### Analytics workspace

The [analytics workspace](./analytics/) keeps the legacy Python data tooling, notebooks, and tests together. The [notebook setup guide](./analytics/notebooks/README.md) covers using the ECHO_modules JupyterLab environment.

## Configure publishing

1. Publish this project in a GitHub repository and ensure its default deployment branch is `main`.
2. Open **Settings → Pages** and select **GitHub Actions** as the build and deployment source.
3. Push the committed snapshot and code to `main`, or run **Actions → Deploy dashboard → Run workflow** to deploy the current commit.

The workflow tests, builds, and deploys the snapshot already committed in the repository. It does not refresh data on a schedule or contact the ECHO API. A hosted Delta refresh would require a Delta source and credentials accessible to the Actions runner; none is configured by the linked local setup. GitHub-hosted Actions may fit within included usage, but storage, compute, access, and usage limits would need to be established before treating it as a free unattended option.

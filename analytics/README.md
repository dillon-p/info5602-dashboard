# Analytics workspace

This directory is the home for Python data work that supports the dashboard:

- `scripts/` contains the data snapshot download and Delta refresh commands.
- `notebooks/` contains Jupyter notebooks for exploring and analyzing the ECHO
  data.
- `tests/` contains offline tests for the Python tooling.

Run the download and refresh commands from the repository root with
`npm run data:download` and `npm run data:refresh`. For the ECHO Delta and
JupyterLab setup, see the [notebook guide](./notebooks/README.md). Generated
dashboard data remains in `public/data/` so the frontend can load it.

Build the Question 7 sector timeline from `notebooks/Sector.xlsx` with
`analytics/.venv/bin/python -m analytics.scripts.build_sector_timeline` from
the repository root. The generated `public/data/sector_ai_adoption.json`
contains an unweighted mean of available sector-level Yes estimates, excludes
the non-NAICS `XX` category, and preserves low-confidence counts.

# ECHO Delta notebooks

This notebook folder is part of the root-level `analytics/` workspace, which
keeps Python scripts, notebooks, and tests together. This folder is mounted
into the JupyterLab service from the linked
[ECHO_modules Delta Lake setup](https://github.com/edgi-govdata-archiving/ECHO_modules/tree/echo-modules-delta#using-the-echo-tables-in-a-local-delta-lake-system).
The notebook here only opens the two Delta tables used by the dashboard; it
does not perform analysis.

## Start JupyterLab

1. Prepare local ECHO Delta tables and schemas using the linked setup.
2. In that checkout's `.env`, set `DELTA_TABLES_HOST_PATH` and
   `SCHEMA_HOST_PATH` to the corresponding local directories, and set
   `WORK_DIR_HOST_PATH` to the root of this dashboard repository.
3. From the ECHO_modules checkout, build and start its Docker service:

   ```sh
   docker compose -f docker-compose.yaml build
   docker compose -f docker-compose.yaml up
   ```

4. Open `http://localhost:8888/lab/tree/analytics/notebooks/echo_delta_access.ipynb`.

The notebook uses the `spark` session created by the linked container and
`DELTA_TABLES_MOUNT_PATH` configured there. Keep the Delta data and schema
outside this repository; do not commit them.

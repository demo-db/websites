# Turning on public PostgreSQL access

Status: activated (config flipped 2026-10-15). All six PostgreSQL copies live in one private Neon project and are served read-only through https://cloud.openvaultdb.com. Activation rests on the 2026-10-05 Neon verification receipt (kept outside this repository), an independent 2026-10-15 validation of the hosted data, and live read-only checks of all six public APIs; step e was not re-run at activation and the Northwind Worker bindings of step c were not exercised. The pull request that set `publicApiVerified` to `true` in `config/postgresql-api.json` records what was and was not checked. The steps below stay as the procedure to repeat or re-verify. Hostnames, project identifiers, and secret values are deliberately not recorded here.

Complete these steps in order. Use the private Neon and Cloud Run consoles or Secret Manager for every value. Do not paste secret values into shell history, chat, issues, or commits.

## Checklist

**a. Verify each reader role is read-only.** For each dataset `<db>` (chinook, northwind, pubs, sakila, adventureworks, employees), run these as an owner or admin role. Replace `<db>_reader` with the role name.

1. Table and view grants, grouped by schema and privilege. Only `SELECT` should appear for `<db>_reader` and for `PUBLIC`:

   ```sql
   SELECT table_schema, privilege_type, grantee, count(*) AS objects
   FROM information_schema.role_table_grants
   WHERE grantee IN ('<db>_reader', 'PUBLIC')
   GROUP BY table_schema, privilege_type, grantee
   ORDER BY table_schema, privilege_type, grantee;
   ```

2. Sequence grants. `USAGE` and `UPDATE` on sequences are writes or state changes, so none should appear for `<db>_reader` or `PUBLIC`:

   ```sql
   SELECT sequence_schema, sequence_name, privilege_type, grantee
   FROM information_schema.role_usage_grants
   WHERE grantee IN ('<db>_reader', 'PUBLIC');
   ```

3. Default privileges. Any row here grants future objects to a role. Check that no default ACL grants `<db>_reader` or `PUBLIC` anything beyond `SELECT`:

   ```sql
   SELECT defaclrole::regrole AS owner_role, defaclnamespace::regnamespace AS schema,
          defaclobjtype, defaclacl
   FROM pg_default_acl;
   ```

4. Role attributes, owned objects, and schema `CREATE` rights. Expect every flag false, `owned_objects` 0, and `can_create` false for every schema:

   ```sql
   SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
     (SELECT count(*) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE pg_get_userbyid(c.relowner) = r.rolname
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS owned_objects
   FROM pg_roles r
   WHERE r.rolname = '<db>_reader';

   SELECT n.nspname, has_schema_privilege('<db>_reader', n.nspname, 'CREATE') AS can_create
   FROM pg_namespace n
   WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
   ```

5. Role memberships. The reader must not belong to a role that grants broad access. `pg_read_all_data` is read-only but still wider than one dataset, and `pg_write_all_data` and `pg_monitor` must not appear. Expect no rows:

   ```sql
   SELECT g.rolname AS member_of
   FROM pg_auth_members m
   JOIN pg_roles r ON r.oid = m.member
   JOIN pg_roles g ON g.oid = m.roleid
   WHERE r.rolname = '<db>_reader'
     AND g.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_monitor', 'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program');
   ```

   Also confirm the reader is not a member of the owner role of the dataset schema.

**b. Set the OVDB PostgreSQL connection secrets.** On the Cloud Run service that serves OpenVaultDB, bind one Secret Manager secret per dataset as `OVDB_PG_<DB>_DSN`, for `CHINOOK`, `NORTHWIND`, `PUBS`, `SAKILA`, `ADVENTUREWORKS`, and `EMPLOYEES`. Each secret holds the reader connection string for that dataset's `<db>_reader` role.

**c. Set the Northwind Worker bindings.** The Worker deploy from `openvaultdb/cloud` ([PR #46](https://github.com/openvaultdb/cloud/pull/46), merged) reads `NORTHWIND_NEON_DATABASE_URL` and `NORTHWIND_D1_DATABASE_ID`. Provide both as deploy-time secrets or variables in that repository's environment.

**d. Enable the PostgreSQL backend.** Set `OVDB_DEMODB_POSTGRES_ENABLED` to `true` in the OpenVaultDB service configuration. Leave it unset or `false` until steps a to c are complete.

**e. Verify the imported data against the pinned sources.** From a checkout of each provider repository, with a private `0600` URL file that is not committed:

```sh
python3 scripts/hosting-tools/postgres_samples.py verify /path/to/provider-root \
  --url-file /private/tmp/provider-reader-url
```

Run it for all six providers. Every run must pass before step f.

**f. Mark the API verified.** Set `publicApiVerified` to `true` in `config/postgresql-api.json` and deploy the website. The site then shows each PostgreSQL copy as public, with its read-only API link pointing at `https://cloud.openvaultdb.com/v1/databases/<db>-postgresql`. The SQLite pages keep their own API links. No test edit is needed: CI builds and tests both states (see below).

## After activation

CI already covers both states. The `deploy` job tests the committed flag, and the `verified-postgresql-state` job builds and tests with `scripts/fixtures/postgresql-api-verified.json` selected through `DEMODB_POSTGRESQL_API_CONFIG` (run it locally with `pnpm test:verified-postgresql`). That run asserts the six PostgreSQL pages link to `https://cloud.openvaultdb.com/v1/databases/<db>-postgresql`, the public OVDB API count is 12, no PostgreSQL page links the SQLite API, and `demodb.dev` has no local descriptor or `/ovdb/v1/databases/<db>-postgresql` route. After the flip deploys, `scripts/smoke-live.mjs` checks the live pages against the committed value.

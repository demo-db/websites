# Turning on public PostgreSQL access

Status: pending. All six PostgreSQL copies exist in one private Neon project. Public read-only OVDB access is not enabled. The website shows the PostgreSQL copies as pending, and `config/postgresql-api.json` keeps `publicApiVerified` set to `false`. Hostnames, project identifiers, and secret values are deliberately not recorded in this repository.

Complete these steps in order. Use the private Neon and Cloud Run consoles or Secret Manager for every value. Do not paste secret values into shell history, chat, issues, or commits.

## Checklist

**a. Verify each reader role is SELECT-only.** For each dataset `<db>` (chinook, northwind, pubs, sakila, adventureworks, employees), run these as an owner or admin role.

Table grants, grouped by schema and privilege. Only `SELECT` rows should appear for `<db>_reader`:

```sql
SELECT table_schema, privilege_type, grantee, count(*) AS tables
FROM information_schema.role_table_grants
WHERE grantee = '<db>_reader'
GROUP BY table_schema, privilege_type, grantee
ORDER BY table_schema, privilege_type;
```

Role attributes, schema `CREATE` rights, and owned objects. Expect `rolsuper`, `rolcreatedb`, and `rolcreaterole` to be false, `can_create_*` to be false, and `owned_objects` to be 0:

```sql
SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
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

**b. Set the OVDB PostgreSQL connection secrets.** On the Cloud Run service that serves OpenVaultDB, bind one Secret Manager secret per dataset as `OVDB_PG_<DB>_DSN`, for `CHINOOK`, `NORTHWIND`, `PUBS`, `SAKILA`, `ADVENTUREWORKS`, and `EMPLOYEES`. Each secret holds the reader connection string for that dataset's `<db>_reader` role.

**c. Set the Northwind Worker bindings.** The Worker deploy from `openvaultdb/cloud` (merged in [PR #46](https://github.com/openvaultdb/cloud/pull/46)) reads `NORTHWIND_NEON_DATABASE_URL` and `NORTHWIND_D1_DATABASE_ID`. Provide both as deploy-time secrets or variables in that repository's environment.

**d. Enable the PostgreSQL backend.** Set `OVDB_DEMODB_POSTGRES_ENABLED` to `true` in the OpenVaultDB service configuration. Leave it unset or `false` until steps a to c are complete.

**e. Verify the imported data against the pinned sources.** From a checkout of each provider repository, with a private `0600` URL file that is not committed:

```sh
python3 scripts/hosting-tools/postgres_samples.py verify /path/to/provider-root \
  --url-file /private/tmp/provider-reader-url
```

Run it for all six providers. Every run must pass before step f.

**f. Mark the API verified.** Set `publicApiVerified` to `true` in `config/postgresql-api.json` and deploy the website.

**Blocker for step f.** `src/data/ovdb.ts` refuses a `true` value until the website routes OVDB requests for PostgreSQL storage IDs such as `<db>-postgresql`. Today `/ovdb/v1/databases/` serves only the SQLite editions, so a `true` value would advertise a route that does not exist. Add that route, remove the guard in `src/data/ovdb.ts`, and then flip the flag. Until then, leave the flag `false`.

## After activation

Run `pnpm test` and check that each PostgreSQL storage page shows the verified API link. `scripts/test-explore.ts` and `scripts/test-worker.ts` assert the pending state and must be updated in the same change.

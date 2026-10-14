# PostgreSQL sample fidelity

How the PostgreSQL editions produced by `scripts/hosting-tools/postgres_samples.py`
relate to the pinned SQLite contract, and how that is checked live.

## Load order

Foreign keys are `DEFERRABLE INITIALLY DEFERRED` so rows load in any order. Rows
left pending deferred-constraint trigger events on every referencing table, and
PostgreSQL refuses `CREATE INDEX` on such a table (`55006`, "cannot CREATE INDEX
... because it has pending trigger events"). The generated script and the
`import` path both now run:

1. schema, tables, foreign keys (deferred)
2. bulk rows (`INSERT` batches, or `COPY` for `import`)
3. identity sequence seeding
4. `SET CONSTRAINTS ALL IMMEDIATE;` (validates every foreign key once, in bulk)
5. indexes, views, `_import_manifest`

Indexes stay after the load (index-free bulk load is faster than maintaining
indexes per row), and the single constraint settle keeps full FK enforcement.
Output remains deterministic. Northwind's own artifact
(`artifacts/hosting-imports/postgres.sql`, produced by the northwind repo) uses the
same deferred FKs but defines no indexes, so it is not affected today; it would
hit the same error if indexes were added there without the same settle step.

## Live test

`scripts/hosting-tools/test_postgres_live.py` loads each dataset's generated SQL,
runs `verify`, drops the schema, then repeats with `import` and `verify`. It is
skipped unless `DEMODB_LIVE_POSTGRES_URL` (loopback hosts only; never a hosted
database) and `DEMODB_PROVIDER_ROOTS` (a directory of `<id>/` checkouts at the
pinned revisions) are set. Northwind is loaded from its own artifact and compared
table by table against SQLite, because the shared generator does not adapt its
SQL Server-style views (for example `Discontinued = 0` against a `TEXT` column,
which SQLite coerces and PostgreSQL rejects).

CI runs it in `.github/workflows/postgres-live.yml` against a `postgres:17`
service container. Locally any throwaway server works, for example the binaries
of the npm `@embedded-postgres/*` packages:

```sh
python3 -m venv venv && venv/bin/pip install -r scripts/hosting-tools/requirements-live.txt
DEMODB_LIVE_POSTGRES_URL=postgresql://postgres@127.0.0.1:55432/postgres \
DEMODB_PROVIDER_ROOTS=/path/to/pinned/checkouts \
  venv/bin/python -m unittest scripts/hosting-tools/test_postgres_live.py -v
```

## Type fidelity

- **DATE / DATETIME become `TEXT`.** Deliberate: SQLite stores these as free text
  (only Chinook `Employee.BirthDate/HireDate`, `Invoice.InvoiceDate` and five
  Northwind columns declare them; the other four datasets declare none), and `TEXT` preserves the exact
  source strings so the typed row-multiset check is exact. The ModelSpec types
  (`date`, `datetime`) describe the logical type; the PostgreSQL storage type is
  not part of the SQLite contract. Converting to `DATE`/`TIMESTAMP` would normalise
  text such as `1947-09-19 00:00:00` and break byte-exact verification, so it is
  documented rather than changed. Consumers wanting temporal operators should cast
  (`"InvoiceDate"::timestamp`).
- **Northwind `Invoices.UnitPrice` is `double precision`; `"Order Details"."UnitPrice"`
  is `NUMERIC`.** In the pinned SQLite source the base column has `NUMERIC` affinity
  and holds a mix of integer and real storage (943 integer and 1212 real values in
  the view). Northwind's artifact casts the view column to `DOUBLE PRECISION` so
  view results reproduce SQLite's floating results. ModelSpec describes tables
  only (`UnitPrice` is `decimal`); views carry no ModelSpec type, so this is a
  documented view-level difference, not a contract violation. Exact-decimal
  claims apply to base tables only; `verify` compares view numerics with a
  bounded float tolerance.
- **Northwind `Invoices.Salesperson`** is `0` in both SQLite and PostgreSQL (SQLite
  `+` on text), as documented in the README.

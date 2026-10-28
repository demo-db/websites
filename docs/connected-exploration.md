# Connected exploration

The shared profile templates provide dataset discovery, one progressive table preview, native record/FK navigation, MeaningGraph bindings below the table list, guided investigations, and supported product handoffs. Structural similarity, semantic bindings, and declared native foreign keys remain different kinds of evidence.

## Prepared SQL

`src/data/querydock/manifest.json` pins seven reviewed teaching inputs and their expected results. Inputs begin with up to eight rows from question-relevant tables, then include every required declared FK parent. Other physical tables may be empty. Source columns and FK pairs are retained; FK checks are deferred to the explicit seed transaction's commit to permit circular source references. Generation checks imports with `foreign_keys=ON`, rejects violations and oversized inputs, and preserves upstream notices. The fixture is a derived teaching subset; aggregates are not full-database totals.

From the DemoDB WB worktree, with the paired application worktree also writable:

```sh
pnpm exec tsx <apps-worktree>/apps/querydock-app/tools/curate-demodb.mjs <demodb-worktree>
```

The producer uses QueryDock's actual snapshot admission rules and writes digest-named, immutable same-origin assets, a consumer manifest, and a compact return-context catalogue. Previously published digest assets and contexts are retained. Source/provider revision changes fail the consumer build until the paired inputs are regenerated and reviewed. QueryDock prepares a new local draft and requires Run. Its browser acceptance exports the complete result as raw CSV and compares columns and every value, as a multiset where SQL ties do not specify a unique order.

Shipping Logs keeps its original JSONL/inGitDB path. Its two declared baseline log collections can open in DataTug's live read-only log viewer. Future recovery collections are labelled examples and do not imply a replay was executed.

## Context and boundaries

- DataTug table handoffs use native names, a fixture SHA-256, source revision, an allowlisted return URL and, where addressable, a complete primary-key object. Record keys admit only bounded strings, safe integers and booleans; a query validates the entire declared PK and uniqueness, including composite keys and records beyond the first page. Cached browser edits are distinguished from the original fixture. Unsupported source search is explained.
- The embed's opt-in `data-state-key` retains search, sort, page, equality filters and native record selection. Refresh resolves identity again instead of retaining array position. FK links preserve complete declared composite pairs and use same-origin table routes. Standalone embeds ignore host URL state by default.
- CodeGrapher's source and SHA-256 identify the graph snapshot. `node`, `focus`, `center` and `depth` select a declared neighborhood; meanings remain distinct graph edges. Source row filters are retained on the return link and explicitly do not filter schema nodes.
- Return navigation accepts public DemoDB profile/table/learning routes and the catalogue's concept comparison route. Credentials, other origins and unsupported paths are refused. Source IDs, checksums and row/filter values are not interchangeable.

## Diagnostics

`demodb-handoff` is a local `CustomEvent` for requested, ready or failed stages. Payloads contain product and optional public dataset/object identifiers only. They exclude SQL, row values, filters, source/return URLs, error bodies and account identifiers. No collector or analytics SDK is installed by this feature. A host that forwards these events must use its existing explicit consent gate; pre-consent events must be dropped. QueryDock's website analytics remains excluded from SQL workspace routes.

## Acceptance

```sh
pnpm test
pnpm test:browser
```

The owned browser host binds only loopback and closes with its runner. It maps all DemoDB hosts to the built static bundles, with no production requests. Tests cover every profile, native keys/FKs, failed enhancement with static fallback, URL Back/Forward restoration, no-JavaScript meanings, phone overflow/header geometry, keyboard focus, touch targets and measured light/dark contrast. Browser artifacts are local and ignored.

The paired application's browser suite verifies the actual bundled SQLite engine, record selection and immutable example imports. Provider applications must be deployed and checked before publishing new consumer links. The SQLite catalogue contract is bidirectional: every advertised SQLite edition must be supported by released DataTug, with matching fixture bytes and SHA-256.

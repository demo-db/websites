import assert from 'node:assert/strict';
import { databases, databaseById, downloadFiles } from '../src/data/db';
import { ovdbDatabases } from '../src/data/ovdb';

assert.equal(new Set(databases.map((database) => database.id)).size, databases.length, 'provider IDs are unique');
for (const id of ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees', 'shipping', 'shipping-logs']) assert.ok(databaseById.has(id), `${id} remains registered`);
const descriptorById = new Map(ovdbDatabases.map((database) => [database.localId, database]));
for (const database of databases) {
  assert.equal(database.siteHost, `${database.id}.demodb.dev`);
  if (database.id !== 'shipping-logs') assert.ok(database.exports.some((file) => file.format === 'sqlite' && file.table === null), `${database.id} publishes SQLite`);
  assert.ok(database.tables.some((recordset) => recordset.kind === 'table'));
  const descriptor = descriptorById.get(database.id);
  assert.ok(descriptor, `${database.id} has a typed OVDB descriptor`);
  assert.equal(database.ovdb.readOnly, true, `${database.id} remains read-only`);
  assert.equal(typeof database.ovdb.query, 'boolean', `${database.id} declares query availability`);
  assert.equal(descriptor.capabilities.query, database.ovdb.declaredQuery, `${database.id} descriptor and provider query flags agree`);
  assert.equal(descriptor.capabilities.write, false, `${database.id} descriptor does not expose writes`);
}


for (const id of ['shipping', 'shipping-logs']) {
  const database = databaseById.get(id)!;
  assert.equal(database.ovdb.declaredAvailable, true, `\${id} keeps its provider declaration`);
  assert.equal(database.ovdb.deploymentVerified, false, `\${id} remains pending until live deployment is verified`);
  assert.equal(database.ovdb.available, false, `\${id} is excluded from callable admission`);
  assert.equal(database.ovdb.query, false, `\${id} makes no live query claim`);
}

const chinook = databaseById.get('chinook')!;
assert.equal(chinook.tables.filter((table) => table.kind === 'table').length, 11);
assert.ok(chinook.tables.some((table) => table.name === 'Artist' && table.description.length > 0));
assert.ok(chinook.exports.some((file) => file.publicPath === 'chinook.sqlite'));
assert.ok(chinook.exports.some((file) => file.publicPath === 'json/chinook.Artist.json'));
assert.ok(downloadFiles(chinook).every((file) => file.format !== 'metadata'), 'provider metadata remains available without being listed as data downloads');

const northwind = databaseById.get('northwind')!;
assert.equal(northwind.tables.filter((table) => table.kind === 'table').length, 13);
assert.equal(northwind.tables.filter((table) => table.kind === 'view').length, 17);
const details = northwind.tables.find((table) => table.name === 'Order Details')!;
assert.deepEqual(details.columns.filter((column) => column.primaryKey).map((column) => column.name), ['OrderID', 'ProductID']);
assert.ok(northwind.tables.find((table) => table.name === 'Employees')?.foreignKeys.some((fk) => fk.column === 'ReportsTo' && fk.table === 'Employees'));
assert.equal(northwind.tables.find((table) => table.name === 'CustomerDemographics')?.rowCount, 0);
assert.ok(details.rows.length > 0);
assert.ok(northwind.exports.some((file) => file.publicPath === 'json/northwind.Order Details.json'));

const pubs = databaseById.get('pubs')!;
assert.equal(pubs.tables.filter((table) => table.kind === 'table').length, 11);
assert.equal(pubs.tables.filter((table) => table.kind === 'view').length, 1);
assert.equal(pubs.ovdb.available, true, 'Pubs is published after its backend was mounted and verified');
assert.equal(pubs.ovdb.query, true, 'Pubs advertises its verified read-only query API');
assert.ok(pubs.tables.some((table) => table.name === 'pub_info' && table.columns.some((column) => column.name === 'logo' && column.type === 'BLOB')));
assert.ok(pubs.tables.some((table) => table.name === 'discounts' && table.columns.filter((column) => column.primaryKey).length === 0));
assert.ok(pubs.exports.some((file) => file.publicPath === 'pubs.sqlite'));
assert.ok(pubs.exports.some((file) => file.table === 'pub_info' && file.format === 'json'));

const sakila = databaseById.get('sakila')!;
assert.equal(sakila.tables.filter((table) => table.kind === 'table').length, 16);
assert.equal(sakila.tables.filter((table) => table.kind === 'view').length, 7);
assert.deepEqual(sakila.tables.find((table) => table.name === 'film_actor')?.columns.filter((column) => column.primaryKey).map((column) => column.name), ['actor_id', 'film_id']);
assert.ok(sakila.tables.find((table) => table.name === 'address')?.columns.some((column) => column.name === 'location' && /BLOB/i.test(column.type)));
assert.ok(sakila.tables.find((table) => table.name === 'staff')?.columns.some((column) => column.name === 'picture' && /BLOB/i.test(column.type)));
assert.ok(sakila.exports.some((file) => file.publicPath === 'sakila.sqlite'));
assert.ok(sakila.exports.some((file) => file.table === 'film_actor' && file.format === 'json'));

const adventureworks = databaseById.get('adventureworks')!;
assert.equal(adventureworks.tables.filter((table) => table.kind === 'table').length, 71);
assert.equal(adventureworks.tables.filter((table) => table.kind === 'view').length, 11, 'only the SQLite-executable native views are physical view recordsets');
assert.equal(adventureworks.schema.sourceViews?.length, 20, 'all original SQL Server views are retained as source metadata');
assert.equal(adventureworks.schema.sourceViews?.filter((view) => view.availableAsSqliteView).length, 11);
assert.equal(adventureworks.schema.sourceViews?.filter((view) => !view.availableAsSqliteView).length, 9, 'SQL Server-only definitions remain descriptive, not queryable');
assert.ok(adventureworks.schema.sourceViews?.some((view) => view.recordset === 'Person.vAdditionalContactInfo' && !view.availableAsSqliteView));
assert.ok(adventureworks.tables.some((table) => table.name === 'HumanResources.EmployeeDepartmentHistory' && table.columns.filter((column) => column.primaryKey).map((column) => column.name).join(',') === 'BusinessEntityID,DepartmentID,ShiftID,StartDate'));
assert.equal(adventureworks.exports.find((file) => file.format === 'sqlite' && file.table === null)?.decodedBytes, 126820352);
assert.equal(adventureworks.exports.find((file) => file.format === 'sqlite' && file.table === null)?.chunks?.length, 2);

const employees = databaseById.get('employees')!;
assert.equal(employees.tables.filter((table) => table.kind === 'table').length, 6);
assert.equal(employees.tables.filter((table) => table.kind === 'view').length, 2);
assert.deepEqual(employees.tables.find((table) => table.name === 'titles')?.columns.filter((column) => column.primaryKey).map((column) => column.name), ['emp_no', 'title', 'from_date']);
assert.deepEqual(employees.tables.find((table) => table.name === 'salaries')?.columns.filter((column) => column.primaryKey).map((column) => column.name), ['emp_no', 'from_date']);
assert.equal(employees.tables.find((table) => table.name === 'employees')?.rowCount, 1024);
assert.ok(employees.exports.some((file) => file.publicPath === 'employees.sqlite'));

const shipping = databaseById.get('shipping')!;
assert.equal(shipping.tables.filter((table) => table.kind === 'table').length, 10);
assert.equal(shipping.tables.filter((table) => table.kind === 'view').length, 2);
assert.deepEqual(shipping.tables.find((table) => table.name === 'requests')?.rows.filter((row) => [11038, 11045, 11062].includes(Number(row.order_id))).map((row) => row.order_id), [11038, 11045, 11062]);
assert.ok(shipping.exports.some((file) => file.publicPath === 'shipping.sqlite'));

const shippingLogs = databaseById.get('shipping-logs')!;
assert.equal(shippingLogs.tables.length, 3);
assert.deepEqual(shippingLogs.tables.map((table) => [table.name, table.rowCount]), [['baseline', 29], ['recovery11045example', 3], ['recovery11062example', 3]]);
assert.ok(shippingLogs.tables.every((table) => table.columns.some((column) => column.name === 'event_id' && column.primaryKey)));
assert.ok(shippingLogs.exports.some((file) => file.format === 'ingitdb' && file.publicPath === 'shipping-logs.ingitdb.tar.gz'));
assert.equal(shippingLogs.exports.filter((file) => file.format === 'jsonl').length, 3);
assert.ok(!shippingLogs.exports.some((file) => file.format === 'sqlite'), 'original logs are not converted to SQLite');

console.log('Provider registry includes the six established providers plus immutable Shipping and native Shipping Logs contracts and preserves their native schema.');

import assert from 'node:assert/strict';
import { databases, databaseById, downloadFiles } from '../src/data/db';

assert.equal(new Set(databases.map((database) => database.id)).size, databases.length, 'provider IDs are unique');
for (const id of ['chinook', 'northwind', 'pubs', 'sakila', 'adventureworks', 'employees']) assert.ok(databaseById.has(id), `${id} remains registered`);
for (const database of databases) {
  assert.equal(database.siteHost, `${database.id}.demodb.dev`);
  assert.ok(database.exports.some((file) => file.format === 'sqlite' && file.table === null), `${database.id} publishes SQLite`);
  assert.ok(database.tables.some((recordset) => recordset.kind === 'table'));
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
assert.equal(sakila.ovdb.query, false, 'Sakila does not advertise an unmounted query API');

const adventureworks = databaseById.get('adventureworks')!;
assert.equal(adventureworks.tables.filter((table) => table.kind === 'table').length, 71);
assert.equal(adventureworks.tables.filter((table) => table.kind === 'view').length, 11, 'only the SQLite-executable native views are physical view recordsets');
assert.equal(adventureworks.schema.sourceViews?.length, 20, 'all original SQL Server views are retained as source metadata');
assert.equal(adventureworks.schema.sourceViews?.filter((view) => view.availableAsSqliteView).length, 11);
assert.equal(adventureworks.schema.sourceViews?.filter((view) => !view.availableAsSqliteView).length, 9, 'SQL Server-only definitions remain descriptive, not queryable');
assert.ok(adventureworks.schema.sourceViews?.some((view) => view.recordset === 'Person.vAdditionalContactInfo' && !view.availableAsSqliteView));
assert.ok(adventureworks.tables.some((table) => table.name === 'HumanResources.EmployeeDepartmentHistory' && table.columns.filter((column) => column.primaryKey).map((column) => column.name).join(',') === 'BusinessEntityID,DepartmentID,ShiftID,StartDate'));
assert.equal(adventureworks.exports.find((file) => file.format === 'sqlite' && file.table === null)?.decodedBytes, 125276160);
assert.equal(adventureworks.exports.find((file) => file.format === 'sqlite' && file.table === null)?.chunks?.length, 2);
assert.equal(adventureworks.ovdb.query, false, 'AdventureWorks does not advertise an unmounted query API');

const employees = databaseById.get('employees')!;
assert.equal(employees.tables.filter((table) => table.kind === 'table').length, 6);
assert.equal(employees.tables.filter((table) => table.kind === 'view').length, 2);
assert.deepEqual(employees.tables.find((table) => table.name === 'titles')?.columns.filter((column) => column.primaryKey).map((column) => column.name), ['emp_no', 'title', 'from_date']);
assert.deepEqual(employees.tables.find((table) => table.name === 'salaries')?.columns.filter((column) => column.primaryKey).map((column) => column.name), ['emp_no', 'from_date']);
assert.equal(employees.tables.find((table) => table.name === 'employees')?.rowCount, 1024);
assert.ok(employees.exports.some((file) => file.publicPath === 'employees.sqlite'));
assert.equal(employees.ovdb.query, false, 'Employees does not advertise an unmounted query API');

console.log('Provider registry includes validated Chinook, Northwind, Pubs, Sakila, AdventureWorks, and Employees contracts and preserves their native schema.');

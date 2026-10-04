import assert from 'node:assert/strict';
import { databases, databaseById, downloadFiles } from '../src/data/db';

assert.deepEqual(databases.map((database) => database.id), ['chinook', 'northwind']);
assert.equal(databaseById.size, 2);
for (const database of databases) {
  assert.equal(database.siteHost, `${database.id}.demodb.dev`);
  assert.ok(database.exports.some((file) => file.format === 'sqlite' && file.table === null), `${database.id} publishes SQLite`);
  assert.ok(database.tables.some((recordset) => recordset.kind === 'table'));
  assert.ok(database.ovdb.available, `${database.id} advertises its OVDB capability`);
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

console.log('Provider registry includes validated Chinook and Northwind contracts and preserves their native schema.');

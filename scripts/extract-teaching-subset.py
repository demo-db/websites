"""Extract bounded relational teaching inputs from checked generated SQLite exports.
Question-relevant tables start with eight native rows; FK parent closure is retained.
Never use this subset to claim complete-database totals.
"""
import sqlite3, json, sys, pathlib, gzip, hashlib, re
root = pathlib.Path(sys.argv[1]).resolve()
metadata = json.loads((root/'src/data/generated/index.json').read_text())
quote = lambda name: '"' + name.replace('"', '""') + '"'
notices = json.loads((root/'config/querydock-notices.json').read_text())
output = []
roots = {
 'chinook':['Track','Invoice'], 'northwind':['Orders','Products'],
 'pubs':['titles','titleauthor','sales'], 'sakila':['film','rental','payment'],
 'adventureworks':['Sales.SalesOrderHeader','Sales.SalesOrderDetail','Purchasing.PurchaseOrderHeader','Production.ProductInventory'],
 'employees':['salaries','dept_emp'], 'shipping':['shipping_requests','current_routes'],
}
for db in metadata['databases']:
    fixture = next((item for item in db['exports'] if item['format'] == 'sqlite' and item['table'] is None), None)
    if not fixture or not db['queries']: continue
    file = root/'public/_db'/db['id']/'data'/fixture['assetPath']
    if fixture.get('compression') == 'gzip':
        body = gzip.decompress(b''.join((root/'public/_db'/db['id']/'data'/part['assetPath']).read_bytes() for part in fixture['chunks']))
    else: body = file.read_bytes()
    if hashlib.sha256(body).hexdigest() != (fixture.get('decodedSha256') or fixture['sha256']): raise ValueError('Fixture checksum mismatch')
    conn = sqlite3.connect(':memory:'); conn.deserialize(body)
    tables = [table for table in db['tables'] if table['kind'] == 'table']
    selected = {}; columns = {}; foreign = {}
    for table in tables:
        name = table['name']
        columns[name] = [row[1] for row in conn.execute('PRAGMA table_info('+quote(name)+')')]
        fields = ','.join(map(quote, columns[name]))
        selected[name] = {tuple(row) for row in conn.execute('SELECT '+fields+' FROM '+quote(name)+' LIMIT 8')} if db['id'] == 'shipping' or name in roots[db['id']] else set()
        groups = {}
        for row in conn.execute('PRAGMA foreign_key_list('+quote(name)+')'): groups.setdefault(row[0], []).append(row)
        foreign[name] = groups.values()
    changed = True
    while changed:
        changed = False
        for name in selected:
            for relation in foreign[name]:
                target = relation[0][2]
                if target not in selected: raise ValueError('Unknown FK parent '+target)
                parent_pk = [row[1] for row in sorted(conn.execute('PRAGMA table_info('+quote(target)+')'), key=lambda row: row[5]) if row[5]]
                pairs = [(columns[name].index(row[3]), row[4] or parent_pk[row[1]]) for row in relation]
                sql = 'SELECT '+','.join(map(quote,columns[target]))+' FROM '+quote(target)+' WHERE '+' AND '.join(quote(field)+' = ?' for _,field in pairs)
                for row in list(selected[name]):
                    values = [row[index] for index,_ in pairs]
                    if any(value is None for value in values): continue
                    for parent in conn.execute(sql, values):
                        parent = tuple(parent)
                        if parent not in selected[target]: selected[target].add(parent); changed = True
    schemas = [row[0] for row in conn.execute("SELECT sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name")]
    views = [row[0] for row in conn.execute("SELECT sql FROM sqlite_schema WHERE type='view' AND sql IS NOT NULL ORDER BY name")]
    def literal(value):
        if value is None: return 'NULL'
        if isinstance(value, bytes): return "X'"+value.hex()+"'"
        if isinstance(value, str): return "'"+value.replace("'", "''")+"'"
        return str(value)
    seed = '-- '+db['name']+' teaching subset. Source '+db['sourceRepository']+' @ '+str(db['sourceCommit'])+'\n-- Data licence: '+str(db['source'].get('license','See source licence'))+'. Preserve upstream notices.\n'
    for name, rows in selected.items():
        for row in sorted(rows, key=lambda row: json.dumps(row,default=str,ensure_ascii=False)):
            seed += 'INSERT INTO '+quote(name)+' ('+','.join(map(quote,columns[name]))+') VALUES ('+','.join(map(literal,row))+');\n'
    notice = notices[db['id']]
    if notice['revision'] != db['sourceCommit']: raise ValueError('Stale source notices')
    notice_sql = ''
    for item in notice['files']:
        if hashlib.sha256(item['text'].encode()).hexdigest() != item['sha256']: raise ValueError('Notice checksum mismatch')
        notice_sql += '-- '+item['path']+' @ '+db['sourceCommit']+'\n'+'\n'.join('-- '+line for line in item['text'].splitlines())+'\n'
    # Only import timing changes: all native columns and FK pairs are retained.
    references = re.compile(r'REFERENCES\s+(?:"(?:[^"]|"")*"|\[[^]]*\]|`[^`]*`|[A-Za-z0-9_.]+)(?:\s*\([^)]*\))?(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:SET\s+(?:NULL|DEFAULT)|NO\s+ACTION|CASCADE|RESTRICT))*', re.I)
    schemas = [references.sub(lambda match: match.group(0)+' DEFERRABLE INITIALLY DEFERRED', sql) for sql in schemas]
    schema = '-- Derived teaching fixture: bounded source rows and foreign-key parent closure.\n-- Data licence: '+str(db['source'].get('license'))+'; source '+db['sourceRepository']+' @ '+db['sourceCommit']+'\n'+notice_sql+'-- Teaching import: foreign keys are deferred until the seed transaction commits.\n'+';\n'.join(schemas+views)+';\n'
    seed = 'BEGIN;\n'+seed+'COMMIT;\n'
    if len(seed.encode()) > 384*1024: raise ValueError('Teaching seed exceeds bound '+db['id']+' '+str(len(seed.encode())))
    check = sqlite3.connect(':memory:'); check.execute('PRAGMA foreign_keys=ON'); check.executescript(schema)
    try: check.executescript(seed)
    except sqlite3.IntegrityError as error:
        raise ValueError(db['id']+' import failed: '+str(error)+'; '+str(list(check.execute('PRAGMA foreign_key_check')))) from error
    if list(check.execute('PRAGMA foreign_key_check')): raise ValueError('Subset FK closure incomplete '+db['id'])
    examples = []
    for index,query in enumerate(db['queries']):
        cursor = check.execute(query['sql']); rows = cursor.fetchall()
        examples.append({'id': 'example-'+str(index+1), **query, 'expected': {'columns':[column[0] for column in cursor.description], 'rowCount':len(rows), 'rows':[list(row) for row in rows[:5]], 'allRows':[list(row) for row in rows]}})
    output.append({'id':db['id'], 'name':db['name'], 'sourceRevision':db['sourceCommit'], 'fixtureSha256':hashlib.sha256(body).hexdigest(), 'licence':db['source'].get('license'), 'sourceRepository':db['sourceRepository'], 'rowCounts':{name:len(rows) for name,rows in selected.items()}, 'schemaSql':schema, 'seedSql':seed, 'rootTables':roots[db['id']] if db['id'] != 'shipping' else list(selected), 'examples':examples})
print(json.dumps(output,ensure_ascii=False))

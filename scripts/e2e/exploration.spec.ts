import { test, expect, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const metadata=JSON.parse(readFileSync(resolve('src/data/generated/index.json'),'utf8')) as {databases:{id:string;name:string;tables:{name:string;kind:string}[]}[]};
async function mapHosts(context:BrowserContext){await context.route('**/*',async route=>{const url=new URL(route.request().url());if(/^(?:[a-z0-9-]+\.)?demodb\.dev$/u.test(url.hostname)){const response=await route.fetch({url:`${process.env.DEMODB_ACCEPTANCE_ORIGIN}/__host/${url.hostname}${url.pathname}${url.search}`});await route.fulfill({response});}else await route.abort();});}
test.beforeEach(async({context})=>mapHosts(context));
for(const db of metadata.databases)test(`${db.name}: profile meanings remain below tables and contextual actions are separate`,async({page})=>{
 await page.goto(`https://${db.id}.demodb.dev/`);await expect(page.locator('.profile-meanings')).toBeVisible();
 expect(await page.locator('.profile-meanings').evaluate(element=>element.getBoundingClientRect().top)).toBeGreaterThan(await page.locator('.table-grid').first().evaluate(element=>element.getBoundingClientRect().top));
 await expect(page.locator('.profile-tool-list')).toContainText('QueryDock');
 await page.goto(`https://${db.id}.demodb.dev/tables/`);
 await expect(page.locator('[data-recordset-results] [data-recordset]')).toHaveCount(db.tables.length);
 await expect(page.locator('a a')).toHaveCount(0);
 const action=page.locator('[data-handoff="codegrapher"]').first();await expect(action).toBeVisible();expect(new URL((await action.getAttribute('href'))!).searchParams.get('node')).toMatch(/^table:/);
});
test('catalogue facets and table controls restore Back/Forward state without overwriting the destination URL',async({page})=>{
 await page.goto('https://demodb.dev/?q=Customer&format=sqlite');await expect(page.getByRole('searchbox')).toHaveValue('Customer');
 await page.evaluate(()=>{history.pushState(null,'',location.href+'#databases');});
 await page.getByRole('searchbox').fill('not-a-table');await expect(page.locator('[data-empty]')).toBeVisible();
 await page.goBack();await expect(page.getByRole('searchbox')).toHaveValue('Customer');await expect(page).toHaveURL(/q=Customer/);
 await page.goForward();await expect(page.getByRole('searchbox')).toHaveValue('not-a-table');
 await page.goto('https://adventureworks.demodb.dev/tables/?q=Sales&kind=table&layout=list');await expect(page.getByRole('searchbox')).toHaveValue('Sales');
 await page.evaluate(()=>history.pushState(null,'',location.href+'#main'));await page.getByRole('searchbox').fill('Production');await page.goBack();await expect(page.getByRole('searchbox')).toHaveValue('Sales');await expect(page).toHaveURL(/q=Sales/);
});
test('grid selection, keyboard sort and FK links keep native record context',async({page})=>{
 await page.goto('https://chinook.demodb.dev/tables/Album/');
 const grid=page.locator('datatug-grid');await expect(grid.locator('tbody tr')).toHaveCount(50);
 await expect(page.locator('[data-static-preview]')).toBeHidden();
 const sort=grid.getByRole('button',{name:'AlbumId',exact:true});await sort.focus();await page.keyboard.press('Enter');await expect(grid.getByRole('button',{name:'AlbumId ↑'})).toBeFocused();
 await grid.locator('tbody tr').first().press('Enter');await expect(page.locator('[data-selected-record]')).toBeVisible();
 const href=await page.locator('[data-record-datatug]').getAttribute('href');expect(JSON.parse(new URL(href!).searchParams.get('recordKey')!)).toEqual({AlbumId:1});
 await grid.locator('tbody tr').first().getByRole('link').first().press('Enter');
 await expect(page).toHaveURL(/\/tables\/Artist\/.*rows=/);await expect(page.locator('datatug-grid .footer')).toContainText('1 matching rows');
 await page.reload();await expect(page.locator('datatug-grid tbody tr')).toHaveCount(1);
});
test('interactive load failure retains static records and invalid state has explicit recovery',async({page})=>{
 await page.route('**/data/json/chinook.Album.json',route=>route.abort());await page.goto('https://chinook.demodb.dev/tables/Album/');
 await expect(page.locator('datatug-grid [role="alert"]')).toBeVisible();await expect(page.locator('[data-static-preview]')).toBeVisible();
 await page.unroute('**/data/json/chinook.Album.json');await page.goto('https://chinook.demodb.dev/tables/Album/?rows=%7B%22filter%22%3A%7B%22missing%22%3A1%7D%7D');await expect(page.getByRole('button',{name:'Clear invalid table link'})).toBeVisible();await page.getByRole('button',{name:'Clear invalid table link'}).click();await expect(page.locator('datatug-grid tbody tr')).toHaveCount(50);
});
test('mobile utility pages fit the viewport and principal controls meet touch size',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:844});
 for(const path of ['https://demodb.dev/','https://adventureworks.demodb.dev/tables/','https://chinook.demodb.dev/tables/Album/','https://chinook.demodb.dev/downloads/','https://shipping.demodb.dev/learn/','https://demodb.dev/concepts/?q=customer']){
  await page.goto(path);expect(await page.locator('.site-header').evaluate(header=>header.getBoundingClientRect().bottom >= header.querySelector('nav')!.getBoundingClientRect().bottom),path).toBe(true);if(path.endsWith('/tables/Album/'))await page.screenshot({path:testInfo.outputPath('table-phone.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path).toBe(true);
  for(const control of await page.locator('.discovery-controls input,.discovery-controls select,.table-actions a').all()){if(await control.isVisible())expect((await control.boundingBox())!.height,path).toBeGreaterThanOrEqual(44);}
 }
});
test('JavaScript-free profile still expands all entity bindings and offers data fallback',async({browser})=>{
 const context=await browser.newContext({javaScriptEnabled:false});await mapHosts(context);const page=await context.newPage();await page.goto('https://chinook.demodb.dev/');const more=page.locator('.profile-meanings details summary');await more.click();await expect(page.locator('.profile-meanings details ul')).toBeVisible();await page.goto('https://chinook.demodb.dev/tables/Album/');await expect(page.locator('[data-static-preview]')).toBeVisible();await context.close();
});

test('light and dark text, form boundaries and focus colors meet measured contrast',async({page},testInfo)=>{
 const luminance=(hex:string)=>{const channels=hex.trim().slice(1).match(/../g)!.map(part=>parseInt(part,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
 const ratio=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 await page.goto('https://chinook.demodb.dev/tables/Album/');
 const measurements:Record<string,number>={};
 for(const theme of ['light','dark']){
  if(theme==='dark')await page.locator('[data-theme-toggle]').click();
  const tokens=await page.evaluate(()=>{const style=getComputedStyle(document.documentElement);return Object.fromEntries(['ink','muted','faint','cyan','lime','bg','panel','control-border','console-comment','code-surface','null-color'].map(name=>[name,style.getPropertyValue('--'+name).trim()]));});
  for(const text of ['ink','muted','faint','cyan','lime','null-color']){const value=ratio(tokens[text],tokens.panel);measurements[theme+'.'+text]=value;expect(value,text+' in '+theme).toBeGreaterThanOrEqual(4.5);}
  expect(ratio(tokens['control-border'],tokens.panel)).toBeGreaterThanOrEqual(3);expect(ratio(tokens.cyan,tokens.bg)).toBeGreaterThanOrEqual(3);
  await page.locator('.table-actions a').first().focus();await expect(page.locator('.table-actions a').first()).toBeFocused();
 }
 await testInfo.attach('contrast-ratios',{body:JSON.stringify(measurements,null,2),contentType:'application/json'});
});

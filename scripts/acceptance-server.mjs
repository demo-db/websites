/** Read-only local acceptance host. Owner: invoking DemoDB test/preview process.
 * Teardown: test runner finally/server.close, or Ctrl-C for --preview. No daemon.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(import.meta.dirname,'../dist-hosts');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm'};
export async function acceptanceServer() {
 await readFile(resolve(root,'demodb.dev/index.html'));
 const server = createServer(async(req,res)=>{
  try {
   const url = new URL(req.url,'http://localhost'); let host=(req.headers.host??'').split(':')[0]; let path=url.pathname;
   const mapping=/^\/__host\/([a-z0-9.-]+)(\/.*)$/u.exec(path);
   if(mapping){host=mapping[1];path=mapping[2];} else host=host==='localhost'||host==='127.0.0.1'?'demodb.dev':host.replace(/\.localhost$/u,'.demodb.dev');
   if(!/^(?:[a-z0-9-]+\.)?demodb\.dev$/u.test(host)) throw Error('Unknown host');
   const directory=resolve(root,host); let file=resolve(directory,'.'+decodeURIComponent(path));
   if(!file.startsWith(directory+'/') && file!==directory) throw Error('Invalid path');
   if(path.endsWith('/'))file=resolve(file,'index.html');
   let body;try{body=await readFile(file);}catch{file=resolve(file,'index.html');body=await readFile(file);}
   res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}).end(body);
  } catch {res.writeHead(404).end('Not found');}
 });
 await new Promise((done)=>server.listen(0,'127.0.0.1',done));
 const origin=`http://127.0.0.1:${server.address().port}`;
 console.log(`DemoDB acceptance owner=pid ${process.pid} origin=${origin}; teardown=server.close/Ctrl-C`);
 return {server,origin,close:async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const host=await acceptanceServer();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void host.close());
}

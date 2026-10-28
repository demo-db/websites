import { spawn } from 'node:child_process';
import { acceptanceServer } from './acceptance-server.mjs';
const host=await acceptanceServer();
const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','-c','scripts/e2e/playwright.config.ts',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,DEMODB_ACCEPTANCE_ORIGIN:host.origin}});
const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{process.exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});}finally{await host.close();}

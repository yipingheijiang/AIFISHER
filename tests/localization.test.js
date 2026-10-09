import '../server/security/installOutboundPolicy.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import nodeFetch from 'node-fetch';
import express from 'express';
import { Agent } from 'undici';
import { WebSocketServer } from 'ws';
import { assertIndependentUrl, isRemovedServiceHost } from '../server/security/offlinePolicy.js';
import { createLocalWorkspace, chooseLocalWorkspace } from '../apps/desktop/src/localWorkspace.mjs';
import { createModelSourceRouter } from '../server/generation/modelSourceRouter.js';
import { loadModelCatalog } from '../server/config/modelCatalog.js';
import { GENERATION_PROVIDER_CONTRACTS } from '../server/generation/generationProviderCatalog.js';
import { createGenerationTaskRecovery } from '../server/generation/generationTaskRecovery.js';
import { createConfigRouter } from '../server/routes/config.js';
import { fetchExternalUrl } from '../server/security/externalUrlPolicy.js';
import { BaseProvider } from '../server/providers/baseProvider.js';
import { GptTextProvider } from '../server/providers/gptProvider.js';
import { comfyClient } from '../server/comfyui/comfyClient.js';
import { createProviderCredentialStore } from '../scripts/release/providerCredentialStore.mjs';

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, server); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function withDirectory(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aifisher-local-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
describe('local workspace persistence', () => {
  it('reads existing independent credentials when an old relay key is also present', async () => withDirectory(async dir => {
    const filePath=path.join(dir,'credentials.bin');
    const protector={protect:async bytes=>Buffer.from(bytes),unprotect:async bytes=>Buffer.from(bytes)};
    const old=createProviderCredentialStore({filePath,allowedKeys:['OPENAI_API_KEY','RELAY_API_KEY'],protector});
    await old.replace({OPENAI_API_KEY:'independent-test-key',RELAY_API_KEY:'retired-test-key'});
    const bytes=await readFile(filePath);
    const local=createProviderCredentialStore({filePath,allowedKeys:['OPENAI_API_KEY'],protector});
    expect(await local.read()).toEqual({OPENAI_API_KEY:'independent-test-key'});
    expect(await readFile(filePath)).toEqual(bytes);
    await expect(local.update({RELAY_API_KEY:'refused'})).rejects.toThrow();
  }));
  it('migrates only the existing UUID and preserves all old encrypted state', async () => withDirectory(async dir => {
    const id = randomUUID(), secret = 'private-device-secret';
    const legacyDevicePath = path.join(dir, 'device-identity.bin');
    const bytes = Buffer.concat([Buffer.from('AFDEVICE1'), Buffer.from(JSON.stringify({localUserId:id,secret,refreshToken:'old-cloud-token'}))]);
    await writeFile(legacyDevicePath, bytes);
    const options = {filePath:path.join(dir,'local-workspace.json'),legacyDevicePath,decryptString:bytes=>bytes.toString(),resolveLocalUser:()=>{throw Error('must retain UUID');}};
    const workspace = createLocalWorkspace(options);
    await workspace.restore(); expect(workspace.userId()).toBe(id);
    const saved = await readFile(options.filePath,'utf8');
    expect(JSON.parse(saved)).toEqual({version:1,workspaceId:id});
    expect(saved).not.toContain(secret); expect(saved).not.toContain('old-cloud-token');
    expect(await readFile(legacyDevicePath)).toEqual(bytes);
    const second = randomUUID(); await workspace.selectLocalUser(second);
    const restarted = createLocalWorkspace(options); await restarted.restore(); expect(restarted.userId()).toBe(second);
    await expect(restarted.selectLocalUser('../other')).rejects.toThrow();
  }));
  it('chooses an existing workspace and refuses to replace a damaged record', async () => withDirectory(async dir => {
    const id = randomUUID(); await mkdir(path.join(dir,id));
    expect(await chooseLocalWorkspace({usersDirectory:dir})).toBe(id);
    await expect(chooseLocalWorkspace({usersDirectory:dir,forceChoice:true,choose:()=>null})).rejects.toThrow();
    const filePath = path.join(dir,'local-workspace.json'); await writeFile(filePath,'broken');
    await expect(createLocalWorkspace({filePath,legacyDevicePath:path.join(dir,'missing'),resolveLocalUser:()=>id}).restore()).rejects.toThrow();
    expect(await readFile(filePath,'utf8')).toBe('broken');
  }));
});
describe('independent network boundary', () => {
  it('rejects removed hosts before all supported HTTP transports connect', async () => {
    for (const url of ['https://work-fisher.com','https://API.Work-Fisher.COM./a','http://x.y.work-fisher.com','https://user:pass@identity.work-fisher.com']) {
      expect(() => assertIndependentUrl(url)).toThrow();
      await expect(fetch(url)).rejects.toThrow();
      await expect(nodeFetch(url)).rejects.toThrow();
      expect(() => http.get(url.replace('https:','http:'))).toThrow();
    }
    await expect(fetch(new URL('https://work-fisher.com'))).rejects.toThrow();
    await expect(fetch(new Request('https://work-fisher.com'))).rejects.toThrow();
    expect(isRemovedServiceHost('work-fisher.com.attacker.invalid')).toBe(false);
    expect(assertIndependentUrl('http://localhost:8188').hostname).toBe('localhost');
  });
  it('blocks redirect hops including custom dispatchers and provider downloads', async () => {
    await withServer((_req,res)=>res.writeHead(302,{Location:'https://api.work-fisher.com/secret'}).end(), async base => {
      await expect(fetch(base)).rejects.toThrow();
      await expect(nodeFetch(base)).rejects.toThrow();
      await expect(BaseProvider.asyncDownloadToBuffer(base,false)).rejects.toThrow();
      const dispatcher = new Agent();
      try { await expect(fetch(base,{dispatcher})).rejects.toThrow(); }
      finally { await dispatcher.close(); }
    });
    for (const status of [301,302,307,308]) {
      const fetchImpl=vi.fn(async()=>({status,headers:new Headers({Location:'https://api.work-fisher.com/'})}));
      const resolveHost=vi.fn(async()=>[{address:'8.8.8.8'}]);
      await expect(fetchExternalUrl('https://independent.invalid',{fetchImpl,resolveHost})).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(resolveHost).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects dynamic URLs at config save without changing keys or data', async () => withDirectory(async dir => {
    const envPath=path.join(dir,'providers.env'); await writeFile(envPath,'');
    const credentialStore={read:async()=>({}),update:vi.fn()};
    const app=express(); app.use(express.json());app.use(createConfigRouter({envPath,modelNames:[],credentialStore,logger:{log(){},error(){}}}));
    await withServer(app,async base=>{
      const response=await fetch(base+'/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({MODEL_URL_TEST:'https://api.work-fisher.com/v1',OPENAI_API_KEY:'test-value'})});
      expect(response.status).toBe(400);expect((await response.json()).code).toBe('REMOVED_SERVICE_URL');
      expect(credentialStore.update).not.toHaveBeenCalled();expect(await readFile(envPath,'utf8')).toBe('');
      expect((await fetch(base+'/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({MODEL_URL_TEST:base+'/v1'})})).status).toBe(200);
    });
  }));
  it('keeps IPv6 loopback transports and rejects a removed-service proxy', async () => {
    const server=http.createServer((_req,res)=>res.end('ipv6-local'));
    await new Promise(resolve=>server.listen(0,'::1',resolve));
    try {
      const text=await new Promise((resolve,reject)=>{
        http.get({hostname:'::1',port:server.address().port,path:'/'},res=>{
          let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve(data));
        }).on('error',reject);
      });
      expect(text).toBe('ipv6-local');
      const wsServer=new WebSocketServer({server});
      const {WebSocket}=await import('ws');
      const socket=new WebSocket(`ws://[::1]:${server.address().port}/ws`);
      await new Promise((resolve,reject)=>{socket.on('open',resolve);socket.on('error',reject);});
      socket.terminate();for(const client of wsServer.clients)client.terminate();await new Promise(resolve=>wsServer.close(resolve));
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    const prior=process.env.HTTPS_PROXY;process.env.HTTPS_PROXY='http://api.work-fisher.com:8888';
    try {expect(()=>BaseProvider.injectProxy({},true)).toThrow();}
    finally {if(prior===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=prior;}
  });
});
describe('removed account and relay lifecycle', () => {
  it('loads model menus with zero outbound fetches and retains independent sources', async () => {
    const catalog=loadModelCatalog();expect(Object.values(catalog).filter(model=>model.provider!=='CodexImageProvider')).toHaveLength(71);
    expect(catalog['Codex 内置生图']?.provider).toBe('CodexImageProvider');
    expect(Object.values(catalog).some(m=>m.source==='relay'||m.provider.startsWith('Relay'))).toBe(false);
    expect(GENERATION_PROVIDER_CONTRACTS.some(c=>c.name.startsWith('Relay'))).toBe(false);
    const app=express();app.use(createModelSourceRouter({catalog,readSecret:()=>''}));
    await withServer(app,async base=>{
      const original=globalThis.fetch; const spy=vi.fn(()=>{throw Error('unexpected background network');});
      globalThis.fetch=spy;
      try {
        for(const endpoint of ['/generation/sources','/generation/model-availability','/generation/model-availability?mode=text-to-video']) {
          const response=await original(base+endpoint);expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain('work-fisher.com');
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {globalThis.fetch=original;}
    });
  });
  it('stops legacy Relay recovery without querying or resubmitting', async () => {
    const resolveProvider=vi.fn(),saveResult=vi.fn();
    const recover=createGenerationTaskRecovery({coordinator:{},resolveProvider,saveResult});
    const task={providerName:'RelayVideoProvider',status:'unknown',code:'GENERATION_INTERRUPTED',attemptId:'old',remoteTask:{taskId:'old'}};
    const result=await recover(task,{});expect(result.code).toBe('LOCAL_EDITION_SOURCE_REMOVED');expect(result.status).toBe('failed');
    expect(task.status).toBe('unknown');expect(resolveProvider).not.toHaveBeenCalled();expect(saveResult).not.toHaveBeenCalled();
    const success={...task,status:'success',resultUrl:'/library/media/old.mp4'};expect(await recover(success,{})).toBe(success);
  });
});
describe('local provider compatibility (mock, no paid service)', () => {
  it('generates text through a user-configured loopback endpoint', async () => {
    await withServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      expect(JSON.parse(body).model).toBe('local-model');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'local mock result'}}]}));
    }, async base=>{
      const result=await GptTextProvider.generateText({nodeId:'local-test',prompt:'test',textModel:'local-model',url:base+'/v1/chat/completions',useProxy:false},{OPENAI_API_KEY:'local-test-key'});
      expect(JSON.stringify(result)).toContain('local mock result');
    });
  });
  it('submits a ComfyUI workflow and reads its result over localhost HTTP/WebSocket', async () => {
    const prior=process.env.COMFYUI_SERVER_URL;
    let wsServer;
    await withServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(req.url==='/prompt') {
        for await(const chunk of req)void chunk;
        res.end(JSON.stringify({prompt_id:'local-prompt'}));
        setTimeout(()=>{for(const client of wsServer.clients)client.send(JSON.stringify({type:'executing',data:{node:null,prompt_id:'local-prompt'}}));},25);
      } else res.end(JSON.stringify({'local-prompt':{outputs:{'1':{images:[{filename:'local.png',subfolder:'',type:'output'}]}}}}));
    },async(base,server)=>{
      wsServer=new WebSocketServer({server});
      process.env.COMFYUI_SERVER_URL=new URL(base).host;
      try {expect(await comfyClient.queuePrompt({'1':{class_type:'SaveImage',inputs:{}}},2000,'1')).toContain('/view?filename=local.png');}
      finally {comfyClient.ws?.terminate();comfyClient.ws=null;for(const client of wsServer.clients)client.terminate();await new Promise(resolve=>wsServer.close(resolve));}
    });
    if(prior===undefined)delete process.env.COMFYUI_SERVER_URL;else process.env.COMFYUI_SERVER_URL=prior;
  });
});

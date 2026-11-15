import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterAll,beforeAll,it,expect} from 'vitest';

// Execute the real formatter and transpiled projection in workerd, not Node's
// Intl. Explicit modules retain their actual import paths; no copied renderer,
// production credentials, remote bindings or persistent database are involved.
let mf:Miniflare;
beforeAll(()=>{
 const projection=ts.transpileModule(readFileSync('src/provenance-time.ts','utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
 }).outputText;
 mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2025-06-01',modulesRoot:resolve('.'),modules:[
  {type:'ESModule',path:resolve('test/provenance-time-worker.mjs'),contents:`
   import {createProvenanceTimePresentation} from '../src/provenance-time';
   export default {async fetch(request){
    const {zone,rows}=await request.json();
    try {return Response.json(createProvenanceTimePresentation(zone).project(rows));}
    catch {return Response.json({error:'invalid_time_zone'},{status:400});}
   }};`},
  {type:'ESModule',path:resolve('src/provenance-time'),contents:projection},
  {type:'ESModule',path:resolve('cf-memory-agent/scripts/time-zone.mjs'),contents:readFileSync('cf-memory-agent/scripts/time-zone.mjs','utf8')},
 ]}));
});
afterAll(async()=>{await mf?.dispose();});
const row=(at:unknown,imported=false)=>({event_id:'event-a',source_session_id:'session-a',actor_id:'alice',relation:'derived_from',created_at:1792038296825,source:{occurred_at:at,imported}});
async function read(zone:unknown,rows:ReturnType<typeof row>[]){
 return mf.dispatchFetch('http://clock.test/',{method:'POST',body:JSON.stringify({zone,rows})});
}
it('actual workerd Intl renders UTC, Tokyo midnight and historical seconds offsets from the same source',async()=>{
 for(const [zone,at,date_time,offset] of [
  ['UTC',1791988971552,'2026-10-14T14:42:51.552',0],
  ['Asia/Tokyo',1791988971552,'2026-10-14T23:42:51.552',32400],
  ['Asia/Tokyo',Date.parse('2026-10-14T15:00:00.001Z'),'2026-10-15T00:00:00.001',32400],
  ['Africa/Monrovia',0,'1969-12-31T23:15:30.000',-2670],
 ] as const){
  const response=await read(zone,[row(at)]);expect(response.status).toBe(200);
  const output=await response.json();expect(output).toMatchObject({time_zone:zone,entries:[{source_time:{local:{date_time,time_zone:zone,utc_offset_seconds:offset},basis:'recorded_source_event'}}]});
 }
});
it('actual workerd keeps repeated DST hours distinct, imported claims explicit and unknown dates null',async()=>{
 const response=await read('America/New_York',[row(Date.parse('2026-11-01T05:30:00Z')),row(Date.parse('2026-11-01T06:30:00Z')),row(null,true)]);
 expect(await response.json()).toMatchObject({entries:[
  {source_time:{local:{date_time:'2026-11-01T01:30:00.000',utc_offset_seconds:-14400}}},
  {source_time:{local:{date_time:'2026-11-01T01:30:00.000',utc_offset_seconds:-18000}}},
  {source_time:{utc_iso:null,local:null,basis:'imported_claim'},provenance_created_at:{utc_iso:'2026-10-15T04:24:56.825Z'}},
 ]});
});
it('actual workerd refuses invalid and numeric-only zones without echoing input',async()=>{
 for(const zone of ['+09','+0900','-05','Asia/Tokyo\nSECRET','not/a/zone',null]){
  const response=await read(zone,[row(0)]);expect(response.status).toBe(400);
  expect(await response.json()).toEqual({error:'invalid_time_zone'});
 }
});

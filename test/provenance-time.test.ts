import {describe,it,expect} from 'vitest';
import {createProvenanceTimePresentation as clock} from '../src/provenance-time';
const row=(occurred_at:unknown,created_at:unknown=1792038296825,extra={})=>({event_id:'event-a',source_session_id:'session-a',actor_id:'alice',relation:'derived_from',created_at,source:{occurred_at,...extra}});
const source=(zone:unknown,value:unknown)=>clock(zone).project([row(value)]).entries[0].source_time;
describe('provenance read-only time display',()=>{
 it('fixes actual67 historic day/time error without changing the original epoch or provenance record time',()=>{
  const old=row(1791988971552),before=JSON.stringify(old),out=clock('Asia/Tokyo').project([old]).entries[0];
  expect(out.source_time).toEqual({utc_iso:'2026-10-14T14:42:51.552Z',local:{date_time:'2026-10-14T23:42:51.552',time_zone:'Asia/Tokyo',utc_offset_seconds:32400},basis:'recorded_source_event'});
  expect(out.provenance_created_at.utc_iso).toBe('2026-10-15T04:24:56.825Z');expect(JSON.stringify(old)).toBe(before);
 });
 it('UTC default and Tokyo midnight retain milliseconds and an explicit zone rather than guessing a date',()=>{
  const at=Date.parse('2026-10-14T15:00:00.001Z');
  expect(source(undefined,at).local).toMatchObject({date_time:'2026-10-14T15:00:00.001',time_zone:'UTC',utc_offset_seconds:0});
  expect(source('Asia/Tokyo',at).local).toMatchObject({date_time:'2026-10-15T00:00:00.001',utc_offset_seconds:32400});
 });
 it('DST repeated civil hours remain distinct through their exact offsets',()=>{
  const a=source('America/New_York',Date.parse('2026-11-01T05:30:00Z')),b=source('America/New_York',Date.parse('2026-11-01T06:30:00Z'));
  expect(a.local?.date_time).toBe('2026-11-01T01:30:00.000');expect(b.local?.date_time).toBe(a.local?.date_time);
  expect(a.local?.utc_offset_seconds).toBe(-14400);expect(b.local?.utc_offset_seconds).toBe(-18000);expect(a.utc_iso).not.toBe(b.utc_iso);
 });
 it('historical seconds offsets are not rounded or falsely labeled as RFC3339',()=>{
  expect(source('Africa/Monrovia',0)).toEqual({utc_iso:'1970-01-01T00:00:00.000Z',local:{date_time:'1969-12-31T23:15:30.000',time_zone:'Africa/Monrovia',utc_offset_seconds:-2670},basis:'recorded_source_event'});
 });
 it('missing/string/fractional/out-of-range times remain unknown, never coerced or replaced by created_at',()=>{
  for(const value of [undefined,null,'1791988971552',1.5,NaN,Infinity,-1,253402300800000,Number.MAX_SAFE_INTEGER]){
   const out=source('UTC',value);expect(out).toEqual({utc_iso:null,local:null,basis:'unknown'});
  }
  expect(source('UTC',0).utc_iso).toBe('1970-01-01T00:00:00.000Z');expect(source('UTC',253402300799999).utc_iso).toBe('9999-12-31T23:59:59.999Z');
 });
 it('imported dates remain expressly claims, never certified observations; identity and relation stay tied to each row',()=>{
  const rows=[row(0,1,{imported:true}),{...row(undefined,2),event_id:'event-b',relation:'confirms'}];
  const out=clock().project(rows);expect(out.for_returned_provenance_only).toBe(true);
  expect(out.entries[0]).toMatchObject({event_id:'event-a',relation:'derived_from',source_time:{basis:'imported_claim',utc_iso:'1970-01-01T00:00:00.000Z'}});
  expect(out.entries[1]).toMatchObject({event_id:'event-b',relation:'confirms',source_time:{basis:'unknown',utc_iso:null}});
 });
 it('invalid timezone is a constant refusal without raw input or lower-level exception details',()=>{
  for(const zone of [null,123,'','Asia/Tokyo\nSECRET','not/a/zone','x'.repeat(81),'../Asia/Tokyo','+09:00','+09','+0900','-05'])expect(()=>clock(zone)).toThrow(/^invalid_time_zone$/);
 });
});

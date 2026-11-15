// Shared Node/Workers formatter: no process, filesystem, network or mutable state.
export function provenanceTimeFormatter(value='UTC') {
  if(typeof value!=='string'||! /^[A-Za-z][A-Za-z0-9_+\-/]{0,79}$/.test(value))throw Error('invalid_time_zone');
  try {
    return new Intl.DateTimeFormat('en-CA',{timeZone:value,calendar:'iso8601',numberingSystem:'latn',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
      hourCycle:'h23',timeZoneName:'longOffset'});
  } catch { throw Error('invalid_time_zone'); }
}
export function memoryTimeZone(env={}) {
  const value=env.CF_MEMORY_MEMORY_TIME_ZONE;
  return provenanceTimeFormatter(value===undefined?'UTC':value).resolvedOptions().timeZone;
}

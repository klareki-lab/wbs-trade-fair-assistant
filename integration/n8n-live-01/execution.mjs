// Decode n8n's flatted execution serialization without exposing credentials/payloads.
export function executionData(raw){
 if(typeof raw!=='string')return raw;
 const a=JSON.parse(raw),cache=new Map();
 function get(i){if(cache.has(i))return cache.get(i);const v=a[i];if(v===null||typeof v!=='object')return v;const out=Array.isArray(v)?[]:{};cache.set(i,out);for(const[k,q]of Object.entries(v))out[k]=typeof q==='string'?get(Number(q)):q;return out;}
 return get(0);
}

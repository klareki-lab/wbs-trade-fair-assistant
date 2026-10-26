export const base='http://127.0.0.1:15679';
export async function apiSession(){
 const r=await fetch(base+'/rest/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emailOrLdapLoginId:'n8n-live-01@example.test',password:'IsolatedLive01Only!2026'})});
 if(!r.ok)throw Error('Isolated login failed '+r.status);
 const cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join(';');
 return async function api(path,body,method=body?'PATCH':'GET'){
  const r=await fetch(base+'/rest/'+path,{method,headers:{cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await r.json();if(!r.ok)throw Error('Isolated API '+r.status+' '+path);return result.data??result;
 };
}

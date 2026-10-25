// Same-origin, session-cookie-only admin dashboard. No upstream URLs or credentials.
const $=id=>document.getElementById(id);
const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let current={page:1,limit:50,search:'',band:'',processing:'',email:'',duplicate:'',sort:'created',direction:'desc'};
let items=[],total=0,lastRequest=0,tab='all',stats=null;
const dashUrl=()=>{const q=new URLSearchParams();for(const [k,v]of Object.entries(current))if(v!==''&&v!=null)q.set(k,String(v));return '/api/dashboard?'+q.toString()};
const date=x=>{if(!x)return '–'; const d=new Date(x);return Number.isNaN(d.getTime())?'–':d.toLocaleString('de-DE',{dateStyle:'medium',timeStyle:'short'})};
const pill=(s,kind='')=>{const v=String(s??'unbekannt'); const cls=/^(HOT|delivered|completed|NEW)$/.test(v)?'p-ok':/^(failed|uncertain)$/.test(v)?'p-err':/^(WARM|POSSIBLE_DUPLICATE|processing|sending)$/.test(v)?'p-warn':'p-n';return `<span class="pill ${cls}">${esc(v)}</span>`};
const detailLink=id=>`<button type="button" class="btn sm" data-id="${esc(id)}">Details</button>`;
const state=(message,error=false)=>{ $('liveText').textContent=message; $('pulse').classList.toggle('unavailable',error); };
const textIf=x=>x===null||x===undefined||x===''?'–':esc(x);
function renderStats(s){
  stats=s; const set=(id,v)=>$(id).textContent=v===null||v===undefined?'–':String(v);
  set('kGesamt',s.total);set('kA',s.hot);set('kSchnitt',s.scored_average);set('kDup',s.duplicates);set('kFaellig',s.failed);
  set('kGesamtSub',`${s.today??'–'} heute · ${s.unscored??'–'} unbewertet`);
  set('kASub',`${s.warm??'–'} WARM · ${s.cold??'–'} COLD`);
  set('kSchnittSub','Nur bewertete Leads');set('kDupSub','Keine automatische Zusammenführung');
  set('kFaelligSub',`${s.email_attention??'–'} E-Mail-Fehler / unklar`);
  const bands=[['HOT',s.hot],['WARM',s.warm],['COLD',s.cold],['Unbewertet',s.unscored]];
  $('katBox').innerHTML='<div class="bars">'+bands.map(([k,n])=>`<div class="bar-row" data-band="${esc(k)}"><span>${esc(k)}</span><div class="bar-track"><meter min="0" max="${Math.max(1,s.total||1)}" value="${Math.max(0,n||0)}"></meter></div><b>${esc(n)}</b></div>`).join('')+'</div>';
  const interests=Array.isArray(s.interests)?s.interests:[];
  $('interestBars').innerHTML=interests.length?interests.map(v=>`<div class="bar-row"><span>${esc(v.name)}</span><div class="bar-track"><meter min="0" max="${Math.max(1,s.total||1)}" value="${Math.max(0,Number(v.count)||0)}"></meter></div><b>${esc(v.count)}</b></div>`).join(''):'<div class="empty">Noch keine Trainingsinteressen erfasst.</div>';
  $('navDup').textContent=s.duplicates||'';
}
function renderTable(){
  $('tabs').innerHTML=[['all','Alle Leads'],['dups','Duplikate']].map(([k,t])=>`<button type="button" class="btn sm ${tab===k?'primary':''}" data-tab="${k}">${t}</button>`).join('');
  if(!items.length){$('tableBox').innerHTML='<div class="empty">Keine Leads für die aktuelle Auswahl gefunden.</div>'}
  else $('tableBox').innerHTML=`<table><thead><tr><th>Erfasst</th><th>Firma / Kontakt</th><th>Score</th><th>Verarbeitung</th><th>E-Mail</th><th>Duplikat</th><th>Details</th></tr></thead><tbody>`+
    items.map(l=>`<tr data-id="${esc(l.lead_id)}" tabindex="0" role="button" aria-label="Details für ${esc(l.company||l.lead_id)} öffnen"><td>${esc(date(l.created_at))}</td><td><strong>${textIf(l.company)}</strong><br><span class="muted">${textIf(l.contact)} · ${textIf(l.email)}</span></td><td>${pill(l.score_band||'UNSCORED')} ${l.score_total==null?'–':esc(l.score_total)+'/100'}</td><td>${pill(l.processing_status)}${l.processing_error?'<br><span class="p-err">'+esc(l.processing_error)+'</span>':''}</td><td>${pill(l.email_status||'none')}${l.email_error?'<br><span class="p-err">'+esc(l.email_error)+'</span>':''}</td><td>${pill(l.duplicate_status)}</td><td>${detailLink(l.lead_id)}</td></tr>`).join('')+'</tbody></table>';
  $('pageInfo').textContent=`Seite ${current.page} · ${total} Treffer`;
  $('prev').disabled=current.page===1;$('next').disabled=current.page*current.limit>=total;
  $('tableFoot').textContent=`${items.length} angezeigt · ${total} gefilterte Einträge · Keine Änderung an Neon`;
}
async function load(){
  const id=++lastRequest;state('Lade Live-Daten …');$('refreshBtn').disabled=true;
  try{
    const resp=await fetch(dashUrl(),{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    if(resp.status===401){window.location.assign('/');return}
    if(!resp.ok)throw new Error(`Dashboard API: HTTP ${resp.status}`);
    const data=await resp.json();if(!data.success||!Array.isArray(data.leads)||!data.stats)throw Error('Ungültige API-Antwort');
    if(id!==lastRequest)return;
    items=data.leads;total=data.total;renderStats(data.stats);renderTable();
    $('pageSub').textContent='Neon PostgreSQL · zuletzt aktualisiert '+date(data.as_of);
    state('Live · read-only');
  }catch(e){if(id!==lastRequest)return;state('Daten nicht verfügbar',true);$('pageSub').textContent=e.message; $('tableBox').innerHTML=`<div class="empty">Daten konnten nicht geladen werden. Kein Demo-Modus aktiv. ${esc(e.message)}</div>`;}
  finally{if(id===lastRequest)$('refreshBtn').disabled=false}
}
let debounce;
$('search').addEventListener('input',e=>{clearTimeout(debounce);debounce=setTimeout(()=>{current.search=e.target.value;current.page=1;load()},280)});
for(const [id,key]of [['filterBand','band'],['filterProcessing','processing'],['filterEmail','email']])$(id).addEventListener('change',e=>{current[key]=e.target.value;current.page=1;load()});
$('sort').addEventListener('change',e=>{[current.sort,current.direction]=e.target.value.split(':');current.page=1;load()});
function selectTab(next){
 if(next!=='all'&&next!=='dups')return;
 tab=next;
 current.duplicate=tab==='dups'?'yes':'';
 // Clicking a tab is a navigation intent: clear mutually-exclusive filters that could
 // zero out the duplicate view (e.g. band=UNSCORED + processing=completed from an earlier search).
 current.band='';current.processing='';current.email='';current.search='';
 const search=$('search');if(search)search.value='';
 for(const [id,key]of [['filterBand','band'],['filterProcessing','processing'],['filterEmail','email']]){const el=$(id);if(el)el.value=''}
 current.page=1;load();
}
function resetFilters(){
 current.search='';current.band='';current.processing='';current.email='';current.duplicate='';tab='all';
 const search=$('search');if(search)search.value='';
 for(const [id,key]of [['filterBand','band'],['filterProcessing','processing'],['filterEmail','email']]){const el=$(id);if(el)el.value=''}
 current.page=1;load();
}
$('tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;selectTab(b.dataset.tab)});
document.querySelectorAll('.side .nav[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));
$('resetFiltersBtn')?.addEventListener('click',resetFilters);
$('prev').addEventListener('click',()=>{if(current.page>1){current.page--;load()}});
$('next').addEventListener('click',()=>{if(current.page*current.limit<total){current.page++;load()}});
$('refreshBtn').addEventListener('click',load);
$('logoutBtn').addEventListener('click',async()=>{try{await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'}})}finally{location.assign('/')}});
document.querySelectorAll('.nav[data-go]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.go).scrollIntoView({behavior:'smooth'})));
const safeExternalUrl=v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)?esc(u.href):null}catch{return null}};
function showDetail(id){
 const l=items.find(x=>x.lead_id===id);if(!l)return;
 $('dTitle').textContent=l.company||'Unbekannte Firma';$('dSub').textContent=l.lead_id;
 const kv=(title,value)=>`<dt>${esc(title)}</dt><dd>${textIf(value)}</dd>`;
 const content=(title,body)=>`<div class="panel"><h3>${esc(title)}</h3>${body}</div>`;
 const web=safeExternalUrl(l.website);
 $('msgs').innerHTML=content('Score und Zustellung',`<dl class="kv">${kv('Score',l.score_total==null?'Nicht bewertet':l.score_total+'/100')}${kv('Kategorie',l.score_band)}${kv('Verarbeitung',l.processing_status)}${kv('Fehler',l.processing_error)}${kv('E-Mail',l.email_status)}${kv('E-Mail-Fehler',l.email_error)}${kv('Versuche',l.processing_attempts)}</dl>`)+
 content('Kontakt',`<dl class="kv">${kv('Firma',l.company)}${kv('Name',l.contact)}${kv('E-Mail',l.email)}${kv('Telefon',l.phone)}${kv('E-Mail bestätigt',l.email_verified?'Ja':'Nein')}${web?'<dt>Website</dt><dd><a target="_blank" rel="noopener noreferrer" href="'+web+'">'+web+'</a></dd>':''}${kv('Erfasst',date(l.created_at))}</dl>`)+
 content('Angaben',`<dl class="kv">${kv('Training',l.training_interest)}${kv('Budget',l.budget_status)}${kv('Follow-up',l.follow_up)}${kv('Datum',l.follow_up_date)}${kv('Duplikat',l.duplicate_status)}${kv('Prüfung nötig',l.review_required?'Ja':'Nein')}</dl>`)+
 content('Notizen',`<pre class="notiz">${textIf(l.notes)}</pre>`)+
 content('Unsicherheiten / Duplikat-Hinweise',`<pre class="detailJson">${esc(JSON.stringify({flags:l.uncertainty_flags,possible_contact_ids:l.possible_contact_ids,ai_uncertainty:l.ai_uncertainty},null,2))}</pre>`)+
 content('AI Extraction',`<pre class="detailJson">${esc(l.ai_extraction?JSON.stringify(l.ai_extraction,null,2):'Nicht vorhanden / noch nicht verarbeitet')}</pre>`)+
 content('Company Research',`<pre class="detailJson">${esc(l.company_research?JSON.stringify(l.company_research,null,2):'Nicht vorhanden / noch nicht verarbeitet')}</pre>`);
 $('drawer').classList.add('open');$('backdrop').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
}
$('tableBox').addEventListener('click',e=>{
 const b=e.target.closest('button[data-id]');if(b){showDetail(b.dataset.id);return}
 const a=e.target.closest('a');if(a)return; // let real links behave
 const row=e.target.closest('tr[data-id]');if(row)showDetail(row.dataset.id);
});
$('tableBox').addEventListener('keydown',e=>{
 if(e.key!=='Enter'&&e.key!==' ')return;
 const row=e.target.closest('tr[data-id]');if(!row)return;
 e.preventDefault();showDetail(row.dataset.id);
});
const close=()=>{$('drawer').classList.remove('open');$('backdrop').classList.remove('open');$('drawer').setAttribute('aria-hidden','true')};
$('closeDrawer').addEventListener('click',close);$('backdrop').addEventListener('click',close);document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
load();

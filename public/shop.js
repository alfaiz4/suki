/* Helper bersama: Supabase, tema, sesi, format, countdown */
(function(){
const SUPABASE_URL = window.__CFG.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.__CFG.SUPABASE_ANON_KEY;
const WA_NUMBER=window.__CFG.WA_NUMBER;
const REMEMBER_KEY="polos-remember";
const adaptiveStorage={
  getItem:k=>localStorage.getItem(k)??sessionStorage.getItem(k),
  setItem:(k,v)=>{const p=localStorage.getItem(REMEMBER_KEY)!=="0";(p?sessionStorage:localStorage).removeItem(k);(p?localStorage:sessionStorage).setItem(k,v)},
  removeItem:k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)}
};
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{storage:adaptiveStorage,persistSession:true,autoRefreshToken:true}});
const q=s=>document.querySelector(s);
const rp=n=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(n).replace(/\s/g,"");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LABEL={pending:"Pending",proses:"Proses",success:"Success",gagal:"Gagal"};
const badge=s=>'<span class="badge b-'+s+'">'+(LABEL[s]||s)+'</span>';
const fmtDate=d=>new Date(d).toLocaleString("id-ID",{dateStyle:"medium",timeStyle:"short"});
const mmss=s=>String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
function countdown(el,endMs,onEnd){
  const tick=()=>{const s=Math.max(0,Math.round((endMs-Date.now())/1000));el.textContent=mmss(s);if(s<=0){clearInterval(id);onEnd&&onEnd()}};
  const id=setInterval(tick,1000);tick();return()=>clearInterval(id);
}
async function requireSession(){
  const {data}=await sb.auth.getSession();
  if(!data.session){try{sessionStorage.setItem("polos-noauto","1")}catch(e){}location.replace("index.html");return null}
  return data.session;
}
async function isAdmin(uid){const {data}=await sb.from("profiles").select("role").eq("id",uid).maybeSingle();return !!data&&data.role==="admin"}
async function fn(action,body){
  const {data:s}=await sb.auth.getSession();
  const r=await fetch("/api/fr3",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+(s.session?s.session.access_token:"")},body:JSON.stringify({action,...body})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j.error)throw new Error(j.error||"Permintaan gagal");return j;
}
function toast(m){let t=q("#toast");if(!t){t=document.createElement("div");t.id="toast";t.className="toast";document.body.appendChild(t)}
  t.textContent=m;t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),2800)}
function initTheme(){
  const root=document.documentElement,sw=q("#theme");
  const dark=()=>root.dataset.theme?root.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
  const sync=()=>sw.setAttribute("aria-checked",dark());
  try{const t=localStorage.getItem("polos-tema");if(t==="dark"||t==="light")root.dataset.theme=t}catch(e){}
  sync();sw.addEventListener("click",()=>{const n=dark()?"light":"dark";root.dataset.theme=n;sync();try{localStorage.setItem("polos-tema",n)}catch(e){}});
}
function header(back,label){
  q("#hdr").innerHTML='<a class="home-link" href="'+back+'">← '+label+'</a><span class="brand">NeoGroup</span>'+
  '<button class="switch" id="theme" role="switch" aria-checked="false" aria-label="Mode gelap"><span class="knob">'+
  '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'+
  '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></span></button>';
  initTheme();
}
const errMsg=e=>{const m=(e&&e.message)||"";
  if(m.includes("LIMIT_ACTIVE"))return"LIMIT_ACTIVE";
  if(m.includes("COOLDOWN"))return"COOLDOWN:"+(m.match(/COOLDOWN:(\d+)/)||[])[1];
  return m||"Terjadi kesalahan"};
window.Shop={sb,q,rp,esc,badge,LABEL,fmtDate,mmss,countdown,requireSession,isAdmin,fn,toast,header,errMsg,WA_NUMBER};
})();

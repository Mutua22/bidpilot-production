let licenseActive=false;
function sendLicenseMessage(msg){return new Promise(resolve=>chrome.runtime.sendMessage(msg,resolve));}
async function refreshLicense(force=false){const status=document.getElementById("licenseStatus");const data=await sendLicenseMessage({action:"getLicenseData"});if(data?.licenseKey&&!document.getElementById("licenseKey").value)document.getElementById("licenseKey").value=data.licenseKey;const r=await sendLicenseMessage({action:"licenseStatus",force});licenseActive=!!r?.ok;status.innerHTML=licenseActive?'<span class="license-good">Active · '+new Date(r.license.expiresAt).toLocaleDateString()+'</span>':'<span class="license-bad">'+(r?.error||"License required")+'</span>';return licenseActive;}
document.getElementById("activateLicense").onclick=async()=>{const key=document.getElementById("licenseKey").value.trim();const status=document.getElementById("licenseStatus");status.textContent="Activating…";const r=await sendLicenseMessage({action:"activateLicense",key});licenseActive=!!r?.ok;status.innerHTML=licenseActive?'<span class="license-good">Activated · '+new Date(r.license.expiresAt).toLocaleDateString()+'</span>':'<span class="license-bad">'+(r?.error||"Activation failed")+'</span>';};
const defaults = {
  minPrice: null,
  minDeadline: null,
  minTimeType: 2,
  maxRefundRate: null,
  maxRefundRateFriends: null,
  subjectFilter: [],
  onlyInvited: false,
  priceMode: "skip",
  deadlineMode: "skip"
};

const $ = id => document.getElementById(id);
const get = keys => new Promise(r => chrome.storage.local.get(keys, r));
const set = data => new Promise(r => chrome.storage.local.set(data, r));

function valNum(id){
  const v = $(id).value.trim();
  return v === "" ? null : Number(v);
}
function setNum(id,v){ $(id).value = v == null ? "" : String(v); }
function radio(name,v){ const el = document.querySelector(`input[name="${name}"][value="${v}"]`); if(el) el.checked=true; }

async function load(){
  const data = await get({botSettings: defaults, botRunning:false, botStats:{questionsChecked:0,bidsPlaced:0,bidAttempts:0}, authToken:null, activityLog:[]});
  const s = {...defaults, ...(data.botSettings || {})};
  setNum("minPrice",s.minPrice); setNum("minDeadline",s.minDeadline);
  $("minTimeType").value = String(s.minTimeType ?? 2);
  setNum("maxRefundRate",s.maxRefundRate); setNum("maxRefundRateFriends",s.maxRefundRateFriends);
  $("subjectFilter").value = Array.isArray(s.subjectFilter) ? s.subjectFilter.join(", ") : (s.subjectFilter || "");
  $("onlyInvited").checked = !!s.onlyInvited;
  radio("priceMode", s.priceMode === "adjust" ? "adjust" : "skip");
  radio("deadlineMode", s.deadlineMode === "adjust" ? "adjust" : "skip");
  renderRunning(!!data.botRunning, data.authToken);
  renderStats(data.botStats);
  renderLog(data.activityLog || []);
}

function readSettings(){
  return {
    minPrice: valNum("minPrice"),
    minDeadline: valNum("minDeadline"),
    minTimeType: Number($("minTimeType").value) || 2,
    maxRefundRate: valNum("maxRefundRate"),
    maxRefundRateFriends: valNum("maxRefundRateFriends"),
    subjectFilter: $("subjectFilter").value.split(",").map(x=>x.trim()).filter(Boolean),
    onlyInvited: $("onlyInvited").checked,
    priceMode: document.querySelector('input[name="priceMode"]:checked')?.value || "skip",
    deadlineMode: document.querySelector('input[name="deadlineMode"]:checked')?.value || "skip"
  };
}

async function saveSettings(){
  const botSettings = readSettings();
  await set({botSettings});
  $("status").innerHTML = '<span class="success">Settings saved. These exact values will be used by the running bot.</span>';
}

async function sendToStudypool(message){
  const tabs = await chrome.tabs.query({url:["https://www.studypool.com/*","https://studypool.com/*"]});
  const current = tabs.find(t=>t.active) || tabs[0];
  if(!current?.id) return false;
  try { await chrome.tabs.sendMessage(current.id,message); return true; } catch(e) { return false; }
}

async function start(){
  const ok=await refreshLicense(true);
  if(!ok){$("status").innerHTML='<span class="danger">Activate a valid BidPilot license before starting the bot.</span>';return;}
  const botSettings=readSettings();
  await set({botSettings,botRunning:true});
  const sent=await sendToStudypool({action:"startBot",settings:botSettings});
  if(sent){$("status").innerHTML='<span class="success">Bot running. Stay on the normal Newest Questions list page.</span>';}else{$("status").innerHTML='<span class="danger">Bot saved as ON, but no Studypool content script responded. Open/refresh Studypool Newest Questions once.</span>';}
  renderRunning(true);
}

async function stop(){
  await set({botRunning:false});
  await sendToStudypool({action:"stopBot"});
  renderRunning(false);
  $("status").textContent="Bot stopped.";
}

function renderRunning(on,token){
  $("pill").textContent=on?"ON":"OFF"; $("pill").className="pill"+(on?" on":"");
  $("start").style.display=on?"none":"block"; $("stop").style.display=on?"block":"none";
  if(on && token) $("status").innerHTML='<span class="success">Running · API authorization captured · remain on Newest Questions.</span>';
}
function renderStats(s={}){ $("questionsChecked").textContent=s.questionsChecked||0; $("bidsPlaced").textContent=s.bidsPlaced||0; }
function renderLog(items){ $("log").textContent=(items||[]).slice(-80).map(x=>typeof x==="string"?x:(x.time?new Date(x.time).toLocaleTimeString()+" ":"")+String(x.message||x)).join("\n"); }

$("save").onclick=saveSettings; $("save2").onclick=saveSettings; $("start").onclick=start; $("stop").onclick=stop;

document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active");});

chrome.runtime.onMessage.addListener(msg=>{
  if(msg.action==="updateStats") renderStats(msg.stats);
  if(msg.action==="logActivity"){
    const line = `${new Date().toLocaleTimeString()} ${msg.message||""}`;
    $("log").textContent += ($("log").textContent?"\n":"")+line;
    $("log").scrollTop=$("log").scrollHeight;
  }
});

load();
refreshLicense(false);

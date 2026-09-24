/* ═══════════════════════════════════════════════════════════════
   🛰️  NET.JS — Connexion au serveur central KLEAN (temps réel)
   ----------------------------------------------------------------
   Chargé automatiquement quand l'application est servie par
   server.js. Si le serveur est absent (ouverture du fichier
   directement), l'application reste en mode démo/simulation.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const NET = {
  on: false, ws: null,
  deviceId: null,
  agentId: localStorage.getItem('k2_agentId') || null,
  searchTimeout: null, animIv: null,
  posWatch: false, pos: null, pollIv: null
};

/* 📡 GPS : distance entre deux points (mètres) */
function haversineM(lat1, lon1, lat2, lon2){
  const R = 6371000, rad = Math.PI/180;
  const dLat = (lat2-lat1)*rad, dLon = (lon2-lon1)*rad;
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
/* L'agent partage sa position en continu tant qu'il est en ligne */
function netStartPosWatch(){
  if(!navigator.geolocation || NET.posWatch) return;
  NET.posWatch = true;
  navigator.geolocation.watchPosition(pos=>{
    NET.pos = {lat: pos.coords.latitude, lng: pos.coords.longitude};
    if(agent && agent.online && NET.on) wsSend({type:'agent_pos', agentId:NET.agentId, lat:NET.pos.lat, lng:NET.pos.lng});
  }, ()=>{}, {enableHighAccuracy:true, maximumAge:15000});
}

(function netInit(){
  if (location.protocol === 'file:') return;              // ouverture directe → démo
  fetch('/api/health', {cache:'no-store'})
    .then(r => { if(!r.ok) throw 0; return r.json(); })
    .then(() => fetch('/api/config', {cache:'no-store'}).then(r=>r.json()).then(d=>{ NET.commission = (d.commission||25)/100; }).catch(()=>{}))
    .then(() => {
      NET.deviceId = localStorage.getItem('k2_device');
      if(!NET.deviceId){
        NET.deviceId = (crypto.randomUUID ? crypto.randomUUID() : 'dev-'+Date.now());
        localStorage.setItem('k2_device', NET.deviceId);
      }
      connectWS();
    })
    .catch(()=>{ /* serveur absent → mode démo */ });
})();

function connectWS(){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws');
  NET.ws = ws;
  ws.onopen = () => {
    NET.on = true;
    wsSend({type:'hello', role:'client', deviceId:NET.deviceId, clientId: (typeof client!=='undefined' && client && client.id) ? client.id : null});
    applyNetOverrides();
    toast('🛰️ Connecté au serveur KLEAN — temps réel activé');
    // si un profil agent existe et était en ligne → se réannoncer
    if (agent && agent.nom && agent.online) netAnnounceOnline();
  };
  ws.onmessage = ev => { try { routeNet(JSON.parse(ev.data)); } catch(e){} };
  ws.onclose = () => { NET.on = false; };
  setInterval(() => wsSend({type:'ping'}), 25000);
  // 🔁 Surveillance du statut de candidature (en attente → validé)
  setInterval(()=>{
    if(NET.on && typeof agent!=='undefined' && agent.apply && agent.apply.status==='pending' && agent.apply.agentId){
      fetch('/api/agents/'+agent.apply.agentId+'/status', {cache:'no-store'}).then(r=>r.json()).then(d=>{
        if(d.status === 'approved') agentApplyApproved();
        else if(d.status === 'rejected'){ agent.apply = {status:'rejected', reason: d.rejectReason || 'dossier incomplet'}; saveAll(); renderAgentGate(); }
      }).catch(()=>{});
    }
  }, 12000);
}
function wsSend(o){ if(NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(o)); }

/* ───────── Remplacement des flux simulés par les flux réels ───────── */
function applyNetOverrides(){
  window.launchSearch   = netLaunchSearch;
  window.cancelSearch   = netCancelSearch;
  window.cancelMission  = netCancelMission;
  window.showRequest    = netShowRequest;
  window.answerRequest  = netAnswerRequest;
  window.toggleOnline   = netToggleOnline;
  window.quickOnboard   = netQuickOnboard;
  window.advanceMission = netAdvanceMission;
  window.forceRequest   = netForceInfo;
  window.renderAgentHist= netRenderAgentHist;
}

/* ══════════ CÔTÉ CLIENT ══════════ */
async function netLaunchSearch(){
  c.nom = document.querySelector('#inp-nom').value.trim();
  c.tel = document.querySelector('#inp-tel').value.trim();
  const _bd = document.querySelector('#bk-desc');
  c.desc = (_bd ? _bd.value : '').trim().slice(0,280);
  if(c.service==='cours' && !c.desc) return toast('📖 Précisez la matière ou le domaine du coach');
  if(!c.nom) return toast('Indiquez votre nom 👤');
  if(c.tel.replace(/\D/g,'').length < 8) return toast('Numéro invalide 📞');

  /* 👤 Un client doit être INSCRIT pour trouver un agent */
  if(typeof client === 'undefined' || !client || !client.token || !client.id){
    toast('👤 Créez votre compte gratuit (30 secondes) pour réserver — sécurité des professionnels 🛡️');
    setTimeout(() => {
      showView('view-account', document.querySelector('#nav-client .nav-btn[data-v=view-account]') || document.querySelector('#nav-client .nav-btn:last-child'), 'client');
    }, 700);
    return;
  }

  /* ⏸️ Maximum 3 missions actives simultanées */
  const _act = bookings.filter(b => !['terminee','annulee'].includes(b.status)).length;
  if(_act >= 3) return toast('⏸️ Vous avez déjà 3 missions en cours — attendez qu\'une se termine');

  const p = calcPrice(c);
  let created;
  try{
    const headers = {'Content-Type':'application/json'};
    if(typeof client!=='undefined' && client && client.token) headers['X-Client-Token'] = client.token;
    const r = await fetch('/api/missions', {
      method:'POST', headers,
      body: JSON.stringify({...c, prixTotal:p.total, deviceId:NET.deviceId})
    });
    created = await r.json();
  }catch(e){ return toast('Serveur injoignable — réessayez'); }

  mission = {
    id: created.id, ...JSON.parse(JSON.stringify(c)),
    prix: p, status:'recherche', createdAt:Date.now(),
    agent:null, dist: created.dist || 0, eta: 0, rated: 0
  };
  bookings.unshift({...mission}); saveAll();
  showView('view-search', document.querySelector('#nav-client .nav-btn:nth-child(3)'), 'client');
  document.querySelector('#search-msg').textContent = '📡 Demande diffusée aux agents en ligne à '+ (typeof cityName==='function'? cityName(c.city) : 'votre ville') +'…';
  wsSend({type:'subscribe_mission', missionId: mission.id});
  clearTimeout(NET.searchTimeout);
  NET.searchTimeout = setTimeout(()=>{
    if(mission && mission.status==='recherche'){
      document.querySelector('#search-msg').textContent = '⏳ Aucun agent n\'a encore accepté — la demande reste diffusée…';
    }
  }, 45000);
}

function netCancelSearch(){
  clearTimeout(NET.searchTimeout); clearInterval(NET.animIv);
  if(mission){ netCancelOnServer(); mission.status='annulee'; syncBooking(); mission=null; }
  searchTimers.forEach(clearTimeout);
  showView('view-home', document.querySelector('#nav-client .nav-btn'), 'client');
  toast('Recherche annulée');
}
function netCancelMission(){
  if(!mission || ['terminee','annulee','encours'].includes(mission.status)) return toast('Annulation impossible à ce stade');
  if(confirm('Annuler la mission ? (gratuit tant que l\'agent n\'est pas arrivé)')){
    netCancelOnServer();
    clearInterval(NET.animIv);
    mission.status='annulee'; syncBooking(); mission=null;
    showView('view-home', document.querySelector('#nav-client .nav-btn'), 'client');
    toast('Mission annulée');
  }
}
function netCancelOnServer(){
  fetch('/api/missions/'+mission.id+'/cancel', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).catch(()=>{});
}
function netStartRoute(){
  // animation visuelle du trajet (le statut réel vient du serveur + position GPS)
  clearInterval(sim);
  netStartTrackPoll();
  const start = {x: 40+Math.random()*80, y: 30+Math.random()*60};
  const ctrl  = {x:(start.x+CLIENT_POS.x)/2 + 30, y:(start.y+CLIENT_POS.y)/2 - 34};
  mission._route = {start, ctrl, end:CLIENT_POS, dist0: mission.dist || 2, dur: 45, t: 0};
  document.querySelector('#route-path').setAttribute('d', `M${start.x} ${start.y} Q${ctrl.x} ${ctrl.y} ${CLIENT_POS.x} ${CLIENT_POS.y}`);
  renderTrack();
  clearInterval(NET.animIv);
  NET.animIv = setInterval(()=>{
    if(!mission || mission.status!=='enroute') return;
    mission._route.t += 1;
    const r = mission._route;
    const k = Math.min(0.9, (r.t / r.dur) * 0.9);      // on avance jusqu'à 90% et on attend l'événement "arrive"
    const remaining = Math.max(0.2, r.dist0*(1-k));
    mission.dist = remaining;
    mission.eta = Math.max(1, Math.round(r.dist0*4*(1-k)));
    if(document.querySelector('#view-track').classList.contains('active')){
      const q = quad(r.start, r.ctrl, r.end, k);
      document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
    }
    refreshTrackNumbers();
  },1000);
}
/* 📡 Suivi GPS : interroge le serveur pour la vraie position de l'agent */
function netStartTrackPoll(){
  clearInterval(NET.pollIv);
  NET.pollIv = setInterval(async ()=>{
    if(!mission || mission.status !== 'enroute') return;
    try{
      const r = await fetch('/api/missions/'+mission.id, {cache:'no-store'});
      if(!r.ok) return;
      const d = await r.json();
      if(d.agentPos && typeof mission.lat === 'number' && mission.lat !== null){
        const km = haversineM(mission.lat, mission.lng, d.agentPos.lat, d.agentPos.lng)/1000;
        mission.dist = Math.max(km, 0.1);
        mission.eta  = Math.max(1, Math.ceil(mission.dist*4));
        refreshTrackNumbers();
        if(mission._route && document.querySelector('#view-track').classList.contains('active')){
          const p = Math.max(0, Math.min(0.95, 1 - mission.dist/Math.max(mission._route.dist0, 0.5)));
          const q = quad(mission._route.start, mission._route.ctrl, mission._route.end, p);
          document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
        }
      }
    }catch(e){}
  }, 5000);
}
function netSnapArrive(){
  clearInterval(NET.animIv); clearInterval(NET.pollIv);
  if(mission && mission._route){
    const q = quad(mission._route.start, mission._route.ctrl, mission._route.end, 1);
    document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
  }
  if(mission){ mission.dist = 0; }
}
function refreshTrackNumbers(){
  if(!mission) return;
  const km = document.querySelector('#trk-km'), eta = document.querySelector('#trk-eta');
  if(km) km.textContent = Math.max(mission.dist,0).toFixed(1)+' km';
  if(eta && mission.status==='enroute') eta.textContent = '~'+mission.eta+' min';
}
function netStartWork(){
  let wp = 0;
  clearInterval(NET.animIv); clearInterval(NET.pollIv);
  NET.animIv = setInterval(()=>{
    wp = Math.min(95, wp+3);                     // on attend le vrai événement "terminee" pour 100%
    if(document.querySelector('#view-track').classList.contains('active')){
      document.querySelector('#trk-progress').style.width = wp+'%';
      document.querySelector('#trk-progress-txt').textContent = 'Nettoyage en cours… '+wp+'%';
    }
  },1000);
}

/* ───────── Messages serveur ───────── */
function routeNet(msg){
  switch(msg.type){

    case 'agent_approved':
      if(agent.apply) agentApplyApproved();
      else { toast('🎉 Votre dossier est validé !'); renderAgentGate && renderAgentGate(); }
      break;

    case 'agent_rejected':
      if(agent.apply){ agent.apply = {status:'rejected', reason: msg.reason || 'dossier incomplet'}; saveAll(); renderAgentGate(); }
      toast('😕 Candidature non retenue');
      break;

    case 'agent_pending':
      toast('⏳ Dossier en vérification par KLEAN');
      break;

    case 'agent_denied':
      if(msg.reason === 'blocked'){
        agent.online = false; if(agent.apply) agent.apply = {status:'blocked'};
        saveAll(); try{ renderAgentGate && renderAgentGate(); }catch(e){}
        toast('⛔ Compte suspendu par le gestionnaire — contactez le support');
      }
      else if(msg.reason === 'apply'){ toast('🛡️ Envoyez d\'abord votre dossier de candidature'); if(agent.nom){ agent.nom=''; saveAll(); } renderAgentGate && renderAgentGate(); }
      else toast('🛡️ Accès agent refusé');
      break;

    case 'agent_registered':
      NET.agentId = msg.agentId;
      localStorage.setItem('k2_agentId', msg.agentId);
      break;

    case 'mission_request':            // → AGENT : nouvelle demande
      if(!agent.online || !agent.nom) break;
      if(incomingReq || activeMission) break;
      netShowRequest(msg.mission);
      break;

    case 'mission_taken':              // → AGENT : un autre agent a pris la demande
      if(incomingReq && incomingReq.id === msg.missionId){
        hideRequest(); toast('⚡ Mission prise par un autre agent');
      }
      break;

    case 'mission_reassigned':        // → AGENT : le gestionnaire lui a retiré cette mission
      if(incomingReq && incomingReq.id === msg.missionId) hideRequest();
      toast('⤴ Mission retirée — réattribuée par le gestionnaire');
      break;

    case 'support_msg':               // → PRO : l'équipe a répondu au support
      toast('💬 Réponse du support KLEAN' + (msg.par ? ' (' + msg.par + ')' : ''));
      try { if (window.supRefreshBadge) window.supRefreshBadge(); } catch (e) { }
      break;

    case 'mission_update': {           // → CLIENT (et agent assigné)
      // côté agent : le client a annulé
      if(activeMission && activeMission.id === msg.missionId && msg.status === 'annulee'){
        activeMission = null; renderAgentDash();
        toast('😕 Le client a annulé la mission');
        break;
      }
      if(!mission || mission.id !== msg.missionId) break;
      handleMissionUpdate(msg);
      break;
    }
  }
}
function handleMissionUpdate(msg){
  clearTimeout(NET.searchTimeout);
  const st = msg.status;
  if(st === 'accepted' && msg.agent){
    mission.agent = { nom: msg.agent.nom, note: msg.agent.note || 5, missions: msg.agent.missions || 0, tel: (msg.agent.tel||'').replace(/\D/g,''), photo: msg.agent.photo || null };
    mission.dist = msg.dist || mission.dist || 2;
    // 📍 distance réelle si le serveur a la position GPS de l'agent
    if(msg.agentPos && typeof mission.lat === 'number' && mission.lat !== null){
      mission.dist = haversineM(mission.lat, mission.lng, msg.agentPos.lat, msg.agentPos.lng)/1000;
    }
    mission.status = 'enroute'; syncBooking();
    const card = document.querySelector('#found-card');
    card.style.display = 'block';
    document.querySelector('#found-agent').innerHTML = agentRowHTML(mission.agent, mission.dist);
    document.querySelector('#search-msg').innerHTML = '✅ <b style="color:var(--pd)">'+mission.agent.nom+' a accepté votre mission !</b>';
    setTimeout(()=>{ showView('view-track', document.querySelector('#nav-client .nav-btn:nth-child(3)'), 'client'); netStartRoute(); }, 2000);
  }
  else if(st === 'enroute'){ /* déjà en cours d'animation */ }
  else if(st === 'arrive'){
    mission.status = 'arrive'; syncBooking(); netSnapArrive(); renderTrack();
  }
  else if(st === 'encours'){
    mission.status = 'encours'; syncBooking(); renderTrack(); netStartWork();
  }
  else if(st === 'terminee'){
    clearInterval(NET.animIv);
    mission.status = 'terminee'; mission.dist = 0; syncBooking(); renderTrack();
    const bar = document.querySelector('#trk-progress');
    if(bar){ bar.style.width='100%'; document.querySelector('#trk-progress-txt').textContent='Nettoyage en cours… 100%'; }
    toast('✅ Mission terminée ! Notez votre agent ⭐');
  }
  else if(st === 'annulee'){
    mission.status = 'annulee'; syncBooking();
  }
}

/* ══════════ CÔTÉ AGENT ══════════ */
async function netEnsureAgentRegistered(){
  if(NET.agentId) return NET.agentId;
  const r = await fetch('/api/health').catch(()=>null);
  // l'inscription se fait via le WS agent_online (le serveur crée l'agent)
  return new Promise(resolve=>{
    const iv = setInterval(()=>{ if(NET.agentId){ clearInterval(iv); resolve(NET.agentId); } }, 300);
    netAnnounceOnline();
    setTimeout(()=>{ clearInterval(iv); resolve(NET.agentId); }, 5000);
  });
}
function netAnnounceOnline(){
  netStartPosWatch();
  wsSend({type:'agent_online', agentId:NET.agentId, nom:agent.nom, quartier:agent.quartier, tel:agent.tel});
}
async function netQuickOnboard(){
  const nom = document.querySelector('#ob-nom').value.trim();
  if(!nom) return toast('Indiquez votre nom 👤');
  agent.nom = nom; agent.quartier = document.querySelector('#ob-quartier').value; agent.online = true;
  saveAll(); renderAgentDash();
  netAnnounceOnline();
  toast('🎉 Bienvenue '+nom+' ! Vous êtes en ligne.');
}
function netToggleOnline(){
  if(!agent.apply || agent.apply.status !== 'approved'){
    return toast('🛡️ Votre dossier doit d\'abord être validé par KLEAN');
  }
  if(!agent.nom) return toast('Complétez d\'abord votre dossier 👤');
  agent.online = !agent.online; saveAll(); renderAgentDash();
  if(agent.online){
    agentAlertUnlock && agentAlertUnlock();
    try{ agentPushEnsure && agentPushEnsure(); }catch(e){}
    netAnnounceOnline();
    toast('🟢 En ligne — les vraies demandes arrivent');
  } else {
    wsSend({type:'agent_offline', agentId:NET.agentId});
    toast('⚪ Hors ligne'); hideRequest();
  }
}
function netForceInfo(){ toast('🛰️ Temps réel actif : les demandes arrivent toutes seules'); }

function netShowRequest(m){
  try{ if(typeof playAgentAlert === 'function') playAgentAlert(); }catch(e){}
  // 📍 Distance réelle GPS si on connaît notre position ET celle du client
  let distShown = m.dist || 0;
  if(NET.pos && typeof m.lat === 'number'){
    distShown = haversineM(NET.pos.lat, NET.pos.lng, m.lat, m.lng)/1000;
  }
  incomingReq = {
    id: m.id, service: m.service, pieces: m.pieces, depth: m.depth,
    extras:{}, prix:{total:m.prixTotal, svc:SERVICES.find(s=>s.id===m.service), baseSvc:m.prixTotal},
    client:m.clientNom, quartier:m.quartier, adresse:'', time:m.time, dist:distShown, clientLat:m.lat, clientLng:m.lng, server:true
  };
  const p = incomingReq.prix;
  const gain = p.total*(1-(NET.commission||0.25));
  const gpsTag = (NET.pos && typeof m.lat === 'number') ? ' (GPS réel 📡)' : '';
  document.querySelector('#req-sub').textContent = m.clientNom+' · 📍 '+m.quartier+' · '+distShown.toFixed(1)+' km de vous';
  document.querySelector('#req-lines').innerHTML = `
    <div class="rline"><span>${p.svc.ic} ${p.svc.nom}</span><span>${fmt(p.svc.base)}</span></div>
    <div class="rline"><span>🛏️ ${m.pieces} pièce(s) · ${m.depth}</span><span></span></div>
    <div class="rline"><span>🕐 ${formatDate(m.date||'')} à ${m.time}</span><span></span></div>
    ${m.desc ? `<div class=\"rline\" style=\"background:var(--pl);border-radius:8px;padding:6px 8px\"><span>📝 ${m.desc}</span><span></span></div>` : ''}
    ${m.budget ? `<div class=\"rline\"><span>💰 Budget client indicatif</span><span>${fmt(m.budget)}</span></div>` : ''}
    <div class="rline"><span>📍 Distance${gpsTag}</span><span>${distShown.toFixed(1)} km</span></div>
    <div class="rline total"><span>Montant mission</span><span>${fmt(p.total)}</span></div>`;
  if(m.photos && m.photos.length){
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    row.innerHTML = m.photos.map((ph,i)=>`<button style="flex:1;padding:0;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--card2);cursor:pointer" onclick="viewMissionPhoto(${i})"><img src="${ph}" style="width:100%;height:70px;object-fit:cover;display:block"></button>`).join('');
    document.querySelector('#req-lines').appendChild(row);
    window._missionPhotos = m.photos;
  }
  document.querySelector('#req-gain').textContent = fmt(gain);
  document.querySelector('#req-modal-bg').classList.add('show');
  let left = 20; const CIRC = 144.5;
  document.querySelector('#req-count').textContent = left;
  document.querySelector('#req-ring').style.strokeDashoffset = 0;
  clearInterval(reqCountdown);
  reqCountdown = setInterval(()=>{
    left--;
    document.querySelector('#req-count').textContent = Math.max(0,left);
    document.querySelector('#req-ring').style.strokeDashoffset = CIRC*(1-left/20);
    if(left<=0){ hideRequest(); }
  },1000);
}
async function netAnswerRequest(accept){
  if(!incomingReq) return;
  if(!accept){ hideRequest(); return; }
  const reqId = incomingReq.id;
  let res;
  try{
    const r = await fetch('/api/missions/'+reqId+'/accept', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({agentId: NET.agentId})
    });
    res = r;
  }catch(e){ return toast('Serveur injoignable'); }
  if(res.status === 409){ hideRequest(); return toast('⚡ Trop tard — prise par un autre agent'); }
  if(!res.ok){ return toast('Erreur — réessayez'); }
  const data = await res.json();
  activeMission = {...incomingReq, clientTel: data.clientTel || '', stage:1, startedAt:Date.now(), server:true};
  hideRequest();
  renderAgentDash();
  toast('✓ Mission acceptée ! En route 🛵');
}
async function netAdvanceMission(){
  const STATUS = {1:'enroute', 2:'arrive', 3:'encours', 4:'terminee'};
  const st = STATUS[activeMission.stage];
  try{
    const r = await fetch('/api/missions/'+activeMission.id+'/status', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({agentId:NET.agentId, status: st})
    });
    if(!r.ok) throw 0;
    const data = await r.json();
    if(st === 'terminee'){
      const gain = data.gain, comm = data.comm;
      agent.gains.today += gain; agent.gains.total += gain; agent.gains.comm += comm;
      agent.missionsDone = data.stats.missionsDone; agent.rating = data.stats.rating;
      agent.hist.unshift({
        id:activeMission.id, service:activeMission.service, quartier:activeMission.quartier,
        date:new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'short'}),
        montant:activeMission.prix.total, gain, comm, note:5
      });
      activeMission = null; saveAll(); renderAgentDash();
      toast('💰 +'+fmt(gain)+' ! Mission terminée.');
      return;
    }
    activeMission.stage++;
    renderMissionPanel();
  }catch(e){ toast('Erreur réseau — réessayez'); }
}
async function netRenderAgentHist(){
  freshGains();
  const el = document.querySelector('#agent-hist');
  el.innerHTML = '<div class="empty" style="padding:20px">Chargement…</div>';
  let data = null;
  if(NET.agentId){
    try{
      const r = await fetch('/api/agents/'+NET.agentId+'/summary');
      if(r.ok) data = await r.json();
    }catch(e){}
  }
  if(!data){ el.innerHTML = '<div class="empty" style="padding:30px 16px"><div class="ic">🧾</div><b>Pas encore de mission</b><p>Passez en ligne pour recevoir vos premières demandes réelles.</p></div>'; document.querySelector('#hist-total').innerHTML=''; return; }
  const st = data.stats;
  document.querySelector('#hist-total').innerHTML = `
    <div class="rline"><span>Missions réalisées</span><span>${st.missionsDone}</span></div>
    <div class="rline"><span>Vos gains (75%)</span><span style="color:var(--pd);font-weight:800">${fmt(st.gain)}</span></div>
    <div class="rline total"><span>Commission KLEAN (25%)</span><span>${fmt(st.comm)}</span></div>`;
  if(!st.hist.length){ el.innerHTML = '<div class="empty" style="padding:30px 16px"><div class="ic">🧾</div><b>Pas encore de mission</b><p>Passez en ligne pour recevoir vos demandes.</p></div>'; return; }
  el.innerHTML = st.hist.map(h=>{
    const svc = SERVICES.find(s=>s.id===h.service)||{ic:'🧹',nom:h.service};
    return `<div class="hist-item">
      <div><b>${svc.ic} ${svc.nom}</b><small>${h.date||''} · ${h.quartier||''} · ${'⭐'.repeat(h.note||5)}</small></div>
      <div class="amt"><b>+${fmt(h.gain)}</b><small>−${fmt(h.comm)} KLEAN</small></div>
    </div>`;
  }).join('');
  // synchronise le tableau de bord
  agent.missionsDone = st.missionsDone; agent.rating = st.rating; saveAll();
}

/* Afficher une photo de mission en grand */
function viewMissionPhoto(i){
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;padding:14px';
  ov.innerHTML = `<img src="${window._missionPhotos[i]}" style="max-width:100%;max-height:88vh;border-radius:12px"><button style="position:absolute;top:14px;right:16px;background:var(--card2);border:1px solid var(--line);color:var(--ink);font-size:20px;width:38px;height:38px;border-radius:50%;cursor:pointer">✕</button>`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}


/* ═══════════════════════ 📣 AFFICHE (mise à jour / annonce du PDG) ═══════════════════════
   → bandeau discret en haut de l'app + mémoire pour ne pas repousser deux fois la même annonce
   → bandeau « MISE À JOUR » affiché automatiquement quand le serveur change de version       */
function renderAnnonceBanner(a) {
  let el = document.getElementById('ann-bar');
  if (!a) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'ann-bar';
    el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9400;max-width:520px;width:calc(100% - 20px);';
    document.body.appendChild(el);
  }
  const C = { maj: '#ffb020', info: '#15c98a', alerte: '#ff6b6b' }[a.type] || '#ffb020';
  const I = { maj: '\u2728', info: '\u2139\uFE0F', alerte: '\u26A0\uFE0F' }[a.type] || '\uD83D\uDCE3';
  const T = { maj: 'MISE À JOUR KLEAN', info: 'INFO KLEAN', alerte: 'IMPORTANT — KLEAN' }[a.type] || 'KLEAN';
  el.innerHTML =
    '<div style="background:var(--card);border:1.5px solid ' + C + ';border-radius:14px;padding:11px 13px;display:flex;align-items:flex-start;gap:9px;box-shadow:0 12px 34px rgba(0,0,0,.4)">' +
    '<span style="font-size:16px;flex:none">' + I + '</span>' +
    '<div style="flex:1;min-width:0">' +
    '<b style="font-size:10.5px;letter-spacing:.5px;color:' + C + '">' + T + '</b>' +
    '<div style="font-size:13px;line-height:1.45;margin-top:2px">' + a.message + '</div>' +
    (a.force ? '<button onclick="location.reload(true)" style="margin-top:7px;background:' + C + ';color:#10130f;border:none;font-weight:900;font-size:11.5px;padding:7px 13px;border-radius:9px;cursor:pointer;font-family:inherit">\uD83D\uDD04 Actualiser l\u2019application</button>' : '') +
    '</div>' +
    '<button onclick="fermerAnnonce()" style="flex:none;background:none;border:none;color:var(--muted);font-size:15px;cursor:pointer;padding:0 2px;line-height:1">\u2715</button>' +
    '</div>';
}
window._annId = null;
function fermerAnnonce() {
  if (window._annId) try { localStorage.setItem('klean_ann_cachee', window._annId); } catch (e) { }
  const el = document.getElementById('ann-bar');
  if (el) el.remove();
}
async function checkAnnonce() {
  try {
    const r = await fetch('/api/annonce', { cache: 'no-store' });
    const d = await r.json();
    if (!d || !d.ok) return;
    if (d.version) {
      const lastV = localStorage.getItem('klean_version');
      localStorage.setItem('klean_version', d.version);
      if (lastV && lastV !== d.version && localStorage.getItem('klean_ann_cachee') !== 'v' + d.version) {
        window._annId = 'v' + d.version;
        renderAnnonceBanner({ id: window._annId, type: 'maj', force: true, message: 'KLEAN vient d\u2019être modernisé (' + d.version + '). Rechargez pour profiter des dernières nouveautés.' });
        return;
      }
    }
    if (d.annonce && localStorage.getItem('klean_ann_cachee') !== d.annonce.id) {
      window._annId = d.annonce.id;
      renderAnnonceBanner(d.annonce);
      return;
    }
    if (!d.annonce) renderAnnonceBanner(null);
  } catch (e) { /* silencieux : hivernage ou démo locale */ }
}
window.addEventListener('load', function () { checkAnnonce(); setInterval(checkAnnonce, 60000); });


/* ═══════════════════ 💬 SUPPORT INTERNE (client & pro ↔ équipe) ═══════════════════
   Bulle flottante en bas de l'app + fil direct avec l'équipe.
   Le client s'identifie par son jeton, le professionnel par son agentId.            */
function supId() {
  try {
    if (typeof client !== 'undefined' && client && client.token) return { h: { 'X-Client-Token': client.token }, body: {}, qs: '' };
  } catch (e) { }
  const aid = (NET && NET.agentId) || localStorage.getItem('k2_agentId') || '';
  if (aid) return { h: { 'Content-Type': 'application/json' }, body: { agentId: aid }, qs: '?agentId=' + encodeURIComponent(aid) };
  return null;
}
let _supBuild = false, _supTimer = null, _supUnread = 0;
function supBuild() {
  if (_supBuild) return; _supBuild = true;
  const css = document.createElement('style');
  css.textContent = `
#sup-fab{position:fixed;right:14px;bottom:96px;z-index:9600;width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,#15c98a,#0a8f60);border:none;color:#04130c;font-size:22px;box-shadow:0 8px 22px rgba(21,201,138,.35);cursor:pointer;display:flex;align-items:center;justify-content:center}
#sup-fab .bdg{position:absolute;top:-3px;right:-3px;background:#ff6b6b;color:#fff;font-size:10px;font-weight:900;min-width:18px;height:18px;border-radius:9px;display:none;align-items:center;justify-content:center;padding:0 4px;border:2px solid var(--card)}
#sup-pane{position:fixed;left:0;right:0;bottom:0;z-index:9700;max-width:520px;margin:0 auto;background:var(--card);border-top-left-radius:20px;border-top-right-radius:20px;box-shadow:0 -14px 44px rgba(0,0,0,.5);padding:14px 14px 0;display:none;flex-direction:column;max-height:72vh}
#sup-msgs2{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding:4px 2px;min-height:170px}
.sup-b{max-width:82%;border-radius:12px;padding:8px 11px;font-size:13.5px;line-height:1.42;word-break:break-word}
.sup-b small{display:block;margin-top:3px;font-size:9.5px;color:var(--muted)}`;
  document.head.appendChild(css);
  const fab = document.createElement('button');
  fab.id = 'sup-fab'; fab.innerHTML = '💬<span class="bdg" id="sup-bdg"></span>';
  fab.onclick = function () { supOpen(); };
  document.body.appendChild(fab);
  const pane = document.createElement('div');
  pane.id = 'sup-pane';
  pane.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">' +
    '<div><b style="font-size:15px">💬 Support KLEAN</b><div style="font-size:11px;color:var(--muted)">Le gestionnaire vous lit — réponse habituelle : <10 min</div></div>' +
    '<button onclick="supClose()" style="background:var(--card2);border:1px solid var(--line);color:var(--muted);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:15px">✕</button></div>' +
    '<div id="sup-msgs2"></div>' +
    '<div style="display:flex;gap:7px;padding:10px 0 12px">' +
    '<input id="sup-in" maxlength="400" placeholder="Écrivez votre message…" style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--line);background:var(--card2);color:var(--ink);font:inherit;font-size:13.5px">' +
    '<button onclick="supSend()" style="background:var(--p);border:none;color:#04130c;font-weight:900;padding:0 16px;border-radius:12px;cursor:pointer;font-family:inherit;font-size:14px">➤</button></div>';
  document.body.appendChild(pane);
  supRefreshBadge();
  setInterval(supRefreshBadge, 30000);
}
async function supRefreshBadge() {
  const id = supId(); if (!id) return;
  try {
    const r = await fetch('/api/support/mine' + (id.qs ? id.qs + '&' : '?') + 'peek=1', { headers: id.h });
    const d = await r.json().catch(() => ({}));
    _supUnread = (d && d.unread) || 0;
    const b = document.getElementById('sup-bdg');
    if (b) { b.textContent = _supUnread > 9 ? '9+' : _supUnread; b.style.display = _supUnread ? 'flex' : 'none'; }
  } catch (e) { }
}
window.supRefreshBadge = supRefreshBadge;
function supRender(list) {
  const box = document.getElementById('sup-msgs2'); if (!box) return;
  if (list === null) {
    box.innerHTML = '<div class="sup-b" style="background:var(--card2);border:1px solid var(--line);align-self:center;color:var(--muted)">Créez un compte pour écrire au support.<small>Accueil → inscription en 1 min</small></div>';
    return;
  }
  box.innerHTML = (list || []).map(s => {
    const me = s.from === 'user';
    return '<div class="sup-b" style="align-self:' + (me ? 'flex-end;background:rgba(21,201,138,.16);border:1px solid rgba(21,201,138,.4)' : 'flex-start;background:var(--card2);border:1px solid var(--line)') + '">' +
      s.text + '<small>' + (me ? 'vous' : ('Support' + (s.par ? ' · ' + s.par : ''))) + ' · ' + (s.at || '').slice(11, 16) + '</small></div>';
  }).join('') || '<div class="sup-b" style="background:var(--card2);border:1px solid var(--line);align-self:flex-start">Bonjour ! 👋 Écrivez-nous ici — un souci de mission, une question, une idée ?<small>Support KLEAN</small></div>';
  box.scrollTop = box.scrollHeight;
}
function supOpen() {
  supBuild();
  document.getElementById('sup-pane').style.display = 'flex';
  supLoad();
  if (_supTimer) clearInterval(_supTimer);
  _supTimer = setInterval(supLoad, 8000);
}
function supClose() {
  document.getElementById('sup-pane').style.display = 'none';
  if (_supTimer) { clearInterval(_supTimer); _supTimer = null; }
}
window.supClose = supClose;
async function supLoad() {
  const id = supId();
  if (!id) { supRender(null); return; }
  try {
    const r = await fetch('/api/support/mine' + id.qs, { headers: id.h });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) { supRender(null); return; }
    supRender(d.messages || []);
    if (d.unread) supRefreshBadge();
  } catch (e) { }
}
async function supSend() {
  const id = supId();
  const inp = document.getElementById('sup-in');
  const text = (inp && inp.value || '').trim();
  if (!id) { toast('🗣️ Créez d\u2019abord un compte pour écrire au support'); return; }
  if (text.length < 2) return;
  const r = await fetch('/api/support/send', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, id.h),
    body: JSON.stringify(Object.assign({ text }, id.body))
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast('⚠️ ' + (d.error || 'Envoi impossible')); return; }
  inp.value = '';
  supLoad();
}
window.supSend = supSend;
window.addEventListener('load', supBuild);

/* ════════════════════════════════════════════════════════════════
   🟠 ÉCOLE LINK — Serveur central (pont école ↔ parents)
   ─────────────────────────────────────────────────────────────────
   Node 18+ — base locale db.json (auto-créée), WebSocket maison,
   notifications web (VAPID) si web-push installé.
   ════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATALOG = require('./catalog-ci.json');
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'db.json');
const APP_NAME = 'ÉCOLE LINK';
const SUB_PRICE = 3000;            // 3 000 F / an / famille
const SUB_DAYS = 365;
const TRIAL_DAYS = 30;

let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.log('ℹ️  web-push non installé — notifications poche désactivées (npm install web-push)'); }
let pg = null;
try { pg = require('pg'); } catch (e) { /* optionnel : repli fichier */ }

/* ───────── Base de données ─────────
   🐘 Si DATABASE_URL (Neon) est posée : coffre permanent (table el_kv, un document JSON).
   📁 Sinon : fichier db.json local (développement / tests) — le code ne change pas d'un iota. */
function freshDb() {
  return {
    settings: { price: SUB_PRICE, trialDays: TRIAL_DAYS, vapid: null, secret: crypto.randomBytes(20).toString('hex'), ownerPassHash: null, ownerSalt: null },
    schools: [], staff: [], classes: [], students: [], parents: [],
    attendance: [], absences: [], announcements: [], payments: [], notifications: [], audit: []
  };
}
let db;
let pgClient = null, pgSaveTimer = null, pgDirty = false;
function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
  if (!pgClient) return;
  pgDirty = true;
  if (pgSaveTimer) return;
  pgSaveTimer = setTimeout(async () => {
    pgSaveTimer = null;
    if (!pgDirty) return;
    pgDirty = false;
    try {
      await pgClient.query('INSERT INTO el_kv(key, data, updated_at) VALUES($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET data = $2::jsonb, updated_at = NOW()', ['db', JSON.stringify(db)]);
    } catch (e) { console.log('⚠️ Sauvegarde Neon :', e.message); pgDirty = true; }
  }, 1200);
}
async function initDb() {
  if (process.env.DATABASE_URL && pg) {
    try {
      pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgClient.connect();
      await pgClient.query('CREATE TABLE IF NOT EXISTS el_kv (key TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
      const r = await pgClient.query('SELECT data FROM el_kv WHERE key = $1', ['db']);
      if (r.rows.length && r.rows[0].data) {
        db = r.rows[0].data;
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
        console.log('🐘 Base chargée depuis Neon — les données sont en sécurité ✓');
        return;
      }
      db = freshDb();
      await pgClient.query('INSERT INTO el_kv(key, data) VALUES($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', ['db', JSON.stringify(db)]);
      try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
      console.log('🐘 Neon : coffre frais créé ✓');
      return;
    } catch (e) {
      console.log('⚠️ Neon injoignable (' + e.message + ') — repli sur le fichier local db.json');
      try { if (pgClient) await pgClient.end(); } catch (e2) {}
      pgClient = null;
    }
  }
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = freshDb(); saveDb(); }
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function uid(p) { return p + '-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function nowISO() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }
function daysFromNow(n) { return Date.now() + n * 86400000; }
function hashPassword(salt, pw) { return sha256(salt + '::' + String(pw)); }
function validPassword(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Au moins 8 caractères';
  if (!/[a-zA-Z]/.test(pw)) return 'Contient une lettre';
  if (!/[0-9]/.test(pw)) return 'Contient un chiffre';
  return null;
}
function parentToken(passHash) { return sha256('PT::' + passHash + '::' + db.settings.secret); }
function auditLog(kind, data) { db.audit.push({ at: nowISO(), kind, data }); if (db.audit.length > 400) db.audit = db.audit.slice(-400); }

/* ───────── Sessions admin/école (mémoire — relogin au redémarrage) ───────── */
const sessions = new Map(); // sid -> {role:'boss'|'staff', staffId, at}
function newSession(obj) { const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, { ...obj, at: Date.now() }); return sid; }
function getSession(req) {
  const c = /(?:^|;\s*)elsid=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return c && sessions.get(c[1]) ? { sid: c[1], ...sessions.get(c[1]) } : null;
}
function setCookie(res, sid) { res.setHeader('Set-Cookie', 'elsid=' + sid + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200'); }

/* ───────── HTTP helpers ───────── */
function sendJson(res, code, obj, head) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' }, head || {}));
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 9e6) { reject(new Error('payload')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon' };

/* ───────── Auth accès ───────── */
function findParentByToken(req) {
  const t = req.headers['x-parent-token'];
  if (!t) return null;
  return db.parents.find(p => parentToken(p.passHash) === t && !p.blocked) || null;
}
function staffOf(sess) { return sess && sess.role === 'staff' ? db.staff.find(x => x.id === sess.staffId) : null; }

/* ───────── Modèle d'affaires : abonnement famille ───────── */
function priceOf() {
  const p = db.settings && db.settings.price;
  return (typeof p === 'number' && isFinite(p) && p >= 0) ? Math.round(p) : SUB_PRICE;
}
function trialDaysOf() {
  const t = db.settings && db.settings.trialDays;
  return (typeof t === 'number' && isFinite(t) && t >= 0 && t <= 365) ? Math.round(t) : TRIAL_DAYS;
}
function isFree() { return priceOf() === 0; }
function subOf(parent) {
  if (isFree()) return { active: true, trialDaysLeft: 0, until: null, price: 0, free: true };
  const now = Date.now();
  const trial = parent.trialEnd || 0, sub = parent.subUntil || 0;
  const active = now < trial || now < sub;
  const trialDaysLeft = trial ? Math.max(0, Math.ceil((trial - now) / 86400000)) : 0;
  const until = sub > now ? new Date(sub).toISOString().slice(0, 10) : null;
  return { active, trialDaysLeft, until, price: priceOf(), free: false };
}
function parentsOfStudent(studentId) { return db.parents.filter(p => (p.children || []).some(c => c.studentId === studentId)); }
function childrenOf(parent) {
  return (parent.children || []).map(li => db.students.find(s => s.id === li.studentId)).filter(Boolean);
}
function targetParents(a) {
  /* qui reçoit l'annonce ? */
  let studs = [];
  if (a.target.type === 'school') studs = db.students.filter(s => s.schoolId === a.schoolId);
  else if (a.target.type === 'class') studs = db.students.filter(s => s.schoolId === a.schoolId && s.classId === a.target.classId);
  const set = new Map();
  studs.forEach(s => parentsOfStudent(s.id).forEach(p => set.set(p.id, p)));
  return [...set.values()];
}

/* ───────── Notifications (poche + temps réel + boîte interne) ───────── */
function parentSockets(parentId) { return [...sockets].filter(s => s.meta && s.meta.role === 'parent' && s.meta.parentId === parentId); }
function bossSockets() { return [...sockets].filter(s => s.meta && s.meta.role === 'boss'); }
function schoolSockets(schoolId) { return [...sockets].filter(s => s.meta && s.meta.role === 'staff' && s.meta.schoolId === schoolId); }
function vapidKeys() {
  if (!webpush) return null;
  if (!db.settings.vapid) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    db.settings.vapid = { publicKey: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
    saveDb(); console.log('🔑 Clés VAPID générées');
  }
  try { webpush.setVapidDetails('mailto:contact@ecolelink.ci', db.settings.vapid.publicKey, db.settings.vapid.privateKey); }
  catch (e) { console.log('⚠️ VAPID invalide :', e.message); return null; }
  return db.settings.vapid;
}
async function notifyParent(parent, icon, title, body, extra) {
  const n = { id: uid('NT'), parentId: parent.id, icon, title, body, at: nowISO(), read: false, ...(extra || {}) };
  db.notifications.push(n); if (db.notifications.length > 4000) db.notifications = db.notifications.slice(-4000);
  saveDb();
  broadcast(parentSockets(parent.id), { type: 'alerte', notification: n });
  if (webpush && vapidKeys() && Array.isArray(parent.pushSubs)) {
    const payload = JSON.stringify({ title: icon + ' ' + title, body, url: '/?onglet=ecole' });
    let dirty = false;
    for (const sub of [...parent.pushSubs]) {
      try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: extra && extra.urgent ? 'high' : 'normal' }); }
      catch (e) { const c = e && (e.statusCode || e.status); if (c === 404 || c === 410) { parent.pushSubs = parent.pushSubs.filter(s => s.endpoint !== sub.endpoint); dirty = true; } }
    }
    if (dirty) saveDb();
  }
  return n;
}
function notifySchool(schoolId, icon, title, body) {
  broadcast(schoolSockets(schoolId), { type: 'alerte_ecole', icon, title, body, at: nowISO() });
}
function schoolName(id) { const s = db.schools.find(x => x.id === id); return s ? s.nom : '—'; }
function className(id) { const c = db.classes.find(x => x.id === id); return c ? c.nom : '—'; }

/* ═══════════ ROUTES ═══════════ */
async function handleApi(req, res, p, url) {
  /* ---- Santé & config ---- */
  if (p === '/api/health') return sendJson(res, 200, { ok: true, app: APP_NAME, at: nowISO() });
  if (p === '/api/catalog' && req.method === 'GET') {
    const q = (url.searchParams.get('ville') || '').trim();
    if (!q) {
      return sendJson(res, 200, {
        villes: (CATALOG.villes || []).map(v => ({ nom: v.nom, n: (v.ecoles || []).length }))
      });
    }
    const v = (CATALOG.villes || []).find(x => x.nom === q);
    if (!v) return sendJson(res, 404, { error: 'Ville introuvable' });
    const live = db.schools.map(s => (s.nom || '').toLowerCase());
    return sendJson(res, 200, {
      ville: v.nom,
      ecoles: (v.ecoles || []).map(e => ({
        ...e,
        surPlateforme: live.some(n => n.includes((e.nom || '').toLowerCase().slice(0, 18)))
      }))
    });
  }
  if (p === '/api/config') return sendJson(res, 200, { price: priceOf(), trialDays: trialDaysOf(), subDays: SUB_DAYS, free: isFree(), vapid: vapidKeys() ? db.settings.vapid.publicKey : null });

  /* ---- PDG : premier mot de passe puis connexion ---- */
  if (p === '/api/admin/setup' && req.method === 'POST') {
    const b = await readBody(req);
    if (db.settings.ownerPassHash) return sendJson(res, 409, { error: 'Déjà initialisé — connectez-vous' });
    const perr = validPassword(b.password);
    if (perr) return sendJson(res, 400, { error: perr });
    db.settings.ownerSalt = crypto.randomBytes(12).toString('hex');
    db.settings.ownerPassHash = hashPassword(db.settings.ownerSalt, b.password);
    saveDb();
    const sid = newSession({ role: 'boss' }); setCookie(res, sid);
    auditLog('pdg_init', {});
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/login' && req.method === 'POST') {
    const b = await readBody(req);
    const ok = db.settings.ownerPassHash && hashPassword(db.settings.ownerSalt, b.password || '') === db.settings.ownerPassHash;
    if (!ok) return sendJson(res, 401, { error: 'Mot de passe incorrect' });
    const sid = newSession({ role: 'boss' }); setCookie(res, sid);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const s = getSession(req); if (s) sessions.delete(s.sid);
    res.setHeader('Set-Cookie', 'elsid=; Path=/; HttpOnly; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  /* ---- Parents : public compte ---- */
  if (p === '/api/parents/register' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.nom || String(b.nom).trim().length < 2) return sendJson(res, 400, { error: 'Indiquez votre nom complet' });
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (tel.length < 8) return sendJson(res, 400, { error: 'Numéro de téléphone invalide' });
    const perr = validPassword(b.password);
    if (perr) return sendJson(res, 400, { error: perr });
    if (db.parents.find(x => x.tel === tel)) return sendJson(res, 409, { error: 'Ce numéro a déjà un compte — connectez-vous' });
    const salt = crypto.randomBytes(12).toString('hex');
    const par = { id: uid('PA'), nom: String(b.nom).trim(), tel, salt, passHash: hashPassword(salt, b.password), createdAt: nowISO(), children: [], trialEnd: isFree() ? 0 : daysFromNow(trialDaysOf()), subUntil: 0, pushSubs: [], blocked: false, read: {}, rsvp: {} };
    db.parents.push(par); saveDb();
    console.log('👨‍👩‍👧 Nouveau parent : ' + par.nom + ' (' + tel + ') — ' + (isFree() ? 'accès gratuit' : ('essai ' + trialDaysOf() + ' jours')));
    return sendJson(res, 201, { ok: true, parentId: par.id, token: parentToken(par.passHash), nom: par.nom });
  }
  if (p === '/api/parents/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const par = db.parents.find(x => x.tel === tel);
    if (!par || hashPassword(par.salt, b.password || '') !== par.passHash) return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    if (par.blocked) return sendJson(res, 403, { error: 'Compte bloqué — contactez la plateforme' });
    return sendJson(res, 200, { ok: true, parentId: par.id, token: parentToken(par.passHash), nom: par.nom, photo: par.photo || '' });
  }

  /* =================== PARENT (X-Parent-Token) =================== */
  if (p.startsWith('/api/parents/') || p === '/api/parents/me') {
    const par = findParentByToken(req);
    if (!par) return sendJson(res, 401, { error: 'Session parent requise' });

    if (p === '/api/parents/me' && req.method === 'GET') {
      return sendJson(res, 200, {
        nom: par.nom, tel: par.tel, photo: par.photo || '',
        sub: subOf(par),
        unread: db.notifications.filter(n => n.parentId === par.id && !n.read).length,
        children: childrenOf(par).map(s => ({
          id: s.id, nom: s.nom, prenom: s.prenom, sex: s.sex || '', photo: s.photo || '',
          school: schoolName(s.schoolId), classe: className(s.classId), classId: s.classId, schoolId: s.schoolId,
          today: todayStatus(s.id)
        }))
      });
    }
    if (p === '/api/parents/me' && req.method === 'PUT') {
      const b = await readBody(req);
      if (b.nom && String(b.nom).trim().length >= 2) par.nom = String(b.nom).trim().slice(0, 80);
      if (typeof b.photo === 'string' && b.photo.length < 600000) par.photo = b.photo;
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/parents/claim' && req.method === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '').replace(/\D/g, '');
      const st = db.students.find(s => s.linkCode === code);
      if (!st) return sendJson(res, 404, { error: 'Code inconnu — demandez-le à l\'école' });
      if ((par.children || []).some(c => c.studentId === st.id)) return sendJson(res, 409, { error: 'Cet enfant est déjà dans votre famille' });
      st.linkCode = null;
      (par.children = par.children || []).push({ studentId: st.id, since: nowISO() });
      saveDb();
      auditLog('enfant_lie', { parent: par.nom, enfant: st.prenom + ' ' + st.nom, ecole: schoolName(st.schoolId) });
      notifySchool(st.schoolId, '🤝', 'Famille liée', par.nom + ' a rejoint le suivi de ' + st.prenom + ' ' + st.nom);
      return sendJson(res, 200, { ok: true, enfant: st.prenom + ' ' + st.nom, ecole: schoolName(st.schoolId), classe: className(st.classId) });
    }
    if (p === '/api/parents/feed' && req.method === 'GET') {
      const kls = new Set(childrenOf(par).map(s => s.classId));
      const anns = db.announcements
        .filter(a => a.target.type === 'school'
          ? childrenOf(par).some(c => c.schoolId === a.schoolId)
          : kls.has(a.target.classId))
        .slice(-60).reverse()
        .map(a => ({
          id: a.id, title: a.title, body: a.body, cat: a.cat, at: a.at, pic: a.pic || '',
          school: schoolName(a.schoolId), classe: a.target.type === 'class' ? className(a.target.classId) : '',
          reunionAt: a.reunionAt || null,
          read: !!(par.read && par.read[a.id]),
          ack: !!(par.ack && par.ack[a.id]),
          rsvp: (par.rsvp && par.rsvp[a.id]) || null
        }));
      const notes = db.notifications.filter(n => n.parentId === par.id).slice(-60).reverse();
      return sendJson(res, 200, { announcements: anns, notifications: notes });
    }
    if (p === '/api/parents/read' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.notificationId) { const n = db.notifications.find(x => x.id === b.notificationId && x.parentId === par.id); if (n) n.read = true; }
      if (b.announcementId) { (par.read = par.read || {})[b.announcementId] = nowISO(); }
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/parents/ack' && req.method === 'POST') {
      const b = await readBody(req);
      const a = db.announcements.find(x => x.id === b.announcementId);
      if (!a) return sendJson(res, 404, { error: 'Message introuvable' });
      (par.read = par.read || {})[a.id] = nowISO();
      (par.ack = par.ack || {})[a.id] = nowISO();
      saveDb();
      notifySchool(a.schoolId, '📩', 'Message reçu', par.nom + ' a confirmé la réception de « ' + a.title + ' »');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/parents/rsvp' && req.method === 'POST') {
      const b = await readBody(req);
      const a = db.announcements.find(x => x.id === b.announcementId);
      if (!a) return sendJson(res, 404, { error: 'Annonce introuvable' });
      if (!['oui', 'non'].includes(b.resp)) return sendJson(res, 400, { error: 'Réponse oui/non attendue' });
      (par.rsvp = par.rsvp || {})[a.id] = { resp: b.resp, at: nowISO() };
      saveDb();
      notifySchool(a.schoolId, '🗳️', 'Réponse à une convocation', par.nom + ' : ' + (b.resp === 'oui' ? '✅ présent(e)' : '❌ absent(e)') + ' — « ' + a.title + ' »');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/parents/absences' && req.method === 'GET') {
      const mine = db.absences.filter(x => x.parentId === par.id).slice(-40).reverse()
        .map(x => ({ ...x, enfant: childNameOf(x.studentId), ecole: schoolName(x.schoolId) }));
      return sendJson(res, 200, mine);
    }
    if (p === '/api/parents/absences' && req.method === 'POST') {
      const b = await readBody(req);
      const st = childrenOf(par).find(s => s.id === b.studentId);
      if (!st) return sendJson(res, 404, { error: 'Enfant introuvable' });
      if (!String(b.note || '').trim() && b.kind !== 'maladie') return sendJson(res, 400, { error: 'Précisez le motif en quelques mots' });
      const rec = { id: uid('AB'), parentId: par.id, studentId: st.id, schoolId: st.schoolId, kind: String(b.kind || 'maladie'), from: b.from || today(), to: b.to || today(), note: String(b.note || '').slice(0, 400), certPhoto: String(b.certPhoto || '').slice(0, 600000), status: 'envoyee', at: nowISO() };
      db.absences.push(rec); saveDb();
      auditLog('absence_signalee', { par: par.nom, enfant: st.prenom, motif: rec.kind });
      notifySchool(st.schoolId, '🤒', 'Absence déclarée', par.nom + ' — ' + st.prenom + ' ' + st.nom + ' absent(e) (' + rec.kind + ') du ' + rec.from + (rec.to !== rec.from ? ' au ' + rec.to : ''));
      return sendJson(res, 201, { ok: true });
    }
    if (p === '/api/parents/attendance' && req.method === 'GET') {
      const sid = url.searchParams.get('studentId');
      const st = childrenOf(par).find(s => s.id === sid);
      if (!st) return sendJson(res, 404, { error: 'Enfant introuvable' });
      const rows = [];
      for (const d of db.attendance.slice(-300)) {
        const r = (d.rows || []).find(x => x.studentId === sid);
        if (r) rows.push({ date: d.date, status: r.status });
      }
      return sendJson(res, 200, rows.slice(-60).reverse());
    }
    if (p === '/api/parents/pay' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.ref || '').trim()) return sendJson(res, 400, { error: 'Indiquez la référence de la transaction' });
      const pay = { id: uid('PY'), parentId: par.id, parent: par.nom, tel: par.tel, amount: SUB_PRICE, method: String(b.method || 'wave'), ref: String(b.ref).slice(0, 60), status: 'pending', at: nowISO() };
      db.payments.push(pay); saveDb();
      auditLog('abonnement_paye_en_attente', { parent: par.nom, method: pay.method, ref: pay.ref });
      broadcast(bossSockets(), { type: 'paiement', payment: pay });
      return sendJson(res, 201, { ok: true, message: 'Paiement reçu — validation par la plateforme sous 24 h max. Merci ! 🧡' });
    }
    if (p === '/api/parents/payments' && req.method === 'GET') {
      return sendJson(res, 200, db.payments.filter(x => x.parentId === par.id).slice(-12).reverse());
    }
    if (p === '/api/parents/push-sub' && req.method === 'POST') {
      const b = await readBody(req);
      (par.pushSubs = par.pushSubs || []);
      if (b.sub && b.sub.endpoint && !par.pushSubs.some(s => s.endpoint === b.sub.endpoint)) par.pushSubs.push(b.sub);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  /* =================== ÉCOLE (staff) =================== */
  if (p === '/api/school/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const st = db.staff.find(x => x.tel === tel);
    if (!st || hashPassword(st.salt, b.password || '') !== st.passHash) return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    const sid = newSession({ role: 'staff', staffId: st.id }); setCookie(res, sid);
    return sendJson(res, 200, { ok: true, nom: st.nom, role: st.role, school: schoolName(st.schoolId) });
  }
  if (p.startsWith('/api/school/')) {
    const sess = getSession(req); const me = staffOf(sess);
    if (!me) return sendJson(res, 403, { error: 'Connexion école requise' });
    const mySchool = me.schoolId;

    if (p === '/api/school/me' && req.method === 'GET') {
      const t = todayRows(mySchool);
      return sendJson(res, 200, {
        nom: me.nom, role: me.role, school: schoolName(mySchool),
        classes: db.classes.filter(c => c.schoolId === mySchool).map(c => ({
          id: c.id, nom: c.nom,
          effectif: db.students.filter(s => s.classId === c.id).length,
          pointe: !!db.attendance.find(d => d.classId === c.id && d.date === today())
        })),
        today: t,
        stats7: stats7(mySchool)
      });
    }
    if (p === '/api/school/classes' && req.method === 'POST') {
      if (me.role !== 'directeur') return sendJson(res, 403, { error: 'Le directeur seul crée les classes' });
      const b = await readBody(req);
      if (!String(b.nom || '').trim()) return sendJson(res, 400, { error: 'Nom de la classe requis' });
      const c = { id: uid('CL'), schoolId: mySchool, nom: String(b.nom).trim().slice(0, 40), createdAt: nowISO() };
      db.classes.push(c); saveDb();
      return sendJson(res, 201, { ok: true });
    }
    if (p === '/api/school/students' && req.method === 'GET') {
      const cid = url.searchParams.get('classId');
      return sendJson(res, 200, db.students.filter(s => s.schoolId === mySchool && (!cid || s.classId === cid))
        .map(s => ({ id: s.id, nom: s.nom, prenom: s.prenom, sex: s.sex || '', classId: s.classId, classe: className(s.classId), lie: parentsOfStudent(s.id).length, code: s.linkCode || null })));
    }
    if (p === '/api/school/students' && req.method === 'POST') {
      const b = await readBody(req);
      const cls = db.classes.find(c => c.id === b.classId && c.schoolId === mySchool);
      if (!cls) return sendJson(res, 404, { error: 'Classe introuvable' });
      if (String(b.nom || '').trim().length < 2 || String(b.prenom || '').trim().length < 2) return sendJson(res, 400, { error: 'Nom + prénom requis' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const st = { id: uid('EL'), schoolId: mySchool, classId: cls.id, nom: String(b.nom).trim(), prenom: String(b.prenom).trim(), sex: ['F', 'M'].includes(b.sex) ? b.sex : '', createdAt: nowISO(), linkCode: code };
      db.students.push(st); saveDb();
      auditLog('eleve_cree', { par: me.nom, enfant: st.prenom + ' ' + st.nom, ecole: schoolName(mySchool) });
      return sendJson(res, 201, { ok: true, code });
    }
    if (p === '/api/school/students/regen' && req.method === 'POST') {
      const b = await readBody(req);
      const st = db.students.find(s => s.id === b.studentId && s.schoolId === mySchool);
      if (!st) return sendJson(res, 404, { error: 'Élève introuvable' });
      st.linkCode = String(Math.floor(100000 + Math.random() * 900000)); saveDb();
      return sendJson(res, 200, { ok: true, code: st.linkCode });
    }
    if (p === '/api/school/attendance' && req.method === 'GET') {
      const cid = url.searchParams.get('classId'), date = url.searchParams.get('date') || today();
      const d = db.attendance.find(x => x.classId === cid && x.date === date);
      return sendJson(res, 200, d ? { date, rows: d.rows, pointeur: d.by } : { date, rows: null });
    }
    if (p === '/api/school/attendance' && req.method === 'POST') {
      const b = await readBody(req);
      const cls = db.classes.find(c => c.id === b.classId && c.schoolId === mySchool);
      if (!cls) return sendJson(res, 404, { error: 'Classe introuvable' });
      const rows = (Array.isArray(b.rows) ? b.rows : []).filter(r => ['present', 'absent', 'retard'].includes(r.status))
        .map(r => ({ studentId: r.studentId, status: r.status }));
      if (!rows.length) return sendJson(res, 400, { error: 'Aucune ligne valide' });
      const date = today();
      const old = db.attendance.find(x => x.classId === cls.id && x.date === date);
      if (old) { old.rows = rows; old.by = me.nom; } else db.attendance.push({ id: uid('AT'), schoolId: mySchool, classId: cls.id, date, by: me.nom, rows });
      saveDb();
      /* notifications aux parents des absents (et retards) — la minute même du pointage */
      for (const r of rows.filter(x => x.status !== 'present')) {
        const st = db.students.find(s => s.id === r.studentId);
        if (!st) continue;
        for (const par of parentsOfStudent(st.id)) {
          if (r.status === 'absent')
            await notifyParent(par, '🚨', st.prenom + ' est absent(e) aujourd\'hui',
              'L\'école ' + schoolName(mySchool) + ' a pointé ' + st.prenom + ' ' + st.nom + ' absent(e) ce ' + frDate(date) + ' (' + cls.nom + '). Si c\'est une erreur, contactez la direction.', { urgent: true });
          else
            await notifyParent(par, '⏰', st.prenom + ' est arrivé(e) en retard',
              st.prenom + ' ' + st.nom + ' a été pointé(e) en retard ce ' + frDate(date) + ' (' + cls.nom + ', ' + schoolName(mySchool) + ').', {});
        }
      }
      auditLog('pointage', { classe: cls.nom, par: me.nom, absents: rows.filter(r => r.status === 'absent').length, retards: rows.filter(r => r.status === 'retard').length });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/school/announce' && req.method === 'GET') {
      return sendJson(res, 200, db.announcements.filter(a => a.schoolId === mySchool).slice(-40).reverse().map(a => ({ ...a, stats: announceStats(a) })));
    }
    if (p === '/api/school/announce/receipts' && req.method === 'GET') {
      const a = db.announcements.find(x => x.id === url.searchParams.get('id') && x.schoolId === mySchool);
      if (!a) return sendJson(res, 404, { error: 'Annonce introuvable' });
      const rows = targetParents(a).map(p2 => ({
        nom: p2.nom, tel: p2.tel,
        vu: !!(p2.read && p2.read[a.id]),
        recu: !!(p2.ack && p2.ack[a.id]),
        rsvp: (p2.rsvp && p2.rsvp[a.id] && p2.rsvp[a.id].resp) || null
      }));
      return sendJson(res, 200, { titre: a.title, rows });
    }
    if (p === '/api/school/announce' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.title || '').trim()) return sendJson(res, 400, { error: 'Titre requis' });
      let target = { type: 'school' };
      if (b.targetClassId) {
        const cls = db.classes.find(c => c.id === b.targetClassId && c.schoolId === mySchool);
        if (cls) target = { type: 'class', classId: cls.id };
      }
      const cat = ['info', 'urgent', 'reunion'].includes(b.cat) ? b.cat : 'info';
      const a = { id: uid('AN'), schoolId: mySchool, title: String(b.title).trim().slice(0, 90), body: String(b.body || '').trim().slice(0, 1500), cat, pic: String(b.pic || '').slice(0, 600000), reunionAt: b.reunionAt || null, target, by: me.nom, at: nowISO() };
      db.announcements.push(a); saveDb();
      const cible = targetParents(a);
      const icon = cat === 'urgent' ? '🚨' : cat === 'reunion' ? '📅' : '📣';
      for (const par of cible) {
        await notifyParent(par, icon, a.title, (a.body || '').slice(0, 160) + (cat === 'reunion' && a.reunionAt ? ' — 📅 ' + frDate(a.reunionAt) : ''), { announcementId: a.id, urgent: cat === 'urgent' });
      }
      auditLog('annonce_envoyee', { par: me.nom, titre: a.title, cibles: cible.length, cat });
      return sendJson(res, 201, { ok: true, cibles: cible.length });
    }
    if (p === '/api/school/absences' && req.method === 'GET') {
      return sendJson(res, 200, db.absences.filter(x => x.schoolId === mySchool).slice(-60).reverse()
        .map(x => ({ ...x, enfant: childNameOf(x.studentId), parent: (db.parents.find(p2 => p2.id === x.parentId) || {}).nom || '' })));
    }
    if (p === '/api/school/absences/validate' && req.method === 'POST') {
      const b = await readBody(req);
      const x = db.absences.find(z => z.id === b.id && z.schoolId === mySchool);
      if (!x) return sendJson(res, 404, { error: 'Déclaration introuvable' });
      x.status = 'validee'; saveDb();
      const par = db.parents.find(p2 => p2.id === x.parentId);
      if (par) await notifyParent(par, '✅', 'Absence prise en compte', 'L\'école a validé l\'absence de ' + childNameOf(x.studentId) + ' (' + x.kind + '). Bon rétablissement à l\'enfant 🧡');
      return sendJson(res, 200, { ok: true });
    }
  }

  /* =================== PDG (plateforme) =================== */
  if (p.startsWith('/api/admin/')) {
    const sess = getSession(req);
    if (!sess || sess.role !== 'boss') return sendJson(res, 403, { error: 'Accès plateforme — connexion requise' });

    if (p === '/api/admin/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.price != null) {
        const pr = parseFloat(b.price);
        if (isNaN(pr) || pr < 0 || pr > 500000) return sendJson(res, 400, { error: 'Prix entre 0 (gratuit) et 500 000 F' });
        db.settings.price = Math.round(pr);
      }
      if (b.trialDays != null) {
        const td = parseInt(b.trialDays, 10);
        if (isNaN(td) || td < 0 || td > 365) return sendJson(res, 400, { error: 'Essai entre 0 et 365 jours' });
        db.settings.trialDays = td;
      }
      saveDb();
      auditLog('tarif_modifie', { price: priceOf(), trialDays: trialDaysOf(), par: 'pdg' });
      return sendJson(res, 200, { ok: true, price: priceOf(), trialDays: trialDaysOf(), free: isFree() });
    }
    if (p === '/api/admin/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (hashPassword(db.settings.ownerSalt, b.current || '') !== db.settings.ownerPassHash)
        return sendJson(res, 401, { error: 'Mot de passe actuel incorrect' });
      const perr = validPassword(b.next);
      if (perr) return sendJson(res, 400, { error: perr });
      db.settings.ownerSalt = crypto.randomBytes(12).toString('hex');
      db.settings.ownerPassHash = hashPassword(db.settings.ownerSalt, b.next);
      saveDb();
      sessions.forEach((v, k) => { if (v.role === 'boss') sessions.delete(k); });
      auditLog('mdp_pdg_change', {});
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        price: priceOf(), trialDays: trialDaysOf(), free: isFree(),
        schools: db.schools.map(s => ({
          ...s,
          effectif: db.students.filter(x => x.schoolId === s.id).length,
          classes: db.classes.filter(x => x.schoolId === s.id).length,
          staff: db.staff.filter(x => x.schoolId === s.id).length
        })),
        staff: db.staff.map(s => ({ id: s.id, schoolId: s.schoolId, nom: s.nom, tel: s.tel, role: s.role })),
        parents: db.parents.length,
        students: db.students.length,
        subActifs: db.parents.filter(p => subOf(p).active).length,
        essais: db.parents.filter(p => subOf(p).trialDaysLeft > 0 && !subOf(p).until).length,
        paymentsPending: db.payments.filter(x => x.status === 'pending'),
        paymentsDone: db.payments.filter(x => x.status === 'validated').length,
        recettes: db.payments.filter(x => x.status === 'validated').reduce((n, x) => n + (x.amount || 0), 0),
        audit: db.audit.slice(-80).reverse()
      });
    }
    if (p === '/api/admin/schools' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.nom || '').trim()) return sendJson(res, 400, { error: 'Nom de l\'école requis' });
      const s = { id: uid('SC'), nom: String(b.nom).trim().slice(0, 80), createdAt: nowISO() };
      db.schools.push(s); saveDb();
      auditLog('ecole_creee', { nom: s.nom });
      return sendJson(res, 201, { ok: true, id: s.id });
    }
    if (p === '/api/admin/staff' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.schools.find(x => x.id === b.schoolId);
      if (!s) return sendJson(res, 404, { error: 'École introuvable' });
      const tel = String(b.tel || '').replace(/\D/g, '');
      if (tel.length < 8 || String(b.nom || '').trim().length < 2) return sendJson(res, 400, { error: 'Nom + téléphone requis' });
      if (db.staff.find(x => x.tel === tel)) return sendJson(res, 409, { error: 'Ce numéro existe déjà' });
      let pw = String(b.password || ''), gen = false;
      if (!pw) { pw = 'Lien-' + Math.floor(1000 + Math.random() * 9000) + '!'; gen = true; }
      const salt = crypto.randomBytes(12).toString('hex');
      const st = { id: uid('ST'), schoolId: s.id, nom: String(b.nom).trim(), tel, role: ['directeur', 'surveillant', 'professeur'].includes(b.role) ? b.role : 'directeur', salt, passHash: hashPassword(salt, pw), createdAt: nowISO() };
      db.staff.push(st); saveDb();
      auditLog('staff_cree', { nom: st.nom, ecole: s.nom, role: st.role });
      return sendJson(res, 201, { ok: true, id: st.id, nom: st.nom, tel, password: pw, passwordGenere: gen, school: s.nom });
    }
    if (p === '/api/admin/payments/validate' && req.method === 'POST') {
      const b = await readBody(req);
      const x = db.payments.find(z => z.id === b.id);
      if (!x) return sendJson(res, 404, { error: 'Paiement introuvable' });
      x.status = 'validated'; x.validatedAt = nowISO();
      const par = db.parents.find(p => p.id === x.parentId);
      if (par) {
        const base = Math.max(Date.now(), par.subUntil || 0);
        par.subUntil = base + SUB_DAYS * 86400000;
        saveDb();
        await notifyParent(par, '🎉', 'Abonnement actif pour 1 an !',
          'Merci ' + par.nom.split(' ')[0] + ' ! Votre famille est abonnée jusqu\'au ' + frDate(new Date(par.subUntil).toISOString().slice(0, 10)) + '. Bon suivi de vos enfants 🧡');
        auditLog('abonnement_valide', { parent: par.nom, montant: x.amount });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/payments/reject' && req.method === 'POST') {
      const b = await readBody(req);
      const x = db.payments.find(z => z.id === b.id);
      if (!x) return sendJson(res, 404, { error: 'Paiement introuvable' });
      x.status = 'rejected'; saveDb();
      const par = db.parents.find(p => p.id === x.parentId);
      if (par) await notifyParent(par, '⚠️', 'Paiement non reconnu', 'La référence ' + x.ref + ' n\'a pas été retrouvée. Contactez la plateforme ou réessayez — aucun montant n\'est perdu si la transaction a bien eu lieu.');
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Route inconnue' });
}

/* ───────── Utilitaires métier ───────── */
function todayStatus(studentId) {
  const d = db.attendance.find(x => x.date === today() && (x.rows || []).some(r => r.studentId === studentId));
  if (!d) return null;
  const r = d.rows.find(x => x.studentId === studentId);
  return r ? r.status : null;
}
function todayRows(schoolId) {
  const cls = db.classes.filter(c => c.schoolId === schoolId);
  let presents = 0, absents = 0, retards = 0, nonPointes = 0;
  for (const c of cls) {
    const d = db.attendance.find(x => x.classId === c.id && x.date === today());
    if (!d) { nonPointes += db.students.filter(s => s.classId === c.id).length; continue; }
    for (const r of d.rows) { if (r.status === 'present') presents++; else if (r.status === 'absent') absents++; else if (r.status === 'retard') retards++; }
  }
  return { presents, absents, retards, nonPointes };
}
function stats7(schoolId) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    let tot = 0, ab = 0;
    for (const d of db.attendance.filter(x => x.schoolId === schoolId && x.date === day))
      for (const r of d.rows) { tot++; if (r.status === 'absent') ab++; }
    days.push({ date: day.slice(5), taux: tot ? Math.round(ab / tot * 100) : null });
  }
  return days;
}
function announceStats(a) {
  const cible = targetParents(a).length;
  const reads = db.parents.filter(p => p.read && p.read[a.id]).length;
  const acks = db.parents.filter(p => p.ack && p.ack[a.id]).length;
  const oui = db.parents.filter(p => p.rsvp && p.rsvp[a.id] && p.rsvp[a.id].resp === 'oui').length;
  const non = db.parents.filter(p => p.rsvp && p.rsvp[a.id] && p.rsvp[a.id].resp === 'non').length;
  return { cible, reads, acks, oui, non };
}
function childNameOf(studentId) { const s = db.students.find(x => x.id === studentId); return s ? s.prenom + ' ' + s.nom : 'l\'élève'; }
function frDate(iso) { try { return new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Abidjan' }); } catch (e) { return iso; } }

/* ───────── Fichiers statiques ───────── */
function serveStatic(req, res, p) {
  let file;
  if (p === '/' || p === '/index.html') file = 'index.html';
  else if (p === '/admin' || p === '/admin.html') file = 'admin.html';
  else if (p === '/admin-login.html') file = 'admin-login.html';
  else if (p === '/sw.js') file = 'sw.js';
  else if (p === '/manifest.json') file = 'manifest.json';
  else if (p === '/manifest-admin.json') file = 'manifest-admin.json';
  else if (p === '/ecole-link-icon-192.png') file = 'ecole-link-icon-192.png';
  else if (p === '/ecole-link-icon-512.png') file = 'ecole-link-icon-512.png';
  else if (p === '/logo-ecole-link.png' || p === '/favicon.ico') file = 'ecole-link-icon-512.png';
  if (!file) return false;
  const fp = path.join(__dirname, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file === 'index.html' || file === 'admin.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
  return true;
}

/* ───────── WebSocket léger (handshake maison) ───────── */
const sockets = new Set();
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(sock, obj) {
  if (sock.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { sock.write(Buffer.concat([header, data])); } catch (e) {}
}
function broadcast(list, obj) { list.forEach(s => wsSend(s, obj)); }
function handleWsData(sock) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) { const m = buf.slice(maskOff, maskOff + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
      buf = buf.slice(off + len);
      if (opcode === 0x8) { sock.end(); return; }
      if (opcode === 0x9) { try { sock.write(Buffer.from([0x8a, 0])); } catch (e) {} continue; }
      if (opcode === 0x1) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg && msg.type === 'ping') wsSend(sock, { type: 'pong', at: Date.now() });
        } catch (e) {}
      }
    }
  };
}
function upgradeWs(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const url = new URL(req.url, 'http://x');
  sock.meta = {};
  const pTok = url.searchParams.get('parent');
  if (pTok) {
    const par = db.parents.find(x => parentToken(x.passHash) === pTok && !x.blocked);
    if (par) sock.meta = { role: 'parent', parentId: par.id };
  }
  const sid = /(?:^|;\s*)elsid=([0-9a-f]+)/.exec(req.headers.cookie || '');
  if (sid && sessions.has(sid[1])) {
    const sn = sessions.get(sid[1]);
    if (sn.role === 'boss') sock.meta = { role: 'boss' };
    else if (sn.role === 'staff') { const st = staffOf(sn); if (st) sock.meta = { role: 'staff', schoolId: st.schoolId }; }
  }
  sockets.add(sock);
  sock.on('data', handleWsData(sock));
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
}

/* ───────── Serveur ───────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, p, url);
    if (serveStatic(req, res, p)) return;
    res.writeHead(404); res.end('404');
  } catch (e) {
    console.log('⚠️', e.message);
    try { sendJson(res, 500, { error: 'Erreur interne' }); } catch (e2) {}
  }
});
server.on('upgrade', (req, sock) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/ws') return upgradeWs(req, sock);
  sock.destroy();
});
(async () => {
  await initDb();
  server.listen(PORT, () => {
    console.log('');
    console.log('🟠 ' + APP_NAME + ' — serveur en marche');
    console.log('📡 HTTP        : http://localhost:' + PORT);
    console.log('📡 WebSocket   : ws://localhost:' + PORT + '/ws');
    console.log('🐘 Coffre      : ' + (pgClient ? 'Neon (permanent)' : 'fichier local db.json'));
    console.log('🎓 Prix famille : ' + SUB_PRICE + ' F / ' + SUB_DAYS + ' jours (essai ' + TRIAL_DAYS + ' jours)');
    console.log('');
  });
})();

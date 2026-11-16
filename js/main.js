// 進入點：登入、角色載入、路由、閒置登出
import { CONFIG } from './config.js';
import { sb, state, $, esc, toast, errText, canWrite, isAdmin, ROLE_LABEL, verifyTotp } from './core.js';
import { assetsView, peopleView, hostsView, vendorsView, tasksView, kbView } from './entities.js';
import { dashboardView, auditView, usersView, importView } from './secure.js';

const ROUTES = [
  { id: 'dashboard', label: '總覽', view: dashboardView },
  { id: 'assets', label: '設備台帳（電腦／印表機／網路／中控）', view: assetsView },
  { id: 'people', label: '人員', view: peopleView },
  { id: 'hosts', label: '主機與系統帳密', view: hostsView },
  { id: 'vendors', label: '廠商聯絡', view: vendorsView },
  { id: 'tasks', label: '交辦事項', view: tasksView },
  { id: 'kb', label: '知識庫', view: kbView },
  { id: 'audit', label: '稽核紀錄', view: auditView },
  { id: 'users', label: '使用者管理', view: usersView, admin: true },
  { id: 'import', label: '匯入帳密', view: importView, admin: true },
];

const show = (id) => ['loginView', 'mfaView', 'pendingView', 'appView'].forEach((v) => $('#' + v).classList.toggle('hidden', v !== id));
const allowed = () => ROUTES.filter((r) => !r.admin || isAdmin());

async function route() {
  const list = allowed();
  const id = location.hash.replace(/^#\//, '') || 'dashboard';
  const r = list.find((x) => x.id === id) || list[0];
  $('#nav').innerHTML = list.map((x) => `<a href="#/${x.id}" class="${x.id === r.id ? 'active' : ''}">${esc(x.label)}</a>`).join('');
  $('#pageTitle').textContent = r.label;
  $('#side').classList.remove('open');
  const root = $('#content');
  root.innerHTML = '<p class="muted">載入中…</p>';
  try { await r.view(root); } catch (e) { root.innerHTML = `<p class="empty">${esc(errText(e))}</p>`; }
}

// 密碼登入後，必須再通過動態驗證碼（aal2）才能進系統
async function gate(session) {
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal2') return enter(session);
  show('mfaView');
  const body = $('#mfaBody');
  if (aal?.nextLevel === 'aal2') {
    body.innerHTML = `<form id="mfaForm" style="display:grid;gap:12px">
      <p class="sub">請輸入驗證 App 上的 6 位數字。</p>
      <input type="text" id="mfaCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
      <button class="btn primary" type="submit">驗證</button><p class="msg" id="mfaMsg"></p></form>`;
    $('#mfaCode').focus();
    $('#mfaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await verifyTotp($('#mfaCode').value); } catch { $('#mfaMsg').textContent = '驗證碼不正確或已過期'; return; }
      enter((await sb.auth.getSession()).data.session);
    });
    return;
  }
  // 第一次登入：設定動態驗證碼
  const { data: fl } = await sb.auth.mfa.listFactors();
  for (const f of fl?.all || []) if (f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
  const { data: en, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'it-asset-' + Date.now() });
  if (error) { body.innerHTML = `<p class="msg">${esc(errText(error))}</p>`; return; }
  body.innerHTML = `<form id="mfaForm" style="display:grid;gap:12px">
    <p class="sub">第一次登入需設定動態驗證碼：<br>1. 手機安裝 Google Authenticator 或 Microsoft Authenticator<br>2. 掃描下方 QR Code（或手動輸入金鑰）<br>3. 輸入 App 顯示的 6 位數字</p>
    <img alt="QR Code" width="180" height="180" style="justify-self:center;background:#fff;padding:6px;border-radius:8px" />
    <div class="muted" style="font-size:12px;word-break:break-all">手動輸入金鑰：<span id="mfaSecret"></span></div>
    <input type="text" id="mfaCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
    <button class="btn primary" type="submit">確認並啟用</button><p class="msg" id="mfaMsg"></p></form>`;
  body.querySelector('img').src = en.totp.qr_code;
  $('#mfaSecret').textContent = en.totp.secret;
  $('#mfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: en.id });
    if (e1) { $('#mfaMsg').textContent = errText(e1); return; }
    const { error: e2 } = await sb.auth.mfa.verify({ factorId: en.id, challengeId: ch.id, code: $('#mfaCode').value.trim() });
    if (e2) { $('#mfaMsg').textContent = '驗證碼不正確，請再試一次'; return; }
    enter((await sb.auth.getSession()).data.session);
  });
}

async function enter(session) {
  state.session = session;
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error || !data || !data.active || !data.role) { state.profile = null; show('pendingView'); return; }
  state.profile = data;
  $('#whoLabel').textContent = `${data.display_name || data.email}（${ROLE_LABEL[data.role]}）`;
  show('appView');
  startIdle();
  route();
}

async function logout() {
  stopIdle();
  await sb.auth.signOut();
  state.session = state.profile = null; state.people = null;
  show('loginView');
}

// 閒置自動登出
let idleTimer; const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(async () => { await logout(); toast('閒置過久，已自動登出', true); }, CONFIG.idleMinutes * 60000); };
const EV = ['click', 'keydown', 'mousemove', 'touchstart'];
function startIdle() { EV.forEach((e) => window.addEventListener(e, bump, { passive: true })); bump(); }
function stopIdle() { EV.forEach((e) => window.removeEventListener(e, bump)); clearTimeout(idleTimer); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn'); const msg = $('#loginMsg');
  btn.disabled = true; msg.textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
  btn.disabled = false;
  if (error) { msg.textContent = 'Email 或密碼不正確'; return; }
  $('#loginPassword').value = '';
  gate(data.session);
});
$('#logoutBtn').addEventListener('click', logout);
$('#mfaLogout').addEventListener('click', logout);
$('#pendingLogout').addEventListener('click', logout);
$('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));
window.addEventListener('hashchange', () => { if (state.profile) route(); });

(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) gate(data.session); else show('loginView');
})();

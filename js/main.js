// 進入點：登入、角色載入、路由、閒置登出
import { CONFIG } from './config.js';
import { sb, state, $, esc, toast, errText, canWrite, isAdmin, ROLE_LABEL } from './core.js';
import { assetsView, peopleView, hostsView, vendorsView, tasksView, kbView } from './entities.js';
import { dashboardView, auditView, usersView, requestsView, importView } from './secure.js';

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
  { id: 'requests', label: '帳號申請', view: requestsView, admin: true },
  { id: 'import', label: '匯入帳密', view: importView, admin: true },
];

const show = (id) => ['loginView', 'applyView', 'resetView', 'pendingView', 'appView'].forEach((v) => $('#' + v).classList.toggle('hidden', v !== id));
const loggedOutView = () => (location.hash === '#/apply' ? 'applyView' : location.hash === '#/reset' ? 'resetView' : 'loginView');
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

// 忘記密碼（未登入可用）
$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#rsMsg'); const btn = $('#rsBtn');
  msg.style.color = ''; msg.textContent = '';
  if ($('#rsWebsite').value) return;
  const pw = $('#rsPw').value;
  if (pw.length < 8) { msg.textContent = '密碼至少 8 個字元'; return; }
  if (pw !== $('#rsPw2').value) { msg.textContent = '兩次密碼不一致'; return; }
  btn.disabled = true;
  const { error } = await sb.rpc('submit_password_reset', {
    p_email: $('#rsEmail').value.trim(), p_name: $('#rsName').value.trim(), p_ext: $('#rsExt').value.trim(), p_password: pw,
  });
  btn.disabled = false;
  if (error) { msg.textContent = errText(error); return; }
  $('#resetForm').reset();
  msg.style.color = 'var(--ok, #2e7d32)';
  msg.textContent = '✓ 已送出，管理者確認身分並核准後，請用新密碼登入。';
});

// 申請帳號（未登入可用）
$('#applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#apMsg'); const btn = $('#apBtn');
  msg.style.color = ''; msg.textContent = '';
  if ($('#apWebsite').value) return;                       // 機器人陷阱欄位
  const pw = $('#apPw').value;
  if (pw.length < 8) { msg.textContent = '密碼至少 8 個字元'; return; }
  if (pw !== $('#apPw2').value) { msg.textContent = '兩次密碼不一致'; return; }
  btn.disabled = true;
  const { error } = await sb.rpc('submit_account_request', {
    p_email: $('#apEmail').value.trim(), p_name: $('#apName').value.trim(), p_ext: $('#apExt').value.trim(),
    p_dept: $('#apDept').value.trim(), p_password: pw,
  });
  btn.disabled = false;
  if (error) { msg.textContent = errText(error); return; }
  $('#applyForm').reset();
  msg.style.color = 'var(--ok, #2e7d32)';
  msg.textContent = '✓ 已送出申請，請等候管理者核准。';
});

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
  enter(data.session);
});
$('#logoutBtn').addEventListener('click', logout);
$('#pendingLogout').addEventListener('click', logout);
$('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));
window.addEventListener('hashchange', () => {
  if (state.profile) route();
  else if (!state.session) show(loggedOutView());
});

(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) enter(data.session); else show(loggedOutView());
})();

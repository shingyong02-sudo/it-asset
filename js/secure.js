// 密碼管理、儀表板、稽核紀錄、使用者管理、匯入
import { sb, state, $, esc, toast, errText, rpc, modal, confirmDialog, reauth, canWrite, isAdmin, fmtTime, loadSites, loadPeople,
  siteName, showHistory, diffHtml, ACTION_LABEL, COL_LABEL, ROLE_LABEL, exportXlsx, todayStr } from './core.js';

// ======================= 帳號密碼 =======================
export async function openCredentials(host) {
  const m = modal(`帳號密碼：${host.name}${host.address ? '（' + host.address + '）' : ''}`, '<div id="credBody"></div>', {
    wide: true,
    buttons: [{ label: '關閉', cls: 'primary' }],
  });
  const body = m.$('#credBody');

  async function load() {
    const { data, error } = await sb.from('credentials').select('id,account,purpose,secret_set_at,rotated_at,notes,active').eq('host_id', host.id).order('account');
    if (error) { body.innerHTML = `<p class="empty">${esc(errText(error))}</p>`; return; }
    body.innerHTML = `
      <div class="note" style="margin-bottom:10px">密碼以加密方式儲存，預設不顯示。每次「顯示」或「變更」都需再輸入您的登入密碼並填寫原因，並永久記錄操作者與時間。</div>
      ${canWrite() ? '<div class="bar"><button class="btn primary sm" id="addCred">＋ 新增帳號</button></div>' : ''}
      <div class="table-wrap"><table><thead><tr><th>帳號</th><th>用途</th><th>密碼</th><th>最後變更</th><th>備註</th><th>操作</th></tr></thead><tbody>
      ${data.length ? data.map((c) => `<tr data-id="${esc(c.id)}">
        <td>${esc(c.account || '（無帳號）')}</td><td>${esc(c.purpose || '')}</td>
        <td>${c.secret_set_at ? '<span class="tag ok">已設定</span>' : '<span class="tag warn">未設定</span>'}</td>
        <td>${esc(fmtTime(c.rotated_at || c.secret_set_at))}</td><td class="wrap">${esc(c.notes || '')}</td>
        <td>${canWrite() ? `${c.secret_set_at ? '<button class="btn sm" data-a="show">顯示</button> ' : ''}<button class="btn sm" data-a="set">${c.secret_set_at ? '變更' : '設定'}密碼</button> ` : ''}
          ${isAdmin() && c.secret_set_at ? '<button class="btn sm" data-a="hist">歷史密碼</button> ' : ''}
          <button class="btn sm" data-a="log">紀錄</button>
          ${canWrite() ? '<button class="btn sm" data-a="edit">編輯</button> ' : ''}${isAdmin() ? '<button class="btn sm danger" data-a="del">刪除</button>' : ''}</td></tr>`).join('')
        : '<tr><td colspan="6" class="empty">尚無帳號</td></tr>'}
      </tbody></table></div>`;
    $('#addCred', body)?.addEventListener('click', () => credForm(null));
    body.querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      const c = data.find((x) => x.id === b.closest('tr').dataset.id);
      ({ show: () => reveal(c), set: () => setSecret(c), hist: () => histList(c), log: () => showHistory('credentials', c.id, `${host.name} / ${c.account || ''}`), edit: () => credForm(c), del: () => delCred(c) })[b.dataset.a]();
    }));
  }

  function credForm(c) {
    modal(c ? '編輯帳號' : '新增帳號', `<div class="form-grid">
      <label>帳號<input data-k="account" value="${esc(c?.account || '')}" /></label>
      <label>用途<input data-k="purpose" value="${esc(c?.purpose || '')}" /></label>
      <label class="full">備註<textarea data-k="notes">${esc(c?.notes || '')}</textarea></label></div>
      ${c ? '' : '<p class="muted">新增後再按「設定密碼」輸入密碼。</p>'}`, {
      buttons: [{ label: '取消' }, {
        label: '儲存', cls: 'primary', onClick: async (mm) => {
          const p = { account: mm.$('[data-k=account]').value.trim() || null, purpose: mm.$('[data-k=purpose]').value.trim() || null, notes: mm.$('[data-k=notes]').value.trim() || null };
          const res = c ? await sb.from('credentials').update(p).eq('id', c.id).select() : await sb.from('credentials').insert({ ...p, host_id: host.id }).select();
          if (res.error) { toast(errText(res.error), true); return true; }
          if (!res.data?.length) { toast('儲存失敗：沒有權限', true); return true; }
          toast('✓ 已儲存'); load(); return false;
        },
      }],
    });
  }

  async function delCred(c) {
    if (!(await confirmDialog(`確定刪除帳號「${c.account || '(無帳號)'}」？密碼與歷史密碼會一併移除，刪除動作會留在稽核紀錄。`, { okLabel: '刪除', danger: true }))) return;
    const { data, error } = await sb.from('credentials').delete().eq('id', c.id).select();
    if (error || !data?.length) return toast(error ? errText(error) : '刪除失敗：沒有權限', true);
    toast('✓ 已刪除'); load();
  }

  async function reveal(c, historyId = null) {
    const r = await reauth({ title: historyId ? '查看歷史密碼' : '查看密碼', note: '此操作會被永久記錄：誰、何時、為什麼查看。' });
    if (!r) return;
    try {
      const pw = await rpc('reveal_secret', { p_credential_id: c.id, p_reason: r.reason, p_history_id: historyId });
      showSecret(pw);
    } catch (e) { toast(errText(e), true); }
  }

  function showSecret(pw) {
    let left = 30;
    const mm = modal('密碼', `<div class="secret-box" id="sb"></div><p class="muted" id="cd"></p>`, {
      buttons: [
        { label: '複製', onClick: async () => { try { await navigator.clipboard.writeText(pw); toast('已複製（請盡快貼上，剪貼簿不會自動清除）'); } catch { toast('複製失敗，請手動選取', true); } return true; } },
        { label: '關閉', cls: 'primary', onClick: () => { clearInterval(t); } },
      ],
    });
    mm.$('#sb').textContent = pw;
    const cd = mm.$('#cd');
    const tick = () => { cd.textContent = `${left} 秒後自動關閉`; if (left-- <= 0) { clearInterval(t); mm.close(); } };
    const t = setInterval(tick, 1000); tick();
  }

  async function setSecret(c) {
    const r = await reauth({ title: c.secret_set_at ? '變更密碼' : '設定密碼', secretLabel: '新密碼',
      note: c.secret_set_at ? '舊密碼會加密留存（僅管理者可追查），本次變更會留下紀錄。' : '密碼會加密儲存。' });
    if (!r) return;
    try { await rpc('set_credential_secret', { p_credential_id: c.id, p_secret: r.secret, p_reason: r.reason }); toast('✓ 密碼已儲存'); load(); }
    catch (e) { toast(errText(e), true); }
  }

  async function histList(c) {
    try {
      const rows = await rpc('list_credential_history', { p_credential_id: c.id });
      const mm = modal(`歷史密碼：${c.account || ''}`, rows.length ? `<div class="table-wrap"><table><thead><tr><th>被取代時間</th><th>變更者</th><th>原因</th><th></th></tr></thead><tbody>${
        rows.map((h) => `<tr><td>${esc(fmtTime(h.replaced_at))}</td><td>${esc(h.replaced_by_email || '')}</td><td class="wrap">${esc(h.reason || '')}</td><td><button class="btn sm" data-h="${h.id}">查看</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">沒有歷史密碼</p>', { buttons: [{ label: '關閉', cls: 'primary' }] });
      mm.el.querySelectorAll('button[data-h]').forEach((b) => b.addEventListener('click', () => reveal(c, Number(b.dataset.h))));
    } catch (e) { toast(errText(e), true); }
  }

  await load();
}

// ======================= 總覽 =======================
export async function dashboardView(root) {
  await loadSites();
  root.innerHTML = '<p class="muted">載入中…</p>';
  let s;
  try { s = await rpc('dashboard_stats'); } catch (e) { root.innerHTML = `<p class="empty">${esc(errText(e))}</p>`; return; }
  const { data: conf } = await sb.from('v_ip_conflicts').select('*').order('n', { ascending: false }).limit(30);
  const bySite = {};
  s.by_site_type.forEach((x) => { (bySite[x.site_id] ||= {})[x.asset_type] = x.n; });
  const TL = { pc: '電腦', printer: '印表機', network: '網路設備', server: '主機', camera: '攝影機', access: '門禁', parking: '停管', other: '其他' };
  const stat = (n, l, cls = '') => `<div class="stat ${n > 0 ? cls : ''}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  root.innerHTML = `
    <h3 class="sec" style="margin-top:0">需要處理</h3>
    <div class="grid">
      ${stat(s.dup_ip, '重複使用的 IP', 'danger')}${stat(s.invalid_ip, 'IP 格式錯誤', 'warn')}
      ${stat(s.eol_os, '已停止支援的作業系統（XP/Win7…）', 'warn')}${stat(s.pc_no_ip, '電腦未登記 IP', 'warn')}
      ${stat(s.no_person, '電腦尚未指派使用人', 'warn')}${stat(s.people_left_with_assets, '離職人員名下仍有資產', 'danger')}
      ${stat(s.open_tasks, '未完成的交辦事項')}${stat(s.hosts, '登錄中的主機／系統')}
    </div>
    <h3 class="sec">各院區資產</h3>
    <div class="table-wrap"><table><thead><tr><th>院區</th>${Object.keys(TL).map((k) => `<th>${TL[k]}</th>`).join('')}<th>合計</th></tr></thead><tbody>
    ${state.sites.map((st) => { const r = bySite[st.id] || {}; const sum = Object.values(r).reduce((a, b) => a + b, 0);
      return `<tr><td>${esc(st.name)}</td>${Object.keys(TL).map((k) => `<td>${r[k] || 0}</td>`).join('')}<td><b>${sum}</b></td></tr>`; }).join('')}
    </tbody></table></div>
    <h3 class="sec">重複 IP 清單</h3>
    ${conf?.length ? `<div class="table-wrap"><table><thead><tr><th>IP</th><th>使用數</th><th>使用的設備</th></tr></thead><tbody>${
      conf.map((c) => `<tr><td>${esc(c.ip_text.replace(/\s+/g, ' '))}</td><td>${c.n}</td><td class="wrap">${esc(c.names.join('、'))}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">目前沒有重複的 IP。</p>'}`;
}

// ======================= 稽核紀錄 =======================
export async function auditView(root) {
  await loadSites(); await loadPeople().catch(() => {});
  const PAGE = 50; let page = 0; let total = 0; const f = { table: '', action: '', actor: '', from: '', to: '', kw: '' };
  const TABLES = { assets: '資產', people: '人員', hosts: '主機', credentials: '帳號密碼', vendor_contacts: '廠商', tasks: '交辦', kb_articles: '知識庫', profiles: '使用者' };
  root.innerHTML = `
    <div class="bar">
      <select id="fTable"><option value="">全部資料</option>${Object.entries(TABLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select id="fAction"><option value="">全部動作</option>${Object.entries(ACTION_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input type="text" id="fActor" placeholder="操作者 Email" style="width:180px" />
      <input type="text" id="fKw" placeholder="摘要關鍵字" style="width:160px" />
      <label>從 <input type="date" id="fFrom" style="width:auto" /></label><label>到 <input type="date" id="fTo" style="width:auto" /></label>
      <span class="grow"></span>
      ${['admin', 'auditor'].includes(state.profile.role) ? '<button class="btn" id="btnVerify">驗證紀錄完整性</button>' : ''}
      <button class="btn" id="btnExport">匯出 XLSX</button>
    </div>
    <div id="verifyBox"></div>
    <div class="table-wrap"><table><thead><tr><th>時間</th><th>操作者</th><th>角色</th><th>院區</th><th>資料</th><th>動作</th><th>對象</th><th>內容</th></tr></thead><tbody id="aRows"></tbody></table></div>
    <div class="pager"><span id="aCount"></span><button class="btn sm" id="aPrev">上一頁</button><span id="aPage"></span><button class="btn sm" id="aNext">下一頁</button></div>`;

  const q = (forExport) => {
    let r = sb.from('audit_logs').select('*', forExport ? {} : { count: 'exact' }).order('id', { ascending: false });
    if (f.table) r = r.eq('table_name', f.table);
    if (f.action) r = r.eq('action', f.action);
    if (f.actor) r = r.ilike('actor_email', `%${f.actor.replace(/[,()*%\\"]/g, ' ').trim()}%`);
    if (f.kw) r = r.ilike('summary', `%${f.kw.replace(/[,()*%\\"]/g, ' ').trim()}%`);
    if (f.from) r = r.gte('at', new Date(f.from + 'T00:00:00').toISOString());
    if (f.to) r = r.lte('at', new Date(f.to + 'T23:59:59').toISOString());
    return r;
  };

  async function load() {
    const { data, error, count } = await q(false).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return toast(errText(error), true);
    total = count ?? data.length;
    $('#aRows', root).innerHTML = data.length ? data.map((l, i) => `<tr data-i="${i}" style="cursor:pointer">
      <td>${esc(fmtTime(l.at))}</td><td>${esc(l.actor_email || '')}</td><td>${esc(ROLE_LABEL[l.actor_role] || '')}</td><td>${esc(siteName(l.site_id))}</td>
      <td>${esc(TABLES[l.table_name] || l.table_name)}</td>
      <td><span class="tag ${l.action === 'REVEAL' || l.action === 'SET_SECRET' ? 'warn' : l.action === 'DELETE' ? 'danger' : ''}">${esc(ACTION_LABEL[l.action] || l.action)}</span></td>
      <td class="wrap">${esc(l.summary || '')}</td><td class="wrap">${diffHtml(l) || ''}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">沒有紀錄</td></tr>';
    $('#aRows', root).querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => {
      const l = data[Number(tr.dataset.i)];
      modal('紀錄明細', `<div class="form-grid"><div><b>時間</b><br>${esc(fmtTime(l.at))}</div><div><b>操作者</b><br>${esc(l.actor_email || '')}</div>
        <div><b>動作</b><br>${esc(ACTION_LABEL[l.action] || l.action)}</div><div><b>對象</b><br>${esc(l.summary || '')}</div>
        <div class="full">${diffHtml(l)}</div>
        <div class="full muted" style="word-break:break-all;font-size:12px">編號 ${l.id}｜雜湊 ${esc(l.row_hash || '')}</div></div>`, { buttons: [{ label: '關閉', cls: 'primary' }] });
    }));
    const pages = Math.max(1, Math.ceil(total / PAGE));
    $('#aCount', root).textContent = `共 ${total} 筆`; $('#aPage', root).textContent = `${page + 1} / ${pages}`;
    $('#aPrev', root).disabled = page === 0; $('#aNext', root).disabled = page + 1 >= pages;
  }
  const bind = (id, key) => $(id, root).addEventListener('change', (e) => { f[key] = e.target.value; page = 0; load(); });
  bind('#fTable', 'table'); bind('#fAction', 'action'); bind('#fActor', 'actor'); bind('#fKw', 'kw'); bind('#fFrom', 'from'); bind('#fTo', 'to');
  $('#aPrev', root).addEventListener('click', () => { page--; load(); });
  $('#aNext', root).addEventListener('click', () => { page++; load(); });
  $('#btnVerify', root)?.addEventListener('click', async () => {
    try {
      const v = await rpc('verify_audit_chain');
      $('#verifyBox', root).innerHTML = v.ok ? `<div class="note" style="background:var(--accent-bg);color:var(--ok);margin-bottom:10px">✓ 已檢查 ${v.checked} 筆紀錄，雜湊鏈完整，未發現被修改或中間被刪除。</div>`
        : `<div class="note" style="background:var(--danger-bg);color:var(--danger);margin-bottom:10px">⚠ 發現異常！從第 ${v.first_bad_id} 筆起的紀錄與雜湊不符，可能遭到竄改，請立即通報並保全資料庫。</div>`;
    } catch (e) { toast(errText(e), true); }
  });
  $('#btnExport', root).addEventListener('click', async () => {
    const { data, error } = await q(true).limit(10000);
    if (error) return toast(errText(error), true);
    await exportXlsx(`稽核紀錄_${todayStr()}.xlsx`, '稽核紀錄', [
      { header: '編號', key: 'id', width: 8 }, { header: '時間', key: 'at', width: 17 }, { header: '操作者', key: 'who', width: 26 }, { header: '角色', key: 'role', width: 10 },
      { header: '院區', key: 'site', width: 10 }, { header: '資料', key: 'tbl', width: 12 }, { header: '動作', key: 'act', width: 10 },
      { header: '對象', key: 'sum', width: 28 }, { header: '變更內容', key: 'chg', width: 50 }, { header: '原因', key: 'why', width: 30 }],
    data.map((l) => ({ id: l.id, at: fmtTime(l.at), who: l.actor_email, role: ROLE_LABEL[l.actor_role] || '', site: siteName(l.site_id), tbl: TABLES[l.table_name] || l.table_name,
      act: ACTION_LABEL[l.action] || l.action, sum: l.summary,
      chg: l.action === 'UPDATE' && l.changed_cols ? l.changed_cols.map((k) => `${COL_LABEL[k] || k}：${l.old_data?.[k] ?? ''} → ${l.new_data?.[k] ?? ''}`).join('；') : '', why: l.reason })));
    toast('✓ 已匯出 XLSX');
  });
  await load();
}

// ======================= 使用者管理（管理者）=======================
export async function usersView(root) {
  const { data, error } = await sb.from('profiles').select('*').order('created_at');
  if (error) { root.innerHTML = `<p class="empty">${esc(errText(error))}</p>`; return; }
  root.innerHTML = `
    <div class="bar"><span class="muted">人員離職時請「停用」帳號（紀錄會永久保留，不會刪除）。</span><span class="grow"></span>
      <button class="btn primary" id="btnNewUser">＋ 新增使用者</button></div>
    <div class="table-wrap"><table><thead><tr><th>Email</th><th>顯示名稱</th><th>角色</th><th>啟用</th><th>建立時間</th><th></th></tr></thead><tbody>
    ${data.map((u) => `<tr data-id="${esc(u.id)}"><td>${esc(u.email)}</td>
      <td><input data-k="display_name" value="${esc(u.display_name || '')}" style="min-width:120px" /></td>
      <td><select data-k="role"><option value="">（未指派）</option>${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><select data-k="active"><option value="true" ${u.active ? 'selected' : ''}>啟用</option><option value="false" ${!u.active ? 'selected' : ''}>停用</option></select></td>
      <td>${esc(fmtTime(u.created_at))}</td>
      <td><button class="btn sm primary" data-a="save">儲存</button> <button class="btn sm" data-a="log">紀錄</button></td></tr>`).join('')}
    </tbody></table></div>
    <h3 class="sec">角色說明</h3>
    <div class="table-wrap"><table><thead><tr><th>角色</th><th>能做什麼</th></tr></thead><tbody>
      <tr><td>管理者</td><td class="wrap">全部功能：管理使用者、刪除資料、查看歷史密碼、匯入帳密、驗證稽核紀錄。</td></tr>
      <tr><td>資訊人員</td><td class="wrap">新增／修改資產、人員、主機、廠商、交辦；可查看與變更密碼（每次需重新驗證並留下原因）。</td></tr>
      <tr><td>稽核員</td><td class="wrap">唯讀：可查詢所有資料與稽核紀錄、驗證紀錄完整性；看不到密碼。</td></tr></tbody></table></div>`;
  $('#btnNewUser', root).addEventListener('click', () => {
    modal('新增使用者', `<div class="form-grid">
      <label class="full">Email（登入帳號）<input type="email" data-k="email" autocomplete="off" /></label>
      <label>顯示名稱<input data-k="name" /></label>
      <label>角色<select data-k="role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'it' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="full">初始密碼（至少 12 字元，請交給對方後請他自行更換）<input type="password" data-k="pw" autocomplete="new-password" /></label></div>`, {
      buttons: [{ label: '取消' }, {
        label: '建立', cls: 'primary', onClick: async (mm) => {
          const v = (k) => mm.$(`[data-k=${k}]`).value.trim();
          const pw = mm.$('[data-k=pw]').value;
          if (!v('email')) { toast('請填寫 Email', true); return true; }
          if (pw.length < 12) { toast('密碼至少 12 個字元', true); return true; }
          const r = await reauth({ title: '確認建立使用者', note: '需要再次驗證您的登入密碼。', withReason: false });
          if (!r) return true;
          try {
            await rpc('admin_create_user', { p_email: v('email'), p_password: pw, p_name: v('name'), p_role: v('role') });
            toast('✓ 已建立使用者'); mm.close(); usersView(root);
          } catch (e) { toast(errText(e), true); }
          return true;
        },
      }],
    });
  });
  root.querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'); const id = tr.dataset.id;
    if (b.dataset.a === 'log') return showHistory('profiles', id, tr.children[0].textContent);
    const role = tr.querySelector('[data-k=role]').value || null;
    const active = tr.querySelector('[data-k=active]').value === 'true';
    if (active && !role) return toast('啟用前請先指派角色', true);
    const { data: res, error: e2 } = await sb.from('profiles').update({ role, active, display_name: tr.querySelector('[data-k=display_name]').value.trim() || null }).eq('id', id).select();
    if (e2) return toast(errText(e2), true);
    if (!res?.length) return toast('儲存失敗：沒有權限', true);
    toast('✓ 已儲存');
  }));
}

// ======================= 匯入帳密（管理者）=======================
const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join('') : '') ?? '').trim();
  return String(v).trim();
};
const guessType = (n) => /防火牆/.test(n) ? 'firewall' : /^NAS/i.test(n) ? 'nas' : /PACS/i.test(n) ? 'pacs' : /網站/.test(n) ? 'web' : /WIFI/i.test(n) ? 'wifi'
  : /officescan|office|EEC|凌越/i.test(n) ? 'software' : /SERVER|入金|監視器|AP/i.test(n) ? 'server' : 'other';
const looksAddr = (a) => /^(https?:\/\/|\d{1,3}(\.\d{1,3}){3})/.test(a);

export async function importView(root) {
  root.innerHTML = `
    <div class="note" style="margin-bottom:12px">匯入主機帳密 Excel（欄位：設備｜IP／網址｜帳號｜密碼｜帳號2｜密碼2）。檔案在<b>您的瀏覽器內</b>解析，密碼只送到資料庫加密儲存，預覽畫面不會顯示密碼。
      匯入完成後，請把原 Excel 檔刪除，並更換這些主機的密碼。已存在的「主機＋帳號＋用途」不會重複匯入。</div>
    <div class="bar"><input type="file" id="pdFile" accept=".xlsx" /></div>
    <div id="pdPreview"></div>`;
  $('#pdFile', root).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    let rows = [];
    try {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets[0]; let section = 'SH', fw = 0;
      ws.eachRow((row) => {
        const v = (i) => cellText(row.getCell(i).value);
        const host = v(1); if (!host || host === '設備') return;
        if (host === '防火牆' && ++fw === 2) section = 'SY';
        const addr = v(2); let site = section;
        if (/192\.168\.10\.|shingyong/i.test(addr)) site = 'SY'; else if (/192\.168\.1\.|shinghou/i.test(addr)) site = 'SH';
        const base = { site_code: site, host, host_type: guessType(host), address: looksAddr(addr) ? addr : '' };
        const purposeFromAddr = addr && !looksAddr(addr) ? addr : '';
        const pairs = [[v(3), v(4), purposeFromAddr], [v(5), v(6), '帳號2']];
        pairs.forEach(([account, secret, purpose]) => { if (account || secret) rows.push({ ...base, account, secret, purpose }); });
      });
    } catch (err) { return toast('讀取 Excel 失敗：' + err.message, true); }
    if (!rows.length) return toast('沒有讀到任何資料', true);
    const prev = $('#pdPreview', root);
    prev.innerHTML = `<h3 class="sec">預覽（${rows.length} 筆帳號）— 請確認院區是否正確</h3>
      <div class="table-wrap"><table><thead><tr><th>院區</th><th>設備</th><th>類型</th><th>位址／網址</th><th>帳號</th><th>用途</th><th>密碼</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td><select data-i="${i}">${state.sites.map((s) => `<option value="${s.code}" ${s.code === r.site_code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></td>
        <td>${esc(r.host)}</td><td>${esc(r.host_type)}</td><td>${esc(r.address)}</td><td>${esc(r.account)}</td><td>${esc(r.purpose)}</td><td>${r.secret ? '●●●●●●' : '<span class="tag warn">空白</span>'}</td></tr>`).join('')}</tbody></table></div>
      <div class="bar" style="margin-top:12px"><button class="btn primary" id="doImport">確認匯入</button></div>`;
    prev.querySelectorAll('select[data-i]').forEach((s) => s.addEventListener('change', () => { rows[Number(s.dataset.i)].site_code = s.value; }));
    $('#doImport', prev).addEventListener('click', async () => {
      const r = await reauth({ title: '確認匯入帳密', note: '需要再次驗證您的登入密碼。' });
      if (!r) return;
      try {
        const res = await rpc('import_credentials', { p_rows: rows, p_reason: r.reason });
        prev.innerHTML = `<div class="note" style="background:var(--accent-bg);color:var(--ok)">✓ 匯入完成：新增主機 ${res.hosts}、帳號 ${res.credentials}、略過 ${res.skipped}。請立即刪除原 Excel 檔，並更換這些主機密碼。</div>`;
        $('#pdFile', root).value = ''; rows = [];
      } catch (err) { toast(errText(err), true); }
    });
  });
}

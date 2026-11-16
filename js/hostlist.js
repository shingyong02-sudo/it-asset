// 主機設備清單：編號、系統名稱、IP位置、帳號、密碼（加密，需再驗證才顯示）、記錄檔
import { sb, state, $, esc, toast, errText, rpc, modal, confirmDialog, reauth, canWrite, isAdmin, fmtTime, loadSites,
  siteName, diffHtml, ACTION_LABEL, exportXlsx, todayStr } from './core.js';
import { siteTabs } from './entities.js';

export async function hostListView(root) {
  await loadSites();
  const tabs = siteTabs();
  let sel = 0, kw = '';

  root.innerHTML = `
    <div class="tabs" id="hlTabs">${tabs.map((t, i) => `<button type="button" class="tab ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(t.label)}</button>`).join('')}</div>
    <div class="bar"><input type="search" id="hlKw" placeholder="搜尋系統名稱／IP／帳號…" /><span class="grow"></span>
      <button class="btn" id="hlExport">匯出 XLSX</button>
      ${canWrite() ? '<button class="btn primary" id="hlAdd">＋ 新增主機設備</button>' : ''}</div>
    <div class="note" style="margin-bottom:10px">密碼以加密方式儲存，預設不顯示；每次「顯示」或「變更」都需再輸入登入密碼並填寫原因。所有新增、修改、查看、變更都會記錄在「記錄檔」，無法刪改。</div>
    <div class="table-wrap"><table><thead><tr><th>編號</th><th>系統名稱</th><th>IP位置</th><th>帳號</th><th>密碼</th><th>記錄檔</th><th>操作</th></tr></thead><tbody id="hlRows"></tbody></table></div>
    <div class="pager"><span id="hlCount"></span></div>`;

  let rows = [];

  async function load() {
    const siteId = tabs[sel]?.values[0];
    let q = sb.from('hosts').select('id,site_id,name,address,host_type,owner_name,notes,active,credentials(id,account,purpose,secret_set_at,rotated_at,notes)')
      .eq('site_id', siteId).order('name', { ascending: true }).limit(2000);
    const { data, error } = await q;
    if (error) { $('#hlRows', root).innerHTML = `<tr><td colspan="7" class="empty">${esc(errText(error))}</td></tr>`; return; }
    // 一個帳號一列；沒有帳號的主機也要出現一列
    rows = [];
    for (const h of data) {
      const creds = (h.credentials || []).slice().sort((a, b) => String(a.account || '').localeCompare(String(b.account || '')));
      if (!creds.length) rows.push({ host: h, cred: null });
      else creds.forEach((c) => rows.push({ host: h, cred: c }));
    }
    const k = kw.trim().toLowerCase();
    if (k) rows = rows.filter((r) => [r.host.name, r.host.address, r.cred?.account].some((v) => String(v || '').toLowerCase().includes(k)));
    draw();
  }

  function draw() {
    const body = $('#hlRows', root);
    body.innerHTML = rows.length ? rows.map((r, i) => `<tr data-i="${i}">
      <td>${i + 1}</td><td>${esc(r.host.name)}${r.host.active ? '' : ' <span class="tag">停用</span>'}</td><td>${esc(r.host.address || '')}</td>
      <td>${esc(r.cred?.account || '')}</td>
      <td>${r.cred ? (r.cred.secret_set_at ? '<span class="tag ok">●●●●●●（已設定）</span>' : '<span class="tag warn">未設定</span>') : ''}</td>
      <td><button class="btn sm" data-a="log">記錄檔</button></td>
      <td>${r.cred && r.cred.secret_set_at && canWrite() ? '<button class="btn sm" data-a="show">顯示密碼</button> ' : ''}
        ${r.cred && canWrite() ? `<button class="btn sm" data-a="set">${r.cred.secret_set_at ? '變更' : '設定'}密碼</button> ` : ''}
        ${canWrite() ? '<button class="btn sm" data-a="edit">編輯</button> ' : ''}${isAdmin() ? '<button class="btn sm danger" data-a="del">刪除</button>' : ''}</td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">沒有資料</td></tr>';
    $('#hlCount', root).textContent = `共 ${rows.length} 筆`;
    body.querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', () => {
      const r = rows[Number(b.closest('tr').dataset.i)];
      ({ log: () => showLog(r), show: () => reveal(r), set: () => setSecret(r), edit: () => form(r), del: () => del(r) })[b.dataset.a]();
    }));
  }

  // ---- 記錄檔：主機本身 + 該帳號 的所有異動（誰、何時、改了什麼）----
  async function showLog(r) {
    const ors = [`and(table_name.eq.hosts,record_id.eq.${r.host.id})`];
    if (r.cred) ors.push(`and(table_name.eq.credentials,record_id.eq.${r.cred.id})`);
    const { data, error } = await sb.from('audit_logs').select('*').or(ors.join(',')).order('id', { ascending: false }).limit(300);
    if (error) return toast(errText(error), true);
    const TB = { hosts: '主機', credentials: '帳號' };
    modal(`記錄檔：${r.host.name}${r.cred?.account ? ' / ' + r.cred.account : ''}`, data.length
      ? `<div class="table-wrap"><table><thead><tr><th>時間</th><th>操作者</th><th>對象</th><th>動作</th><th>內容</th></tr></thead><tbody>${data.map((l) =>
        `<tr><td>${esc(fmtTime(l.at))}</td><td>${esc(l.actor_email || '')}</td><td>${esc(TB[l.table_name] || l.table_name)}</td>
        <td><span class="tag ${l.action === 'REVEAL' ? 'warn' : l.action === 'DELETE' ? 'danger' : ''}">${esc(ACTION_LABEL[l.action] || l.action)}</span></td>
        <td class="wrap">${diffHtml(l) || esc(l.summary || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">尚無紀錄</p>', { wide: true, buttons: [{ label: '關閉', cls: 'primary' }] });
  }

  async function reveal(r) {
    const a = await reauth({ title: '查看密碼', note: '此操作會被永久記錄：誰、何時、為什麼查看。' });
    if (!a) return;
    try {
      const pw = await rpc('reveal_secret', { p_credential_id: r.cred.id, p_reason: a.reason, p_history_id: null });
      let left = 30;
      const mm = modal('密碼', '<div class="secret-box" id="sb"></div><p class="muted" id="cd"></p>', {
        buttons: [
          { label: '複製', onClick: async () => { try { await navigator.clipboard.writeText(pw); toast('已複製'); } catch { toast('複製失敗，請手動選取', true); } return true; } },
          { label: '關閉', cls: 'primary', onClick: () => clearInterval(t) },
        ],
      });
      mm.$('#sb').textContent = pw;
      const cd = mm.$('#cd');
      const tick = () => { cd.textContent = `${left} 秒後自動關閉`; if (left-- <= 0) { clearInterval(t); mm.close(); } };
      const t = setInterval(tick, 1000); tick();
    } catch (e) { toast(errText(e), true); }
  }

  async function setSecret(r) {
    const a = await reauth({ title: r.cred.secret_set_at ? '變更密碼' : '設定密碼', secretLabel: '新密碼',
      note: r.cred.secret_set_at ? '舊密碼會加密留存，本次變更會留下紀錄。' : '密碼會加密儲存。' });
    if (!a) return;
    try { await rpc('set_credential_secret', { p_credential_id: r.cred.id, p_secret: a.secret, p_reason: a.reason }); toast('✓ 密碼已儲存'); load(); }
    catch (e) { toast(errText(e), true); }
  }

  // ---- 新增／編輯（系統名稱、IP位置、帳號）----
  function form(r) {
    const isNew = !r;
    modal(isNew ? '新增主機設備' : '編輯主機設備', `<div class="form-grid">
      <label class="full"><span class="req">系統名稱</span><input data-k="name" value="${esc(r?.host.name || '')}" /></label>
      <label>IP位置<input data-k="address" value="${esc(r?.host.address || '')}" /></label>
      <label>帳號<input data-k="account" value="${esc(r?.cred?.account || '')}" /></label>
      ${isNew ? `<label>院區<select data-k="site">${tabs.map((t) => `<option value="${t.values[0]}" ${t === tabs[sel] ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>` : ''}
      <p class="muted full">${isNew ? '存檔後再按「設定密碼」輸入密碼。' : '帳號欄位只影響這一列的帳號；要新增同系統的其他帳號，請用「主機與系統帳密」頁。'}</p></div>`, {
      buttons: [{ label: '取消' }, {
        label: '儲存', cls: 'primary', onClick: async (mm) => {
          const v = (k) => mm.$(`[data-k=${k}]`)?.value.trim() || null;
          if (!v('name')) { toast('請填寫系統名稱', true); return true; }
          try {
            if (isNew) {
              const { data: h, error } = await sb.from('hosts').insert({ site_id: Number(v('site')), name: v('name'), address: v('address') }).select().single();
              if (error) throw error;
              if (v('account')) { const { error: e2 } = await sb.from('credentials').insert({ host_id: h.id, account: v('account') }); if (e2) throw e2; }
            } else {
              const { data, error } = await sb.from('hosts').update({ name: v('name'), address: v('address') }).eq('id', r.host.id).select();
              if (error) throw error; if (!data?.length) throw new Error('儲存失敗：沒有權限');
              if (r.cred) {
                const { data: d2, error: e2 } = await sb.from('credentials').update({ account: v('account') }).eq('id', r.cred.id).select();
                if (e2) throw e2; if (!d2?.length) throw new Error('儲存失敗：沒有權限');
              } else if (v('account')) {
                const { error: e3 } = await sb.from('credentials').insert({ host_id: r.host.id, account: v('account') }); if (e3) throw e3;
              }
            }
            toast('✓ 已儲存'); load(); return false;
          } catch (e) { toast(errText(e), true); return true; }
        },
      }],
    });
  }

  async function del(r) {
    const what = r.cred ? `帳號「${r.cred.account || '(無帳號)'}」（系統：${r.host.name}）` : `主機「${r.host.name}」`;
    if (!(await confirmDialog(`確定刪除${what}？密碼會一併移除，刪除動作會留在記錄檔。`, { okLabel: '刪除', danger: true }))) return;
    const res = r.cred ? await sb.from('credentials').delete().eq('id', r.cred.id).select() : await sb.from('hosts').delete().eq('id', r.host.id).select();
    if (res.error || !res.data?.length) return toast(res.error ? errText(res.error) : '刪除失敗：沒有權限', true);
    toast('✓ 已刪除'); load();
  }

  $('#hlTabs', root).addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    sel = Number(b.dataset.i);
    root.querySelectorAll('#hlTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  let t; $('#hlKw', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { kw = e.target.value; load(); }, 300); });
  $('#hlAdd', root)?.addEventListener('click', () => form(null));
  $('#hlExport', root).addEventListener('click', async () => {
    if (!rows.length) return toast('目前沒有資料可匯出', true);
    await exportXlsx(`主機設備清單_${tabs[sel].label}_${todayStr()}.xlsx`, `主機設備清單（${tabs[sel].label}）`,
      [{ header: '編號', key: 'no', width: 8 }, { header: '系統名稱', key: 'name', width: 28 }, { header: 'IP位置', key: 'addr', width: 22 }, { header: '帳號', key: 'acc', width: 18 }, { header: '密碼', key: 'pw', width: 12 }],
      rows.map((r, i) => ({ no: i + 1, name: r.host.name, addr: r.host.address, acc: r.cred?.account, pw: r.cred?.secret_set_at ? '（已加密，不匯出）' : '未設定' })));
    toast('✓ 已匯出 XLSX（不含密碼）');
  });
  await load();
}

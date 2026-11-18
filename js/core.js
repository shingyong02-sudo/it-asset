// 共用核心：Supabase 連線、狀態、對話框、重新驗證、稽核歷史、XLSX 匯出
import { CONFIG } from './config.js';

export const sb = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const state = { session: null, profile: null, sites: [], siteMap: {}, people: null, peopleMap: {} };

export const $ = (sel, root = document) => root.querySelector(sel);
export const ROLE_LABEL = { admin: '管理者', it: '資訊人員', auditor: '稽核員' };
export const canWrite = () => ['admin', 'it'].includes(state.profile?.role);
export const isAdmin = () => state.profile?.role === 'admin';
export const canAudit = () => ['admin', 'auditor', 'it'].includes(state.profile?.role);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer;
export function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), isErr ? 4500 : 2500);
}

// 把後端錯誤訊息整理成人看得懂的文字
export function errText(e) {
  const m = (e && (e.message || e.details)) || String(e);
  return m.replace(/^REAUTH_REQUIRED:\s*/, '').replace(/^KEY_NOT_SET:\s*/, '');
}

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

// ---------- 對話框 ----------
export function modal(title, bodyHtml, { wide = false, buttons = [] } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <h3>${esc(title)}</h3><div class="body">${bodyHtml}</div><div class="foot"></div></div>`;
  document.body.appendChild(overlay);
  const m = { el: overlay, $: (s) => overlay.querySelector(s), close: () => overlay.remove() };
  const foot = overlay.querySelector('.foot');
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (b.cls || '');
    btn.textContent = b.label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const keep = await b.onClick?.(m);
        if (!keep) m.close();
      } finally {
        btn.disabled = false;
      }
    });
    foot.appendChild(btn);
  });
  return m;
}

export function confirmDialog(message, { okLabel = '確定', danger = false } = {}) {
  return new Promise((resolve) => {
    modal('請確認', `<p>${esc(message)}</p>`, {
      buttons: [
        { label: '取消', onClick: () => resolve(false) },
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
    });
  });
}

// 重新輸入登入密碼 + 填寫原因（查看／變更密碼、匯入前使用）
export function reauth({ title, note = '', withReason = true, secretLabel = '' }) {
  return new Promise((resolve) => {
    const m = modal(title, `
      ${note ? `<div class="note">${esc(note)}</div>` : ''}
      <div class="form-grid">
        <label class="full">您的登入密碼（再次確認身分）<input type="password" id="ra_pw" autocomplete="current-password" /></label>
        ${secretLabel ? `<label class="full">${esc(secretLabel)}<input type="password" id="ra_secret" autocomplete="new-password" /></label>` : ''}
        ${withReason ? `<label class="full">原因（會寫入稽核紀錄，至少 4 字）<textarea id="ra_reason"></textarea></label>` : ''}
      </div>`, {
      buttons: [
        { label: '取消', onClick: () => resolve(null) },
        {
          label: '確認', cls: 'primary', onClick: async (mm) => {
            const pw = mm.$('#ra_pw').value;
            const reason = withReason ? mm.$('#ra_reason').value.trim() : '';
            const secret = secretLabel ? mm.$('#ra_secret').value : '';
            if (!pw) { toast('請輸入登入密碼', true); return true; }
            if (withReason && reason.length < 4) { toast('請填寫原因（至少 4 字）', true); return true; }
            if (secretLabel && !secret) { toast('請輸入新密碼', true); return true; }
            const { data, error } = await sb.auth.signInWithPassword({ email: state.session.user.email, password: pw });
            if (error) { toast('登入密碼不正確', true); return true; }
            state.session = data.session;
            resolve({ reason, secret });
            return false;
          },
        },
      ],
    });
    m.$('#ra_pw').focus();
  });
}

// ---------- 基礎資料 ----------
export async function loadSites() {
  const { data, error } = await sb.from('sites').select('*').order('sort');
  if (error) throw error;
  state.sites = data;
  state.siteMap = Object.fromEntries(data.map((s) => [s.id, s]));
}
export const siteName = (id) => state.siteMap[id]?.name || '';

export async function loadPeople(force = false) {
  if (state.people && !force) return state.people;
  const { data, error } = await sb.from('people').select('id,name,dept,status').order('name').limit(5000);
  if (error) throw error;
  state.people = data;
  state.peopleMap = Object.fromEntries(data.map((p) => [p.id, p]));
  return data;
}
export const personLabel = (p) => `${p.name}${p.dept ? '（' + p.dept + '）' : ''}${p.status === '離職' ? ' [離職]' : ''}`;

// ---------- 稽核歷史顯示 ----------
export const COL_LABEL = {
  site_id: '院區', asset_type: '類型', name: '名稱', floor: '樓層', unit: '單位', location: '位置', brand_model: '廠牌型號',
  os: '作業系統', office_license: 'OFFICE', purchase_date_raw: '購買日期', ip_text: 'IP', mac: 'MAC', serial_no: '序號',
  status: '狀態', person_id: '使用人', notes: '備註', dept: '部門', title: '職稱', employee_no: '員編', ext: '分機',
  left_at: '離職日', host_type: '類型', address: '位址／網址', owner_name: '負責人', active: '啟用', account: '帳號',
  asset_no: '財產編號', dept_id: '部門', custodian_id: '保管人', acquired_date: '取得日期', cost: '取得成本', salvage_value: '殘值',
  useful_life_months: '耐用月數', scrapped_at: '報廢日', purpose: '用途', has_secret: '已設密碼', vendor: '廠商', contact_name: '聯絡人', phone: '電話', system_name: '系統',
  detail: '內容', progress_note: '進度', due_date: '期限', category: '分類', body: '內文', role: '角色', display_name: '顯示名稱', email: 'Email',
};
export const ACTION_LABEL = { INSERT: '新增', UPDATE: '修改', DELETE: '刪除', REVEAL: '查看密碼', SET_SECRET: '變更密碼', IMPORT: '匯入', RESET_MFA: '重設動態碼',
  REQUEST_TRANSFER: '申請移轉', REQUEST_SCRAP: '申請報廢', APPROVE_TRANSFER: '核准移轉', APPROVE_SCRAP: '核准報廢', REJECT_TRANSFER: '退回移轉', REJECT_SCRAP: '退回報廢' };

function fmtVal(k, v) {
  if (v === null || v === undefined || v === '') return '（空）';
  if (k === 'site_id') return siteName(v) || v;
  if (k === 'person_id') return state.peopleMap[v] ? state.peopleMap[v].name : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function diffHtml(log) {
  if (log.action === 'UPDATE' && log.changed_cols) {
    return `<div class="diff">${log.changed_cols.map((k) =>
      `<div><span class="k">${esc(COL_LABEL[k] || k)}：</span><span class="o">${esc(fmtVal(k, log.old_data?.[k]))}</span> → <span class="nw">${esc(fmtVal(k, log.new_data?.[k]))}</span></div>`).join('')}</div>`;
  }
  if (log.reason) return `<div class="diff"><span class="k">原因：</span>${esc(log.reason)}</div>`;
  return '';
}

export async function showHistory(table, id, title) {
  await loadPeople().catch(() => {});
  const { data, error } = await sb.from('audit_logs').select('*').eq('table_name', table).eq('record_id', String(id)).order('id', { ascending: false }).limit(200);
  if (error) return toast(errText(error), true);
  const rows = data.map((l) => `<tr><td>${fmtTime(l.at)}</td><td>${esc(l.actor_email || '')}</td>
    <td><span class="tag ${l.action === 'REVEAL' ? 'warn' : l.action === 'DELETE' ? 'danger' : ''}">${esc(ACTION_LABEL[l.action] || l.action)}</span></td>
    <td class="wrap">${diffHtml(l) || esc(l.summary || '')}</td></tr>`).join('');
  modal(`異動紀錄：${title}`, data.length
    ? `<div class="table-wrap"><table><thead><tr><th>時間</th><th>操作者</th><th>動作</th><th>內容</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty">尚無紀錄</p>', { wide: true, buttons: [{ label: '關閉', cls: 'primary' }] });
}

// ---------- XLSX 匯出 ----------
export async function exportXlsx(filename, sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '資訊資產管控系統';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 14 }));
  ws.mergeCells(1, 1, 1, columns.length);
  const t = ws.getCell(1, 1);
  t.value = `${sheetName}（匯出時間：${fmtTime(new Date().toISOString())}；匯出者：${state.profile?.email || ''}）`;
  t.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;
  const h = ws.getRow(2);
  columns.forEach((c, i) => (h.getCell(i + 1).value = c.header));
  h.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C7A3D' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  rows.forEach((r, idx) => {
    const row = ws.addRow(r);
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
      if (idx % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F1' } };
    });
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

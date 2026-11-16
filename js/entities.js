// 各資料表的清單／表單設定
import { sb, state, esc, toast, modal, confirmDialog, siteName, fmtTime, personLabel } from './core.js';
import { crudView } from './crud.js';
import { openCredentials } from './secure.js';

const siteOpts = () => state.sites.map((s) => [s.id, s.name]);
export const TYPE_LABEL = { pc: '電腦', printer: '印表機', network: '網路設備', server: '主機／伺服器', camera: '攝影機', access: '門禁', parking: '停管', other: '其他' };
export const STATUS_LABEL = { in_use: '使用中', spare: '備品', repair: '維修中', retired: '已報廢', lost: '遺失' };
const EOL = /(^XP|WIN7|VISTA|SERVER2003|SERVER2008)/i;
const opts = (o) => Object.entries(o);

// ---------- 資產台帳 ----------
export const assetsView = crudView({
  table: 'assets', label: '資產台帳', select: '*, person:people(name)',
  search: ['name', 'ip_text', 'unit', 'location', 'brand_model', 'floor', 'serial_no', 'notes'],
  order: ['updated_at', false],
  defaults: { site_id: 2, asset_type: 'pc', status: 'in_use' },
  filters: [
    { key: 'site_id', label: '院區', options: siteOpts },
    { key: 'asset_type', label: '類型', options: () => opts(TYPE_LABEL) },
    { key: 'status', label: '狀態', options: () => opts(STATUS_LABEL) },
  ],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id)) },
    { key: 'asset_type', label: '類型', fmt: (r) => esc(TYPE_LABEL[r.asset_type] || r.asset_type) },
    { key: 'name', label: '名稱' },
    { key: 'floor', label: '樓層' },
    { key: 'unit', label: '單位' },
    { key: 'ip_text', label: 'IP', fmt: (r) => esc(r.ip_text || '') + (r.ip_text && !r.ip ? ' <span class="tag danger">格式錯誤</span>' : '') },
    { key: 'brand_model', label: '廠牌型號' },
    { key: 'os', label: 'OS', fmt: (r) => r.os && EOL.test(r.os) ? `<span class="tag warn">${esc(r.os)}</span>` : esc(r.os || '') },
    { key: 'person', label: '使用人', fmt: (r) => esc(r.person?.name || '') },
    { key: 'status', label: '狀態', fmt: (r) => `<span class="tag ${r.status === 'in_use' ? 'ok' : r.status === 'retired' || r.status === 'lost' ? 'danger' : 'warn'}">${esc(STATUS_LABEL[r.status] || r.status)}</span>` },
  ],
  fields: [
    { key: 'site_id', label: '院區', type: 'site', required: true },
    { key: 'asset_type', label: '類型', type: 'select', options: opts(TYPE_LABEL), required: true },
    { key: 'name', label: '名稱（電腦名稱／位置）' },
    { key: 'ip_text', label: 'IP 位址' },
    { key: 'floor', label: '樓層' },
    { key: 'unit', label: '單位' },
    { key: 'location', label: '位置' },
    { key: 'brand_model', label: '廠牌型號' },
    { key: 'os', label: '作業系統' },
    { key: 'office_license', label: 'OFFICE 版本' },
    { key: 'purchase_date_raw', label: '購買日期（民國年.月）' },
    { key: 'mac', label: 'MAC' },
    { key: 'serial_no', label: '序號' },
    { key: 'status', label: '狀態', type: 'select', options: opts(STATUS_LABEL), required: true },
    { key: 'person_id', label: '使用人', type: 'person' },
    { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  beforeSave: async (p, row) => {
    if (!p.ip_text || p.status === 'retired') return true;
    const { data } = await sb.from('assets').select('id,name').eq('ip_text', p.ip_text.trim()).neq('status', 'retired').limit(3);
    const others = (data || []).filter((x) => !row || x.id !== row.id);
    if (!others.length) return true;
    return confirmDialog(`IP ${p.ip_text} 已被「${others.map((o) => o.name || '(無名稱)').join('、')}」使用，仍要儲存嗎？`, { okLabel: '仍要儲存' });
  },
  exportColumns: [
    { header: '院區', key: 'site', width: 10 }, { header: '類型', key: 'type', width: 12 }, { header: '名稱', key: 'name', width: 22 },
    { header: '樓層', key: 'floor', width: 8 }, { header: '單位', key: 'unit', width: 14 }, { header: 'IP', key: 'ip', width: 16 },
    { header: '廠牌型號', key: 'brand', width: 20 }, { header: '作業系統', key: 'os', width: 12 }, { header: 'OFFICE', key: 'office', width: 12 },
    { header: '購買日期', key: 'pd', width: 10 }, { header: '使用人', key: 'person', width: 12 }, { header: '狀態', key: 'status', width: 10 },
    { header: '備註', key: 'notes', width: 30 },
  ],
  exportRow: (r) => ({ site: siteName(r.site_id), type: TYPE_LABEL[r.asset_type], name: r.name, floor: r.floor, unit: r.unit, ip: r.ip_text, brand: r.brand_model,
    os: r.os, office: r.office_license, pd: r.purchase_date_raw, person: r.person?.name, status: STATUS_LABEL[r.status], notes: r.notes }),
});

// ---------- 人員（使用人）----------
export const peopleView = crudView({
  table: 'people', label: '人員', search: ['name', 'dept', 'employee_no', 'ext', 'title'], order: ['name', true],
  defaults: { site_id: 2, status: '在職' },
  filters: [{ key: 'site_id', label: '院區', options: siteOpts }, { key: 'status', label: '狀態', options: () => [['在職', '在職'], ['離職', '離職']] }],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id)) },
    { key: 'name', label: '姓名' }, { key: 'dept', label: '部門／單位' }, { key: 'title', label: '職稱' },
    { key: 'employee_no', label: '員編' }, { key: 'ext', label: '分機' },
    { key: 'status', label: '狀態', fmt: (r) => `<span class="tag ${r.status === '離職' ? 'danger' : 'ok'}">${esc(r.status)}${r.left_at ? '（' + esc(r.left_at) + '）' : ''}</span>` },
  ],
  fields: [
    { key: 'site_id', label: '院區', type: 'site', required: true }, { key: 'name', label: '姓名', required: true },
    { key: 'dept', label: '部門／單位' }, { key: 'title', label: '職稱' }, { key: 'employee_no', label: '員工編號' }, { key: 'ext', label: '分機' },
    { key: 'status', label: '狀態', type: 'select', options: [['在職', '在職'], ['離職', '離職']], required: true },
    { key: 'left_at', label: '離職日', type: 'date' }, { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  beforeSave: async (p, row) => {
    if (p.status === '離職' && !p.left_at) p.left_at = new Date().toISOString().slice(0, 10);
    if (p.status === '在職') p.left_at = null;
    if (p.status === '離職' && row) {
      const { count } = await sb.from('assets').select('id', { count: 'exact', head: true }).eq('person_id', row.id).neq('status', 'retired');
      if (count) return confirmDialog(`此人名下仍有 ${count} 件資產（電腦等），離職後請記得轉移。仍要標記為離職？`, { okLabel: '標記離職' });
    }
    return true;
  },
  rowActions: [{
    label: '名下資產',
    run: async (r) => {
      const { data, error } = await sb.from('assets').select('name,ip_text,asset_type,status,unit').eq('person_id', r.id).order('name');
      if (error) return toast(error.message, true);
      modal(`名下資產：${r.name}`, data.length ? `<div class="table-wrap"><table><thead><tr><th>名稱</th><th>類型</th><th>IP</th><th>單位</th><th>狀態</th></tr></thead><tbody>${
        data.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(TYPE_LABEL[a.asset_type])}</td><td>${esc(a.ip_text)}</td><td>${esc(a.unit)}</td><td>${esc(STATUS_LABEL[a.status])}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">沒有指派任何資產</p>', { buttons: [{ label: '關閉', cls: 'primary' }] });
    },
  }],
});

// ---------- 主機與帳密 ----------
const HOST_TYPE = { firewall: '防火牆', nas: 'NAS', server: '伺服器', pacs: 'PACS', web: '網站後台', wifi: 'WiFi', software: '軟體系統', other: '其他' };
export const hostsView = crudView({
  table: 'hosts', label: '主機系統', search: ['name', 'address', 'owner_name', 'notes'], order: ['name', true],
  defaults: { site_id: 2, host_type: 'other', active: true },
  filters: [{ key: 'site_id', label: '院區', options: siteOpts }, { key: 'host_type', label: '類型', options: () => opts(HOST_TYPE) }],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id)) },
    { key: 'name', label: '設備／系統' }, { key: 'host_type', label: '類型', fmt: (r) => esc(HOST_TYPE[r.host_type] || r.host_type) },
    { key: 'address', label: '位址／網址' }, { key: 'owner_name', label: '負責人' },
    { key: 'active', label: '狀態', fmt: (r) => (r.active ? '<span class="tag ok">使用中</span>' : '<span class="tag">停用</span>') },
  ],
  fields: [
    { key: 'site_id', label: '院區', type: 'site', required: true }, { key: 'name', label: '設備／系統名稱', required: true },
    { key: 'host_type', label: '類型', type: 'select', options: opts(HOST_TYPE), required: true }, { key: 'address', label: 'IP 或網址' },
    { key: 'owner_name', label: '負責人' }, { key: 'active', label: '使用中', type: 'bool' }, { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  rowActions: [{ label: '帳號密碼', run: (r) => openCredentials(r) }],
});

// ---------- 廠商聯絡 ----------
export const vendorsView = crudView({
  table: 'vendor_contacts', label: '廠商聯絡人', search: ['system_name', 'vendor', 'contact_name', 'phone', 'notes'], order: ['system_name', true],
  filters: [{ key: 'site_id', label: '院區', options: siteOpts }],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id) || '共用') },
    { key: 'system_name', label: '系統／項目' }, { key: 'vendor', label: '廠商' }, { key: 'contact_name', label: '聯絡人' }, { key: 'phone', label: '電話' },
    { key: 'notes', label: '備註', wrap: true },
  ],
  fields: [
    { key: 'site_id', label: '院區（空白＝共用）', type: 'select', options: siteOpts() },
    { key: 'system_name', label: '系統／項目', required: true }, { key: 'vendor', label: '廠商' }, { key: 'contact_name', label: '聯絡人' },
    { key: 'phone', label: '電話' }, { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  historyTitle: (r) => `${r.system_name} ${r.contact_name || ''}`,
});

// ---------- 交辦事項 ----------
export const tasksView = crudView({
  table: 'tasks', label: '交辦事項', search: ['title', 'detail', 'owner_name', 'vendor', 'progress_note'], order: ['updated_at', false],
  defaults: { status: '待處理' },
  filters: [{ key: 'status', label: '狀態', options: () => ['待處理', '處理中', '已完成', '暫停'].map((s) => [s, s]) }, { key: 'site_id', label: '院區', options: siteOpts }],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id) || '共用') },
    { key: 'title', label: '事項', wrap: true },
    { key: 'status', label: '狀態', fmt: (r) => `<span class="tag ${r.status === '已完成' ? 'ok' : r.status === '暫停' ? '' : 'warn'}">${esc(r.status)}</span>` },
    { key: 'owner_name', label: '負責人' }, { key: 'vendor', label: '廠商' }, { key: 'due_date', label: '期限' },
    { key: 'progress_note', label: '處理情形', wrap: true },
  ],
  fields: [
    { key: 'title', label: '事項', required: true, full: true },
    { key: 'site_id', label: '院區', type: 'select', options: siteOpts() },
    { key: 'status', label: '狀態', type: 'select', required: true, options: ['待處理', '處理中', '已完成', '暫停'].map((s) => [s, s]) },
    { key: 'owner_name', label: '負責人' }, { key: 'vendor', label: '廠商' }, { key: 'due_date', label: '期限', type: 'date' },
    { key: 'detail', label: '內容說明', type: 'textarea', full: true }, { key: 'progress_note', label: '處理情形', type: 'textarea', full: true },
  ],
});

// ---------- 知識庫 ----------
export const kbView = crudView({
  table: 'kb_articles', label: '知識庫', search: ['title', 'category', 'body'], order: ['updated_at', false],
  filters: [{ key: 'site_id', label: '院區', options: siteOpts }],
  columns: [
    { key: 'site_id', label: '院區', fmt: (r) => esc(siteName(r.site_id) || '共用') },
    { key: 'category', label: '分類' }, { key: 'title', label: '標題', wrap: true }, { key: 'updated_at', label: '更新時間', fmt: (r) => esc(fmtTime(r.updated_at)) },
  ],
  fields: [
    { key: 'title', label: '標題', required: true, full: true }, { key: 'category', label: '分類（例：PACS、備份、HIS）' },
    { key: 'site_id', label: '院區', type: 'select', options: siteOpts() }, { key: 'body', label: '內容', type: 'textarea', full: true },
  ],
  rowActions: [{
    label: '檢視',
    run: (r) => modal(r.title, `<div class="muted" style="margin-bottom:8px">${esc(r.category || '')}</div><pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(r.body || '')}</pre>`, { wide: true, buttons: [{ label: '關閉', cls: 'primary' }] }),
  }],
});

export { personLabel };

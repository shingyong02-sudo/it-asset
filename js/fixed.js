// 第一期：部門、財產（編號／折舊）、移轉／報廢簽核、QR Code 列印清單
import { sb, state, $, esc, toast, errText, modal, confirmDialog, canWrite, isAdmin, siteName, fmtTime, personLabel, loadSites, loadPeople } from './core.js';
import { crudView } from './crud.js';
import { siteTabs } from './entities.js';

const CAT = {};                       // code -> name
let DEPTS = [];                       // 全部部門
async function loadRef() {
  await loadSites();
  const [c, d] = await Promise.all([
    sb.from('asset_categories').select('*').order('sort'),
    sb.from('departments').select('id,site_id,name').order('name').limit(2000),
  ]);
  if (c.error) throw c.error;
  if (d.error) throw d.error;
  Object.keys(CAT).forEach((k) => delete CAT[k]);
  c.data.forEach((x) => { CAT[x.code] = x.name; });
  DEPTS = d.data;
}
const deptOpts = () => DEPTS.map((d) => [d.id, `${siteName(d.site_id)}／${d.name}`]);
const money = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));

// 直線法折舊（按月）：與資料庫 v_fixed_assets 相同算法
export function depreciation(a) {
  const start = new Date(a.acquired_date);
  const end = a.scrapped_at ? new Date(a.scrapped_at) : new Date();
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  months = Math.min(a.useful_life_months, Math.max(0, months));
  const acc = Math.round(((a.cost - a.salvage_value) / a.useful_life_months) * months);
  return { months, acc, book: a.cost - acc };
}

// ---------- 部門／單位 ----------
export const departmentsView = crudView({
  table: 'departments', label: '部門／單位', search: ['name', 'notes'], order: ['name', true],
  defaults: { site_id: 2 },
  tabGroups: [{ field: 'site_id', items: siteTabs }],
  columns: [{ key: 'name', label: '部門／單位' }, { key: 'notes', label: '備註', wrap: true }],
  fields: [
    { key: 'site_id', label: '院所', type: 'site', required: true },
    { key: 'name', label: '部門／單位名稱', required: true },
    { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  beforeRender: loadRef,
});

// ---------- 財產 ----------
function requestDialog(kind, a, reload) {
  const isT = kind === 'transfer';
  const peopleOpts = ['<option value="">（不變更）</option>', ...state.people.filter((p) => p.status !== '離職')
    .map((p) => `<option value="${esc(p.id)}">${esc(personLabel(p))}</option>`)].join('');
  const dOpts = ['<option value="">（不變更）</option>', ...deptOpts().map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)].join('');
  modal(`${isT ? '保管人移轉' : '報廢'}申請：${a.asset_no} ${a.name}`, `<div class="form-grid">
    ${isT ? `<label class="full">新保管人<select data-k="cust">${peopleOpts}</select></label>
    <label>新部門<select data-k="dept">${dOpts}</select></label>
    <label>新存放地點<input data-k="loc" /></label>` : ''}
    <label class="full">${isT ? '移轉' : '報廢'}原因<textarea data-k="reason"></textarea></label></div>
    <p class="muted">送出後由管理者簽核，核准後才會生效。</p>`, {
    buttons: [{ label: '取消' }, {
      label: '送出申請', cls: 'primary', onClick: async (mm) => {
        const reason = mm.$('[data-k=reason]').value.trim();
        if (!reason) { toast('請填寫原因', true); return true; }
        const { error } = await sb.rpc('request_approval', {
          p_kind: kind, p_asset: a.id, p_reason: reason,
          p_to_custodian: isT ? (mm.$('[data-k=cust]').value || null) : null,
          p_to_dept: isT ? (mm.$('[data-k=dept]').value || null) : null,
          p_to_location: isT ? (mm.$('[data-k=loc]').value.trim() || null) : null,
        });
        if (error) { toast(errText(error), true); return true; }
        toast('✓ 已送出，等待管理者簽核');
        reload();
        return false;
      },
    }],
  });
}

export const fixedAssetsView = crudView({
  table: 'fixed_assets', label: '財產', select: '*, dept:departments(name), cust:people(name)',
  search: ['asset_no', 'name', 'brand_model', 'serial_no', 'location', 'notes'],
  orders: [['asset_no', true]], pageSize: 100,
  defaults: { site_id: 2, category: 'C', salvage_value: 0, useful_life_months: 60 },
  tabGroups: [{ field: 'site_id', items: siteTabs }],
  filters: [
    { key: 'category', label: '分類', options: () => Object.entries(CAT) },
    { key: 'status', label: '狀態', options: () => [['in_use', '使用中'], ['scrapped', '已報廢']] },
  ],
  columns: [
    { key: 'asset_no', label: '財產編號' },
    { key: 'category', label: '分類', fmt: (r) => esc(CAT[r.category] || r.category) },
    { key: 'name', label: '名稱' },
    { key: 'dept', label: '部門', fmt: (r) => esc(r.dept?.name || '') },
    { key: 'cust', label: '保管人', fmt: (r) => esc(r.cust?.name || '') },
    { key: 'location', label: '存放地點' },
    { key: 'acquired_date', label: '取得日' },
    { key: 'cost', label: '取得成本', fmt: (r) => money(r.cost) },
    { key: 'book', label: '帳面價值', fmt: (r) => money(depreciation(r).book) },
    { key: 'status', label: '狀態', fmt: (r) => (r.status === 'scrapped' ? '<span class="tag danger">已報廢</span>' : '<span class="tag ok">使用中</span>') },
  ],
  fields: [
    { key: 'site_id', label: '院所', type: 'site', required: true, newOnly: true },
    { key: 'category', label: '分類', type: 'select', required: true, get options() { return Object.entries(CAT); } },
    { key: 'name', label: '名稱', required: true },
    { key: 'brand_model', label: '廠牌型號' },
    { key: 'serial_no', label: '序號' },
    { key: 'dept_id', label: '部門／單位', type: 'select', newOnly: true, get options() { return deptOpts(); } },
    { key: 'custodian_id', label: '保管人', type: 'person', newOnly: true },
    { key: 'location', label: '存放地點', newOnly: true },
    { key: 'acquired_date', label: '取得日期', type: 'date', required: true },
    { key: 'cost', label: '取得成本（元）', type: 'number', required: true },
    { key: 'salvage_value', label: '殘值（元）', type: 'number', required: true },
    { key: 'useful_life_months', label: '耐用月數（例：5 年＝60）', type: 'number', required: true },
    { key: 'notes', label: '備註', type: 'textarea', full: true },
  ],
  historyTitle: (r) => `${r.asset_no} ${r.name}`,
  beforeRender: async () => { await loadRef(); await loadPeople(true); },
  beforeSave: async (p) => {
    if (p.salvage_value > p.cost) { toast('殘值不可大於取得成本', true); return false; }
    return true;
  },
  rowActions: [
    { label: '移轉', show: (r) => canWrite() && r.status === 'in_use', run: (r, reload) => requestDialog('transfer', r, reload) },
    { label: '報廢', show: (r) => canWrite() && r.status === 'in_use', run: (r, reload) => requestDialog('scrap', r, reload) },
    {
      label: '折舊', run: (r) => {
        const d = depreciation(r);
        modal(`折舊明細：${r.asset_no}`, `<div class="form-grid">
          <div>取得成本：<b>${money(r.cost)}</b></div><div>殘值：<b>${money(r.salvage_value)}</b></div>
          <div>耐用月數：<b>${r.useful_life_months}</b></div><div>已使用月數：<b>${d.months}</b></div>
          <div>每月折舊：<b>${money(Math.round((r.cost - r.salvage_value) / r.useful_life_months))}</b></div>
          <div>累計折舊：<b>${money(d.acc)}</b></div>
          <div class="full">帳面價值：<b>${money(d.book)}</b>（直線法，按月；${r.scrapped_at ? '截至報廢日 ' + esc(r.scrapped_at) : '截至今日'}）</div></div>`,
        { buttons: [{ label: '關閉', cls: 'primary' }] });
      },
    },
  ],
  exportColumns: [
    { header: '財產編號', key: 'no', width: 20 }, { header: '院所', key: 'site', width: 10 }, { header: '分類', key: 'cat', width: 12 },
    { header: '名稱', key: 'name', width: 24 }, { header: '廠牌型號', key: 'bm', width: 20 }, { header: '序號', key: 'sn', width: 16 },
    { header: '部門', key: 'dept', width: 14 }, { header: '保管人', key: 'cust', width: 12 }, { header: '存放地點', key: 'loc', width: 16 },
    { header: '取得日', key: 'ad', width: 12 }, { header: '取得成本', key: 'cost', width: 12 }, { header: '殘值', key: 'sv', width: 10 },
    { header: '耐用月數', key: 'life', width: 10 }, { header: '累計折舊', key: 'acc', width: 12 }, { header: '帳面價值', key: 'book', width: 12 },
    { header: '狀態', key: 'st', width: 8 },
  ],
  exportRow: (r) => { const d = depreciation(r); return { no: r.asset_no, site: siteName(r.site_id), cat: CAT[r.category], name: r.name, bm: r.brand_model, sn: r.serial_no,
    dept: r.dept?.name, cust: r.cust?.name, loc: r.location, ad: r.acquired_date, cost: r.cost, sv: r.salvage_value, life: r.useful_life_months,
    acc: d.acc, book: d.book, st: r.status === 'scrapped' ? '已報廢' : '使用中' }; },
});

// ---------- 簽核 ----------
const KIND = { transfer: '保管人移轉', scrap: '報廢' };
const ST = { pending: ['待簽核', 'warn'], approved: ['已核准', 'ok'], rejected: ['已退回', 'danger'], cancelled: ['已取消', ''] };

export async function approvalsView(root) {
  await loadRef();
  let only = 'pending';
  root.innerHTML = `<div class="bar"><select id="apSt"><option value="pending">待簽核</option><option value="">全部</option></select></div>
    <div class="table-wrap"><table><thead><tr><th>申請時間</th><th>類別</th><th>財產</th><th>內容</th><th>原因</th><th>狀態</th><th>操作</th></tr></thead><tbody id="apRows"></tbody></table></div>`;
  async function load() {
    let q = sb.from('approvals').select('*, asset:fixed_assets(asset_no,name), c:people(name), d:departments(name)').order('requested_at', { ascending: false }).limit(300);
    if (only) q = q.eq('status', only);
    const { data, error } = await q;
    if (error) return toast(errText(error), true);
    const uid = state.session.user.id;
    $('#apRows', root).innerHTML = data.length ? data.map((a, i) => {
      const [stl, stc] = ST[a.status];
      const what = a.kind === 'transfer'
        ? [a.c?.name && `保管人→${a.c.name}`, a.d?.name && `部門→${a.d.name}`, a.to_location && `地點→${a.to_location}`].filter(Boolean).join('、')
        : '報廢';
      const btns = a.status === 'pending' ? [
        isAdmin() ? `<button class="btn sm primary" data-a="ok" data-i="${i}">核准</button><button class="btn sm danger" data-a="no" data-i="${i}">退回</button>` : '',
        (a.requested_by === uid || isAdmin()) ? `<button class="btn sm" data-a="cx" data-i="${i}">取消</button>` : '',
      ].join(' ') : esc(a.decision_note || '');
      return `<tr><td>${esc(fmtTime(a.requested_at))}</td><td>${esc(KIND[a.kind])}</td><td>${esc(a.asset?.asset_no || '')} ${esc(a.asset?.name || '')}</td>
        <td class="wrap">${esc(what)}</td><td class="wrap">${esc(a.reason)}</td><td><span class="tag ${stc}">${stl}</span></td><td>${btns}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">沒有資料</td></tr>';
    $('#apRows', root).querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', () => act(data[Number(b.dataset.i)], b.dataset.a)));
  }
  function act(a, how) {
    if (how === 'cx') {
      return confirmDialog('確定取消此申請？', { okLabel: '取消申請' }).then(async (ok) => {
        if (!ok) return;
        const { error } = await sb.rpc('cancel_approval', { p_id: a.id });
        if (error) return toast(errText(error), true);
        toast('✓ 已取消'); load();
      });
    }
    const approve = how === 'ok';
    modal(`${approve ? '核准' : '退回'}：${KIND[a.kind]} ${a.asset?.asset_no || ''}`,
      `<label class="full">${approve ? '簽核意見（可空白）' : '退回原因'}<textarea id="apNote"></textarea></label>`, {
        buttons: [{ label: '取消' }, {
          label: approve ? '核准' : '退回', cls: approve ? 'primary' : 'danger', onClick: async (mm) => {
            const note = mm.$('#apNote').value.trim();
            if (!approve && !note) { toast('請填寫退回原因', true); return true; }
            const { error } = await sb.rpc('decide_approval', { p_id: a.id, p_approve: approve, p_note: note || null });
            if (error) { toast(errText(error), true); return true; }
            toast(approve ? '✓ 已核准並生效' : '✓ 已退回'); load(); return false;
          },
        }],
      });
  }
  $('#apSt', root).addEventListener('change', (e) => { only = e.target.value; load(); });
  await load();
}

// ---------- QR Code 列印清單（A4，每頁 3 欄 × 8 列）----------
export async function qrView(root) {
  await loadRef();
  const tabs = siteTabs();
  let site = tabs[0].values[0], rows = [];
  root.innerHTML = `<div class="tabs" id="qrTabs">${tabs.map((t, i) => `<button type="button" class="tab ${i ? '' : 'active'}" data-s="${t.values[0]}">${esc(t.label)}</button>`).join('')}</div>
    <div class="bar"><select id="qrCat"><option value="">分類：全部</option>${Object.entries(CAT).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <label><input type="checkbox" id="qrAll" style="width:auto" checked /> 全選</label><span class="grow"></span>
      <span id="qrCount" class="muted"></span><button class="btn primary" id="qrPrint">列印／存成 PDF</button></div>
    <p class="muted">按「列印」後，在列印視窗選擇「另存為 PDF」，紙張 A4、邊界選「無」即可。QR Code 內容為財產編號。</p>
    <div class="table-wrap"><table><thead><tr><th></th><th>財產編號</th><th>名稱</th><th>部門</th><th>保管人</th></tr></thead><tbody id="qrRows"></tbody></table></div>`;
  async function load() {
    let q = sb.from('fixed_assets').select('id,asset_no,name,dept:departments(name),cust:people(name)').eq('site_id', site).eq('status', 'in_use').order('asset_no').limit(2000);
    const c = $('#qrCat', root).value; if (c) q = q.eq('category', c);
    const { data, error } = await q;
    if (error) return toast(errText(error), true);
    rows = data;
    $('#qrRows', root).innerHTML = rows.length ? rows.map((r, i) => `<tr><td><input type="checkbox" class="qrck" data-i="${i}" style="width:auto" checked /></td>
      <td>${esc(r.asset_no)}</td><td>${esc(r.name)}</td><td>${esc(r.dept?.name || '')}</td><td>${esc(r.cust?.name || '')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">沒有財產</td></tr>';
    $('#qrAll', root).checked = true; count();
  }
  const picked = () => [...root.querySelectorAll('.qrck')].filter((x) => x.checked).map((x) => rows[Number(x.dataset.i)]);
  const count = () => { $('#qrCount', root).textContent = `已選 ${picked().length} / ${rows.length}`; };
  root.addEventListener('change', (e) => {
    if (e.target.id === 'qrAll') root.querySelectorAll('.qrck').forEach((x) => { x.checked = e.target.checked; });
    if (e.target.id === 'qrCat') return load();
    count();
  });
  $('#qrTabs', root).addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    site = Number(b.dataset.s);
    root.querySelectorAll('#qrTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  $('#qrPrint', root).addEventListener('click', () => {
    const sel = picked();
    if (!sel.length) return toast('請至少選一筆', true);
    if (typeof window.qrcode !== 'function') return toast('QR Code 元件載入失敗，請重新整理', true);
    document.getElementById('printArea')?.remove();
    const area = document.createElement('div');
    area.id = 'printArea';
    const pages = [];
    for (let i = 0; i < sel.length; i += 24) pages.push(sel.slice(i, i + 24));
    area.innerHTML = pages.map((pg) => `<section class="qr-page">${pg.map((r) => {
      const q = window.qrcode(0, 'M'); q.addData(r.asset_no); q.make();
      return `<div class="qr-cell"><div class="qr-img">${q.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
        <div class="qr-txt"><b>${esc(r.asset_no)}</b><br>${esc(r.name)}<br>${esc(r.dept?.name || '')}</div></div>`;
    }).join('')}</section>`).join('');
    document.body.appendChild(area);
    const done = () => { area.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  });
  await load();
}

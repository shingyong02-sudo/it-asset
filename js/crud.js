// 通用清單 + 新增／編輯／刪除／異動歷史／匯出 元件
import { sb, state, $, esc, toast, errText, modal, confirmDialog, canWrite, isAdmin, loadSites, loadPeople,
  personLabel, showHistory, exportXlsx, todayStr, siteName } from './core.js';

const PAGE = 50;
const cleanKw = (s) => s.replace(/[,()*%\\"]/g, ' ').trim();

/**
 * cfg: { table, label, select, search:[col], order:[col, asc], defaults:{}, columns:[{key,label,fmt?,wrap?}],
 *        fields:[{key,label,type,options,required,full}], filters:[{key,label,options:()=>[[v,l]]}],
 *        exportColumns:[{header,key,width}], exportRow:(row)=>({...}), rowActions:[{label,run(row,reload)}],
 *        beforeSave:async(payload,row)=>boolean, historyTitle:(row)=>string }
 */
export function crudView(cfg) {
  return async function render(root) {
    await loadSites();
    if (cfg.fields.some((f) => f.type === 'person')) await loadPeople(true);
    let page = 0, kw = '', total = 0;
    const filterVals = {};
    const PG = cfg.pageSize || PAGE;
    // 分頁籤群組（例：院區、設備類別）；每組一次選一項
    const groups = (cfg.tabGroups || []).map((g) => ({ field: g.field, items: g.items(), sel: 0 }));

    root.innerHTML = `
      ${groups.length ? `<div id="tabGroups">${groups.map((g, gi) => `<div class="tabs" data-g="${gi}">${g.items.map((it, ii) =>
        `<button type="button" class="tab ${ii === 0 ? 'active' : ''}" data-i="${ii}">${esc(it.label)}</button>`).join('')}</div>`).join('')}</div>` : ''}
      <div class="bar">
        <input type="search" id="kw" placeholder="搜尋${esc(cfg.label)}…" />
        <span id="filters" class="bar" style="margin:0"></span>
        <span class="grow"></span>
        <button class="btn" id="btnExport">匯出 XLSX</button>
        ${canWrite() && !cfg.readOnly ? `<button class="btn primary" id="btnAdd">＋ 新增</button>` : ''}
      </div>
      <div class="table-wrap"><table><thead><tr>${cfg.rowNo ? '<th>編號</th>' : ''}${cfg.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>操作</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
      <div class="pager"><span id="count"></span><button class="btn sm" id="prev">上一頁</button><span id="pageNo"></span><button class="btn sm" id="next">下一頁</button></div>`;

    const filtersEl = $('#filters', root);
    (cfg.filters || []).forEach((f) => {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">${esc(f.label)}：全部</option>` + f.options().map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      sel.addEventListener('change', () => { filterVals[f.key] = sel.value; page = 0; load(); });
      filtersEl.appendChild(sel);
    });

    function buildQuery(forExport = false) {
      let q = sb.from(cfg.table).select(cfg.select || '*', forExport ? {} : { count: 'exact' });
      for (const [k, v] of Object.entries(filterVals)) if (v !== '' && v !== undefined) q = q.eq(k, v);
      for (const g of groups) {
        const vals = g.items[g.sel]?.values;
        if (vals?.length === 1) q = q.eq(g.field, vals[0]); else if (vals?.length) q = q.in(g.field, vals);
      }
      const k = cleanKw(kw);
      if (k) q = q.or(cfg.search.map((c) => `${c}.ilike.%${k}%`).join(','));
      const orders = cfg.orders || [cfg.order || ['created_at', false]];
      for (const [oc, asc, nullsLast] of orders) q = q.order(oc, { ascending: asc, ...(nullsLast ? { nullsFirst: false } : {}) });
      return q;
    }

    root.querySelectorAll('.tabs').forEach((el) => el.addEventListener('click', (e) => {
      const b = e.target.closest('.tab'); if (!b) return;
      groups[Number(el.dataset.g)].sel = Number(b.dataset.i);
      el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      page = 0; load();
    }));

    async function load() {
      const { data, error, count } = await buildQuery().range(page * PG, page * PG + PG - 1);
      if (error) return toast(errText(error), true);
      total = count ?? data.length;
      const body = $('#rows', root);
      if (!data.length) {
        body.innerHTML = `<tr><td colspan="${cfg.columns.length + 1 + (cfg.rowNo ? 1 : 0)}" class="empty">沒有資料</td></tr>`;
      } else {
        body.innerHTML = data.map((r, i) => `<tr data-i="${i}">${cfg.rowNo ? `<td>${page * PG + i + 1}</td>` : ''}${cfg.columns.map((c) =>
          `<td class="${c.wrap ? 'wrap' : ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}
          <td>${actionsHtml(r)}</td></tr>`).join('');
        body.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
          const r = data[Number(b.closest('tr').dataset.i)];
          const act = b.dataset.act;
          if (act === 'edit') openForm(r);
          else if (act === 'history') showHistory(cfg.table, r.id, cfg.historyTitle ? cfg.historyTitle(r) : (r.name || r.title || r.id));
          else if (act === 'delete') doDelete(r);
          else cfg.rowActions[Number(act.slice(1))].run(r, load);
        }));
      }
      const pages = Math.max(1, Math.ceil(total / PG));
      $('#count', root).textContent = `共 ${total} 筆`;
      $('#pageNo', root).textContent = `${page + 1} / ${pages}`;
      $('#prev', root).disabled = page === 0;
      $('#next', root).disabled = page + 1 >= pages;
    }

    function actionsHtml(r) {
      const out = [];
      (cfg.rowActions || []).forEach((a, i) => { if (!a.show || a.show(r)) out.push(`<button class="btn sm" data-act="a${i}">${esc(a.label)}</button>`); });
      if (canWrite() && !cfg.readOnly) out.push(`<button class="btn sm" data-act="edit">編輯</button>`);
      out.push(`<button class="btn sm" data-act="history">歷史</button>`);
      if (isAdmin() && !cfg.readOnly) out.push(`<button class="btn sm danger" data-act="delete">刪除</button>`);
      return out.join(' ');
    }

    function fieldHtml(f, val) {
      const v = val ?? '';
      const req = f.required ? ' req' : '';
      let input;
      if (f.type === 'textarea') input = `<textarea data-k="${f.key}">${esc(v)}</textarea>`;
      else if (f.type === 'select' || f.type === 'site' || f.type === 'person' || f.type === 'bool') {
        let opts;
        if (f.type === 'site') opts = state.sites.map((s) => [s.id, s.name]);
        else if (f.type === 'person') opts = [['', '（未指派）'], ...state.people.map((p) => [p.id, personLabel(p)])];
        else if (f.type === 'bool') opts = [['true', '是'], ['false', '否']];
        else opts = f.options;
        const cur = f.type === 'bool' ? String(val ?? true) : String(v);
        input = `<select data-k="${f.key}">${(f.required || f.type === 'bool' ? '' : '<option value=""></option>')}${opts.map(([ov, ol]) =>
          `<option value="${esc(ov)}" ${String(ov) === cur ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
      } else input = `<input data-k="${f.key}" type="${f.type === 'date' ? 'date' : 'text'}" value="${esc(v)}" />`;
      return `<label class="${f.full ? 'full' : ''}"><span class="${req}">${esc(f.label)}</span>${input}</label>`;
    }

    function openForm(row) {
      const isNew = !row;
      const vals = row || { ...(cfg.defaults || {}) };
      const m = modal(`${isNew ? '新增' : '編輯'}${cfg.label}`, `<div class="form-grid">${cfg.fields.map((f) => fieldHtml(f, vals[f.key])).join('')}</div>`, {
        wide: cfg.fields.length > 8,
        buttons: [
          { label: '取消' },
          {
            label: '儲存', cls: 'primary', onClick: async (mm) => {
              const payload = {};
              for (const f of cfg.fields) {
                const el = mm.$(`[data-k="${f.key}"]`);
                let v = el.value.trim();
                if (f.required && !v) { toast(`請填寫「${f.label}」`, true); return true; }
                if (v === '') v = null;
                else if (f.type === 'site') v = Number(v);
                else if (f.type === 'bool') v = v === 'true';
                payload[f.key] = v;
              }
              if (cfg.beforeSave && !(await cfg.beforeSave(payload, row))) return true;
              const res = isNew
                ? await sb.from(cfg.table).insert(payload).select()
                : await sb.from(cfg.table).update(payload).eq('id', row.id).select();
              if (res.error) { toast(errText(res.error), true); return true; }
              if (!res.data?.length) { toast('儲存失敗：沒有權限或資料已不存在', true); return true; }
              toast('✓ 已儲存');
              if (cfg.table === 'people') await loadPeople(true);
              load();
              return false;
            },
          },
        ],
      });
      return m;
    }

    async function doDelete(r) {
      if (!(await confirmDialog(`確定刪除「${r.name || r.title || r.id}」？刪除動作會留在稽核紀錄中。`, { okLabel: '刪除', danger: true }))) return;
      const { data, error } = await sb.from(cfg.table).delete().eq('id', r.id).select();
      if (error) return toast(errText(error), true);
      if (!data?.length) return toast('刪除失敗：沒有權限', true);
      toast('✓ 已刪除');
      load();
    }

    let kwTimer;
    $('#kw', root).addEventListener('input', (e) => { clearTimeout(kwTimer); kwTimer = setTimeout(() => { kw = e.target.value; page = 0; load(); }, 300); });
    $('#prev', root).addEventListener('click', () => { page--; load(); });
    $('#next', root).addEventListener('click', () => { page++; load(); });
    $('#btnAdd', root)?.addEventListener('click', () => openForm(null));
    $('#btnExport', root).addEventListener('click', async () => {
      const { data, error } = await buildQuery(true).limit(10000);
      if (error) return toast(errText(error), true);
      if (!data.length) return toast('目前沒有資料可匯出', true);
      const cols = cfg.exportColumns || cfg.columns.map((c) => ({ header: c.label, key: c.key, width: 16 }));
      await exportXlsx(`${cfg.label}_${todayStr()}.xlsx`, cfg.label, cols, data.map((r) => (cfg.exportRow ? cfg.exportRow(r) : r)));
      toast('✓ 已匯出 XLSX');
    });
    await load();
  };
}

export { siteName };

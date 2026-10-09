/* ============================================================
   数据管理后台 · 云端直写（企业估值榜 + 具身LAB排名）
   口令：来自 admin-config.js（该文件已加入 .gitignore，不进版本库）
   ============================================================ */
(function () {
  'use strict';

  // 口令从 admin-config.js 读取，缺失时在登录门给出明确提示
  // 本地首次使用：cp admin-config.example.js admin-config.js 并填入口令
  var ADMIN_PASS = String(window.ADMIN_PASS || '').trim();

  // ---------- 数据集定义 ----------
  var DATASETS = {
    companies: {
      label: '企业估值榜',
      table: 'companies',
      orderCol: 'valuation_cny_yi', asc: false,
      searchKeys: ['name_cn', 'name_en'],
      nameKey: 'name_cn', reqLabel: '公司名称',
      addLabel: '+ 新增公司', unit: '家', minWidth: 1500,
      fields: [
        { k: 'name_cn',            label: '公司名称',       type: 'text' },
        { k: 'core_product',       label: '核心竞争力',     type: 'text' },
        { k: 'valuation_cny_yi',   label: '估值(亿)',       type: 'num'  },
        { k: 'total_funding_cny_yi', label: '累计融资(亿)', type: 'num'  },
        { k: 'latest_round',       label: '最新轮次',       type: 'text' },
        { k: 'lead_investors',     label: '领投方',         type: 'text' },
        { k: 'region',             label: '地区',           type: 'text' },
        { k: 'segment_layer',      label: '分层',           type: 'select', opts: ['本体层', '模型层', '基建层'] },
        { k: 'relation',           label: '生态关系',       type: 'select', opts: ['', 'partner', 'self'], labels: ['无', '智元生态', '智元本体（不显示）'] },
        { k: 'daily_change',       label: '每日变化',       type: 'select', opts: ['', 'new', 'up'], labels: ['无', 'NEW 新进', '↑ 上升'] },
        { k: 'daily_change_value', label: '↑位数',          type: 'num'  }
      ]
    },
    labs: {
      label: '具身LAB排名',
      table: 'labs',
      orderCol: 'rank', asc: true,
      searchKeys: ['university', 'lab', 'person'],
      nameKey: 'university', reqLabel: '高校名称',
      addLabel: '+ 新增实验室', unit: '家', minWidth: 2100,
      fields: [
        { k: 'rank',         label: '名次',         type: 'num' },
        { k: 'university',   label: '高校',         type: 'text' },
        { k: 'lab',          label: '实验室',       type: 'text' },
        { k: 'person',       label: '核心人物',     type: 'textarea' },
        { k: 'citations',    label: '引用量',       type: 'num' },
        { k: 'person_intro', label: '人物介绍',     type: 'textarea' },
        { k: 'lab_intro',    label: '实验室简介',   type: 'textarea' },
        { k: 'publications', label: '发表情况',     type: 'textarea' },
        { k: 'score',        label: '论文得分',     type: 'num' },
        { k: 'website',      label: '官网',         type: 'text' },
        { k: 'contact',      label: '已建联',       type: 'bool' },
        { k: 'contact_note', label: '建联备注',     type: 'textarea' }
      ]
    }
  };

  // ---------- 状态 ----------
  var db = null;
  var dsKey = 'companies';
  var ds = DATASETS[dsKey];
  var rows = [];          // 云端原始行
  var original = {};      // id -> 原始 JSON 快照
  var dirty = new Set();  // 脏行 id 集合
  var pendingNew = null;  // 新增行（未入库）

  var $ = function (s) { return document.querySelector(s); };

  function setStatus(mode, text) {
    var el = $('#status');
    el.className = 'status' + (mode ? ' ' + mode : '');
    $('#statusText').textContent = text;
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- 登录门 ----------
  function bindGate() {
    $('#passBtn').addEventListener('click', tryEnter);
    $('#passInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') tryEnter();
    });
    if (!ADMIN_PASS || ADMIN_PASS === 'CHANGE_ME') {
      $('#gateErr').textContent = '未配置口令：请先创建 admin-config.js（可复制 admin-config.example.js）';
      $('#passInput').disabled = true;
      $('#passBtn').disabled = true;
      return;
    }
    if (sessionStorage.getItem('adminUnlocked') === '1') enter();
  }
  function tryEnter() {
    if (!ADMIN_PASS) { $('#gateErr').textContent = '未配置口令：缺少 admin-config.js'; return; }
    if ($('#passInput').value === ADMIN_PASS) { sessionStorage.setItem('adminUnlocked', '1'); enter(); }
    else $('#gateErr').textContent = '口令不正确';
  }
  function enter() {
    $('#gate').hidden = true;
    $('#editor').hidden = false;
    init();
  }

  // ---------- 初始化 ----------
  function init() {
    var cfg = window.CLOUD_CONFIG || {};
    if (!window.WorkBuddyCloud || !cfg.endpoint || !cfg.publishableKey) {
      setStatus('err', '云服务 SDK 或配置加载失败，请刷新重试');
      return;
    }
    db = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint, publishableKey: cfg.publishableKey
    }).database;

    bindOps();
    bindTabs();
    applyDataset();
    reload();
  }

  function bindOps() {
    $('#reloadBtn').addEventListener('click', reload);
    $('#search').addEventListener('input', render);
    $('#saveAllBtn').addEventListener('click', saveAll);
    $('#addBtn').addEventListener('click', addRow);
  }

  function bindTabs() {
    document.querySelectorAll('.ds-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.ds === dsKey) return;
        document.querySelectorAll('.ds-tab').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        dsKey = btn.dataset.ds;
        ds = DATASETS[dsKey];
        applyDataset();
        reload();
      });
    });
  }

  // 切换数据集：更新表头 / 占位文案 / 按钮文案
  function applyDataset() {
    // 表头 + 列宽
    var colgroup = '<col style="width:52px">' +
      ds.fields.map(function (f) {
        var w = f.type === 'textarea' ? 200 : (f.type === 'num' ? 90 : 130);
        return '<col style="width:' + w + 'px">';
      }).join('') +
      '<col style="width:130px">';
    var thead = '<tr><th>ID</th>' +
      ds.fields.map(function (f) { return '<th>' + esc(f.label) + '</th>'; }).join('') +
      '<th>操作</th></tr>';
    $('#colgroup').innerHTML = colgroup;
    $('#theadRow').innerHTML = thead;
    document.querySelector('table').style.minWidth = ds.minWidth + 'px';

    $('#headSub').textContent = ds.label + ' · 云端直写';
    $('#search').placeholder = '搜索' + (dsKey === 'labs' ? '高校 / 实验室 / 人物…' : '公司名…');
    $('#addBtn').textContent = ds.addLabel;
    document.title = '数据管理 · ' + ds.label;
  }

  // ---------- 加载 ----------
  function reload() {
    dirty.clear(); pendingNew = null;
    setStatus('', '加载中…');
    db.from(ds.table).select('*').order(ds.orderCol, { ascending: ds.asc, nullsFirst: false })
      .then(function (res) {
        if (res.error) { setStatus('err', '读取失败：' + res.error.message); return; }
        rows = res.data || [];
        original = {};
        rows.forEach(function (r) { original[r.id] = JSON.stringify(pick(r)); });
        setStatus('ok', '已加载 ' + rows.length + ' 行（' + ds.label + ' · 云端实时数据）');
        render();
      })
      .catch(function (e) { setStatus('err', '读取失败：' + (e.message || e)); });
  }

  function pick(r) {
    var o = {};
    ds.fields.forEach(function (f) { o[f.k] = r[f.k] === undefined ? null : r[f.k]; });
    return o;
  }

  // ---------- 渲染 ----------
  function visibleRows() {
    var q = $('#search').value.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(function (r) {
      return ds.searchKeys.some(function (k) {
        return String(r[k] || '').toLowerCase().indexOf(q) > -1;
      });
    });
  }

  function cellHtml(f, r) {
    var v = r[f.k] === null || r[f.k] === undefined ? '' : r[f.k];
    if (f.type === 'select') {
      var labels = f.labels || f.opts;
      var opts = f.opts.slice();
      var lbls = labels.slice();
      // 兜底：当前值不在选项里时（如历史遗留取值），追加一项以防保存时被清空
      if (v !== '' && opts.indexOf(String(v)) === -1) { opts.push(String(v)); lbls.push(String(v)); }
      var html = opts.map(function (o, i) {
        return '<option value="' + esc(o) + '"' + (String(v) === String(o) ? ' selected' : '') + '>' + esc(lbls[i]) + '</option>';
      }).join('');
      return '<select data-k="' + f.k + '">' + html + '</select>';
    }
    if (f.type === 'bool') {
      var on = v === true || v === 'true';
      var bhtml = '<option value=""' + (!on ? ' selected' : '') + '>否</option>' +
                  '<option value="true"' + (on ? ' selected' : '') + '>是</option>';
      return '<select data-k="' + f.k + '">' + bhtml + '</select>';
    }
    if (f.type === 'num') {
      return '<input type="number" step="any" data-k="' + f.k + '" value="' + esc(v) + '">';
    }
    if (f.type === 'textarea') {
      return '<textarea rows="2" data-k="' + f.k + '">' + esc(v) + '</textarea>';
    }
    return '<input type="text" data-k="' + f.k + '" value="' + esc(v) + '">';
  }

  function render() {
    var list = visibleRows();
    var html = '';

    if (pendingNew) {
      html += '<tr data-new="1">' +
        '<td class="idc muted">新增</td>' +
        ds.fields.map(function (f) { return '<td>' + cellHtml(f, pendingNew) + '</td>'; }).join('') +
        '<td><div class="row-ops"><button class="btn primary" data-act="insert">保存</button>' +
        '<button class="btn" data-act="cancel-new">取消</button></div></td></tr>';
    }

    html += list.map(function (r) {
      var cls = dirty.has(r.id) ? ' class="dirty"' : '';
      return '<tr data-id="' + r.id + '"' + cls + '>' +
        '<td class="idc">' + r.id + '</td>' +
        ds.fields.map(function (f) { return '<td>' + cellHtml(f, r) + '</td>'; }).join('') +
        '<td><div class="row-ops"><button class="btn" data-act="save"' + (dirty.has(r.id) ? '' : ' disabled') + '>保存</button>' +
        '<button class="btn danger" data-act="del">删</button></div></td></tr>';
    }).join('');

    $('#tbody').innerHTML = html || '<tr><td colspan="' + (ds.fields.length + 2) + '" style="padding:20px;text-align:center" class="muted">无匹配记录</td></tr>';
    $('#countInfo').textContent = list.length + ' / ' + rows.length + ' ' + ds.unit + (dirty.size ? ' · ' + dirty.size + ' 行未保存' : '');
    $('#saveAllBtn').disabled = dirty.size === 0;
  }

  // ---------- 编辑事件（委托） ----------
  function bindTable() {
    $('#tbody').addEventListener('input', onEdit);
    $('#tbody').addEventListener('change', onEdit);
    $('#tbody').addEventListener('click', onAction);
  }

  function onEdit(e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    var k = e.target.getAttribute('data-k');
    if (!k) return;

    if (tr.dataset.new) {
      pendingNew[k] = e.target.value;
      return;
    }
    var id = Number(tr.dataset.id);
    var row = rows.find(function (r) { return r.id === id; });
    if (!row) return;
    row[k] = e.target.value === '' ? null : e.target.value;

    if (JSON.stringify(pick(row)) !== original[id]) dirty.add(id);
    else dirty.delete(id);
    tr.classList.toggle('dirty', dirty.has(id));
    tr.querySelector('[data-act="save"]').disabled = !dirty.has(id);
    $('#countInfo').textContent = visibleRows().length + ' / ' + rows.length + ' ' + ds.unit + (dirty.size ? ' · ' + dirty.size + ' 行未保存' : '');
    $('#saveAllBtn').disabled = dirty.size === 0;
  }

  function onAction(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var tr = btn.closest('tr');
    var act = btn.dataset.act;

    if (act === 'cancel-new') { pendingNew = null; render(); return; }
    if (act === 'insert') { insertNew(tr); return; }
    if (act === 'save') { saveRow(tr, Number(tr.dataset.id), btn); return; }
    if (act === 'del') { delRow(Number(tr.dataset.id), btn); }
  }

  // ---------- 保存 ----------
  function payloadOf(tr) {
    var p = {};
    ds.fields.forEach(function (f) {
      var input = tr.querySelector('[data-k="' + f.k + '"]');
      var v = input ? input.value : '';
      if (f.type === 'num') p[f.k] = v === '' ? null : Number(v);
      else if (f.type === 'bool') p[f.k] = v === 'true';
      else p[f.k] = v === '' ? null : v;
    });
    return p;
  }

  function nameOf(payload, id) {
    return payload[ds.nameKey] || (id != null ? 'id=' + id : '未命名');
  }

  function saveRow(tr, id, btn) {
    var payload = payloadOf(tr);
    if (!payload[ds.nameKey]) { setStatus('err', ds.reqLabel + '不能为空'); return; }
    if (btn) btn.textContent = '…';
    tr.classList.add('saving');
    db.from(ds.table).update(payload).eq('id', id).then(function (res) {
      tr.classList.remove('saving');
      if (btn) btn.textContent = '保存';
      if (res.error) { setStatus('err', '保存失败 (id=' + id + ')：' + res.error.message); return; }
      original[id] = JSON.stringify(pick(Object.assign({ id: id }, payload)));
      dirty.delete(id);
      tr.classList.remove('dirty');
      $('#countInfo').textContent = visibleRows().length + ' / ' + rows.length + ' ' + ds.unit + (dirty.size ? ' · ' + dirty.size + ' 行未保存' : '');
      $('#saveAllBtn').disabled = dirty.size === 0;
      setStatus('ok', '已保存 id=' + id + '「' + nameOf(payload, id) + '」→ 前台刷新即可见');
    }).catch(function (e) {
      tr.classList.remove('saving');
      if (btn) btn.textContent = '保存';
      setStatus('err', '保存失败：' + (e.message || e));
    });
  }

  function saveAll() {
    var ids = Array.from(dirty);
    if (!ids.length) return;
    setStatus('', '正在保存 ' + ids.length + ' 行…');
    var jobs = ids.map(function (id) {
      var tr = $('#tbody tr[data-id="' + id + '"]');
      var payload = payloadOf(tr);
      return db.from(ds.table).update(payload).eq('id', id).then(function (res) {
        if (res.error) throw new Error('id=' + id + ' ' + res.error.message);
        original[id] = JSON.stringify(pick(Object.assign({ id: id }, payload)));
        dirty.delete(id);
        var tr2 = $('#tbody tr[data-id="' + id + '"]');
        if (tr2) tr2.classList.remove('dirty');
      });
    });
    Promise.all(jobs).then(function () {
      setStatus('ok', '已保存 ' + ids.length + ' 行 → 前台刷新即可见');
      render();
    }).catch(function (e) {
      setStatus('err', '部分保存失败：' + (e.message || e) + '（未保存的行仍标黄）');
      render();
    });
  }

  // ---------- 新增 ----------
  function addRow() {
    pendingNew = {};
    ds.fields.forEach(function (f) { pendingNew[f.k] = null; });
    render();
    var tr = $('#tbody tr[data-new]');
    if (tr) tr.querySelector('input[type="text"]').focus();
  }

  function insertNew(tr) {
    var payload = payloadOf(tr);
    if (!payload[ds.nameKey]) { setStatus('err', '新增至少要填「' + ds.reqLabel + '」'); return; }
    setStatus('', '正在新增…');
    db.from(ds.table).insert(payload).then(function (res) {
      if (res.error) { setStatus('err', '新增失败：' + res.error.message); return; }
      pendingNew = null;
      setStatus('ok', '已新增「' + nameOf(payload) + '」→ 前台刷新即可见');
      reload();
    }).catch(function (e) { setStatus('err', '新增失败：' + (e.message || e)); });
  }

  // ---------- 删除 ----------
  function delRow(id, btn) {
    var row = rows.find(function (r) { return r.id === id; });
    var name = row ? (row[ds.nameKey] || ('id=' + id)) : ('id=' + id);
    if (!confirm('确定删除「' + name + '」？')) return;
    if (!confirm('再次确认：删除后前台榜单将不再显示该条目，且不可恢复。')) return;
    setStatus('', '正在删除…');
    db.from(ds.table).delete().eq('id', id).then(function (res) {
      if (res.error) { setStatus('err', '删除失败：' + res.error.message); return; }
      dirty.delete(id);
      setStatus('ok', '已删除「' + name + '」');
      reload();
    }).catch(function (e) { setStatus('err', '删除失败：' + (e.message || e)); });
  }

  // ---------- 启动 ----------
  bindGate();
  bindTable();
})();

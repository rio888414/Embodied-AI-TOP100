/* ============================================================
   具身智能融资雷达 · 应用逻辑
   数据全部从云数据库实时读取，前端不含任何硬编码业务数据
   ============================================================ */

(function () {
  'use strict';

  // ---------- 云服务客户端 ----------
  let cloud = null;

  function initCloud() {
    const cfg = window.CLOUD_CONFIG || {};
    if (!window.WorkBuddyCloud) {
      throw new Error('云服务 SDK 加载失败，请检查网络后刷新页面。');
    }
    if (!cfg.endpoint || !cfg.publishableKey) {
      throw new Error('云服务配置缺失（endpoint / publishableKey）。');
    }
    return window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey
    });
  }

  // ---------- 状态 ----------
  const state = {
    companies: [],
    events: [],
    labs: null,          // 云端 labs 数据；null 表示未取到，渲染时回退静态 LAB_RANKING
    sortBy: 'valuation',
    eventView: 'timeline',
    activeLayer: null,
    onlyPartner: false,
    drillCompanies: [],
    filters: {
      time: 'all', round: 'all', layer: 'all',
      country: 'all', amount: 'all', strategic: false, q: ''
    }
  };

  // ---------- 工具 ----------
  const $ = (sel) => document.querySelector(sel);

  function setStatus(mode, text) {
    const dot = $('#statusDot');
    dot.className = 'dot' + (mode ? ' ' + mode : '');
    $('#statusText').textContent = text;
  }

  function fmt(n, digits) {
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString('zh-CN', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  // 金额展示：≥1 万亿显示万亿，≥1 亿显示亿元，否则亿元保留两位
  function fmtYi(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!isFinite(n)) return null;
    if (n >= 10000) return (n / 10000).toFixed(2).replace(/\.00$/, '') + ' 万亿元';
    if (n >= 1) return n.toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, '') + ' 亿元';
    return n.toFixed(2) + ' 亿元';
  }

  // 原始币种展示
  function fmtOriginal(amount, currency) {
    if (amount === null || amount === undefined) return null;
    const n = Number(amount);
    if (!isFinite(n)) return null;
    const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥';
    return sym + n.toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, '') + (currency === 'USD' || currency === 'EUR' ? 'B' : ' 亿');
  }

  function daysAgo(dateStr) {
    if (!dateStr) return Infinity;
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return Infinity;
    return (Date.now() - d.getTime()) / 86400000;
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- 生态关系 ----------
  // relation: 'partner' = 智元生态伙伴；'self'（智元本体）不参与渲染 —— 平台即站在智元视角，无需自我标注
  const REL_LABEL = { partner: '智元生态' };

  function relationOf(c) {
    const r = c && c.relation;
    return r === 'partner' ? 'partner' : null;
  }

  // 关系徽标：青色描边胶囊（不填充，避免与 NEW 标签争抢注意力）
  function relTag(c) {
    const r = relationOf(c);
    if (!r) return '';
    return `<span class="rel-tag ${r}">${REL_LABEL[r]}</span>`;
  }

  // 关系圆点：用于领奖台、下钻卡片等紧凑场景
  function relDot(c) {
    const r = relationOf(c);
    if (!r) return '';
    return `<span class="rel-dot ${r}" title="${REL_LABEL[r]}"></span>`;
  }

  // ---------- 每月变化标记 ----------
  // daily_change: 'new' | 'up' | 'down' | null
  // 规则：只显示 new（本月新进）和 up（排名上升），down/null 不显示
  function dailyChangeTag(c) {
    const dc = c && c.daily_change;
    if (dc === 'new') return `<span class="change-tag new">NEW</span>`;
    if (dc === 'up' && c.daily_change_value) return `<span class="change-tag up">↑${fmt(Number(c.daily_change_value))}</span>`;
    return '';
  }

  // 用于领奖台/下钻的紧凑变化标记
  function dailyChangeDot(c) {
    const dc = c && c.daily_change;
    if (!dc || dc === 'down') return '';
    const title = dc === 'new' ? '本月新进' : `排名上升 ${c.daily_change_value} 位`;
    return `<span class="change-dot ${dc}" title="${title}"></span>`;
  }

  function layerClass(layer) {
    return {
      '本体层': 'var(--layer-body)',
      '模型层': 'var(--layer-model)',
      '基建层': 'var(--layer-infra)'
    }[layer] || 'var(--text-3)';
  }

  // ---------- 排序：估值优先，融资额兜底 ----------
  function sortCompanies(list, basis) {
    const arr = list.slice();
    arr.sort((a, b) => {
      if (basis === 'funding') {
        const av = a.total_funding_cny_yi, bv = b.total_funding_cny_yi;
        if (av === null && bv === null) return (a.valuation_cny_yi ?? -1) - (b.valuation_cny_yi ?? -1);
        if (av === null) return 1;
        if (bv === null) return -1;
        if (bv !== av) return bv - av;
        return (b.valuation_cny_yi ?? -1) - (a.valuation_cny_yi ?? -1);
      }
      // 默认：估值优先 → 融资额兜底 → 皆缺排末尾
      const av = a.valuation_cny_yi, bv = b.valuation_cny_yi;
      const aHas = av !== null && av !== undefined;
      const bHas = bv !== null && bv !== undefined;
      if (aHas && bHas && bv !== av) return bv - av;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      // 估值相同或都缺失 → 比累计融资额
      const af = a.total_funding_cny_yi, bf = b.total_funding_cny_yi;
      const afHas = af !== null && af !== undefined;
      const bfHas = bf !== null && bf !== undefined;
      if (afHas && bfHas && bf !== af) return bf - af;
      if (afHas && !bfHas) return -1;
      if (!afHas && bfHas) return 1;
      return (a.id || 0) - (b.id || 0);
    });
    return arr;
  }

  // ---------- 数据加载 ----------
  // 优先走云数据平面；一旦失败（网络 / 凭据 / 网关异常），
  // 自动降级到内置快照，保证任何打开链接的人都能看到完整页面。
  let dataSource = 'cloud';

  function useSnapshot(reason) {
    const co = window.SNAPSHOT_COMPANIES || [];
    const ev = window.SNAPSHOT_EVENTS || [];
    if (!co.length) return false;

    state.companies = co;
    state.events = ev;
    dataSource = 'snapshot';
    setStatus('warn', '内置快照 · 实时同步中');
    console.warn('[radar] 降级为内置快照：', reason);
    return true;
  }

  async function loadAll() {
    setStatus('load', '正在读取数据…');

    const [coRes, evRes] = await Promise.all([
      cloud.database.from('companies').select('*').order('id', { ascending: true }),
      cloud.database.from('funding_events').select('*').order('announced_date', { ascending: false })
    ]);

    if (coRes.error) throw coRes.error;
    if (evRes.error) throw evRes.error;

    state.companies = coRes.data || [];
    state.events = evRes.data || [];

    // 具身LAB：独立加载，失败不阻塞主榜（回退静态 lab-data.js）
    try {
      const labRes = await cloud.database.from('labs').select('*').order('rank', { ascending: true });
      state.labs = labRes.error ? null : (labRes.data || []);
      if (state.labs && !state.labs.length) state.labs = null;
    } catch (e) {
      console.warn('[radar] labs 加载失败，回退静态数据', e);
      state.labs = null;
    }

    // 云端返回空集也视为不可用，回退快照
    if (!state.companies.length) {
      if (useSnapshot('云端返回空数据集')) return;
    }

    dataSource = 'cloud';
    setStatus('ok', '数据已同步');
    $('#footUpdate').textContent = new Date().toISOString().slice(0, 10);
  }

  // ---------- 统计条 ----------
  function renderStats() {
    const total = state.companies.length;
    const valued = state.companies.filter(c => c.valuation_cny_yi !== null && c.valuation_cny_yi !== undefined);
    const fundingSum = state.companies.reduce((s, c) => s + (Number(c.total_funding_cny_yi) || 0), 0);
    const recent = state.events.filter(e => daysAgo(e.announced_date) <= 30).length;
    const hundredYi = valued.filter(c => Number(c.valuation_cny_yi) >= 100).length;
    const partners = state.companies.filter(c => relationOf(c) === 'partner').length;

    const items = [
      { label: '追踪公司', value: fmt(total), unit: '家' },
      { label: '追踪累计融资额', value: '¥' + fmt(fundingSum), unit: '亿元' },
      { label: '近 30 天新增事件', value: fmt(recent), unit: '笔' },
      { label: '百亿估值俱乐部', value: fmt(hundredYi), unit: '家', gold: true },
      { label: '智元生态伙伴', value: fmt(partners), unit: '家', partner: true }
    ];

    $('#stats').innerHTML = items.map(it => `
      <div class="stat">
        <div class="stat-label">${esc(it.label)}</div>
        <div class="stat-value tabular ${it.gold ? 'gold' : ''}${it.partner ? 'partner' : ''}">${it.value}<span class="stat-unit">${esc(it.unit)}</span></div>
      </div>
    `).join('');
  }

  // ---------- 领奖台：前三名 ----------
  function renderPodium(list) {
    const host = $('#podium');
    if (!host) return;
    const top = list.slice(0, 3);
    if (!top.length) { host.innerHTML = ''; return; }

    const maxVal = Math.max(...list.map(c => Number(c.valuation_cny_yi) || 0), 1);

    host.innerHTML = top.map((c, i) => {
      const valYi = c.valuation_cny_yi === null || c.valuation_cny_yi === undefined
        ? null : Number(c.valuation_cny_yi);
      const pct = valYi === null ? 0 : Math.max(2, (valYi / maxVal) * 100);
      const rankNo = ['01', '02', '03'][i];
      const rel = relationOf(c);
      const cls = `pod p${i + 1}` + (rel ? ' is-' + rel : '');

      const badge = c.is_public
        ? '<span class="pod-badge gold">已上市</span>'
        : (c.listing_status && c.listing_status !== 'pre-ipo'
            ? '<span class="pod-badge gold">IPO 推进中</span>'
            : '<span class="pod-badge">一级市场</span>');

      const valText = valYi === null
        ? '<span class="muted">未披露</span>'
        : `${fmtYi(valYi).replace(' 亿元', '')}<span class="pod-val-unit">亿元</span>`;

      const barColor = i === 0 ? 'var(--gold)' : i === 1 ? 'var(--text-2)' : 'var(--orange)';

      return `
        <div class="${cls}">
          <div class="pod-rank">
            <span class="pod-no">NO.${rankNo}</span>
            ${badge}
          </div>
          <div class="pod-name">${esc(c.name_cn)}${relDot(c)}</div>
          <div class="pod-meta">${esc(c.country || '')} · ${esc(c.segment || '')}</div>
          <div class="pod-val tabular">${valText}</div>
          <div class="pod-bar"><i style="width:${pct}%;background:${barColor}"></i></div>
          <div class="pod-sub">${esc(c.latest_round || '—')} · 累计融资 ${c.total_funding_cny_yi != null ? fmtYi(Number(c.total_funding_cny_yi)) : '未披露'}</div>
        </div>
      `;
    }).join('');
  }

  // ---------- 估值榜 ----------
  function renderRank() {
    const all = sortCompanies(state.companies, state.sortBy);
    // 「仅看生态伙伴」：只保留与智元有合作的公司，排序规则不变
    const sorted = state.onlyPartner
      ? all.filter(c => relationOf(c) === 'partner')
      : all;
    const body = $('#rankBody');

    renderPodium(all);
    renderLegend(all);

    if (!sorted.length) {
      body.innerHTML = '<tr><td colspan="8" class="loading">暂无数据</td></tr>';
      return;
    }

    const maxVal = Math.max(...all.map(c => Number(c.valuation_cny_yi) || 0), 1);

    // 名次取全量榜位次：生态视图下仍显示真实排名（如 #91），而非重新编号
    const rankOf = new Map();
    all.forEach((c, i) => rankOf.set(c, i + 1));

    body.innerHTML = sorted.map((c) => {
      const rank = rankOf.get(c);
      const valYi = c.valuation_cny_yi === null || c.valuation_cny_yi === undefined ? null : Number(c.valuation_cny_yi);
      const fundYi = c.total_funding_cny_yi === null || c.total_funding_cny_yi === undefined ? null : Number(c.total_funding_cny_yi);
      const undisclosed = valYi === null;

      const valCell = undisclosed
        ? '<span class="muted">未披露</span>'
        : `<span class="val-main">${fmtYi(valYi)}</span><div class="val-sub">${esc(c.valuation_note || '')}</div>`;

      const fundCell = fundYi === null
        ? '<span class="muted">—</span>'
        : fmtYi(fundYi);

      const listingTag = c.is_public
        ? `<span class="co-tag gold">${c.listing_status === 'listed' ? '已上市' : 'IPO 中'}</span>`
        : (c.listing_status && c.listing_status !== 'pre-ipo'
            ? `<span class="co-tag gold">IPO 推进中</span>` : '');

      const verifyTag = c.verify_status === 'pending-verify'
        ? '<span class="co-tag">待核实</span>' : '';

      // 名次强度条：前 3 名金色，前 10 名次亮，其余暗
      const intensity = valYi === null ? 0 : (valYi / maxVal);
      const tickColor = rank <= 3 ? 'var(--gold)'
        : rank <= 10 ? 'var(--line-strong)'
        : 'var(--surface-4)';

      const rel = relationOf(c);
      const rowCls = [undisclosed ? 'is-undisclosed' : '', rel ? 'is-' + rel : '']
        .filter(Boolean).join(' ');

      return `
        <tr class="${rowCls}">
          <td class="c-rank">
            <div class="rank-cell">
              <span class="rank-tick" style="background:${tickColor};opacity:${Math.max(.35, intensity)}"></span>
              <span class="rank-no">${String(rank).padStart(2, '0')}</span>
            </div>
          </td>
          <td class="c-company">
            <div class="co-name">${esc(c.name_cn)}${dailyChangeTag(c)}${relTag(c)}${listingTag}${verifyTag}</div>
            <div class="co-meta">${esc(c.country || '')} · ${esc(c.segment || '')}</div>
          </td>
          <td class="c-core">
            <div class="core-text">${esc(c.core_advantage || c.business_intro || '—')}</div>
            ${c.core_product ? `<div class="core-product">核心产品 · ${esc(c.core_product)}</div>` : ''}
          </td>
          <td class="c-val">${valCell}</td>
          <td class="c-fund">${fundCell}</td>
          <td class="c-round"><span class="chip">${esc(c.latest_round || '—')}</span></td>
          <td class="c-lead hide-sm">${esc(c.lead_investors || '—')}</td>
          <td class="c-region hide-sm">${esc(c.region || c.country || '—')}</td>
        </tr>
      `;
    }).join('');

    const scope = state.onlyPartner
      ? `生态视图 ${sorted.length} 家 · 排序与全量榜一致`
      : `共 ${sorted.length} 家公司 · 金额统一折算为人民币亿元`;
    $('#rankFoot').innerHTML = `
      <span>${scope}</span>
      <span class="foot-rule">排序规则：按<b>估值</b>降序 · 估值未披露的公司按<b>累计融资额</b>降序排列 · 金额统一折算为人民币亿元</span>
      <span>数据来自公开报道与第三方机构，仅供参考</span>
    `;
  }

  // ---------- 图例与「仅看生态伙伴」开关 ----------
  function renderLegend(list) {
    const partners = list.filter(c => relationOf(c) === 'partner').length;
    const el = $('#legendPartnerCount');
    if (el) el.textContent = fmt(partners);

    const btn = $('#partnerToggle');
    if (btn) btn.classList.toggle('is-active', state.onlyPartner);
  }

  // ---------- 事件流筛选 ----------
  function filteredEvents() {
    const f = state.filters;
    return state.events.filter(e => {
      if (f.time !== 'all' && daysAgo(e.announced_date) > Number(f.time)) return false;
      if (f.layer !== 'all' && e.segment_layer !== f.layer) return false;

      if (f.round !== 'all') {
        const r = String(e.round || '');
        if (f.round === '天使') { if (!/天使|种子/.test(r)) return false; }
        else if (f.round === '战略') { if (!/战略|其他|SPAC|IPO|Pre-IPO/i.test(r)) return false; }
        else if (!new RegExp('^' + f.round, 'i').test(r.replace(/\s/g, ''))) return false;
      }

      if (f.country !== 'all') {
        const c = String(e.country || '');
        if (f.country === '中国' && c !== '中国') return false;
        if (f.country === '美国' && c !== '美国') return false;
        if (f.country === '欧洲' && (c === '中国' || c === '美国')) return false;
      }

      if (f.amount !== 'all') {
        const a = Number(e.amount_cny_yi);
        if (!isFinite(a) || a < Number(f.amount)) return false;
      }

      if (f.strategic && !e.has_strategic_investor) return false;

      if (f.q) {
        const hay = [e.company_name, e.lead_investors, e.follow_investors, e.highlight]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  function renderEvents() {
    const list = filteredEvents();
    const body = $('#eventsBody');

    $('#eventsSub').textContent = `按公告日倒序 · 当前 ${list.length} / ${state.events.length} 条`;

    if (!list.length) {
      body.className = 'events-body';
      body.innerHTML = '<div class="empty-hint">没有符合条件的事件，试试放宽筛选。</div>';
      $('#eventsFoot').innerHTML = '';
      return;
    }

    if (state.eventView === 'card') {
      body.className = 'ev-cards';
      body.innerHTML = list.map(e => {
        const est = e.amount_is_estimate;
        const amtTxt = e.amount_text || (e.amount_cny_yi ? fmtYi(Number(e.amount_cny_yi)) : '未披露');
        return `
          <div class="ev-card">
            <div class="ev-card-top">
              <div>
                <div class="co-name">${esc(e.company_name)}</div>
                <div class="co-meta">${esc(e.announced_date || '')} · ${esc(e.round || '')}</div>
              </div>
              <div class="ev-card-amount ${est ? 'est' : ''}">${esc(amtTxt)}</div>
            </div>
            <div class="ev-line">${esc(e.highlight || '')}</div>
            <div class="ev-inv">领投：${esc(e.lead_investors || '—')}</div>
          </div>
        `;
      }).join('');
    } else {
      body.className = 'events-body';
      body.innerHTML = list.map(e => {
        const d = e.announced_date || '';
        const parts = d ? d.split('-') : ['', '', ''];
        const est = e.amount_is_estimate;
        const amtTxt = e.amount_text || (e.amount_cny_yi ? fmtYi(Number(e.amount_cny_yi)) : '未披露');
        const valTxt = e.valuation_cny_yi
          ? '投后 ' + fmtYi(Number(e.valuation_cny_yi))
          : '未披露估值';
        return `
          <div class="ev-row">
            <div class="ev-date">
              <div class="ev-date-d">${esc(parts[1] ? parts[1] + '-' + parts[2] : '')}</div>
              <div class="ev-date-y">${esc(parts[0] || '')}</div>
            </div>
            <div class="ev-axis"><div class="ev-node ${est ? '' : 'hot'}"></div></div>
            <div class="ev-main">
              <div class="ev-head">
                <span class="ev-company">${esc(e.company_name)}</span>
                <span class="ev-round-tag">${esc(e.round || '轮次未披露')}</span>
                <span class="co-tag">${esc(e.segment_layer || '')}</span>
                ${e.has_strategic_investor ? '<span class="co-tag gold">产业战投</span>' : ''}
              </div>
              <div class="ev-line">${esc(e.country || '')}${e.highlight ? ' · ' + esc(e.highlight) : ''}</div>
              <div class="ev-inv">领投 ${esc(e.lead_investors || '—')}${e.follow_investors ? ' · 跟投 ' + esc(e.follow_investors) : ''}</div>
            </div>
            <div class="ev-right">
              <div class="ev-amount ${est ? 'est' : ''}">${esc(amtTxt)}</div>
              <div class="ev-val">${esc(valTxt)}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    const estCount = list.filter(e => e.amount_is_estimate).length;
    $('#eventsFoot').innerHTML = `
      <span>共 ${list.length} 条${estCount ? ` · 其中 ${estCount} 条为模糊金额（金色标注）` : ''}</span>
      <span>金额统一折算为人民币亿元</span>
    `;
  }

  // ---------- 赛道分层 ----------
  // 平台只收录三层：本体层 / 模型层 / 基建层（零件层不纳入统计）
  const LAYERS = ['本体层', '模型层', '基建层'];

  function layerStats() {
    const base = LAYERS;
    const map = {};
    base.forEach(l => { map[l] = { layer: l, sum: 0, count: 0, companies: [] }; });

    state.companies.forEach(c => {
      const l = c.segment_layer;
      if (!map[l]) return;
      const v = Number(c.total_funding_cny_yi) || 0;
      map[l].sum += v;
      map[l].count += 1;
      map[l].companies.push(c);
    });

    const total = base.reduce((s, l) => s + map[l].sum, 0) || 1;
    return base.map(l => ({ ...map[l], share: map[l].sum / total * 100 }));
  }

  function renderLayers() {
    const stats = layerStats();
    const desc = {
      '本体层': '人形 / 双足 / 四足机器人整机',
      '模型层': '具身大模型 / VLA / 世界模型',
      '基建层': '运动控制 / 仿真 / 数据采集'
    };

    $('#layers').innerHTML = stats.map(s => {
      const top = s.companies
        .slice()
        .sort((a, b) => (Number(b.valuation_cny_yi) || 0) - (Number(a.valuation_cny_yi) || 0))
        .slice(0, 4)
        .map(c => c.name_cn)
        .join(' · ');
      const lc = layerClass(s.layer);
      return `
        <div class="layer ${state.activeLayer === s.layer ? 'is-active' : ''}"
             data-layer="${esc(s.layer)}" style="--lc:${lc}">
          <div class="layer-top">
            <div class="layer-name"><span style="color:${lc}">●</span> ${esc(s.layer)}<span class="layer-desc">${esc(desc[s.layer] || '')}</span></div>
            <div class="layer-nums">
              <span>累计融资 <b>${fmt(s.sum)}</b> 亿元</span>
              <span>${s.count} 家</span>
              <span>${s.share.toFixed(1)}%</span>
            </div>
          </div>
          <div class="bar"><i style="width:${Math.max(s.share, 1.5)}%;background:${lc}"></i></div>
          <div class="layer-companies">代表：${esc(top || '暂无')}</div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.layer').forEach(el => {
      el.addEventListener('click', () => {
        const l = el.dataset.layer;
        state.activeLayer = state.activeLayer === l ? null : l;
        renderLayers();
        renderDrill();
      });
    });
  }

  function renderDrill() {
    const panel = $('#drillBody');
    const closeBtn = $('#drillClose');

    if (!state.activeLayer) {
      $('#drillTitle').textContent = '下钻结果';
      $('#drillSub').textContent = '点击上方任一分层查看该赛道公司';
      panel.innerHTML = '<div class="empty-hint">尚未选择分层</div>';
      closeBtn.style.display = 'none';
      return;
    }

    const list = sortCompanies(
      state.companies.filter(c => c.segment_layer === state.activeLayer),
      'valuation'
    );

    $('#drillTitle').textContent = state.activeLayer + ' · 共 ' + list.length + ' 家公司';
    $('#drillSub').textContent = '按估值优先规则排序';
    closeBtn.style.display = 'inline-block';

    if (!list.length) {
      panel.innerHTML = '<div class="empty-hint">该分层暂无收录公司</div>';
      return;
    }

    panel.innerHTML = '<div class="drill-grid">' + list.map(c => {
      const v = c.valuation_cny_yi;
      const f = c.total_funding_cny_yi;
      return `
        <div class="drill-item${relationOf(c) ? ' is-' + relationOf(c) : ''}">
          <div class="drill-co">${esc(c.name_cn)}${relDot(c)}</div>
          <div class="drill-num">估值 ${v ? fmtYi(Number(v)) : '未披露'}</div>
          <div class="drill-num">累计融资 ${f ? fmtYi(Number(f)) : '未披露'}</div>
          <div class="drill-num">${esc(c.latest_round || '')} · ${esc(c.region || c.country || '')}</div>
        </div>
      `;
    }).join('') + '</div>';
  }

  // ---------- 图表 ----------
  function chartBars(host, rows) {
    if (!rows.length) { host.innerHTML = '<div class="empty-hint">暂无数据</div>'; return; }
    const max = Math.max(...rows.map(r => r.value)) || 1;
    host.innerHTML = rows.map(r => `
      <div class="bar-row">
        <div class="bar-row-top"><span>${esc(r.label)}</span><span>${esc(r.text)}</span></div>
        <div class="bar"><i style="width:${Math.max(r.value / max * 100, 1.2)}%;background:${r.color || 'var(--gold)'}"></i></div>
      </div>
    `).join('');
  }

  function renderCharts() {
    // 月度趋势
    const byMonth = {};
    state.events.forEach(e => {
      if (!e.announced_date) return;
      const m = String(e.announced_date).slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + (Number(e.amount_cny_yi) || 0);
    });
    const months = Object.keys(byMonth).sort();
    const host = $('#chartMonthly');

    if (months.length < 2) {
      host.innerHTML = '<div class="empty-hint">数据点不足，无法绘制趋势</div>';
    } else {
      const W = 100, H = 100, pad = 6;
      const maxV = Math.max(...months.map(m => byMonth[m])) || 1;
      const step = (W - pad * 2) / (months.length - 1);
      const pts = months.map((m, i) => {
        const x = pad + i * step;
        const y = H - pad - (byMonth[m] / maxV) * (H - pad * 3);
        return { x, y, m, v: byMonth[m] };
      });
      const poly = pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

      host.innerHTML = `
        <svg class="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="月度融资额趋势">
          <line x1="0" y1="25" x2="100" y2="25" stroke="var(--line-soft)" stroke-width="0.3"/>
          <line x1="0" y1="50" x2="100" y2="50" stroke="var(--line-soft)" stroke-width="0.3"/>
          <line x1="0" y1="75" x2="100" y2="75" stroke="var(--line-soft)" stroke-width="0.3"/>
          <polyline points="${poly}" fill="none" stroke="var(--gold)" stroke-width="0.9"
                    vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-4);margin-top:8px">
          <span>${esc(months[0])}</span>
          <span>${esc(months[months.length - 1])}</span>
        </div>
        <div style="font-size:10.5px;color:var(--text-3);margin-top:8px">
          区间累计 ${fmt(months.reduce((s, m) => s + byMonth[m], 0))} 亿元 · 共 ${months.length} 个月
        </div>
      `;
    }

    // 轮次分布
    const roundBuckets = { '天使/种子': 0, 'A 轮系列': 0, 'B 轮系列': 0, 'C 轮系列': 0, '战略/其他': 0 };
    state.events.forEach(e => {
      const r = String(e.round || '');
      if (/天使|种子/.test(r)) roundBuckets['天使/种子']++;
      else if (/^A/i.test(r.replace(/\s/g, ''))) roundBuckets['A 轮系列']++;
      else if (/^B/i.test(r.replace(/\s/g, ''))) roundBuckets['B 轮系列']++;
      else if (/^C/i.test(r.replace(/\s/g, ''))) roundBuckets['C 轮系列']++;
      else roundBuckets['战略/其他']++;
    });
    chartBars($('#chartRounds'), Object.keys(roundBuckets).map((k, i) => ({
      label: k,
      value: roundBuckets[k],
      text: roundBuckets[k] + ' 笔',
      color: ['var(--purple)', 'var(--blue)', 'var(--cyan)', 'var(--gold)', 'var(--text-3)'][i]
    })));

    // 金额区间
    const amtBuckets = { '未披露': 0, '< 1 亿': 0, '1–10 亿': 0, '10–50 亿': 0, '≥ 50 亿': 0 };
    state.events.forEach(e => {
      const a = Number(e.amount_cny_yi);
      if (!isFinite(a)) amtBuckets['未披露']++;
      else if (a < 1) amtBuckets['< 1 亿']++;
      else if (a < 10) amtBuckets['1–10 亿']++;
      else if (a < 50) amtBuckets['10–50 亿']++;
      else amtBuckets['≥ 50 亿']++;
    });
    chartBars($('#chartAmounts'), Object.keys(amtBuckets).map((k, i) => ({
      label: k,
      value: amtBuckets[k],
      text: amtBuckets[k] + ' 笔',
      color: ['var(--text-3)', 'var(--purple)', 'var(--blue)', 'var(--cyan)', 'var(--gold)'][i]
    })));

    // 地区热力
    const byRegion = {};
    state.companies.forEach(c => {
      const r = c.country || '未知';
      byRegion[r] = (byRegion[r] || 0) + (Number(c.valuation_cny_yi) || 0);
    });
    const regionRows = Object.keys(byRegion)
      .map(k => ({ label: k, value: byRegion[k], text: fmt(byRegion[k]) + ' 亿元' }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map(r => ({ ...r, color: 'var(--blue)' }));
    chartBars($('#chartRegions'), regionRows);
  }

  // ---------- 具身LAB排名 ----------
  // 数据源：云端 labs 表（可在 /admin.html 编辑）；未取到时回退 lab-data.js 静态快照

  // 发表情况浮动提示：鼠标悬停在「论文得分」单元格时显示
  let pubTipBound = false;
  function bindPubTip() {
    const tip = $('#pubTip');
    const body = $('#labBody');
    if (!tip || !body || pubTipBound) return;
    pubTipBound = true;

    body.addEventListener('mouseover', e => {
      const cell = e.target.closest('.c-lab-score.has-pub');
      if (!cell) return;
      tip.textContent = cell.dataset.pub || '';
      tip.hidden = false;
    });
    body.addEventListener('mousemove', e => {
      if (tip.hidden) return;
      const cell = e.target.closest('.c-lab-score.has-pub');
      if (!cell) { tip.hidden = true; return; }
      const pad = 14;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });
    body.addEventListener('mouseout', e => {
      const cell = e.target.closest('.c-lab-score.has-pub');
      if (cell && !cell.contains(e.relatedTarget)) tip.hidden = true;
    });
  }

  function renderLab() {
    const data = state.labs || window.LAB_RANKING || [];
    const fromCloud = !!state.labs;
    const body = $('#labBody');
    if (!body) return;

    const countEl = $('#legendContactCount');
    if (countEl) countEl.textContent = fmt(data.filter(l => l.contact).length);

    if (!data.length) {
      body.innerHTML = '<tr><td colspan="9" class="loading">暂无实验室数据</td></tr>';
      return;
    }

    body.innerHTML = data.map(l => {
      const cite = l.citations === null || l.citations === undefined
        ? '<span class="muted">—</span>'
        : fmt(Number(l.citations));
      const score = l.score === null || l.score === undefined
        ? '<span class="muted">—</span>'
        : `<span class="lab-score tabular">${fmt(Number(l.score))}</span>`;

      // 名次强度条：前 3 金色，前 10 次亮；rank 缺失时用 id 兜底
      const rk = (l.rank === null || l.rank === undefined) ? (l.id || 99) : Number(l.rank);
      const tickColor = rk <= 3 ? 'var(--gold)' : rk <= 10 ? 'var(--line-strong)' : 'var(--surface-4)';
      const personLines = String(l.person || '—').split('\n').map(s => s.trim()).filter(Boolean).join(' / ');
      const pub = String(l.publications || '').replace(/\s*\n+\s*/g, ' ').trim();

      return `
        <tr class="${l.contact ? 'is-contact' : ''}" ${l.contact ? `title="${esc(l.contact_note)}"` : ''}>
          <td class="c-lab-rank">
            <div class="rank-cell">
              <span class="rank-tick" style="background:${tickColor}"></span>
              <span class="rank-no">${String(rk).padStart(2, '0')}</span>
            </div>
          </td>
          <td class="c-lab-name">
            <div class="lab-uni">${esc(l.university)}</div>
            <div class="lab-name">${esc(l.lab)}</div>
            ${l.contact ? '<span class="lab-contact-tag">已建联</span>' : ''}
          </td>
          <td class="c-lab-person"><div class="lab-person">${esc(personLines)}</div></td>
          <td class="c-lab-cite">${cite}</td>
          <td class="c-lab-pintro"><div class="lab-text">${esc(l.person_intro || '—')}</div></td>
          <td class="c-lab-intro"><div class="lab-text">${esc(l.lab_intro || '—')}</div></td>
          <td class="c-lab-score${pub ? ' has-pub' : ''}" ${pub ? `data-pub="${esc(pub)}"` : ''}>${score}</td>
          <td class="c-lab-site hide-sm">${l.website ? `<a class="lab-link" href="${esc(l.website)}" target="_blank" rel="noopener">访问 ↗</a>` : '<span class="muted">—</span>'}</td>
        </tr>
      `;
    }).join('');

    bindPubTip();

    const contactN = data.filter(l => l.contact).length;
    const updatedAt = fromCloud
      ? new Date().toISOString().slice(0, 10) + '（云端实时）'
      : ((window.LAB_META || {}).generatedAt || '—');
    $('#labFoot').innerHTML = `
      <span>共 ${data.length} 家实验室 · 已建联 ${contactN} 家</span>
      <span>数据来自公开学术信息整理，仅供参考 · 最近更新 ${updatedAt}</span>
    `;
  }

  // ---------- 视图切换 ----------
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('is-active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
        btn.classList.add('is-active');
        $('#view-' + btn.dataset.view).classList.add('is-active');
      });
    });
  }

  function bindControls() {
    document.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.eventView = btn.dataset.ev;
        renderEvents();
      });
    });

    const map = {
      fTime: 'time', fRound: 'round', fLayer: 'layer',
      fCountry: 'country', fAmount: 'amount'
    };
    Object.keys(map).forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', () => {
        state.filters[map[id]] = el.value;
        renderEvents();
      });
    });

    $('#fStrategic').addEventListener('change', e => {
      state.filters.strategic = e.target.checked;
      renderEvents();
    });

    let t = null;
    $('#fSearch').addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.filters.q = e.target.value.trim();
        renderEvents();
      }, 200);
    });

    $('#fReset').addEventListener('click', () => {
      state.filters = { time: 'all', round: 'all', layer: 'all', country: 'all', amount: 'all', strategic: false, q: '' };
      $('#fTime').value = 'all';
      $('#fRound').value = 'all';
      $('#fLayer').value = 'all';
      $('#fCountry').value = 'all';
      $('#fAmount').value = 'all';
      $('#fStrategic').checked = false;
      $('#fSearch').value = '';
      renderEvents();
    });

    $('#drillClose').addEventListener('click', () => {
      state.activeLayer = null;
      renderLayers();
      renderDrill();
    });

    const pToggle = $('#partnerToggle');
    if (pToggle) {
      pToggle.addEventListener('click', () => {
        state.onlyPartner = !state.onlyPartner;
        $('#partnerToggleText').textContent = state.onlyPartner ? '显示全部公司' : '仅看生态伙伴';
        renderRank();
      });
    }
  }

  // ---------- 启动 ----------
  async function boot() {
    bindTabs();
    bindControls();

    try {
      cloud = initCloud();
    } catch (err) {
      // SDK 或配置不可用 → 直接走内置快照，页面依然完整
      console.warn('[radar] initCloud failed', err);
      cloud = null;
    }

    try {
      if (cloud) {
        await loadAll();
      } else {
        throw new Error('云服务初始化失败');
      }
    } catch (err) {
      console.error('[radar] load failed', err);
      if (!useSnapshot(err.message || '未知错误')) {
        setStatus('err', '数据读取失败');
        $('#rankBody').innerHTML =
          `<tr><td colspan="8" class="error-box">数据读取失败：${esc(err.message || '未知错误')}</td></tr>`;
        return;
      }
    }

    // 无论数据来自云端还是快照，视图一律完整渲染
    renderStats();
    renderRank();
    renderLab();
    renderEvents();
    renderLayers();
    renderDrill();
    renderCharts();

    const meta = window.SNAPSHOT_META;
    if (dataSource === 'snapshot' && meta && meta.generatedAt) {
      $('#footUpdate').textContent = meta.generatedAt;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

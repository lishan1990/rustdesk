// ============================================================
// RustDesk Dashboard v3 - 复刻官方 Console
// ============================================================
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ---------- 路由表 ----------
const PAGES = {
  overview:  { group: '工作台',   title: '运行总览',     render: renderOverview,     crumb: ['工作台', '运行总览'] },
  users:     { group: '用户与设备', title: '用户管理',   render: renderUsers,        crumb: ['用户与设备', '用户管理'] },
  devices:   { group: '用户与设备', title: '设备管理',   render: renderDevices,      crumb: ['用户与设备', '设备管理'] },
  audits:    { group: '审计与告警', title: '审计日志',   render: renderAudits,       crumb: ['审计与告警', '审计日志'] },
  connections:{ group: '服务运维', title: '实时连接',   render: renderConnections,  crumb: ['服务运维', '实时连接'] },
  logs:      { group: '服务运维',   title: '运行日志',     render: renderLogs,         crumb: ['服务运维', '运行日志'] },
  config:    { group: '服务运维',   title: '服务管理',     render: renderConfig,       crumb: ['服务运维', '服务管理'] },
  'addr-groups':{ group: '协作数据', title: '地址簿分组', render: renderAddrGroups, crumb: ['协作数据', '地址簿分组'] },
  'addr-book': { group: '协作数据',   title: '我的地址簿',   render: renderAddrBook,     crumb: ['协作数据', '我的地址簿'] },
  tags:      { group: '协作数据',   title: '我的标签',     render: renderPlaceholder,   crumb: ['协作数据', '我的标签'] },
  access:    { group: '访问与安全', title: '访问策略', render: renderPlaceholder, crumb: ['访问与安全', '访问策略'] },
  'client-gen':{ group: '客户端定制', title: '定制客户端', render: renderClientGen,   crumb: ['客户端定制', '定制客户端'] },
  'build-env': { group: '客户端定制', title: '构建环境配置', render: renderBuildEnv,  crumb: ['客户端定制', '构建环境配置'] },
  'build-history':{ group: '客户端定制', title: '构建历史', render: renderBuildHistory, crumb: ['客户端定制', '构建历史'] },
};

let currentPage = 'overview';
let autoRefresh = false;
let refreshTimer = null;
let trendRange = 7; // 趋势图天数

// ---------- 导航 ----------
function gotoPage(p) {
  if (!PAGES[p]) return;
  currentPage = p;
  // 侧边栏 active
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === p));
  // 面包屑
  const crumb = PAGES[p].crumb;
  $('#breadcrumb').innerHTML = '';
  crumb.forEach((txt, i) => {
    $('#breadcrumb').appendChild(h('span', {}, txt));
    if (i < crumb.length - 1) $('#breadcrumb').appendChild(h('span', { class: 'sep' }, '/'));
  });
  // 清内容 + 渲染
  $('#content').innerHTML = '';
  PAGES[p].render();
  // 清旧定时器
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (autoRefresh && (p === 'overview' || p === 'connections' || p === 'logs')) {
    refreshTimer = setInterval(() => { $('#content').innerHTML = ''; PAGES[p].render(); }, 5000);
  }
}

// ---------- API 封装 ----------
// 会话过期统一回登录页
function handleUnauthorized(res) {
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('未登录');
  }
}

async function api(path) {
  const res = await fetch(path);
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  handleUnauthorized(res);
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============================================================
// 工具函数
// ============================================================
function h(tag, attrs = {}, children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, String(v));
    }
  }
  const arr = children == null ? [] : (Array.isArray(children) ? children : [children]);
  for (const c of arr) {
    if (c == null || c === false) continue;
    let node;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean')
      node = document.createTextNode(String(c));
    else if (c && c.nodeType && typeof c.appendChild === 'function')
      node = c;
    else continue;
    try { el.appendChild(node); } catch(e) {}
  }
  return el;
}

function badge(text, type = 'muted') {
  return h('span', { class: `badge badge-${type}` }, text);
}

function loading() {
  $('#content').innerHTML = '<div class="loading">加载中...</div>';
}

function empty(msg = '暂无数据') {
  return h('div', { class: 'empty' }, msg);
}

function errorBox(e) {
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-body', style: 'color:var(--err);' }, `加载失败: ${e.message || e}`),
  ]);
}

function pageHead(title, desc) {
  return h('div', { class: 'page-head' }, [
    h('h1', { class: 'page-title' }, title),
    desc ? h('p', { class: 'page-desc' }, desc) : null,
  ]);
}

// ---------- 轻提示 ----------
function toast(msg, type = 'ok') {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- 通用弹窗表单 ----------
function openModal({ title, fields = [], submitText = '确定', onSubmit }) {
  const mask = h('div', { class: 'modal-mask' });
  const inputs = {};
  const body = h('div', { class: 'modal-body' }, fields.map(f => {
    const id = 'mf_' + f.key;
    let control;
    if (f.type === 'select') {
      control = h('select', { class: 'form-input', id }, (f.options || []).map(o =>
        h('option', { value: o.value }, o.label)));
    } else if (f.type === 'textarea') {
      control = h('textarea', { class: 'form-input', id, rows: 3 }, f.value || '');
    } else {
      control = h('input', {
        class: 'form-input', id, type: f.type || 'text',
        value: f.value == null ? '' : String(f.value),
        placeholder: f.placeholder || '',
      });
    }
    if (f.value != null && f.type === 'select') control.value = String(f.value);
    inputs[f.key] = control;
    return h('div', { class: 'modal-field' }, [
      h('label', { class: 'modal-label' }, f.label),
      control,
      f.desc ? h('div', { class: 'modal-desc' }, f.desc) : null,
    ]);
  }));

  const close = () => mask.remove();
  const submitBtn = h('button', { class: 'btn btn-primary' }, submitText);
  submitBtn.addEventListener('click', async () => {
    const values = {};
    for (const k in inputs) values[k] = inputs[k].value;
    submitBtn.disabled = true;
    const oldText = submitText;
    submitBtn.textContent = '处理中...';
    try {
      await onSubmit(values);
      close();
    } catch (e) {
      toast(e.message || String(e), 'err');
      submitBtn.disabled = false;
      submitBtn.textContent = oldText;
    }
  });

  mask.appendChild(h('div', { class: 'modal' }, [
    h('div', { class: 'modal-head' }, [
      h('span', {}, title),
      h('span', { class: 'modal-close', onclick: close }, '×'),
    ]),
    body,
    h('div', { class: 'modal-foot' }, [
      h('button', { class: 'btn btn-secondary', onclick: close }, '取消'),
      submitBtn,
    ]),
  ]));
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.body.appendChild(mask);
  const first = Object.values(inputs)[0];
  if (first) setTimeout(() => first.focus(), 80);
}

// ============================================================
// SVG 折线图
// ============================================================
const CHART_SERIES = [
  { key: 'alarm',      label: '告警',    color: '#f53f3f' },
  { key: 'file',       label: '文件',    color: '#ff7d00' },
  { key: 'newUsers',   label: '新增用户', color: '#00b42a' },
  { key: 'newDevices', label: '新增设备', color: '#165dff' },
  { key: 'connection', label: '连接',    color: '#ff6f3d' },
];

function renderChart(series, days, range) {
  // 布局参数
  const W = 720, H = 280;
  const PAD_L = 48, PAD_R = 20, PAD_T = 16, PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  if (!series || series.length === 0) {
    return h('div', { class: 'chart-wrap' }, empty('暂无趋势数据'));
  }

  // 计算 Y 轴
  let maxY = 0;
  CHART_SERIES.forEach(s => {
    series.forEach(d => { maxY = Math.max(maxY, d[s.key] || 0); });
  });
  maxY = Math.max(maxY, 1);
  maxY = Math.ceil(maxY * 1.2);
  // 取 nice round
  const pow = Math.pow(10, Math.floor(Math.log10(maxY)));
  maxY = Math.ceil(maxY / pow) * pow;

  const yTicks = 4; // 分 4 段
  const yTickVals = [];
  for (let i = 0; i <= yTicks; i++) yTickVals.push(Math.round((maxY / yTicks) * i));

  const xStep = series.length > 1 ? plotW / (series.length - 1) : plotW;

  // 将数据转为 SVG path
  const toPath = (key) => {
    const pts = series.map((d, i) => {
      const x = PAD_L + i * xStep;
      const y = PAD_T + plotH - ((d[key] || 0) / maxY) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return 'M' + pts.join(' L');
  };

  // 生成 SVG namespace 元素
  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }

  // 构建 SVG
  const svg = svgEl('svg', {
    class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
  });

  // Y 轴网格 + 标签
  yTickVals.forEach((v, i) => {
    const y = PAD_T + plotH - (v / maxY) * plotH;
    svg.appendChild(svgEl('line', {
      x1: PAD_L, y1: y, x2: W - PAD_R, y2: y,
      stroke: '#eef0f3', 'stroke-width': 1,
    }));
    svg.appendChild(svgEl('text', {
      x: PAD_L - 8, y: y + 4, 'text-anchor': 'end',
      fill: '#8f959e', 'font-size': '11', 'font-family': 'sans-serif',
    })).textContent = v;
  });

  // X 轴标签（每隔几个显示）
  const labelStep = Math.max(1, Math.floor(series.length / 7));
  series.forEach((d, i) => {
    if (i % labelStep === 0 || i === series.length - 1) {
      const x = PAD_L + i * xStep;
      const dateStr = d.date ? d.date.slice(5) : ''; // MM-DD
      svg.appendChild(svgEl('text', {
        x, y: H - 14, 'text-anchor': 'middle',
        fill: '#8f959e', 'font-size': '11', 'font-family': 'sans-serif',
      })).textContent = dateStr;
    }
  });

  // 绘制每条线
  CHART_SERIES.forEach(s => {
    const hasData = series.some(d => (d[s.key] || 0) > 0);
    if (!hasData && range < 30) return; // 没数据就不画
    const path = svgEl('path', {
      d: toPath(s.key),
      fill: 'none',
      stroke: s.color,
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    svg.appendChild(path);
  });

  // 图例
  const legend = h('div', { class: 'chart-legend' },
    CHART_SERIES.map(s => h('div', { class: 'legend-item' }, [
      h('span', { class: 'line', style: `background:${s.color}` }),
      s.label,
    ]))
  );

  const wrap = h('div', { class: 'chart-wrap' });
  wrap.appendChild(svg);
  wrap.appendChild(legend);
  return wrap;
}

// ============================================================
// 运行总览页
// ============================================================
async function renderOverview() {
  loading();

  let ov = {}, tr = {}, ac = {};
  try {
    [ov, tr, ac] = await Promise.all([
      api('/api/overview'),
      api(`/api/trends?days=${trendRange}`),
      api('/api/active-clients'),
    ]);
  } catch (e) {
    $('#content').innerHTML = '';
    $('#content').appendChild(errorBox(e));
    return;
  }

  // 8 个统计卡片（对齐参考图）
  const statCards = [
    { label: '用户',         value: ov.users,           dot: '#165dff' },
    { label: '启用用户',     value: ov.enabledUsers,    dot: '#00b42a' },
    { label: '设备',         value: ov.devices,         dot: '#ff7d00' },
    { label: '在线设备',     value: ov.onlineDevices,   dot: '#ff6f3d' },
    { label: '活动连接',     value: ov.activeConnections, dot: '#722ed1' },
    { label: '今日连接',     value: ov.todayConnections, dot: '#13c2c2' },
    { label: '今日文件',     value: ov.todayFiles,      dot: '#eb2f96' },
    { label: '待确认告警',   value: ov.pendingAlarms,   dot: '#f53f3f' },
  ];

  const container = h('div', {}, [

    pageHead('运行总览', '设备、连接、文件和安全事件趋势'),

    // 8 卡片
    h('div', { class: 'stat-cards' }, statCards.map(c =>
      h('div', { class: 'stat-card' }, [
        h('div', { class: 'stat-card-label' }, [
          h('span', { class: 'dot', style: `background:${c.dot}` }),
          c.label,
        ]),
        h('div', { class: 'stat-card-value' }, c.value ?? '-'),
      ])
    )),

    // 趋势图 panel
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('span', {}, '趋势'),
        h('div', { class: 'panel-head-actions' }, [
          h('div', { class: 'range-switch' }, [7, 30, 90].map(d =>
            h('button', {
              class: 'range-btn' + (d === trendRange ? ' active' : ''),
              onclick: () => { trendRange = d; gotoPage('overview'); },
            }, `${d} 天`)
          )),
        ]),
      ]),
      h('div', { class: 'panel-body' }, [
        renderChart(tr.series, tr.days, trendRange),
      ]),
    ]),

    // 审计汇总 panel
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, '审计日志汇总'),
      h('div', { class: 'panel-body' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, [
            h('th', {}, '类型'), h('th', {}, '总记录数'), h('th', {}, '说明'),
          ])]),
          h('tbody', {}, [
            h('tr', {}, [h('td', {}, 'audit_conn'), h('td', {}, h('span', { class: 'mono' }, ov.auditTotals?.conn ?? 0)), h('td', {}, '远程连接建立/断开')]),
            h('tr', {}, [h('td', {}, 'audit_file'),  h('td', {}, h('span', { class: 'mono' }, ov.auditTotals?.file ?? 0)), h('td', {}, '文件传输记录')]),
            h('tr', {}, [h('td', {}, 'audit_alarm'), h('td', {}, h('span', { class: 'mono' }, ov.auditTotals?.alarm ?? 0)), h('td', {}, '安全告警事件')]),
            h('tr', {}, [h('td', {}, 'audit_console'), h('td', {}, h('span', { class: 'mono' }, ov.auditTotals?.console ?? 0)), h('td', {}, '控制台操作审计')]),
          ]),
        ]),
      ]),
    ]),

    // 活跃客户端（从 hbbs Punch hole 日志 + ss 实时解析）
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('span', {}, '活跃客户端（近 24h NAT 打洞）'),
        h('span', { style: 'font-size:12px;color:var(--text-mute);font-weight:400;' },
          ac.totalPunch24h ? `共 ${ac.totalPunch24h} 次打洞` : ''
        ),
      ]),
      h('div', { class: 'panel-body' }, renderActiveClients(ac)),
    ]),

  ]);

  $('#content').appendChild(container);
}

// ============================================================
// 活跃客户端（从 hbbs Punch hole 日志解析）
// ============================================================
function renderActiveClients(ac) {
  const punch = ac.punchClients || [];
  if (punch.length === 0) {
    return h('div', {}, [
      empty('近 24 小时无 NAT 打洞记录 — 客户端还没连上 hbbs 的 21116 端口'),
      h('div', { style: 'margin-top:12px;padding:12px 16px;background:#fff7e6;border:1px solid #ffd591;border-radius:6px;color:#874d00;font-size:12px;' }, [
        h('div', { style: 'font-weight:600;margin-bottom:4px;' }, '💡 客户端配置检查清单'),
        h('div', {}, '1. 确保客户端 [网络] 设置里的 ID Server 填的是 182.44.6.48:21116（不是 21114）'),
        h('div', {}, '2. Relay Server 填 182.44.6.48:21117'),
        h('div', {}, '3. Key 填：WcIytNmPq4M3uwX86PG1jEH9irBi5GrDCl8LU0vUFtE='),
        h('div', {}, '4. 保存后重启 RustDesk 客户端，看右下角状态是否变成绿色'),
      ]),
    ]);
  }

  return h('table', {}, [
    h('thead', {}, [h('tr', {}, [
      h('th', {}, '客户端 ID'),
      h('th', {}, 'Peer IP（打洞双方）'),
      h('th', {}, '最后活跃'),
      h('th', {}, '当前中继中'),
      h('th', {}, '打洞次数'),
    ])]),
    h('tbody', {}, punch.map(c =>
      h('tr', {}, [
        h('td', {}, h('span', { class: 'mono' }, c.id)),
        h('td', {}, c.peerIps.map(ip => h('div', { class: 'mono-sm' }, ip)).reduce((a, b, i) => i === 0 ? [b] : [...a, ' + ', b], [])),
        h('td', {}, c.lastSeen || '-'),
        h('td', {}, c.viaHbbrNow ? badge('是', 'ok') : badge('否', 'muted')),
        h('td', {}, c.punchCount),
      ])
    )),
  ]);
}

// ============================================================
// 用户管理
// ============================================================
function openRegisterUser() {
  openModal({
    title: '新增用户',
    submitText: '注册',
    fields: [
      { key: 'name', label: '用户名', placeholder: '例如 zhangsan', desc: '字母、数字、_ . -，长度 2-32' },
      { key: 'password', label: '初始密码', type: 'password', placeholder: '至少 4 位' },
      { key: 'email', label: '邮箱（可选）', placeholder: 'name@example.com' },
    ],
    async onSubmit(v) {
      await postJson('/api/users/register', v);
      toast('用户已注册，客户端可直接用该账号登录');
      renderUsers();
    },
  });
}

function openChangePassword(u) {
  openModal({
    title: `修改密码 · ${u.username}`,
    submitText: '保存',
    fields: [
      { key: 'password', label: '新密码', type: 'password', placeholder: '至少 4 位' },
    ],
    async onSubmit(v) {
      await postJson('/api/users/password', { guid: u.guid, password: v.password });
      toast('密码已更新');
      renderUsers();
    },
  });
}

async function toggleUserStatus(u) {
  const next = Number(u.status) === 1 ? 0 : 1;
  if (next === 0 && !confirm(`确定禁用账户「${u.username}」？禁用后该账号将无法登录客户端。`)) return;
  try {
    await postJson('/api/users/status', { guid: u.guid, status: next });
    toast(next === 1 ? '账户已解禁' : '账户已禁用');
    renderUsers();
  } catch (e) { toast(e.message, 'err'); }
}

async function renderUsers() {
  loading();
  let data = {};
  try { data = await api('/api/users'); } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const list = data.users || [];
  const enabled = list.filter(u => Number(u.status) === 1).length;

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    h('div', { class: 'page-head-row' }, [
      pageHead('用户管理', `共 ${list.length} 个账户 · ${enabled} 个启用`),
      h('div', { class: 'page-actions' }, [
        h('button', { class: 'btn btn-primary', onclick: openRegisterUser }, '+ 新增用户'),
      ]),
    ]),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-body' }, list.length === 0
        ? empty('user 表为空，点击右上角「新增用户」创建第一个账户')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, '用户名'), h('th', {}, '邮箱'), h('th', {}, '状态'),
              h('th', {}, '创建时间'), h('th', {}, '最后改密'), h('th', { class: 'th-actions' }, '操作'),
            ])]),
            h('tbody', {}, list.map(u => {
              const active = Number(u.status) === 1;
              return h('tr', {}, [
                h('td', {}, [
                  h('span', { class: 'mono-sm' }, u.username || '-'),
                  Number(u.role) === 1 ? h('span', { class: 'tag tag-info', style: 'margin-left:8px;' }, '管理员') : null,
                ]),
                h('td', {}, u.email || '-'),
                h('td', {}, active ? badge('启用', 'ok') : badge('已禁用', 'err')),
                h('td', {}, h('span', { class: 'mono-sm' }, u.createdAt || '-')),
                h('td', {}, h('span', { class: 'mono-sm' }, u.passwordSetAt || '-')),
                h('td', { class: 'td-actions' }, [
                  h('button', { class: 'btn-link', onclick: () => openChangePassword(u) }, '修改密码'),
                  h('button', {
                    class: 'btn-link ' + (active ? 'danger' : 'ok'),
                    onclick: () => toggleUserStatus(u),
                  }, active ? '禁用账户' : '解禁账户'),
                ]),
              ]);
            })),
          ])
      ),
    ]),
  ]));
}

// ============================================================
// 设备管理
// ============================================================
async function renameDevice(d) {
  const note = prompt(`给设备 ${d.id} 设置备注名称（留空则恢复默认）：`, d.hasNote ? d.name : '');
  if (note === null) return;
  try {
    await postJson('/api/devices/rename', { id: d.id, note });
    toast(note ? '备注已保存' : '备注已清空');
    renderDevices();
  } catch (e) { toast(e.message, 'err'); }
}

async function renderDevices() {
  loading();
  let data = {};
  try { data = await api('/api/devices'); } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const list = data.devices || [];

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    pageHead('设备管理', `peer 表 · 共 ${data.total ?? list.length} 台设备 · OSS 版不支持封禁`),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-body' }, list.length === 0
        ? empty('还没有客户端注册过。让一台客户端连接服务器即可生成记录。')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, 'ID'), h('th', {}, '名称'), h('th', {}, '主机名'),
              h('th', {}, '操作系统'), h('th', {}, 'IP'), h('th', {}, '状态'),
              h('th', {}, '最近注册'),
            ])]),
            h('tbody', {}, list.slice(0, 200).map(d => {
              const banned = Number(d.status) === 0;
              return h('tr', {}, [
                h('td', {}, h('span', { class: 'mono-sm' }, d.id || '-')),
                h('td', {}, [
                  h('span', {}, d.name || '-'),
                  ' ',
                  h('button', { class: 'btn-link', onclick: () => renameDevice(d) }, '改备注'),
                ]),
                h('td', {}, d.hostname || '-'),
                h('td', {}, d.os || '-'),
                h('td', {}, h('span', { class: 'mono-sm' }, d.ip || '-')),
                h('td', {}, banned ? badge('已封禁', 'err') : badge('正常', 'ok')),
                h('td', {}, h('span', { class: 'mono-sm' }, d.lastSeen || '-')),
              ]);
            })),
          ])
      ),
    ]),
  ]));
}

// ============================================================
// 审计日志
// ============================================================
async function renderAudits() {
  loading();
  let data = {};
  try { data = await api('/api/audits?type=conn&limit=100'); } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const tabs = [
    { key: 'conn', label: '连接记录' },
    { key: 'file', label: '文件传输' },
    { key: 'alarm', label: '安全告警' },
    { key: 'console', label: '控制台操作' },
  ];

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    pageHead('审计日志', '历史操作审计记录'),
    h('div', { class: 'tabs' }, tabs.map(t =>
      h('div', {
        class: 'tab' + (t.key === 'conn' ? ' active' : ''),
        onclick: () => swapAuditTab(t.key),
        'data-type': t.key,
      }, t.label)
    )),
    h('div', { id: 'auditPanel', class: 'panel' }, [
      h('div', { class: 'panel-body' }, renderAuditTable(data.rows || [], data.table || 'audit_conn')),
    ]),
  ]));
}

function renderAuditTable(rows, table) {
  if (!rows || rows.length === 0) return empty(`${table} 表为空`);
  const first = rows[0];
  const cols = Object.keys(first);
  return h('table', {}, [
    h('thead', {}, [h('tr', {}, cols.map(c => h('th', {}, c)))]),
    h('tbody', {}, rows.slice(0, 50).map(r =>
      h('tr', {}, cols.map(c => h('td', {},
        typeof r[c] === 'object' ? JSON.stringify(r[c]).slice(0, 80) : String(r[c] ?? '-').slice(0, 120)
      )))
    )),
  ]);
}

async function swapAuditTab(type) {
  $$('.tab').forEach(el => el.classList.toggle('active', el.dataset.type === type));
  const data = await api(`/api/audits?type=${type}&limit=100`);
  const panel = $('#auditPanel .panel-body');
  panel.innerHTML = '';
  panel.appendChild(renderAuditTable(data.rows || [], data.table || type));
}

// ============================================================
// 实时连接
// ============================================================
async function renderConnections() {
  loading();
  let data = {};
  try { data = await api('/api/connections'); } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const rows = data.connections || [];
  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    pageHead('实时连接', `ss -tnp 实时结果 · ${data.count} 条连接`),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-body' }, rows.length === 0
        ? empty('当前没有活跃 TCP 连接（hbbs/hbbr 可能通过 UDP 或 WebSocket 通信）')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [h('th', {}, '状态'), h('th', {}, 'Local'), h('th', {}, 'Peer'), h('th', {}, '进程')])]),
            h('tbody', {}, rows.map(r =>
              h('tr', {}, [
                h('td', {}, badge(r.state, stateColor(r.state))),
                h('td', {}, h('span', { class: 'mono-sm' }, r.local)),
                h('td', {}, h('span', { class: 'mono-sm' }, r.peer)),
                h('td', {}, r.process || '-'),
              ])
            )),
          ])
      ),
    ]),
  ]));
}

function stateColor(s) {
  if (s === 'ESTAB' || s === 'ESTABLISHED') return 'ok';
  if (s === 'TIME-WAIT') return 'muted';
  if (s === 'LISTEN') return 'info';
  return 'muted';
}

// ============================================================
// 运行日志
// ============================================================
async function renderLogs() {
  loading();
  let hbbs = {}, hbbr = {};
  try {
    [hbbs, hbbr] = await Promise.all([
      api('/api/logs?svc=rustdesk-hbbs&since=30+minutes+ago&lines=100'),
      api('/api/logs?svc=rustdesk-hbbr&since=30+minutes+ago&lines=50'),
    ]);
  } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    pageHead('运行日志', 'journalctl 实时日志（最近 30 分钟）'),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, 'rustdesk-hbbs'),
      h('div', { class: 'panel-body' }, renderLogViewer(hbbs.log || [])),
    ]),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, 'rustdesk-hbbr'),
      h('div', { class: 'panel-body' }, renderLogViewer(hbbr.log || [])),
    ]),
  ]));
}

function renderLogViewer(lines) {
  if (!lines.length) return empty('暂无日志');
  const box = h('div', { class: 'log-viewer' });
  lines.forEach(l => {
    const cls = l.includes('ERROR') || l.includes('error') || l.includes('ERR') ? 'log-err'
              : l.includes('WARN') || l.includes('warn') ? 'log-warn'
              : 'log-info';
    box.appendChild(h('div', { class: 'log-line ' + cls }, l));
  });
  return box;
}

// ============================================================
// 服务管理
// ============================================================
async function renderConfig() {
  loading();
  let [st, kp] = [{}, {}];
  try {
    [st, kp] = await Promise.all([api('/api/status'), api('/api/keypair')]);
  } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const s = st.server || {};
  const c = st.config || {};
  const svc = st.services || {};

  const copyEl = (text) => {
    return h('dd', {
      class: 'copy-hint',
      onclick: (e) => {
        navigator.clipboard.writeText(text);
        const el = e.currentTarget;
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 800);
      },
      title: '点击复制',
    }, text);
  };

  const allOk = svc.hbbs?.active && svc.hbbr?.active && svc.api?.active !== false;
  const svcCard = (name, role, ports, info) => h('div', { class: 'ops-svc-card' }, [
    h('div', { class: 'ops-svc-top' }, [
      h('div', { class: 'ops-svc-name' }, [
        h('span', { class: 'ops-svc-dot ' + (info.active ? 'ok' : 'err') }),
        h('span', { class: 'mono' }, name),
      ]),
      badge(info.active ? '运行中' : '已停止', info.active ? 'ok' : 'err'),
    ]),
    h('div', { class: 'ops-svc-role' }, role),
    h('div', { class: 'ops-svc-meta' }, [
      h('span', {}, `端口 ${ports}`),
      h('span', {}, `v${info.version || '1.8.7'}`),
      h('span', {}, info.enabled ? '开机自启' : '未设自启'),
    ]),
  ]);

  const metric = (label, value) => h('div', { class: 'ops-metric' }, [
    h('div', { class: 'ops-metric-label' }, label),
    h('div', { class: 'ops-metric-value' }, value || '-'),
  ]);

  const portsList = Array.isArray(st.ports) ? st.ports : [];

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    pageHead('服务管理', '服务运行状态、客户端连接参数与服务器资源'),

    // 顶部状态横幅
    h('div', { class: 'ops-hero ' + (allOk ? 'ok' : 'err') }, [
      h('div', { class: 'ops-hero-icon' }, allOk ? '✓' : '!'),
      h('div', { class: 'ops-hero-main' }, [
        h('div', { class: 'ops-hero-title' }, allOk ? '服务运行正常' : '存在异常服务，请检查'),
        h('div', { class: 'ops-hero-sub' },
          `${s.ip || '-'} · ${s.hostname || '-'} · ${s.os || '-'} · 已运行 ${s.uptime || '-'}`),
      ]),
      h('div', { class: 'ops-hero-side' }, [
        h('span', { class: 'ops-hero-num' }, String(s.activeConnections ?? 0)),
        h('span', { class: 'ops-hero-unit' }, '活动连接'),
      ]),
    ]),

    // 服务卡片
    h('div', { class: 'ops-svc-grid' }, [
      svcCard('rustdesk-hbbs', 'ID / 信令服务器（Docker 容器）', '21115-21116', svc.hbbs || {}),
      svcCard('rustdesk-hbbr', '中继 / 转发服务器（Docker 容器）', '21117+21119', svc.hbbr || {}),
      svcCard('rustdesk-api', '客户端登录 / 地址簿 API', '21114', svc.api || {}),
      h('div', { class: 'ops-svc-card' }, [
        h('div', { class: 'ops-svc-top' }, [
          h('div', { class: 'ops-svc-name' }, [
            h('span', { class: 'ops-svc-dot ok' }),
            h('span', { class: 'mono' }, 'rustdesk-dashboard'),
          ]),
          badge('运行中', 'ok'),
        ]),
        h('div', { class: 'ops-svc-role' }, 'Web 管理面板（当前页面）'),
        h('div', { class: 'ops-svc-meta' }, [
          h('span', {}, '端口 21120'),
          h('span', {}, 'Node.js'),
          h('span', {}, 'Express'),
        ]),
      ]),
    ]),

    // 连接参数 + 密钥
    h('div', { class: 'ops-two-col' }, [
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-head' }, [
          h('span', {}, '客户端连接参数'),
          h('span', { class: 'text-muted text-sm' }, '点击右侧值可复制'),
        ]),
        h('div', { class: 'panel-body' }, [
          h('dl', { class: 'config-rows' }, [
            h('dt', {}, 'ID Server'),    copyEl(c.idServer || '-'),
            h('dt', {}, 'Relay Server'), copyEl(c.relayServer || '-'),
            h('dt', {}, 'API Server'),   copyEl(c.apiServer || '-'),
            h('dt', {}, '公钥 Key'),     copyEl(c.key || '-'),
          ]),
        ]),
      ]),
      h('div', { class: 'panel' }, [
        h('div', { class: 'panel-head' }, [
          h('span', {}, '密钥与服务器'),
          h('span', { class: 'text-muted text-sm' }, '只读'),
        ]),
        h('div', { class: 'panel-body' }, [
          h('dl', { class: 'config-rows' }, [
            h('dt', {}, '私钥文件'),
            h('dd', {}, kp.privateKeyExists
              ? `已存在 · 权限 ${kp.privateKeyPerm || '-'}`
              : '未找到'),
            h('dt', {}, '私钥路径'), h('dd', {}, h('span', { class: 'mono-sm' }, kp.privateKeyPath || '-')),
            h('dt', {}, '架构'),     h('dd', {}, `${s.arch || '-'}`),
            h('dt', {}, '时区'),     h('dd', {}, 'Asia/Shanghai'),
          ]),
        ]),
      ]),
    ]),

    // 资源
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, '服务器资源'),
      h('div', { class: 'ops-metric-grid' }, [
        metric('CPU 负载', s.load),
        metric('内存使用', s.memory),
        metric('磁盘使用', s.disk),
        metric('运行时间', s.uptime),
      ]),
    ]),

    // 端口
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('span', {}, '监听端口'),
        h('span', { class: 'text-muted text-sm' }, `${portsList.length} 条监听记录`),
      ]),
      h('div', { class: 'panel-body' }, portsList.length === 0
        ? empty('未获取到端口监听信息')
        : h('div', { class: 'ops-port-tags' }, portsList.map(p =>
            h('span', { class: 'ops-port-tag mono-sm' }, String(p)))))
    ]),
  ]));
}

// ============================================================
// 地址簿分组（ab 表）
// ============================================================
let currentAb = '';

function openCreateAb() {
  openModal({
    title: '新建地址簿分组',
    submitText: '创建',
    fields: [
      { key: 'name', label: '分组名称', placeholder: '例如：运维部设备' },
      { key: 'note', label: '备注（可选）', placeholder: '用途说明' },
    ],
    async onSubmit(v) {
      await postJson('/api/ab/create', v);
      toast('地址簿分组已创建，客户端同步后即可看到');
      renderAddrGroups();
    },
  });
}

function openEditAb(b) {
  openModal({
    title: '编辑地址簿分组',
    submitText: '保存',
    fields: [
      { key: 'name', label: '分组名称', value: b.name },
      { key: 'note', label: '备注（可选）', value: b.note },
    ],
    async onSubmit(v) {
      await postJson('/api/ab/update', { guid: b.guid, name: v.name, note: v.note });
      toast('已保存');
      renderAddrGroups();
    },
  });
}

async function deleteAb(b) {
  if (!confirm(`确定删除地址簿分组「${b.name}」？分组内的 ${b.peerCount} 个设备条目也会一并删除。`)) return;
  try {
    await postJson('/api/ab/delete', { guid: b.guid });
    if (currentAb === b.guid) currentAb = '';
    toast('分组已删除');
    renderAddrGroups();
  } catch (e) { toast(e.message, 'err'); }
}

async function renderAddrGroups() {
  loading();
  let data = {};
  try { data = await api('/api/ab/list'); } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const books = data.books || [];

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    h('div', { class: 'page-head-row' }, [
      pageHead('地址簿分组', `共 ${books.length} 个分组 · 数据直接写入 hbbs 数据库，客户端登录后自动同步`),
      h('div', { class: 'page-actions' }, [
        h('button', { class: 'btn btn-primary', onclick: openCreateAb }, '+ 新建分组'),
      ]),
    ]),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-body' }, books.length === 0
        ? empty('还没有地址簿分组，点击右上角「新建分组」创建一个')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, '分组名称'), h('th', {}, '备注'), h('th', {}, '设备数'),
              h('th', {}, '类型'), h('th', {}, '创建时间'), h('th', { class: 'th-actions' }, '操作'),
            ])]),
            h('tbody', {}, books.map(b =>
              h('tr', {}, [
                h('td', {}, b.name || '-'),
                h('td', {}, b.note || '-'),
                h('td', {}, String(b.peerCount || 0)),
                h('td', {}, b.personal ? badge('个人', 'info') : badge('共享', 'muted')),
                h('td', {}, h('span', { class: 'mono-sm' }, b.createdAt || '-')),
                h('td', { class: 'td-actions' }, [
                  h('button', { class: 'btn-link', onclick: () => { currentAb = b.guid; gotoPage('addr-book'); } }, '管理设备'),
                  h('button', { class: 'btn-link', onclick: () => openEditAb(b) }, '编辑'),
                  h('button', { class: 'btn-link danger', onclick: () => deleteAb(b) }, '删除'),
                ]),
              ])
            )),
          ])
      ),
    ]),
  ]));
}

// ============================================================
// 我的地址簿（ab_peer 表）
// ============================================================
function openAddPeer(abGuid) {
  openModal({
    title: '添加设备到地址簿',
    submitText: '添加',
    fields: [
      { key: 'id', label: 'RustDesk ID', placeholder: '例如 1255106694' },
      { key: 'note', label: '别名（可选）', placeholder: '例如：财务部电脑' },
      { key: 'tags', label: '标签（可选）', placeholder: '多个用逗号分隔，如 办公,财务' },
    ],
    async onSubmit(v) {
      await postJson('/api/ab/peers/add', {
        ab: abGuid, id: v.id, note: v.note,
        tags: (v.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      });
      toast('设备已加入地址簿');
      renderAddrBook();
    },
  });
}

function openEditPeer(p) {
  openModal({
    title: '编辑地址簿设备',
    submitText: '保存',
    fields: [
      { key: 'id', label: 'RustDesk ID', value: p.id },
      { key: 'note', label: '别名（可选）', value: p.note },
      { key: 'tags', label: '标签（可选）', value: (p.tags || []).join(',') },
    ],
    async onSubmit(v) {
      await postJson('/api/ab/peers/update', {
        guid: p.guid, note: v.note,
        tags: (v.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      });
      toast('已保存');
      renderAddrBook();
    },
  });
}

async function deletePeer(p) {
  if (!confirm(`确定从地址簿移除设备「${p.id}」？`)) return;
  try {
    await postJson('/api/ab/peers/delete', { guid: p.guid });
    toast('已移除');
    renderAddrBook();
  } catch (e) { toast(e.message, 'err'); }
}

async function renderAddrBook() {
  loading();
  let data = {}, peerData = { peers: [] };
  try {
    data = await api('/api/ab/list');
    const books = data.books || [];
    if (!currentAb || !books.some(b => b.guid === currentAb)) {
      const personal = books.find(b => b.personal) || books[0];
      currentAb = personal ? personal.guid : '';
    }
    if (currentAb) peerData = await api(`/api/ab/peers?ab=${encodeURIComponent(currentAb)}`);
  } catch (e) { $('#content').innerHTML = ''; $('#content').appendChild(errorBox(e)); return; }

  const books = data.books || [];
  const peers = peerData.peers || [];
  const selected = books.find(b => b.guid === currentAb);

  const selector = h('select', {
    class: 'form-input form-select',
    style: 'max-width:260px;',
    onchange: (e) => { currentAb = e.target.value; renderAddrBook(); },
  }, books.map(b => h('option', { value: b.guid }, `${b.name}（${b.peerCount}）`)));
  if (currentAb) selector.value = currentAb;

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    h('div', { class: 'page-head-row' }, [
      pageHead('我的地址簿', '地址簿中的设备会同步到已登录的客户端地址簿'),
      h('div', { class: 'page-actions' }, [
        selector,
        h('button', {
          class: 'btn btn-primary',
          onclick: () => { if (!currentAb) return toast('请先创建地址簿分组', 'err'); openAddPeer(currentAb); },
        }, '+ 添加设备'),
      ]),
    ]),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('span', {}, selected ? `分组：${selected.name}` : '未选择分组'),
        h('span', { class: 'text-muted text-sm' }, `${peers.length} 台设备`),
      ]),
      h('div', { class: 'panel-body' }, peers.length === 0
        ? empty(books.length === 0 ? '还没有地址簿分组，请先到「地址簿分组」创建' : '该分组还没有设备，点击右上角「添加设备」')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, 'RustDesk ID'), h('th', {}, '别名'), h('th', {}, '标签'),
              h('th', {}, '设备状态'), h('th', {}, '加入时间'), h('th', { class: 'th-actions' }, '操作'),
            ])]),
            h('tbody', {}, peers.map(p =>
              h('tr', {}, [
                h('td', {}, h('span', { class: 'mono-sm' }, p.id || '-')),
                h('td', {}, p.note || '-'),
                h('td', {}, (p.tags || []).length
                  ? h('span', {}, p.tags.map(t => h('span', { class: 'tag tag-info', style: 'margin-right:4px;' }, t)))
                  : '-'),
                h('td', {}, Number(p.status) === 0 ? badge('已封禁', 'err') : (p.status == null ? badge('未注册', 'muted') : badge('正常', 'ok'))),
                h('td', {}, h('span', { class: 'mono-sm' }, p.createdAt || '-')),
                h('td', { class: 'td-actions' }, [
                  h('button', { class: 'btn-link', onclick: () => openEditPeer(p) }, '编辑'),
                  h('button', { class: 'btn-link danger', onclick: () => deletePeer(p) }, '移除'),
                ]),
              ])
            )),
          ])
      ),
    ]),
  ]));
}

// ============================================================
// 占位页面
// ============================================================
function renderPlaceholder() {
  $('#content').append(h('div', { class: 'card' }, [
    h('div', { class: 'card-body' }, [
      h('div', { class: 'empty' }, [
        h('div', { class: 'empty-icon' }, '📋'),
        h('div', { class: 'text-lg text-bold mb-8' }, '功能规划中'),
        h('div', { class: 'text-muted' }, '本模块为企业版功能，开源版暂无。'),
      ]),
    ]),
  ]));
}

// ============================================================
// 客户端定制页（闲鱼风格）
// ============================================================
let customizeTab = 'basic';
const CUSTOMIZE_TABS = [
  { key: 'basic',   label: '基础' },
  { key: 'server',  label: '服务器' },
  { key: 'security',label: '安全' },
  { key: 'network', label: '网络' },
  { key: 'look',    label: '外观 / 其他' },
];

// 切换 Tab：只切换下方表单面板，不重新渲染整个页面
function switchCustomizeTab(key) {
  customizeTab = key;
  $$('.customize-form-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === key));
  $$('.customize-tab-panel').forEach(el => {
    el.style.display = el.dataset.panel === key ? '' : 'none';
  });
}

// 构建状态（跨页面保持，切走再回来也能看到进度）
const buildView = {
  show: false, running: false, pct: 0, step: '准备中...',
  note: '', download: false, downloadUrl: null, id: null,
};
let buildPollTimer = null;

// ---------- 定制表单本地记忆 ----------
const CUSTOMIZE_STORE_KEY = 'rd_customize_form_v1';
const CUSTOMIZE_TEXT_FIELDS = [
  'brandInput', 'tipInput', 'idServerInput', 'relayInput', 'apiServerInput', 'keyInput', 'fixedPwdInput',
];

function readCustomizeStore() {
  try { return JSON.parse(localStorage.getItem(CUSTOMIZE_STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeCustomizeStore(patch) {
  const data = readCustomizeStore();
  Object.assign(data, patch);
  try { localStorage.setItem(CUSTOMIZE_STORE_KEY, JSON.stringify(data)); } catch (e) {}
}
function clearCustomizeStore() {
  try { localStorage.removeItem(CUSTOMIZE_STORE_KEY); } catch (e) {}
}
function applyCustomizeForm() {
  const data = readCustomizeStore();
  CUSTOMIZE_TEXT_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && typeof data[id] === 'string') el.value = data[id];
  });
  if (data.os) {
    const r = document.querySelector(`input[name="os"][value="${data.os}"]`);
    if (r) r.checked = true;
  }
  if (data.lang) {
    const r = document.querySelector(`input[name="lang"][value="${data.lang}"]`);
    if (r) r.checked = true;
  }
  if (data.conn) {
    const r = document.querySelector(`input[name="conn"][value="${data.conn}"]`);
    if (r) r.checked = true;
  }
  if (data.style) {
    const r = document.querySelector(`input[name="style"][value="${data.style}"]`);
    if (r) r.checked = true;
  }
  const all = document.getElementById('buildAll');
  if (all && (data.all != null || data.both != null)) all.checked = !!(data.all != null ? data.all : data.both);
  ['allowTempPwdChk', 'hideCmChk'].forEach(id => {
    const el = document.getElementById(id);
    if (el && data[id] != null) el.checked = !!data[id];
  });
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.id && CUSTOMIZE_TEXT_FIELDS.indexOf(t.id) >= 0) { writeCustomizeStore({ [t.id]: t.value }); return; }
  if (t.id === 'buildAll') writeCustomizeStore({ all: !!t.checked });
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.name === 'os' || t.name === 'lang' || t.name === 'conn' || t.name === 'style') writeCustomizeStore({ [t.name]: t.value });
  if (t.id === 'buildAll') writeCustomizeStore({ all: !!t.checked });
  if (t.id === 'allowTempPwdChk' || t.id === 'hideCmChk') {
    writeCustomizeStore({ [t.id]: !!t.checked });
  }
});

function syncBuildPanel() {
  const panel = $('#buildProgress');
  if (panel) panel.style.display = buildView.show ? '' : 'none';
  if ($('#buildStep')) $('#buildStep').textContent = buildView.step;
  if ($('#buildPct')) $('#buildPct').textContent = buildView.pct + '%';
  if ($('#buildFill')) $('#buildFill').style.width = buildView.pct + '%';
  if ($('#buildNote')) $('#buildNote').textContent = buildView.note || '';
  const dl = $('#buildDownload');
  if (dl) dl.style.display = buildView.download ? '' : 'none';
  const btn = $('#buildSubmitBtn');
  if (btn) {
    btn.disabled = buildView.running;
    btn.textContent = buildView.running ? '构建中...' : '▶ 提交构建';
  }
}

function syncBuildPanelSafe() {
  if (document.getElementById('buildProgress')) syncBuildPanel();
}

function collectCustomize() {
  const get = (id) => { const el = $('#' + id); return el ? el.value.trim() : ''; };
  const osEl = document.querySelector('input[name="os"]:checked');
  const langEl = document.querySelector('input[name="lang"]:checked');
  const connEl = document.querySelector('input[name="conn"]:checked');
  const styleEl = document.querySelector('input[name="style"]:checked');
  const allEl = document.getElementById('buildAll');
  return {
    brand: get('brandInput'),
    os: osEl ? osEl.value : 'windows',
    all: !!(allEl && allEl.checked),
    lang: langEl ? langEl.value : 'zh',
    conn: connEl ? connEl.value : 'agent',
    style: styleEl ? styleEl.value : 'portable',
    prompt: get('tipInput'),
    host: get('idServerInput'),
    relay: get('relayInput'),
    apiServer: get('apiServerInput'),
    key: get('keyInput'),
    fixedPassword: get('fixedPwdInput'),
    allowTempPassword: !!(document.getElementById('allowTempPwdChk') || {}).checked,
    hideCm: !!(document.getElementById('hideCmChk') || {}).checked,
  };
}

async function startBuild() {
  const cfg = collectCustomize();
  if (!cfg.brand) { toast('请先在「基础」页填写品牌名', 'err'); switchCustomizeTab('basic'); return; }
  if (!cfg.host) { toast('请先在「服务器」页填写 ID 服务器地址', 'err'); switchCustomizeTab('server'); return; }
  buildView.show = true;
  buildView.running = true;
  buildView.pct = 2;
  buildView.step = '正在提交构建任务...';
  buildView.note = '配置会在云端编译进客户端本体，安装后无明文配置文件；编译约 40-90 分钟，可切换页面，回来即可查看进度';
  buildView.download = false;
  buildView.downloadUrl = null;
  syncBuildPanel();
  try {
    const data = await postJson('/api/build/start', cfg);
    buildView.id = data.id;
    pollBuild(data.id);
  } catch (e) {
    buildView.running = false;
    buildView.step = '构建失败';
    buildView.note = e.message || String(e);
    syncBuildPanel();
    toast(e.message || String(e), 'err');
  }
}

function pollBuild(id) {
  clearInterval(buildPollTimer);
  buildPollTimer = setInterval(async () => {
    try {
      const job = await api('/api/build/status?id=' + encodeURIComponent(id));
      buildView.pct = job.progress || 0;
      buildView.step = job.step || '构建中...';
      if (job.status === 'success') {
        clearInterval(buildPollTimer);
        buildView.running = false;
        buildView.download = true;
        buildView.downloadUrl = job.downloadUrl;
        buildView.note = `安装包 ${job.fileName}（${(job.size / 1048576).toFixed(1)} MB）已生成，下载成功后服务器文件自动删除`;
        toast('构建完成，可下载客户端');
      } else if (job.status === 'failed') {
        clearInterval(buildPollTimer);
        buildView.running = false;
        buildView.download = false;
        buildView.note = (job.error || '构建失败') + (job.runUrl ? '（日志：' + job.runUrl + '）' : '');
        toast(job.error || '构建失败', 'err');
      }
      syncBuildPanel();
    } catch (e) {
      clearInterval(buildPollTimer);
      buildView.running = false;
      buildView.note = '获取构建状态失败：' + (e.message || e);
      syncBuildPanel();
    }
  }, 1000);
}

function downloadClient() {
  if (!buildView.downloadUrl) return;
  const a = document.createElement('a');
  a.href = buildView.downloadUrl;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  buildView.download = false;
  buildView.note = '下载已开始，完成后服务器上的安装包会自动删除';
  syncBuildPanel();
}

// 刷新 / 重新登录后，恢复最近一次构建的进度条与下载按钮
async function restoreBuildState() {
  if (buildView.running) {
    syncBuildPanelSafe();
    if (buildView.id) pollBuild(buildView.id);
    return;
  }
  let job = null;
  try {
    const data = await api('/api/build/status');
    job = data && data.job;
  } catch (e) { return; }
  if (!job) return;

  const mb = (n) => ((n || 0) / 1048576).toFixed(1);
  if (job.status === 'running' || job.status === 'queued') {
    buildView.show = true;
    buildView.id = job.id;
    buildView.running = true;
    buildView.pct = job.progress || 0;
    buildView.step = job.step || '构建中...';
    buildView.download = false;
    buildView.downloadUrl = null;
    buildView.note = '配置会在云端编译进客户端本体，安装后无明文配置文件；编译约 40-90 分钟，可切换页面，回来即可查看进度';
    pollBuild(job.id);
  } else if (job.status === 'success') {
    buildView.show = true;
    buildView.id = job.id;
    buildView.running = false;
    buildView.pct = 100;
    buildView.step = job.step || '构建完成';
    buildView.download = !!job.downloadUrl;
    buildView.downloadUrl = job.downloadUrl || null;
    buildView.note = job.downloadUrl
      ? `安装包 ${job.fileName}（${mb(job.size)} MB）已生成，下载成功后服务器文件自动删除`
      : `安装包 ${job.fileName || ''} 已失效（文件已被清理）`;
  } else {
    return;
  }
  syncBuildPanelSafe();
}

// ---------- 构建历史 ----------
const LANG_LABEL  = { zh: '中文', en: '英文' };
const CONN_LABEL  = { agent: '被控专用', dual: '双向' };
const STYLE_LABEL = { portable: '便携版', unattended: '无人值守版', standard: '官方标准版' };
const OS_LABEL    = { windows: 'Windows', android: 'Android', ios: 'iOS', both: 'Windows + Android', all: 'Windows + Android + iOS' };

function fmtDT(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function renderBuildHistory() {
  loading();
  let data = {};
  try { data = await api('/api/build/history'); } catch (e) {
    $('#content').innerHTML = '';
    $('#content').appendChild(errorBox(e));
    return;
  }
  const items = (data.items || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  $('#content').innerHTML = '';
  $('#content').appendChild(h('div', {}, [
    h('div', { class: 'page-head-row' }, [
      pageHead('构建历史', `共 ${items.length} 条构建记录 · 按提交时间倒序，最新的在最上方`),
      h('div', { class: 'page-actions' }, [
        h('button', { class: 'btn btn-primary', onclick: () => gotoPage('client-gen') }, '新建构建'),
      ]),
    ]),
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-body' }, items.length === 0
        ? empty('暂无构建记录，前往「定制客户端」提交第一次构建')
        : h('table', {}, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, '品牌名'), h('th', {}, '界面语言'), h('th', {}, '连接类型'),
              h('th', {}, '款式'), h('th', {}, '客户端系统'), h('th', {}, '构建提交日期'),
              h('th', {}, '构建成功时间'), h('th', {}, '下载链接'), h('th', {}, '是否失效'),
            ])]),
            h('tbody', {}, items.map(it => h('tr', {}, [
              h('td', {}, it.brand || '—'),
              h('td', {}, LANG_LABEL[it.lang] || '—'),
              h('td', {}, CONN_LABEL[it.conn] || '—'),
              h('td', {}, STYLE_LABEL[it.style] || '—'),
              h('td', {}, OS_LABEL[it.os] || '—'),
              h('td', {}, h('span', { class: 'mono-sm' }, fmtDT(it.createdAt))),
              h('td', {}, h('span', { class: 'mono-sm' }, fmtDT(it.successAt))),
              h('td', {}, it.downloadUrl
                ? h('a', { class: 'btn-link', href: it.downloadUrl, download: '' }, '下载客户端')
                : h('span', { class: 'text-muted' }, '—')),
              h('td', {}, it.expired ? badge('已失效', 'err') : badge('有效', 'ok')),
            ]))),
          ])
      ),
    ]),
  ]));
}

function renderClientGen() {
  $('#content').append(h('div', { class: 'customize-page' }, [

    // ======== Banner ========
    h('div', { class: 'customize-banner' }, [
      h('h1', {}, '远程协助客户端定制'),
      h('p', {}, '在线定制属于你自己的远程控制客户端：把品牌名、服务器地址、安全与网络策略填进表单，系统会在云端编译出独立的 Windows、Android 或 iOS 安装包，配置直接内嵌进程序，无需任何源码知识。'),
      h('div', { class: 'customize-banner-tags' }, [
        h('span', { class: 'tag' }, '自定义品牌名'),
        h('span', { class: 'tag' }, '指定自己的服务器'),
        h('span', { class: 'tag' }, '中文 / 英文界面'),
        h('span', { class: 'tag' }, '配置内嵌进安装包'),
        h('span', { class: 'tag' }, '网络设置已锁定'),
        h('span', { class: 'tag' }, '定制版不提示升级'),
      ]),
    ]),

    // ======== 三步卡片 ========
    h('div', { class: 'customize-steps-row' }, [
      h('div', { class: 'customize-step-card' }, [
        h('div', { class: 'customize-step-num' }, '1'),
        h('div', {}, [ h('h4', {}, '填写定制信息'), h('p', {}, '品牌名、服务器 Host/Key、安全与网络选项，五个分页按需填写') ]),
      ]),
      h('div', { class: 'customize-step-card' }, [
        h('div', { class: 'customize-step-num' }, '2'),
        h('div', {}, [ h('h4', {}, '自动编译打包'), h('p', {}, '本页实时显示进度，中途刷新也不会丢，可随时回来继续看') ]),
      ]),
      h('div', { class: 'customize-step-card' }, [
        h('div', { class: 'customize-step-num' }, '3'),
        h('div', {}, [ h('h4', {}, '下载专属客户端'), h('p', {}, '下载链接 30 分钟内有效，到期后自动删除文件，请尽快下载') ]),
      ]),
    ]),

    // ======== 定制信息表单卡片 ========
    h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('span', { class: 'card-title' }, '定制信息'),
        h('span', { class: 'text-muted text-sm' }, ['带 ', h('span', { class: 'req' }, '*'), ' 为必填']),
      ]),
      h('div', { class: 'card-body' }, [

        // Tabs
        h('div', { class: 'customize-form-tabs' },
          CUSTOMIZE_TABS.map(t => h('div', {
            class: 'customize-form-tab' + (customizeTab === t.key ? ' active' : ''),
            dataset: { tab: t.key },
            onclick: () => switchCustomizeTab(t.key),
          }, t.label))
        ),

        // ======== 基础 Tab ========
        h('div', { class: 'customize-tab-panel', 'data-panel': 'basic', style: customizeTab === 'basic' ? null : 'display:none' }, [

          // 界面语言
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '界面语言'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-radio' }, [
                  h('input', { type: 'radio', name: 'lang', value: 'zh', checked: 'checked' }),
                  '中文版（界面全中文）',
                ]),
                h('label', { class: 'customize-radio' }, [
                  h('input', { type: 'radio', name: 'lang', value: 'en' }),
                  '英文版（界面全英文）',
                ]),
                h('div', { class: 'customize-field-desc' }, '托盘、菜单、设置页等全部界面文字，所有款式都适用；默认中文版'),
              ]),
            ]),
          ]),

          // 品牌名 *
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['品牌名', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'brandInput', placeholder: '例：逍遥远程' }),
                h('div', { class: 'customize-field-desc' }, '用于窗口标题、安装目录、服务名。支持中文；只可用中英文、数字、-、_，不能含空格或 / \\ : * ? " < > | 等符号，否则客户端安装失败。'),
              ]),
            ]),
          ]),

          // 提示语
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '提示语'),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'tipInput', placeholder: 'ID 和密码下方的灰色小字' }),
              ]),
            ]),
          ]),

          // 连接类型
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '连接类型'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'conn', value: 'agent', checked: 'checked' }), '被控专用（只接收连接）' ]),
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'conn', value: 'dual' }), '双向（完整版标准界面）' ]),
              ]),
            ]),
          ]),

          // 款式
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '款式'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'style', value: 'portable', checked: 'checked' }), '便携版（复制ID和密码）' ]),
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'style', value: 'unattended' }), '无人值守版（安装按钮）' ]),
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'style', value: 'standard' }), '官方标准版（官方界面）' ]),
              ]),
            ]),
          ]),

          // 界面文案
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '界面文案'),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', placeholder: '技术支持行', style: 'margin-bottom:6px;' }),
                h('input', { class: 'form-input', type: 'text', placeholder: '主界面标题', style: 'margin-bottom:6px;' }),
                h('input', { class: 'form-input', type: 'text', placeholder: '主界面说明' }),
                h('div', { class: 'customize-field-desc' }, '三行都空则使用软件默认文案（英文版用官方英文文案）；选「官方标准版」时这三项不生效'),
              ]),
            ]),
          ]),

        ]),

        // ======== 服务器 Tab ========
        h('div', { class: 'customize-tab-panel', 'data-panel': 'server', style: customizeTab === 'server' ? null : 'display:none' }, [
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['ID 服务器', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'idServerInput', value: '182.44.6.48:21116' }),
                h('div', { class: 'customize-field-desc' }, '客户端发现服务的主端口'),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['中继服务器', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'relayInput', value: '182.44.6.48:21117' }),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['API 服务器', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'apiServerInput', value: 'http://182.44.6.48:21114' }),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['服务器密钥', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'keyInput', value: 'WcIytNmPq4M3uwX86PG1jEH9irBi5GrDCl8LU0vUFtE=' }),
                h('div', { class: 'customize-field-desc' }, '必须与服务器 /opt/rustdesk-server/bin/id_ed25519.pub 一致'),
              ]),
            ]),
          ]),
        ]),

        // ======== 安全 Tab ========
        h('div', { class: 'customize-tab-panel', 'data-panel': 'security', style: customizeTab === 'security' ? null : 'display:none' }, [
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '密码策略'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', checked: 'checked' }), '允许空密码连接' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox' }), '强制双重验证（2FA）' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox' }), '连接需经过审批' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', id: 'allowTempPwdChk' }), '允许使用临时密码连接' ]),
                h('div', { class: 'customize-field-desc' }, '勾选后：被控端同时接受临时密码与固定密码访问，控制端连接框下方显示「临时密码」输入框；不勾选则仅接受固定密码'),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '权限控制'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', checked: 'checked' }), '允许文件传输' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', checked: 'checked' }), '允许剪贴板同步' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox' }), '允许远程重启' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox' }), '允许 UAC 提权' ]),
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', id: 'hideCmChk' }), '隐藏CM连接浮窗' ]),
                h('div', { class: 'customize-field-desc' }, '勾选后：被控端连接成功后不再弹出右下角浮动管理窗，可与「允许使用临时密码连接」同时启用'),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '固定访问密码'),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', id: 'fixedPwdInput', placeholder: '留空则随机生成' }),
                h('div', { class: 'customize-field-desc' }, '填入后所有安装此定制包的客户端使用统一访问密码'),
              ]),
            ]),
          ]),
        ]),

        // ======== 网络 Tab ========
        h('div', { class: 'customize-tab-panel', 'data-panel': 'network', style: customizeTab === 'network' ? null : 'display:none' }, [
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, 'NAT 类型'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'nat', checked: 'checked' }), '自动探测' ]),
                h('label', { class: 'customize-radio' }, [ h('input', { type: 'radio', name: 'nat' }), '仅中继（不打洞，速度稍慢）' ]),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, 'UDP 打洞'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', checked: 'checked' }), '启用 UDP 打洞（推荐）' ]),
                h('div', { class: 'customize-field-desc' }, '关闭后仅走 TCP 中继，更稳定但延迟稍高'),
              ]),
            ]),
          ]),
        ]),

        // ======== 外观/其他 Tab ========
        h('div', { class: 'customize-tab-panel', 'data-panel': 'look', style: customizeTab === 'look' ? null : 'display:none' }, [

          // 客户端系统
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, ['客户端系统', h('span', { class: 'req' }, ' *')]),
              h('div', { class: 'customize-field-control' }, [
                h('div', { class: 'customize-radio-group' }, [
                  h('label', { class: 'customize-radio' }, [
                    h('input', { type: 'radio', name: 'os', value: 'windows', checked: 'checked' }),
                    'Windows 系统（.exe 安装包）',
                  ]),
                  h('label', { class: 'customize-radio' }, [
                    h('input', { type: 'radio', name: 'os', value: 'android' }),
                    'Android 系统（.apk 安装包）',
                  ]),
                  h('label', { class: 'customize-radio' }, [
                    h('input', { type: 'radio', name: 'os', value: 'ios' }),
                    'iOS 系统（.ipa 安装包）',
                  ]),
                ]),
                h('div', { class: 'customize-field-desc' }, '选择本次要构建的客户端平台，默认 Windows；iOS 在 macOS 云端编译，未配置苹果签名时产出未签名 .ipa（可用 AltStore / Sideloadly / 企业证书重签后安装）'),
              ]),
            ]),
          ]),

          // 三系统构建
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '三系统构建'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-checkbox' }, [
                  h('input', { type: 'checkbox', id: 'buildAll' }),
                  '同时构建三系统安装包（Windows + Android + iOS）',
                ]),
                h('div', { class: 'customize-field-desc' }, '勾选后一次生成三个平台的安装包，构建时间约为单系统的三倍'),
              ]),
            ]),
          ]),

          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '安装包图标'),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', placeholder: '上传 .ico 文件（可选）' }),
                h('div', { class: 'customize-field-desc' }, '尺寸建议 256x256，支持 .ico / .png'),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '安装包名后缀'),
              h('div', { class: 'customize-field-control' }, [
                h('input', { class: 'form-input', type: 'text', placeholder: '留空用默认格式' }),
                h('div', { class: 'customize-field-desc' }, '默认格式：品牌名-版本号.exe'),
              ]),
            ]),
          ]),
          h('div', { class: 'customize-field' }, [
            h('div', { class: 'customize-field-row' }, [
              h('div', { class: 'customize-field-label' }, '禁止自动更新'),
              h('div', { class: 'customize-field-control' }, [
                h('label', { class: 'customize-checkbox' }, [ h('input', { type: 'checkbox', checked: 'checked' }), '屏蔽官方更新检查（推荐）' ]),
                h('div', { class: 'customize-field-desc' }, '防止客户端连接 RustDesk 官方服务器检查更新'),
              ]),
            ]),
          ]),
        ]),

      ]),

      // 底部提交栏
      h('div', { class: 'customize-submit-bar' }, [
        h('button', { class: 'btn btn-secondary', onclick: () => { clearCustomizeStore(); buildView.show = false; buildView.download = false; gotoPage('client-gen'); } }, '重置表单'),
        h('button', {
          class: 'btn btn-primary',
          id: 'buildSubmitBtn',
          disabled: buildView.running,
          onclick: startBuild,
        }, [
          h('span', { class: 'submit-icon' }, '▶'),
          buildView.running ? '构建中...' : '提交构建',
        ]),
      ]),

      // 构建进度（位于提交构建按钮下方）
      h('div', { class: 'build-progress', id: 'buildProgress', style: buildView.show ? null : 'display:none' }, [
        h('div', { class: 'build-progress-head' }, [
          h('span', { class: 'build-step', id: 'buildStep' }, buildView.step),
          h('span', { class: 'build-pct', id: 'buildPct' }, buildView.pct + '%'),
        ]),
        h('div', { class: 'build-progress-row' }, [
          h('div', { class: 'build-bar' }, [
            h('div', { class: 'build-bar-fill', id: 'buildFill', style: `width:${buildView.pct}%` }),
          ]),
          h('button', {
            class: 'btn btn-primary btn-download',
            id: 'buildDownload',
            style: buildView.download ? null : 'display:none',
            onclick: downloadClient,
          }, '下载客户端'),
        ]),
        buildView.note
          ? h('div', { class: 'build-note', id: 'buildNote' }, buildView.note)
          : h('div', { class: 'build-note', id: 'buildNote' }),
      ]),
    ]),
  ]));

  // 恢复上次填写的定制内容
  applyCustomizeForm();
  // 刷新 / 重新登录后恢复最近一次构建的进度与下载按钮
  restoreBuildState();
}

// ============================================================
// 构建环境配置（GitHub 仓库 / PAT）
// ============================================================
function renderBuildEnv() {
  $('#content').append(pageHead(
    '构建环境配置',
    '云端编译所用的 GitHub 仓库与 Personal Access Token（PAT）。保存后，之后新提交的构建都会使用这里的仓库与令牌；刷新页面会自动回填。'
  ));

  const repoInput = h('input', {
    class: 'form-input', type: 'text', id: 'envRepo',
    placeholder: 'owner/repo，例如 lishan1990/rustdesk-api-server-pro',
  });
  const tokenInput = h('input', {
    class: 'form-input', type: 'password', id: 'envToken',
    placeholder: 'ghp_ 开头的 Personal Access Token', autocomplete: 'off',
  });
  const saveBtn = h('button', { class: 'btn btn-primary' }, '保存配置');

  $('#content').append(h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      h('span', { class: 'card-title' }, 'GitHub 构建环境'),
      h('span', { class: 'text-muted text-sm' }, '修改后仅影响后续构建'),
    ]),
    h('div', { class: 'card-body' }, [
      h('div', { class: 'customize-field' }, [
        h('div', { class: 'customize-field-row' }, [
          h('div', { class: 'customize-field-label' }, ['GitHub 仓库', h('span', { class: 'req' }, ' *')]),
          h('div', { class: 'customize-field-control' }, [
            repoInput,
            h('div', { class: 'customize-field-desc' }, '填写“所有者/仓库名”。该仓库需已包含本项目的构建工作流（.github/workflows/client-build.yml）与源码分支。'),
          ]),
        ]),
      ]),
      h('div', { class: 'customize-field' }, [
        h('div', { class: 'customize-field-row' }, [
          h('div', { class: 'customize-field-label' }, ['PAT 令牌', h('span', { class: 'req' }, ' *')]),
          h('div', { class: 'customize-field-control' }, [
            tokenInput,
            h('div', { class: 'customize-field-desc' }, '默认以星号显示，已保存的令牌会自动回填；保存时会先校验令牌能否访问该仓库。'),
          ]),
        ]),
      ]),
      h('div', { style: 'display:flex;gap:12px;align-items:center;' }, [
        saveBtn,
        h('span', { id: 'envHint', class: 'text-muted text-sm' }, ''),
      ]),
    ]),
  ]));

  // PAT 生成方法
  $('#content').append(h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [h('span', { class: 'card-title' }, 'PAT 生成方法')]),
    h('div', { class: 'card-body' }, [
      h('ol', { style: 'margin:0 0 0 18px;line-height:2;' }, [
        h('li', {}, '登录 GitHub，点击右上角头像 → Settings（设置）'),
        h('li', {}, '左侧菜单拉到最底部 → Developer settings'),
        h('li', {}, 'Personal access tokens → Tokens (classic) → Generate new token (classic)'),
        h('li', {}, ['Note 填 ', h('code', {}, 'rustdesk-build'), '，Expiration 按需要选择（建议 90 天或 No expiration）']),
        h('li', {}, ['权限（Scopes）勾选：', h('code', {}, 'repo'), '（完整仓库权限）和 ', h('code', {}, 'workflow'), '（修改 GitHub Actions 工作流）']),
        h('li', {}, '点击 Generate token，复制生成的 ghp_ 开头令牌（页面只显示一次）'),
        h('li', {}, '粘贴到上方「PAT 令牌」并保存'),
      ]),
      h('div', { class: 'customize-field-desc', style: 'margin-top:12px;' }, [
        '快捷入口：',
        h('a', { href: 'https://github.com/settings/tokens', target: '_blank', rel: 'noopener', style: 'color:var(--brand,#165dff);' }, 'https://github.com/settings/tokens'),
        '。若用 Fine-grained token，需在 Repository access 里选中目标仓库，并授予 Contents: Read and write、Actions: Read and write、Workflows: Read and write。',
      ]),
    ]),
  ]));

  // 载入已保存配置
  api('/api/build/env').then((d) => {
    const e = (d && d.env) || {};
    repoInput.value = e.repoFull || '';
    tokenInput.value = e.token || '';
    if ($('#envHint')) $('#envHint').textContent = e.branch ? `当前分支：${e.branch}` : '';
  }).catch((e) => toast('读取构建环境失败：' + e.message, 'err'));

  saveBtn.addEventListener('click', async () => {
    const repo = repoInput.value.trim();
    const token = tokenInput.value.trim();
    if (!repo) return toast('请填写 GitHub 仓库', 'err');
    if (!token) return toast('请填写 PAT 令牌', 'err');
    saveBtn.disabled = true;
    const oldText = saveBtn.textContent;
    saveBtn.textContent = '校验并保存...';
    try {
      const r = await postJson('/api/build/env', { repo, token });
      tokenInput.value = (r.env && r.env.token) || token;
      if (r.warning) toast(r.warning, 'err');
      else toast('构建环境已保存', 'ok');
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = oldText;
    }
  });
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // 侧边栏点击
  $$('.nav-item').forEach(el => el.addEventListener('click', () => gotoPage(el.dataset.page)));
  // 刷新按钮
  $('#reloadBtn').addEventListener('click', () => gotoPage(currentPage));
  // 自动刷新
  const ar = $('#autoRefresh');
  ar.addEventListener('click', () => {
    autoRefresh = !autoRefresh;
    ar.classList.toggle('on', autoRefresh);
    ar.textContent = autoRefresh ? '⏱ 自动刷新 (ON)' : '⏱ 自动刷新';
    gotoPage(currentPage);
  });

  // 退出登录
  const badge = $('#userBadge');
  if (badge) {
    badge.addEventListener('click', async () => {
      if (!confirm('确定退出登录？')) return;
      try { await postJson('/api/auth/logout', {}); } catch (e) {}
      location.replace('/login.html');
    });
    // 显示当前登录账号首字母
    api('/api/auth/me').then(d => {
      const name = d.username || 'A';
      badge.textContent = name.slice(0, 1).toUpperCase();
      badge.title = `${name} · 点击退出登录`;
    }).catch(() => {});
  }

  gotoPage('overview');
});

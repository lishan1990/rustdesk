// ============================================================
// RustDesk Self-Hosted Admin Dashboard v2
// Express + sql.js (纯 WASM SQLite, 避开 CentOS 7 旧 sqlite 3.7)
// ============================================================
const express = require('express');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 21120;
const DB_PATH = process.env.DB_PATH || '/opt/rustdesk-server/bin/db.sqlite3';
const KEY_PATH = process.env.KEY_PATH || '/opt/rustdesk-server/bin/id_ed25519.pub';

app.use(express.json());

// ============================================================
// 登录鉴权（未登录一律无法访问管理面板与接口）
// 账号密码可写在 auth.json，或通过环境变量 DASH_USER / DASH_PASS 指定
// ============================================================
const AUTH_FILE = process.env.AUTH_FILE || path.join(__dirname, 'auth.json');
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;   // 7 天
const sessions = new Map();                     // token -> { user, exp }
const loginFails = new Map();                   // ip -> { count, first }

function readAuthConfig() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (cfg.username && cfg.password) return cfg;
    }
  } catch (e) {
    console.warn('[AUTH] 读取 auth.json 失败:', e.message);
  }
  return {
    username: process.env.DASH_USER || 'admin',
    password: process.env.DASH_PASS || 'admin123',
  };
}
const authConfig = readAuthConfig();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).rd_sess;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) { sessions.delete(token); return null; }
  return s.user;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 登录页自身需要的资源放行
const PUBLIC_PATHS = new Set(['/login.html', '/logo.png', '/favicon.ico', '/api/auth/login']);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (currentUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: '未登录或会话已过期' });
  return res.redirect('/login.html');
});

// 静态资源加 no-cache (开发阶段方便调试)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// ---------- sql.js 懒加载 ----------
let dbInstance = null;
let dbReady = false;
async function getDb() {
  if (dbInstance) return dbInstance;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  try {
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      dbInstance = new SQL.Database(new Uint8Array(buf));
      dbReady = true;
      console.log('[DB] Loaded SQLite from', DB_PATH);
    } else {
      // 本地开发 fallback: 返回空 DB，runSql 会返回空数组
      dbInstance = new SQL.Database();
      console.warn('[DB] File not found at', DB_PATH, '- running in mock mode');
    }
  } catch (e) {
    console.warn('[DB] Failed to load:', e.message, '- using empty DB');
    dbInstance = new SQL.Database();
  }
  return dbInstance;
}

// 包装 runSql: 永远返回数组, 出错返回 [] 并记日志
async function runSql(sql) {
  try {
    const db = await getDb();
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.warn('[SQL]', sql.slice(0, 80), '->', e.message);
    return [];
  }
}

// ---------- 带参数的只读查询 ----------
async function runSqlP(sql, params) {
  try {
    const db = await getDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.warn('[SQL-P]', sql.slice(0, 80), '->', e.message);
    return [];
  }
}

// ---------- OSS 数据库（2026-11-10 换官方 OSS 服务端后，设备数据在 db_v2.sqlite3） ----------
const OSS_DB_PATH = process.env.OSS_DB_PATH || '/opt/rustdesk-server/bin/db_v2.sqlite3';
// OSS 库是 WAL 模式且 hbbs 常驻写入：sql.js 只能读主文件、看不到 WAL 里的新数据，
// 所以统一用 sqlite3 CLI 读（自动合并 WAL），实时且与 hbbs 并发安全
function runSqlOss(sql) {
  try {
    const out = execFileSync(SQLITE3_BIN, [OSS_DB_PATH, '-json', sql],
      { timeout: 15000, maxBuffer: 32 * 1024 * 1024 }).toString();
    const arr = JSON.parse(out || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[SQL-OSS]', String(sql).slice(0, 80), '->', e.message);
    return [];
  }
}

// ---------- BLOB <-> HEX 工具 ----------
function hexOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (v.constructor === Uint8Array) return Buffer.from(v).toString('hex');
  if (typeof v === 'object') {
    // sql.js 有时返回 {"0":1,...} 形式的对象
    const bytes = Object.keys(v).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => v[k]);
    if (bytes.length) return Buffer.from(bytes).toString('hex');
  }
  return '';
}
function blobOfHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
function newGuid() { return new Uint8Array(crypto.randomBytes(16)); }

// 用官方工具写密码哈希（hbbs 的哈希算法与标准 bcrypt 不同，必须用它）
function setPasswordByUtils(username, password) {
  execFileSync('/opt/rustdesk-server/bin/rustdesk-utils', ['set_password', username, password], {
    cwd: '/opt/rustdesk-server/bin', timeout: 15000, stdio: 'ignore',
  });
}

// ---------- 写数据库（串行化：停 hbbs → 修改 → 启动） ----------
// hbbs 独占 SQLite 文件，且使用 WAL；sql.js 是内存库，所以写操作必须停服后落盘
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let writeChain = Promise.resolve();
let hbbsBusy = false;

function enqueue(fn) {
  const p = writeChain.then(fn, fn);
  writeChain = p.catch(() => {});
  return p;
}

// 在写库的 mutator 里做带参查询
function dbQuery(db, sql, params) {
  const st = db.prepare(sql);
  try {
    if (params) st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}

// 停服后把 db.sqlite3-wal 合并回主库（json 里 rustdesk-utils 写的密码哈希就落在 WAL）
// 注意：系统自带 sqlite3 3.7.17 无法解析该库 schema，必须用 3.45 版
const SQLITE3_BIN = '/opt/sqlite/bin/sqlite3';
function checkpointMainDb() {
  execFileSync(SQLITE3_BIN, [DB_PATH, 'PRAGMA wal_checkpoint(TRUNCATE);'], {
    timeout: 10000, stdio: 'ignore',
  });
}

function withDbWrite(mutator, opts = {}) {
  return enqueue(async () => {
    hbbsBusy = true;
    try {
      // 2026-11-10 起 hbbs 为官方 OSS 版，不再使用 db.sqlite3，写操作无需停启服务
      // 仍先 checkpoint 一次，保证读到的是此前落盘的完整数据
      checkpointMainDb();
      console.log('[DBW] writing (no service restart, OSS hbbs does not use this file)...');
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const buf = fs.readFileSync(DB_PATH);
      const db = new SQL.Database(new Uint8Array(buf));
      let result;
      try {
        result = mutator(db);
        const out = Buffer.from(db.export());
        // 备份（仅保留最近一份）
        try { fs.writeFileSync(DB_PATH + '.web-bak', buf); } catch {}
        // 清掉旧 WAL/SHM，避免与主文件不一致
        for (const suf of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + suf); } catch {} }
        fs.writeFileSync(DB_PATH + '.web-new', out);
        fs.renameSync(DB_PATH + '.web-new', DB_PATH);
        if (typeof opts.afterWrite === 'function') opts.afterWrite();
      } finally {
        try { db.close(); } catch {}
      }
      console.log('[DBW] written ok');
      return result;
    } finally {
      dbInstance = null; dbReady = false;
      hbbsBusy = false;
    }
  });
}

// ---------- 安全 shell 执行 (用 /bin/bash -c, 5s 超时) ----------
function sh(cmd) {
  try {
    return execFileSync('bash', ['-c', cmd], {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    // stderr 也拿一下
    return (e.stderr || '').toString().trim() || '';
  }
}

// ============================================================
// API
// ============================================================

// ---------- 登录 / 登出 ----------
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (rec && rec.count >= 5 && now - rec.first < 5 * 60 * 1000) {
    return res.status(429).json({ error: '密码错误次数过多，请 5 分钟后再试' });
  }
  const username = String((req.body || {}).username || '');
  const password = String((req.body || {}).password || '');
  if (!safeEqual(username, authConfig.username) || !safeEqual(password, authConfig.password)) {
    const cur = rec && now - rec.first < 5 * 60 * 1000 ? rec : { count: 0, first: now };
    cur.count += 1;
    loginFails.set(ip, cur);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user: authConfig.username, exp: now + SESSION_TTL });
  res.setHeader('Set-Cookie',
    `rd_sess=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`);
  res.json({ ok: true, username: authConfig.username });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).rd_sess;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'rd_sess=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ ok: true, username: user });
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, port: PORT }));

// 服务器状态
app.get('/api/status', (req, res) => {
  // 2026-11-10 起 hbbs/hbbr 以 Docker 容器运行（secure-tcp 版），systemd 单元仅作回滚保留
  const dockerRunning = (name) => sh(`docker inspect -f '{{.State.Running}}' ${name} 2>/dev/null`).trim() === 'true';
  const dockerRestart = (name) => sh(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${name} 2>/dev/null`).trim();
  const hbbsActive = dockerRunning('rustdesk-hbbs') || sh('systemctl is-active rustdesk-hbbs').includes('active');
  const hbbrActive = dockerRunning('rustdesk-hbbr') || sh('systemctl is-active rustdesk-hbbr').includes('active');
  const hbbsEnabled = dockerRestart('rustdesk-hbbs') === 'unless-stopped' || sh('systemctl is-enabled rustdesk-hbbs').includes('enabled');
  const hbbrEnabled = dockerRestart('rustdesk-hbbr') === 'unless-stopped' || sh('systemctl is-enabled rustdesk-hbbr').includes('enabled');
  const apiActive = sh('systemctl is-active rustdesk-api').includes('active');
  const apiEnabled = sh('systemctl is-enabled rustdesk-api').includes('enabled');
  const ports = sh("ss -lntup 2>/dev/null | grep -E ':2111[4-9]' || echo ''").split('\n').filter(Boolean);
  const activeConns = sh("ss -tn 2>/dev/null | grep -E ':2111[4-9]' | wc -l");
  const key = fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8').trim() : '';

  res.json({
    server: {
      ip: '182.44.6.48',
      hostname: sh('hostname'),
      os: sh("grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'"),
      arch: sh('uname -m'),
      uptime: sh("uptime -p 2>/dev/null || cat /proc/uptime | awk '{d=int($1/86400);h=int(($1-d*86400)/3600);print d\"d \"h\"h\"}'"),
      load: sh("cat /proc/loadavg | awk '{print $1, $2, $3}'"),
      memory: sh("free -m | awk 'NR==2{printf \"%s / %s MB\", $3, $2}'"),
      disk: sh("df -h / | awk 'NR==2{printf \"%s / %s (%s)\", $3, $2, $5}'"),
      activeConnections: parseInt(activeConns || '0') || 0,
    },
    services: {
      hbbs: { active: hbbsActive, enabled: hbbsEnabled, version: '1.1.17-secure-tcp (Docker)', docker: true },
      hbbr: { active: hbbrActive, enabled: hbbrEnabled, version: '1.1.17-secure-tcp (Docker)', docker: true },
      api: { active: apiActive, enabled: apiEnabled, version: '2.7' },
    },
    config: {
      idServer: '182.44.6.48:21116',
      relayServer: '182.44.6.48:21117',
      apiServer: 'http://182.44.6.48:21114', // lejianwen/rustdesk-api，客户端登录/地址簿
      key: key || '(missing)',
      publicPorts: [
        'TCP 21114 API/Web',
        'TCP 21115 NAT test',
        'TCP+UDP 21116 hbbs main',
        'TCP 21117 hbbr main',
        'TCP 21118 hbbs WebSocket',
        'TCP 21119 hbbr WebSocket',
        'TCP 21120 Dashboard (本面板)',
      ],
    },
    ports,
  });
});

// 设备列表
// FIX 2026-11-09: hbbs 数据库中 last_online / created_at 等时间字段按 UTC 存储，
// 原代码直接返回原始字符串，页面按本地时间显示 → 比实际早 8 小时（如 19:07 显示 11:07）。
// 统一在接口层把 UTC 转成服务器本地时间。
function utc2local(s) {
  if (!s || typeof s !== 'string') return s || '-';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 审计日志等接口直接透传整行（SELECT *），这里按列名统一转换所有 UTC 时间字段。
// 只处理「列名像时间」且「值符合 UTC 时间格式」的字段，避免误伤备注/IP 等普通文本。
const UTC_TIME_COL = /(^|_)(at|time|date|timestamp|online|login)$|_time$|_at$/i;
function convertUtcFields(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = (UTC_TIME_COL.test(k) && typeof v === 'string') ? utc2local(v) : v;
  }
  return out;
}

// 本地日期字符串（YYYY-MM-DD），用于趋势图按服务器本地日分组，避免 UTC 日界早 8 小时
function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 设备列表（2026-11-10 起读 OSS 服务端 db_v2.sqlite3 的 peer 表）
// OSS peer 表列: guid/id/uuid/pk/created_at/user/status/note/info，info 为 {"ip": ...}
app.get('/api/devices', async (req, res) => {
  const rows = await runSqlOss(`SELECT id, note, status, created_at, info FROM "peer" ORDER BY created_at DESC LIMIT 200`);
  // OSS 服务端只记录 ip；主机名/操作系统从旧 Pro 库按设备 ID 回填（迁移前注册过的设备才有）
  let legacy = {};
  try {
    const legacyRows = await runSql(`SELECT id, info FROM "peer"`);
    for (const r of legacyRows) {
      try { legacy[r.id] = typeof r.info === 'string' ? JSON.parse(r.info) : (r.info || {}); } catch {}
    }
  } catch {}
  const list = rows.map(r => {
    let info = {};
    try {
      if (typeof r.info === 'string' && r.info.startsWith('{')) info = JSON.parse(r.info);
    } catch {}
    const ip = (info.ip || '').replace(/^::ffff:/, '') || (legacy[r.id] || {}).ip || '-';
    const lg = legacy[r.id] || {};
    return {
      id: r.id || '-',                              // RustDesk ID (如 1255106694)
      name: r.note || lg.device_name || '-',        // 备注 > 旧库设备名
      hostname: lg.device_name || '-',
      os: lg.os || '-',
      username: lg.username || '-',
      ip,
      createTime: utc2local(r.created_at),
      lastSeen: utc2local(r.created_at),            // OSS 客户端注册时刷新 created_at
      status: r.status == null ? 1 : r.status, // OSS peer.status 为 NULL，视为正常
      hasNote: !!r.note,
    };
  });
  res.json({ total: rows.length, devices: list });
});

// 设备备注（写 OSS peer.note；用 sqlite3 CLI 在线写，与 hbbs 的 WAL 共存）
app.post('/api/devices/rename', (req, res) => {
  const id = String((req.body || {}).id || '').trim().replace(/'/g, '');
  const note = String((req.body || {}).note || '').trim().slice(0, 300).replace(/'/g, "''");
  if (!id) return res.status(400).json({ error: '缺少设备 ID' });
  try {
    execFileSync(SQLITE3_BIN, [OSS_DB_PATH,
      `PRAGMA wal_checkpoint(TRUNCATE); UPDATE peer SET note = '${note}' WHERE id = '${id}';`],
      { timeout: 10000, stdio: 'ignore' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 审计日志
app.get('/api/audits', async (req, res) => {
  const type = (req.query.type || 'conn').toString();
  const limit = parseInt(req.query.limit) || 100;
  const table = {
    conn: 'audit_conn', file: 'audit_file',
    alarm: 'audit_alarm', console: 'audit_console',
  }[type] || 'audit_conn';
  const rows = await runSql(`SELECT * FROM "${table}" ORDER BY 1 DESC LIMIT ${limit}`);
  // 审计表 created_at / end_time 等均为 UTC，转成服务器本地时间再展示
  res.json({ table, count: rows.length, rows: rows.map(convertUtcFields) });
});

// 系统用户
app.get('/api/users', async (req, res) => {
  const rows = await runSql(`SELECT guid, name, email, status, role, created_at, password_set_at FROM "user" ORDER BY created_at`);
  const users = rows.map(r => ({
    guid: hexOf(r.guid),
    username: r.name,
    email: r.email || '-',
    status: r.status,
    role: r.role,
    createdAt: utc2local(r.created_at),
    passwordSetAt: utc2local(r.password_set_at),
  }));
  res.json({ count: users.length, users });
});

// 注册用户
app.post('/api/users/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim() || null;
  if (!name || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) return res.status(400).json({ error: '用户名只能包含字母、数字、_ . -，长度 2-32' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });

  try {
    const result = await withDbWrite((db) => {
      const exists = dbQuery(db, `SELECT name FROM "user" WHERE name = ?`, [name]);
      if (exists.length) throw new Error('用户名已存在');
      const team = db.exec(`SELECT guid FROM team LIMIT 1`);
      const grp = db.exec(`SELECT guid FROM grp WHERE type = 0 LIMIT 1`);
      const teamGuid = team.length ? team[0].values[0][0] : null;
      const grpGuid = grp.length ? grp[0].values[0][0] : null;
      if (!teamGuid || !grpGuid) throw new Error('缺少默认 team/grp，无法创建用户');
      db.run(
        `INSERT INTO "user" (guid,name,email,phone,password,note,status,grp,created_at,team,role,info,password_set_at)
         VALUES (?,?,?,NULL,'',NULL,1,?,datetime('now'),?,1,'{}',NULL)`,
        [newGuid(), name, email, new Uint8Array(grpGuid), new Uint8Array(teamGuid)]
      );
      return name;
    }, {
      // 密码哈希必须由官方 rustdesk-utils 生成，否则 hbbs 无法通过登录校验
      afterWrite: () => setPasswordByUtils(name, password),
    });
    res.json({ ok: true, username: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 修改密码
app.post('/api/users/password', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  const password = String(req.body.password || '');
  if (!guid) return res.status(400).json({ error: '无效的用户 GUID' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  try {
    let username = '';
    await withDbWrite((db) => {
      const rows = dbQuery(db, `SELECT name FROM "user" WHERE guid = ?`, [guid]);
      if (!rows.length) throw new Error('用户不存在');
      username = rows[0].name;
    }, {
      afterWrite: () => setPasswordByUtils(username, password),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 禁用 / 解禁账户
app.post('/api/users/status', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  const status = Number(req.body.status) === 1 ? 1 : 0;
  if (!guid) return res.status(400).json({ error: '无效的用户 GUID' });
  try {
    await withDbWrite((db) => {
      // 至少保留一个可用管理员，避免把自己锁死
      if (status === 0) {
        const admins = db.exec(`SELECT COUNT(*) FROM "user" WHERE role = 1 AND status = 1`);
        const n = admins.length ? admins[0].values[0][0] : 0;
        const target = dbQuery(db, `SELECT role, status FROM "user" WHERE guid = ?`, [guid]);
        const row = target[0] || {};
        const isAdminActive = row.role === 1 && row.status === 1;
        if (isAdminActive && n <= 1) throw new Error('不能禁用最后一个管理员账户');
      }
      db.run(`UPDATE "user" SET status = ? WHERE guid = ?`, [status, guid]);
    });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 封禁 / 解禁设备
app.post('/api/devices/status', async (req, res) => {
  const id = String(req.body.id || '').trim();
  const status = Number(req.body.status) === 1 ? 1 : 0;
  if (!id) return res.status(400).json({ error: '缺少设备 ID' });
  try {
    return res.status(400).json({ error: 'OSS 版服务端不支持封禁设备，该功能已停用' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 地址簿 ----------
// 地址簿 = ab 表；地址簿里的设备 = ab_peer 表。直接写库，客户端通过 hbbs 读取后即可同步显示。
app.get('/api/ab/list', async (req, res) => {
  const rows = await runSql(`SELECT a.guid, a.name, a.note, a.personal, a.created_at,
      (SELECT COUNT(*) FROM ab_peer p WHERE p.ab = a.guid AND p.deleted_at IS NULL) AS peerCount
    FROM ab a ORDER BY a.created_at`);
  res.json({
    count: rows.length,
    books: rows.map(r => ({
      guid: hexOf(r.guid),
      name: r.name,
      note: r.note || '',
      personal: r.personal,
      peerCount: r.peerCount || 0,
      createdAt: utc2local(r.created_at),
    })),
  });
});

app.post('/api/ab/create', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const note = String(req.body.note || '').trim() || null;
  if (!name) return res.status(400).json({ error: '地址簿名称必填' });
  if (name.length > 100) return res.status(400).json({ error: '名称不能超过 100 字符' });
  try {
    const guid = await withDbWrite(db => {
      const owners = db.exec(`SELECT guid FROM "user" WHERE role = 1 ORDER BY created_at LIMIT 1`);
      const fallback = db.exec(`SELECT guid FROM "user" ORDER BY created_at LIMIT 1`);
      const ownerRow = owners.length ? owners[0].values[0][0] : (fallback.length ? fallback[0].values[0][0] : null);
      if (!ownerRow) throw new Error('数据库中没有用户，无法创建地址簿');
      const g = newGuid();
      db.run(
        `INSERT INTO ab (guid,name,owner,personal,note,created_at,info) VALUES (?,?,?,1,?,datetime('now'),'{}')`,
        [g, name, new Uint8Array(ownerRow), note]
      );
      // 同时建一个同名分组，便于客户端按分组展示
      return hexOf(g);
    });
    res.json({ ok: true, guid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ab/update', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  const name = String(req.body.name || '').trim();
  const note = String(req.body.note || '').trim() || null;
  if (!guid) return res.status(400).json({ error: '无效的地址簿 GUID' });
  if (!name) return res.status(400).json({ error: '地址簿名称必填' });
  try {
    await withDbWrite(db => {
      db.run(`UPDATE ab SET name = ?, note = ? WHERE guid = ?`, [name, note, guid]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ab/delete', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  if (!guid) return res.status(400).json({ error: '无效的地址簿 GUID' });
  try {
    await withDbWrite(db => {
      db.run(`DELETE FROM ab_peer WHERE ab = ?`, [guid]);
      db.run(`DELETE FROM ab_tag WHERE ab = ?`, [guid]);
      db.run(`DELETE FROM ab_rule WHERE ab = ?`, [guid]);
      db.run(`DELETE FROM ab WHERE guid = ?`, [guid]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 地址簿内的设备
app.get('/api/ab/peers', async (req, res) => {
  const ab = blobOfHex(String(req.query.ab || ''));
  if (!ab) return res.status(400).json({ error: '缺少地址簿 GUID' });
  const rows = await runSqlP(
    `SELECT p.guid, p.peer, p.id, p.note, p.created_at, p.info,
       (SELECT pe.status FROM peer pe WHERE pe.id = p.id LIMIT 1) AS onlineStatus
     FROM ab_peer p WHERE p.ab = ? AND p.deleted_at IS NULL ORDER BY p.created_at`,
    [ab]
  );
  res.json({
    count: rows.length,
    peers: rows.map(r => {
      let info = {};
      try { if (typeof r.info === 'string') info = JSON.parse(r.info) || {}; } catch {}
      return {
        guid: hexOf(r.guid),
        id: r.id || '',
        note: r.note || '',
        tags: info.tags || [],
        peerGuid: hexOf(r.peer),
        status: r.onlineStatus,
        createdAt: utc2local(r.created_at),
      };
    }),
  });
});

app.post('/api/ab/peers/add', async (req, res) => {
  const ab = blobOfHex(String(req.body.ab || ''));
  const id = String(req.body.id || '').trim();
  const note = String(req.body.note || '').trim() || null;
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t)).slice(0, 10) : [];
  if (!ab) return res.status(400).json({ error: '缺少地址簿 GUID' });
  if (!id) return res.status(400).json({ error: '设备 ID 必填' });
  try {
    await withDbWrite(db => {
      const peerRow = dbQuery(db, `SELECT guid FROM peer WHERE id = ?`, [id]);
      const peerGuid = peerRow.length ? new Uint8Array(peerRow[0].guid) : null;
      const info = JSON.stringify({ tags });
      db.run(
        `INSERT INTO ab_peer (guid,ab,peer,id,note,created_at,deleted_at,info) VALUES (?,?,?,?,?,datetime('now'),NULL,?)`,
        [newGuid(), ab, peerGuid, id, note, info]
      );
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ab/peers/update', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  const note = String(req.body.note || '').trim() || null;
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t)).slice(0, 10) : [];
  if (!guid) return res.status(400).json({ error: '无效的设备条目 GUID' });
  try {
    await withDbWrite(db => {
      db.run(`UPDATE ab_peer SET note = ?, info = ? WHERE guid = ?`, [note, JSON.stringify({ tags }), guid]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ab/peers/delete', async (req, res) => {
  const guid = blobOfHex(String(req.body.guid || ''));
  if (!guid) return res.status(400).json({ error: '无效的设备条目 GUID' });
  try {
    await withDbWrite(db => {
      db.run(`DELETE FROM ab_peer WHERE guid = ?`, [guid]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 实时连接
app.get('/api/connections', (req, res) => {
  const out = sh("ss -tnp 2>/dev/null | grep -E ':2111[4-9]' || echo ''");
  const rows = out.split('\n').filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return {
      state: parts[0] || '-',
      local: parts[3] || '-',
      peer: parts[4] || '-',
      process: parts.slice(5).join(' '),
    };
  });
  res.json({ count: rows.length, connections: rows });
});

// 活跃客户端（从 hbbs Punch hole 日志 + ss 解析，不依赖 peer 表）
app.get('/api/active-clients', (req, res) => {
  // 1. hbbs 日志里的 Punch hole 记录（最近 24h）
  const holeLog = sh("journalctl -u rustdesk-hbbs --since '24 hours ago' --no-pager 2>/dev/null | grep 'Punch hole' | tail -50");
  // 2. ss 里到 hbbr:21117 的 TCP 连接
  const ssHbbr = sh("ss -tnp 2>/dev/null | grep ':21117.*ESTAB' || echo ''");
  // 3. ss 里到 hbbs:21116 的 TCP 连接
  const ssHbbs = sh("ss -tnp 2>/dev/null | grep ':21116.*ESTAB' || echo ''");

  // 解析 Punch hole: "Punch hole hs00011 116.208.25.238:59853 request from 112.96.231.21:22748"
  const punchLines = holeLog.split('\n').filter(Boolean);
  const clients = new Map(); // key = clientId

  punchLines.forEach(line => {
    // 从行尾提取时间戳
    const timeMatch = line.match(/^(\w+ \d+ \d+:\d+:\d+)/);
    const time = timeMatch ? timeMatch[1] : '-';
    // Punch hole hs00011 116.208.25.238:59853 request from 112.96.231.21:22748
    const m = line.match(/Punch hole (\S+)\s+(\S+)\s+request from (\S+)/);
    if (m) {
      const id = m[1];
      const relayPeer = m[2];   // 中继端
      const fromPeer = m[3];    // 请求发起方
      if (!clients.has(id)) {
        clients.set(id, { id, lastSeen: time, peers: new Set(), sources: [] });
      }
      const c = clients.get(id);
      c.lastSeen = time;
      if (relayPeer) c.peers.add(relayPeer);
      if (fromPeer) c.peers.add(fromPeer);
      c.sources.push({ time, relayPeer, fromPeer });
    }
  });

  // 解析 ss TCP 连接补充实时状态
  const ssHbbrPeers = new Set();
  ssHbbr.split('\n').filter(Boolean).forEach(line => {
    const parts = line.split(/\s+/);
    const peer = parts[4]; // peer:port
    if (peer) {
      const ip = peer.replace(/:\d+$/, '');
      ssHbbrPeers.add(ip);
    }
  });

  // 转成数组
  const list = [...clients.values()].map(c => ({
    id: c.id,
    lastSeen: c.lastSeen,
    peers: [...new Set(c.peers)],
    peerIps: [...new Set([...c.peers].map(p => p.replace(/:\d+$/, '')))],
    viaHbbrNow: [...c.peers].some(p => ssHbbrPeers.has(p.replace(/:\d+$/, ''))),
    punchCount: c.sources.length,
  }));

  // 按最后活跃时间排序（Punch hole 越新越靠前）
  list.sort((a, b) => b.punchCount - a.punchCount);

  // 也从 ss 提取 hbbr 当前所有 ESTAB 连接的 peer IP
  const hbbrNow = ssHbbr.split('\n').filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    return { state: parts[0], local: parts[3], peer: parts[4] };
  });

  res.json({
    punchClients: list,
    hbbrConnectionsNow: hbbrNow,
    totalPunch24h: punchLines.length,
  });
});

// 实时日志
app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  const svc = (req.query.svc || 'rustdesk-hbbs').toString();
  const since = (req.query.since || '30 minutes ago').toString();
  const log = sh(`journalctl -u ${svc} --since '${since}' -n ${lines} --no-pager 2>/dev/null | tail -n ${lines}`);
  res.json({ service: svc, log: log.split('\n').filter(Boolean) });
});

// ---------- 运行总览统计 ----------
app.get('/api/overview', async (req, res) => {
  // 并行查所有需要的计数
  const [
    users, enabledUsers, peers, activeConns,
    todayConns, todayFiles, alarms, todayAlarms,
    connCount, fileCount, alarmCount, consoleCount,
  ] = await Promise.all([
    runSql('SELECT COUNT(*) AS c FROM "user"'),
    runSql('SELECT COUNT(*) AS c FROM "user" WHERE status > 0 OR password_set_at IS NOT NULL'),
    runSql('SELECT COUNT(*) AS c FROM "peer"'),
    runSql('SELECT COUNT(*) AS c FROM "peer" WHERE status = 1 AND last_online > datetime("now", "-30 minutes")'),
    runSql('SELECT COUNT(*) AS c FROM "audit_conn" WHERE created_at > datetime("now", "-1 day")'),
    runSql('SELECT COUNT(*) AS c FROM "audit_file" WHERE created_at > datetime("now", "-1 day")'),
    runSql('SELECT COUNT(*) AS c FROM "audit_alarm"'),
    runSql('SELECT COUNT(*) AS c FROM "audit_alarm" WHERE created_at > datetime("now", "-1 day")'),
    runSql('SELECT COUNT(*) AS c FROM "audit_conn"'),
    runSql('SELECT COUNT(*) AS c FROM "audit_file"'),
    runSql('SELECT COUNT(*) AS c FROM "audit_alarm"'),
    runSql('SELECT COUNT(*) AS c FROM "audit_console"'),
  ]);

  const get = (rows) => (rows && rows[0] && rows[0].c) || 0;

  // 服务器实时连接数 (ss)
  const ssConns = parseInt(sh("ss -tn 2>/dev/null | grep -E ':2111[4-9]' | wc -l") || '0') || 0;

  res.json({
    users: get(users),
    enabledUsers: Math.max(get(enabledUsers), 0),
    devices: get(peers),
    onlineDevices: Math.min(get(peers), get(activeConns)),
    activeConnections: ssConns || get(connCount),
    todayConnections: get(todayConns) || get(connCount),
    todayFiles: get(todayFiles) || get(fileCount),
    pendingAlarms: get(todayAlarms) || get(alarms),
    // 附加数据供趋势图用
    auditTotals: {
      conn: get(connCount),
      file: get(fileCount),
      alarm: get(alarmCount),
      console: get(consoleCount),
    }
  });
});

// ---------- 趋势数据 ----------
app.get('/api/trends', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  // 生成日期数组（近 N 天，按服务器本地日期，不用 toISOString 的 UTC 日期）
  const dates = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(localDateStr(d));
  }

  // hbbs 写库时间为 UTC；按本地日分组需要先把 UTC 时间平移到服务器时区
  const tzMinutes = -new Date().getTimezoneOffset(); // UTC+8 => +480
  const tzMod = `${tzMinutes >= 0 ? '+' : ''}${tzMinutes} minutes`;

  // 查各表按天聚合（SQLite strftime）
  // table: 不带引号的表名，timeCol: 时间列（真实列名）
  const tryByDay = async (table, timeCol) => {
    const quotedTable = /^(user|peer)$/.test(table) ? `"${table}"` : table;
    const rows = await runSql(
      `SELECT strftime('%Y-%m-%d', ${timeCol}, '${tzMod}') AS day, COUNT(*) AS c FROM ${quotedTable} ` +
      `WHERE ${timeCol} > datetime('now', '-${days} days') GROUP BY day`
    );
    return rows;
  };

  const [connRows, fileRows, alarmRows, userRows, peerRows] = await Promise.all([
    tryByDay('audit_conn',  'created_at'),
    tryByDay('audit_file',   'created_at'),
    tryByDay('audit_alarm',  'created_at'),
    tryByDay('user',         'created_at'),
    tryByDay('peer',         'created_at'),
  ]);

  const toMap = (rows) => {
    const m = {};
    rows.forEach(r => { if (r.day) m[r.day] = r.c; });
    return m;
  };

  const connMap = toMap(connRows);
  const fileMap = toMap(fileRows);
  const alarmMap = toMap(alarmRows);
  const userMap = toMap(userRows);
  const peerMap = toMap(peerRows);

  // 计算累计（新增用户/新增设备用累计值）
  let userCum = 0, peerCum = 0;
  const series = dates.map(d => {
    // 当天的值（若无则 0）
    const alarm = alarmMap[d] || 0;
    const file = fileMap[d] || 0;
    const conn = connMap[d] || 0;
    // 累计新增（粗略估计：当天有记录就算新增）
    if (userMap[d]) userCum += userMap[d];
    if (peerMap[d]) peerCum += peerMap[d];
    return {
      date: d,
      alarm,
      file,
      connection: conn,
      newUsers: userCum,
      newDevices: peerCum,
    };
  });

  res.json({ days, dates, series });
});

// 密钥
app.get('/api/keypair', (req, res) => {
  const pub = fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8').trim() : '';
  const privPath = KEY_PATH.replace('.pub', '');
  const privExists = fs.existsSync(privPath);
  res.json({
    publicKey: pub,
    privateKeyExists: privExists,
    privateKeyPath: privExists ? privPath : '',
    privateKeyPerm: privExists ? sh(`stat -c '%a' ${privPath}`) : '',
  });
});

// ---------- WAL Checkpoint ----------
// 2026-11-10 起 hbbs 为官方 OSS 版，设备数据写入 db_v2.sqlite3-wal；
// 面板用 sql.js 只读主文件，需定期在线 checkpoint 才能读到最新设备列表。
// （原 Pro 库 db.sqlite3 已不再被 hbbs 使用，保留旧数据供审计页查看历史。）
let checkpointing = false;
function checkpointWAL() {
  if (checkpointing) return Promise.resolve();
  checkpointing = true;
  return enqueue(async () => {
    try {
      const ossWal = OSS_DB_PATH + '-wal';
      const ossSize = fs.existsSync(ossWal) ? fs.statSync(ossWal).size : 0;
      if (ossSize < 10240) return;
      console.log(`[WAL] OSS checkpoint ${Math.round(ossSize/1024)}KB... (online)`);
      execFileSync(SQLITE3_BIN, [OSS_DB_PATH, 'PRAGMA wal_checkpoint(TRUNCATE);'], {
        timeout: 10000, stdio: 'ignore',
      });
      ossDbInstance = null;
      console.log('[WAL] OSS checkpoint done (online)');
    } catch(e) {
      console.warn('[WAL] checkpoint fail (will retry next round):', e.message);
    } finally {
      checkpointing = false;
    }
  });
}
// 每 30 秒检查一次
setInterval(checkpointWAL, 30000);
console.log('[WAL] OSS checkpoint timer started (online mode, every 30s)');

const https = require('https');

// ============================================================
// 定制客户端构建（GitHub Actions 云端编译）
// 配置在编译期写入客户端二进制（custom-embed.txt → HARD_SETTINGS），
// 安装后不含明文配置文件；「网络设置」页被隐藏，解锁按钮不可用。
// ============================================================
const BUILD_DIR = process.env.BUILD_DIR || '/opt/rustdesk-dashboard/builds';
try { fs.mkdirSync(BUILD_DIR, { recursive: true }); } catch (e) {}
const CLIENT_VERSION = '1.5.1';
const GH_CONF_FILE = process.env.GH_CONF_FILE || path.join(__dirname, 'github.json');
const buildJobs = new Map();

// ---------- 构建历史（持久化到磁盘，刷新/重新登录后仍可查看与下载） ----------
const BUILD_HISTORY_FILE = process.env.BUILD_HISTORY_FILE || path.join(__dirname, 'build-history.json');
const HISTORY_LIMIT = 200;

function readBuildHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(BUILD_HISTORY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeBuildHistory(list) {
  const arr = list.slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, HISTORY_LIMIT);
  try {
    fs.writeFileSync(BUILD_HISTORY_FILE + '.tmp', JSON.stringify(arr, null, 2), { mode: 0o600 });
    fs.renameSync(BUILD_HISTORY_FILE + '.tmp', BUILD_HISTORY_FILE);
    try { execFileSync('chmod', ['600', BUILD_HISTORY_FILE], { stdio: 'ignore' }); } catch (e) {}
  } catch (e) {
    console.warn('[BUILD] write history failed:', e.message);
  }
}

function historyFilePath(entry) {
  return path.join(BUILD_DIR, entry.id, entry.fileName || '');
}

function isHistoryAlive(entry) {
  try { return !!entry.fileName && fs.existsSync(historyFilePath(entry)); } catch (e) { return false; }
}

function upsertBuildHistory(entry) {
  if (!entry || !entry.id) return;
  const list = readBuildHistory().filter(e => e.id !== entry.id);
  list.unshift(entry);
  writeBuildHistory(list);
}

function recordBuildHistory(job) {
  const opts = job.opts || {};
  upsertBuildHistory({
    id: job.id,
    brand: cleanBrand(opts.brand) || 'RustDesk',
    lang: opts.lang === 'en' ? 'en' : 'zh',
    conn: opts.conn === 'dual' ? 'dual' : 'agent',
    style: opts.style === 'standard' ? 'standard' : (opts.style === 'unattended' ? 'unattended' : 'portable'),
    os: opts.both ? 'both' : (opts.os === 'android' ? 'android' : 'windows'),
    createdAt: job.createdAt,
    successAt: Date.now(),
    fileName: job.fileName,
    size: job.size || 0,
  });
}

// 启动时扫描 builds 目录，把遗留的成品重新登记，避免服务重启后无法下载
function restoreBuilds() {
  try {
    if (!fs.existsSync(BUILD_DIR)) return;
    for (const dir of fs.readdirSync(BUILD_DIR)) {
      if (buildJobs.has(dir)) continue;
      const abs = path.join(BUILD_DIR, dir);
      let st;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      let files = [];
      try { files = fs.readdirSync(abs).filter(f => fs.statSync(path.join(abs, f)).isFile()); } catch (e) { continue; }
      if (!files.length) continue;
      const f = files[0];
      const fst = fs.statSync(path.join(abs, f));
      buildJobs.set(dir, {
        id: dir,
        status: 'success',
        progress: 100,
        step: '\u6784\u5efa\u5b8c\u6210',
        fileName: f,
        file: path.join(abs, f),
        size: fst.size,
        createdAt: fst.mtimeMs,
        updatedAt: Date.now(),
        downloaded: false,
      });
      console.log('[BUILD] restore leftover artifact:', dir, f);
      // 历史里没有这条记录时补登（旧产物没有保存定制参数，未知项留空）
      if (!readBuildHistory().some(e => e.id === dir)) {
        const m = f.match(/^(.+?)-[0-9]+\.[0-9]+\.[0-9]+/);
        upsertBuildHistory({
          id: dir,
          brand: m ? m[1] : f,
          lang: null,
          conn: null,
          style: null,
          os: /android/i.test(f) ? 'android' : (/双系统/.test(f) ? 'both' : 'windows'),
          createdAt: fst.mtimeMs,
          successAt: fst.mtimeMs,
          fileName: f,
          size: fst.size,
        });
      }
    }
  } catch (e) {
    console.warn('[BUILD] restore failed:', e.message);
  }
}

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 900000, ...opts }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });
}

function cleanBrand(name) {
  return String(name || '').replace(/[/\\:*?"<>|\r\n\t]/g, '').trim().slice(0, 40);
}

function normalizeHost(h) {
  const s = String(h || '').trim().replace(/^https?:\/\//, '');
  return s.replace(/:(21116|21117)$/, '');
}

function serverKey() {
  try { return fs.readFileSync(KEY_PATH, 'utf8').trim(); } catch (e) { return ''; }
}

function setJob(job, progress, step) {
  job.progress = progress;
  job.step = step;
  job.updatedAt = Date.now();
  if (!job._logAt || progress - job._logAt >= 5) {
    job._logAt = progress;
    console.log(`[BUILD ${job.id}] ${progress}% ${step}`);
  }
}

// ---------- GitHub 配置与 API ----------
function githubConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(GH_CONF_FILE, 'utf8')); } catch (e) {}
  const token = process.env.GITHUB_TOKEN || cfg.token || '';
  if (!token) throw new Error('未配置 GitHub Token（' + GH_CONF_FILE + '）');
  return {
    token,
    owner: cfg.owner || 'lishan1990',
    repo: cfg.repo || 'rustdesk-api-server-pro',
    branch: cfg.branch || 'rd-client',
    workflow: cfg.workflow || 'client-build.yml',
    // 下载产物时走的 GitHub 加速前缀（置空则直连）
    proxy: process.env.GITHUB_PROXY != null ? process.env.GITHUB_PROXY : (cfg.proxy != null ? cfg.proxy : 'https://v4.gh-proxy.org/'),
  };
}

function ghRequest(method, apiPath, body, tokenOverride) {
  return new Promise((resolve, reject) => {
    const cfg = tokenOverride ? { token: tokenOverride } : githubConfig();
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method,
      headers: Object.assign({
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + cfg.token,
        'User-Agent': 'rustdesk-dashboard',
        'X-GitHub-Api-Version': '2022-11-28',
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout: 40000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API 请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ghJson(method, apiPath, body, tokenOverride) {
  const r = await ghRequest(method, apiPath, body, tokenOverride);
  if (r.status >= 400) {
    let msg = r.text.slice(0, 300);
    try { const j = JSON.parse(r.text); if (j.message) msg = j.message; } catch (e) {}
    throw new Error(`GitHub API ${r.status}: ${msg}`);
  }
  if (!r.text) return {};
  try { return JSON.parse(r.text); } catch (e) { return {}; }
}

function ghDownload(target, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('下载产物重定向次数过多'));
    const cfg = githubConfig();
    const url = target.startsWith('http') ? target : ('https://api.github.com' + target);
    const u = new URL(url);
    const headers = { 'User-Agent': 'rustdesk-dashboard', Accept: 'application/vnd.github+json' };
    if (u.hostname === 'api.github.com') headers.Authorization = 'Bearer ' + cfg.token;
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(ghDownload(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('产物下载失败 HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// 用仓库公钥做 sealed box 加密，写入 Actions Secret（不在仓库内留下明文配置）
async function setRepoSecret(name, value) {
  const cfg = githubConfig();
  const pk = await ghJson('GET', `/repos/${cfg.owner}/${cfg.repo}/actions/secrets/public-key`);
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL));
  const enc = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  await ghJson('PUT', `/repos/${cfg.owner}/${cfg.repo}/actions/secrets/${name}`, { encrypted_value: enc, key_id: pk.key_id });
}

function buildEmbedConfig(brand, opts) {
  const lines = ['# RustDesk custom client config compiled into the binary'];
  lines.push(`app-name=${brand}`);
  lines.push(`custom-rendezvous-server=${normalizeHost(opts.host)}`);
  const relay = normalizeHost(opts.relay || opts.host);
  if (relay) lines.push(`relay-server=${relay}`);
  if (opts.apiServer) lines.push(`api-server=${String(opts.apiServer).trim().replace(/\/+$/, '')}`);
  if (opts.key) lines.push(`key=${opts.key.trim()}`);
  if (opts.fixedPassword) lines.push(`password=${opts.fixedPassword}`);
  // 2026-11-13 密码策略：允许使用临时密码连接
  // 勾选=被控端接受临时+固定密码（不写 verification-method，默认即双密码），控制端显示临时密码输入框
  // 不勾选=仅接受固定密码（这也是上游 hide_cm() 的前提之一）
  if (opts.allowTempPassword) {
    lines.push('allow-temp-password=Y');
  } else {
    lines.push('verification-method=use-permanent-password');
  }
  // 2026-11-13 权限控制：隐藏CM连接浮窗（连接成功后不弹浮动管理窗）
  // 定制客户端已放开上游「仅固定密码验证」限制（rd-client 82a1c9d0）：
  // 生效条件 = approve-mode=password + allow-hide-cm，可与「允许临时密码连接」同时勾选
  if (opts.hideCm) {
    lines.push('approve-mode=password');
    lines.push('allow-hide-cm=Y');
  }
  // 隐藏网络/服务器设置页并禁用解锁按钮
  lines.push('hide-network-settings=Y');
  lines.push('hide-server-settings=Y');
  lines.push('disable-unlock-pin=Y');
  return lines.join('\n') + '\n';
}

// ---------- 云端构建 ----------
const JOB_SLICES = {
  'generate-bridge': [6, 14, '生成桥接代码'],
  'build-RustDeskTempTopMostWindow': [14, 18, '编译窗口置顶组件'],
  'x86_64-pc-windows-msvc': [18, 62, '编译 Windows 客户端'],
  'build rustdesk android apk': [18, 40, '编译 Android 核心库'],
  'build rustdesk android universal apk': [40, 86, '打包 Android 安装包'],
};

function sliceFor(name) {
  const n = jobBase(name);
  let best = null;
  for (const k in JOB_SLICES) {
    if (n === k || n.startsWith(k)) {
      if (!best || k.length > best.length) best = k;
    }
  }
  return best ? JOB_SLICES[best] : null;
}

function jobBase(name) {
  return String(name || '').split(' / ')[0];
}

function estimateProgress(jobs) {
  let pct = 6;
  for (const j of jobs) {
    const slice = sliceFor(j.name);
    if (!slice) continue;
    const [start, end] = slice;
    if (j.status === 'completed') {
      pct = Math.max(pct, j.conclusion === 'success' ? end : start);
    } else if (j.status === 'in_progress') {
      const steps = j.steps || [];
      const done = steps.filter(s => s.status === 'completed').length;
      const ratio = steps.length ? done / steps.length : 0.3;
      pct = Math.max(pct, Math.round(start + (end - start) * Math.min(0.95, ratio)));
    } else {
      pct = Math.max(pct, start);
    }
  }
  return Math.min(88, pct);
}

function describeRun(jobs, startedAt) {
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  const active = jobs.find(j => j.status === 'in_progress');
  if (active) {
    const slice = sliceFor(active.name);
    const cur = (active.steps || []).find(s => s.status === 'in_progress');
    const label = slice ? slice[2] : active.name;
    return `${label}${cur ? ' · ' + cur.name : ''}（已运行 ${mins} 分钟）`;
  }
  return `云端构建排队中（已等待 ${mins} 分钟）`;
}

async function waitForRun(cfg, since, job) {
  for (let i = 0; i < 60; i++) {
    const data = await ghJson('GET',
      `/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}/runs?branch=${encodeURIComponent(cfg.branch)}&per_page=10`);
    const run = (data.workflow_runs || []).find(r => new Date(r.created_at).getTime() >= since - 30000);
    if (run) {
      job.runUrl = run.html_url;
      console.log(`[BUILD ${job.id}] run: ${run.html_url}`);
      return run.id;
    }
    setJob(job, 6, '等待 GitHub Actions 接收任务');
    await sleepMs(8000);
  }
  throw new Error('未能在 GitHub Actions 找到构建任务（请确认工作流与分支已推送）');
}

async function pollRun(cfg, runId, job) {
  const startedAt = Date.now();
  for (let i = 0; i < 900; i++) {
    const run = await ghJson('GET', `/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}`);
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Error(`云端构建失败（${run.conclusion}），详情：${job.runUrl || ''}`);
      }
      return true;
    }
    const jobsData = await ghJson('GET', `/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/jobs?per_page=100`);
    const jobs = jobsData.jobs || [];
    setJob(job, estimateProgress(jobs), describeRun(jobs, startedAt));
    await sleepMs(20000);
  }
  throw new Error('云端构建超时（超过 4 小时）');
}

// 用 gh-proxy 前缀下载 GitHub 产物（直连很慢时明显加速；失败自动回退直连）
async function downloadArtifactZip(cfg, artId, dest) {
  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${artId}/zip`;
  const base = (cfg.proxy || '').trim();
  if (base) {
    const url = base.replace(/\/+$/, '') + '/https://api.github.com' + apiPath;
    try {
      const t0 = Date.now();
      await runCmd('curl', ['-sSL', '--fail', '--retry', '2', '--retry-delay', '2',
        '-H', 'Authorization: Bearer ' + cfg.token,
        '-H', 'Accept: application/vnd.github+json',
        '-o', dest, url], { timeout: 1800000 });
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (size > 0) {
        console.log(`[BUILD] 经 ${base} 下载产物：${(size / 1048576).toFixed(1)} MB，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
        return;
      }
    } catch (e) {
      console.warn('[BUILD] 代理下载失败，回退直连：', e.message);
      try { fs.unlinkSync(dest); } catch (e2) {}
    }
  }
  await ghDownload(apiPath, dest);
}

async function fetchArtifacts(cfg, runId, targets, workDir, brand) {
  const data = await ghJson('GET', `/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}/artifacts`);
  const arts = data.artifacts || [];
  const wanted = [];
  if (targets.includes('windows')) wanted.push('rd-client-windows-x64');
  if (targets.includes('android')) wanted.push('rd-client-android-universal');
  const results = [];
  for (const name of wanted) {
    const art = arts.find(a => a.name === name && !a.expired);
    if (!art) throw new Error('缺少构建产物：' + name + '（可能构建步骤失败）');
    const zip = path.join(workDir, name + '.zip');
    await downloadArtifactZip(cfg, art.id, zip);
    const dir = path.join(workDir, name);
    fs.mkdirSync(dir, { recursive: true });
    await runCmd('unzip', ['-o', '-q', zip, '-d', dir], { timeout: 300000 });
    fs.unlinkSync(zip);
    results.push(dir);
    ghJson('DELETE', `/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${art.id}`).catch(() => {});
  }
  return results;
}

function pickInstaller(dir, ext) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(ext)) return p;
    if (e.isDirectory()) {
      const sub = pickInstaller(p, ext);
      if (sub) return sub;
    }
  }
  return null;
}

async function runCloudBuild(job) {
  const opts = job.opts;
  const brand = cleanBrand(opts.brand) || 'RustDesk';
  const targets = opts.both ? ['windows', 'android'] : [opts.os === 'android' ? 'android' : 'windows'];
  const workDir = path.join(BUILD_DIR, job.id);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    job.status = 'running';
    const cfg = githubConfig();
    if (!opts.key) opts.key = serverKey();
    if (opts.keepConfig) {
      // 只重编译客户端源码（如放宽 app-name 校验），沿用上次成功构建的 CUSTOM_CONFIG，
      // 不覆盖 GitHub Secret，服务器地址/key/固定密码等参数保持完全一致。
      setJob(job, 3, '沿用云端现有内嵌配置');
    } else {
      setJob(job, 3, '正在生成内嵌配置');
      await setRepoSecret('CUSTOM_CONFIG', buildEmbedConfig(brand, opts));
    }

    setJob(job, 5, '正在提交云端构建任务');
    const dispatchAt = Date.now();
    await ghJson('POST', `/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`, {
      ref: cfg.branch,
      inputs: { 'upload-artifact': 'true', 'publish-update-metadata': 'false', 'upload-tag': 'client', target: targets.length > 1 ? 'both' : targets[0] },
    });
    const runId = await waitForRun(cfg, dispatchAt, job);
    await pollRun(cfg, runId, job);

    setJob(job, 90, '正在下载云端构建产物');
    const dirs = await fetchArtifacts(cfg, runId, targets, workDir, brand);

    setJob(job, 95, '正在整理安装包');
    const finals = [];
    for (const dir of dirs) {
      const msi = pickInstaller(dir, '.msi');
      const exe = pickInstaller(dir, '.exe');
      const apk = pickInstaller(dir, '.apk');
      if (msi) {
        const name = `${brand}-${CLIENT_VERSION}-x64-安装包.msi`;
        fs.copyFileSync(msi, path.join(workDir, name));
        finals.push(name);
      } else if (exe) {
        const name = `${brand}-${CLIENT_VERSION}-x64.exe`;
        fs.copyFileSync(exe, path.join(workDir, name));
        finals.push(name);
      }
      if (apk) {
        const name = `${brand}-${CLIENT_VERSION}-Android.apk`;
        fs.copyFileSync(apk, path.join(workDir, name));
        finals.push(name);
      }
    }
    if (!finals.length) throw new Error('构建产物中没有可用的安装包');

    let fileName, filePath;
    if (finals.length === 1) {
      fileName = finals[0];
      filePath = path.join(workDir, fileName);
    } else {
      fileName = `${brand}-${CLIENT_VERSION}-双系统客户端.zip`;
      filePath = path.join(workDir, fileName);
      await runCmd('zip', ['-r', '-q', '-y', fileName, ...finals], { cwd: workDir, timeout: 600000 });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) throw new Error('安装包生成失败');
    job.size = fs.statSync(filePath).size;

    try { fs.rmSync(path.join(workDir, 'rd-client-windows-x64'), { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(path.join(workDir, 'rd-client-android-universal'), { recursive: true, force: true }); } catch (e) {}
    finals.forEach(f => { if (f !== fileName) { try { fs.unlinkSync(path.join(workDir, f)); } catch (e) {} } });
    job.fileName = fileName;
    job.file = filePath;
    job.status = 'success';
    job.successAt = Date.now();
    setJob(job, 100, '构建完成，可下载客户端');
    recordBuildHistory(job);
  } catch (e) {
    job.status = 'failed';
    job.error = e.message || String(e);
    job.step = '构建失败：' + job.error;
    console.warn(`[BUILD ${job.id}] failed:`, job.error);
  }
}

// ---------- 构建环境（GitHub 仓库 / PAT） ----------
function readGhConfRaw() {
  try { return JSON.parse(fs.readFileSync(GH_CONF_FILE, 'utf8')); } catch (e) { return {}; }
}

function ghEnvInfo() {
  const cfg = readGhConfRaw();
  const owner = cfg.owner || 'lishan1990';
  const repo = cfg.repo || 'rustdesk-api-server-pro';
  return {
    owner,
    repo,
    repoFull: `${owner}/${repo}`,
    token: cfg.token || process.env.GITHUB_TOKEN || '',
    branch: cfg.branch || 'rd-client',
    workflow: cfg.workflow || 'client-build.yml',
    proxy: cfg.proxy != null ? cfg.proxy : 'https://v4.gh-proxy.org/',
  };
}

app.get('/api/build/env', (req, res) => {
  res.json({ ok: true, env: ghEnvInfo() });
});

app.post('/api/build/env', async (req, res) => {
  const body = req.body || {};
  const cur = readGhConfRaw();
  let owner = cur.owner || 'lishan1990';
  let repo = cur.repo || 'rustdesk-api-server-pro';

  const repoFull = String(body.repo || '').trim();
  if (repoFull) {
    if (repoFull.includes('/')) {
      const parts = repoFull.split('/').filter(Boolean);
      if (parts.length !== 2) return res.status(400).json({ error: '仓库格式应为 owner/repo' });
      owner = parts[0].trim();
      repo = parts[1].trim().replace(/\.git$/, '');
    } else {
      repo = repoFull.replace(/\.git$/, '');
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      return res.status(400).json({ error: '仓库名只能包含字母、数字、下划线、点和中划线' });
    }
  }

  const token = String(body.token || '').trim() || cur.token || process.env.GITHUB_TOKEN || '';
  if (!token) return res.status(400).json({ error: '请填写 PAT' });

  try {
    await ghJson('GET', `/repos/${owner}/${repo}`, null, token);
  } catch (e) {
    return res.status(400).json({ error: 'PAT 或仓库不可用：' + e.message });
  }

  const branch = cur.branch || 'rd-client';
  const workflow = cur.workflow || 'client-build.yml';
  let workflowOk = false;
  try {
    await ghJson('GET', `/repos/${owner}/${repo}/contents/.github/workflows/${workflow}?ref=${encodeURIComponent(branch)}`, null, token);
    workflowOk = true;
  } catch (e) {}

  const next = Object.assign({}, cur, { owner, repo, token });
  fs.writeFileSync(GH_CONF_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { execFileSync('chmod', ['600', GH_CONF_FILE], { stdio: 'ignore' }); } catch (e) {}

  res.json({
    ok: true,
    env: ghEnvInfo(),
    workflowOk,
    warning: workflowOk ? null : `仓库可访问，但分支 ${branch} 下没有 .github/workflows/${workflow}，构建会失败`,
  });
});

app.post('/api/build/start', async (req, res) => {
  const body = req.body || {};
  const brand = cleanBrand(body.brand);
  if (!brand) return res.status(400).json({ error: '请填写品牌名' });
  // 品牌名会作为 app-name 编译进客户端，用于安装目录、Windows 服务名、注册表键和 URL scheme。
  // 客户端 validate_install_app_name() 已放宽为 Windows 允许 Unicode 字母/数字（中文品牌可用），
  // 但空格、点、引号、分号、斜杠等会被拼进特权安装脚本，必须拦截，否则安装失败。
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(brand)) {
    return res.status(400).json({
      error: '品牌名会写入客户端 app-name（安装目录/服务名），只能用中英文、数字、-、_，且不能以 - 开头；不能含空格、点、引号、斜杠等符号，否则客户端会安装失败并一直显示「正在运行未安装版本」',
    });
  }
  if (!String(body.host || '').trim()) return res.status(400).json({ error: '请填写 ID 服务器地址' });
  try { githubConfig(); } catch (e) { return res.status(400).json({ error: e.message }); }

  const running = [...buildJobs.values()].find(j => j.status === 'running' || j.status === 'queued');
  if (running) return res.status(409).json({ error: '已有构建任务正在进行，请等待完成' });

  const id = 'b' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const job = {
    id,
    status: 'queued',
    progress: 0,
    step: '已加入构建队列',
    createdAt: Date.now(),
    opts: {
      brand,
      os: body.os === 'android' ? 'android' : 'windows',
      both: !!body.both,
      lang: body.lang === 'en' ? 'en' : 'zh',
      conn: body.conn === 'dual' ? 'dual' : 'agent',
      style: body.style === 'standard' ? 'standard' : (body.style === 'unattended' ? 'unattended' : 'portable'),
      prompt: String(body.prompt || '').slice(0, 100),
      host: String(body.host || '').trim(),
      relay: String(body.relay || '').trim(),
      apiServer: String(body.apiServer || '').trim(),
      key: String(body.key || '').trim(),
      fixedPassword: String(body.fixedPassword || '').trim(),
      // 2026-11-13: 允许临时密码连接 / 隐藏CM连接浮窗（前端互斥）
      allowTempPassword: body.allowTempPassword === true || body.allowTempPassword === 'true' || body.allowTempPassword === 'Y',
      hideCm: body.hideCm === true || body.hideCm === 'true' || body.hideCm === 'Y',
      // 仅重编源码时沿用云端已保存的 CUSTOM_CONFIG（避免丢失上次填写的固定密码等参数）
      keepConfig: !!body.keepConfig,
    },
  };
  buildJobs.set(id, job);
  runCloudBuild(job);
  res.json({ ok: true, id, job: publicJob(job) });
});

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    error: job.error || null,
    fileName: job.fileName || null,
    size: job.size || 0,
    runUrl: job.runUrl || null,
    createdAt: job.createdAt || 0,
    successAt: job.successAt || 0,
    downloadUrl: job.status === 'success' && job.file ? `/api/build/download?id=${job.id}` : null,
  };
}

app.get('/api/build/status', (req, res) => {
  const id = String(req.query.id || '');

  // 不带 id：返回当前/最近一次构建，供页面刷新或重新登录后恢复进度与下载按钮
  if (!id) {
    let latest = null;
    for (const j of buildJobs.values()) {
      if (!latest || (j.createdAt || 0) > (latest.createdAt || 0)) latest = j;
    }
    if (latest) return res.json({ ok: true, job: publicJob(latest) });

    const h = readBuildHistory()[0];
    if (h) {
      const alive = isHistoryAlive(h);
      return res.json({ ok: true, job: {
        id: h.id,
        status: alive ? 'success' : 'expired',
        progress: 100,
        step: alive ? '构建完成，可下载客户端' : '安装包已失效（文件已被清理）',
        error: null,
        fileName: h.fileName || null,
        size: h.size || 0,
        runUrl: null,
        createdAt: h.createdAt || 0,
        successAt: h.successAt || 0,
        downloadUrl: alive ? `/api/build/download?id=${h.id}` : null,
      } });
    }
    return res.json({ ok: true, job: null });
  }

  const job = buildJobs.get(id);
  if (!job) return res.status(404).json({ error: '构建任务不存在' });
  res.json(publicJob(job));
});

// 本站构建历史（按提交时间倒序，最新在最上方）
app.get('/api/build/history', (req, res) => {
  const items = readBuildHistory()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(e => {
      const alive = isHistoryAlive(e);
      let size = e.size || 0;
      if (alive) { try { size = fs.statSync(historyFilePath(e)).size; } catch (x) {} }
      return {
        id: e.id,
        brand: e.brand || '',
        lang: e.lang || null,
        conn: e.conn || null,
        style: e.style || null,
        os: e.os || 'windows',
        createdAt: e.createdAt || 0,
        successAt: e.successAt || 0,
        fileName: e.fileName || null,
        size,
        expired: !alive,
        downloadUrl: alive ? `/api/build/download?id=${e.id}` : null,
      };
    });
  res.json({ ok: true, items });
});

app.get('/api/build/download', (req, res) => {
  const id = String(req.query.id || '');
  const job = buildJobs.get(id);
  let filePath = job && job.status === 'success' ? job.file : null;
  let fileName = job ? job.fileName : null;

  // 内存任务过期或服务重启后，回退到磁盘上的历史记录
  if (!filePath || !fs.existsSync(filePath)) {
    const entry = readBuildHistory().find(e => e.id === id);
    if (entry && entry.fileName) {
      filePath = historyFilePath(entry);
      fileName = entry.fileName;
    }
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '安装包不存在或已被删除' });
  }

  res.download(filePath, fileName || path.basename(filePath), (err) => {
    if (err) {
      console.warn('[BUILD] download aborted:', err.message);
      return;
    }
    try { fs.unlinkSync(filePath); } catch (e) {}
    try { fs.rmSync(path.join(BUILD_DIR, id), { recursive: true, force: true }); } catch (e) {}
    if (job) {
      job.downloaded = true;
      job.file = null;
      job.step = '已下载，服务器文件已删除';
    }
    console.log(`[BUILD ${id}] downloaded and removed`);
  });
});

// 任务保留 6 小时；已下载的任务 30 分钟后清理
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of buildJobs) {
    const stale = now - job.createdAt > 6 * 60 * 60 * 1000;
    const downloadedIdle = job.downloaded && now - job.updatedAt > 30 * 60 * 1000;
    if (stale || downloadedIdle) {
      if (job.file) { try { fs.unlinkSync(job.file); } catch (e) {} }
      try { fs.rmSync(path.join(BUILD_DIR, id), { recursive: true, force: true }); } catch (e) {}
      buildJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ---------- 启动 ----------
restoreBuilds();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[RustDesk Dashboard] http://0.0.0.0:${PORT}`);
});

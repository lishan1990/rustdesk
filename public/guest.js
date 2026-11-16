/* 游客 CDK 定制客户端 - 前端逻辑 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var state = { token: '', code: '', jobId: '', pollTimer: null, downloading: false };

  // guest.html?cdk=XXXX：预填兑换码并自动进入
  window.addEventListener('load', function () {
    try {
      var q = new URLSearchParams(location.search);
      var pre = (q.get('cdk') || '').trim().toUpperCase();
      if (!pre) return;
      var inp = document.getElementById('cdkInput');
      if (!inp) return;
      inp.value = pre;
      var b = document.getElementById('redeemBtn');
      if (b) b.click();
    } catch (e) {}
  });

  function show(view) {
    ['viewRedeem', 'viewCustom', 'viewDone'].forEach(function (v) {
      var el = document.getElementById(v);
      if (el) el.style.display = (v === view) ? '' : 'none';
    });
    window.scrollTo(0, 0);
  }
  function setError(msg) { var e = $('#cdkError'); if (e) e.textContent = msg || ''; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  function radio(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }

  function toast(msg) {
    var bar = document.createElement('div');
    bar.className = 'g-toast';
    bar.textContent = msg;
    document.body.appendChild(bar);
    setTimeout(function () { bar.classList.add('show'); }, 10);
    setTimeout(function () { bar.classList.remove('show'); setTimeout(function () { try { bar.remove(); } catch (e) {} }, 300); }, 2600);
  }

  // ---- 视图切换 tab ----
  $$('#gTabs .g-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $$('#gTabs .g-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      $$('.g-panel').forEach(function (p) { p.style.display = (p.getAttribute('data-panel') === tab.getAttribute('data-tab')) ? '' : 'none'; });
    });
  });

  // ---- 兑换 ----
  $('#redeemBtn').addEventListener('click', function () {
    var code = val('cdkInput').toUpperCase();
    if (!code) { setError('请输入兑换码'); return; }
    setError('');
    var btn = $('#redeemBtn'); btn.disabled = true; btn.textContent = '验证中…';
    fetch('/api/guest/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '验证并进入';
        if (!res.ok || !res.d.ok) { setError(res.d.error || '兑换失败'); return; }
        state.token = res.d.token; state.code = res.d.code;
        $('#cdkShow').textContent = state.code;
        if (res.d.resumeJob) {
          // 该 CDK 已有构建成功的成品（如误判失败后已恢复），直接进入下载
          state.jobId = res.d.resumeJob.id;
          $('#buildCard').style.display = '';
          $('#stepBuild').classList.remove('active');
          $('#stepBuild').classList.add('done');
          $('#stepDone').classList.add('active');
          $('#buildStep').textContent = '构建已完成，即将开始下载…';
          $('#buildPct').textContent = '100%';
          $('#buildFill').style.width = '100%';
          show('viewCustom');
          startDownload(res.d.resumeJob.downloadUrl);
          return;
        }
        show('viewCustom');
      })
      .catch(function (e) { btn.disabled = false; btn.textContent = '验证并进入'; setError('网络错误：' + e.message); });
  });
  $('#cdkInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#redeemBtn').click(); });

  // ---- 退出 ----
  $('#exitBtn').addEventListener('click', function () {
    state.token = ''; state.jobId = '';
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    show('viewRedeem');
    setError('');
    $('#cdkInput').value = '';
  });
  $('#againBtn').addEventListener('click', function () { location.reload(); });

  // ---- 提交构建 ----
  $('#submitBtn').addEventListener('click', function () {
    if (state.downloading) return;
    var cfg = {
      token: state.token,
      brand: val('brandInput'),
      lang: radio('lang') || 'zh',
      os: radio('os') || 'windows',
      all: checked('buildAll'),
      prompt: val('tipInput'),
      host: val('idServerInput'),
      relay: val('relayInput'),
      apiServer: val('apiServerInput'),
      key: val('keyInput'),
      fixedPassword: val('fixedPwdInput'),
      allowTempPassword: checked('allowTempPwdChk'),
      hideCm: checked('hideCmChk')
    };
    if (!cfg.brand) { toast('请填写品牌名'); switchTab('basic'); return; }
    if (!cfg.host) { toast('请填写 ID 服务器地址'); switchTab('server'); return; }
    if (!cfg.key) { toast('请填写服务器密钥 Key'); switchTab('server'); return; }

    var btn = $('#submitBtn'); btn.disabled = true; btn.textContent = '提交中…';
    fetch('/api/guest/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '▶ 提交并生成客户端';
        if (!res.ok || !res.d.ok) { toast(res.d.error || '提交失败'); return; }
        state.jobId = res.d.id;
        $('#buildCard').style.display = '';
        $('#stepBuild').classList.add('active');
        $('#downloading').style.display = 'none';
        poll();
      })
      .catch(function (e) { btn.disabled = false; btn.textContent = '▶ 提交并生成客户端'; toast('网络错误：' + e.message); });
  });

  function switchTab(key) {
    var t = document.querySelector('#gTabs .g-tab[data-tab="' + key + '"]');
    if (t) t.click();
  }

  function poll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (state.downloading || !state.jobId) return;
      fetch('/api/guest/status?token=' + encodeURIComponent(state.token) + '&id=' + encodeURIComponent(state.jobId))
        .then(function (r) {
          if (r.status === 401) { throw new Error('会话已失效，请返回兑换页重新输入 CDK'); }
          return r.json();
        })
        .then(function (job) {
          $('#buildStep').textContent = job.step || '生成中…';
          $('#buildPct').textContent = (job.progress || 0) + '%';
          $('#buildFill').style.width = (job.progress || 0) + '%';
          if (job.status === 'success') {
            clearInterval(state.pollTimer); state.pollTimer = null;
            $('#stepBuild').classList.remove('active');
            $('#stepBuild').classList.add('done');
            $('#stepDone').classList.add('active');
            startDownload(job.downloadUrl);
          } else if (job.status === 'failed') {
            clearInterval(state.pollTimer); state.pollTimer = null;
            $('#buildNote').textContent = '生成失败：' + (job.error || '未知错误');
            toast('生成失败：' + (job.error || '未知错误'));
          }
        })
        .catch(function (e) {
          clearInterval(state.pollTimer); state.pollTimer = null;
          $('#buildNote').textContent = e.message;
          toast(e.message);
        });
    }, 1500);
  }

  // ---- 自动下载 → 完成后刷新回兑换页 ----
  function startDownload(url) {
    if (!url || state.downloading) return;
    state.downloading = true;
    $('#downloading').style.display = '';
    $('#buildStep').textContent = '正在下载…';
    fetch(url).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || '下载失败 HTTP ' + r.status); });
      return r.blob().then(function (blob) {
        var cd = r.headers.get('Content-Disposition') || '';
        var name = 'client-installer';
        var m = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(cd);
        if (m) { name = decodeURIComponent(m[1].replace(/^"|"$/g, '')); }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      });
    }).then(function () {
      // 下载已完成 → 显示完成提示 → 自动刷新回兑换页
      $('#downloading').style.display = 'none';
      $('#doneTitle').textContent = '下载完成';
      $('#doneMsg').textContent = '安装包已开始下载，本次兑换码已核销。页面即将返回兑换入口。';
      show('viewDone');
      setTimeout(function () { location.reload(); }, 1500);
    }).catch(function (e) {
      $('#downloading').style.display = 'none';
      $('#doneTitle').textContent = '下载遇到问题';
      $('#doneMsg').textContent = e.message + '。兑换码仍有效，可返回重试或联系服务方。';
      show('viewDone');
    });
  }
})();

/* ============================================================
 *  在线排行榜（回放即证明版）
 *
 *  和老版本的根本区别：
 *
 *    老版本存的是  {n: 昵称, s: 分数, t: 时间}  ——  分数是「客人自己说的」，
 *    服务端是公共 key-value，谁都能改，于是榜上全是 99999999 和未来时间戳。
 *
 *    现在存的是  {n, s, t, r}，r 是**整局回放**（随机种子 + 每次投放的
 *    tick 和落点）。任何人的浏览器都能用 sim.js 把这局重跑一遍，
 *    算出来的分数和 s 对得上才算数，对不上就标 ❌ 并且排到榜底。
 *
 *  也就是说：写入依然是随便写的（TinyWebDB 的 secret 本来就守不住，
 *  而且我们也不再指望它），但**写进来的分数必须跑得出来**。
 *  伪造一个分数 = 必须真的构造出一局能打出这个分的操作序列。
 *
 *  还有两条规则是「读的人」自己执行的，不依赖服务端：
 *    · 时间戳必须在 [现在-30天, 现在+2分钟] 内 —— 拨到未来的记录直接无视
 *      （老榜就是被这个打穿的：t 越靠后越能永久霸占「最近20条」的窗口）
 *    · 同一份回放只算一次（按内容去重），刷屏复制没用
 *  排序也从「最近 20 次提交」改成「最近 30 天的前 20 名」——
 *  否则只要灌 20 条合法的垃圾就能把别人的高分挤出窗口。
 *
 *  对外接口和老版本完全一致，game.js 不用改：
 *    window.DanaiwaBoard = { open, close, refresh, onGameOver,
 *                            fetchTop, submitScore, myName, setName, hasName,
 *                            saves, saveAt, saveCount, replaySave, replayRow }
 *  最后一组是「本地存档 / 重放」用的：一局打完就存进 danaiwa.saves.v1（最多 10 局），
 *  上传失败、验证不通过的照样留着 —— 看回放不需要它通过校验。
 * ============================================================ */
(function () {
  'use strict';

  /* —— TinyWebDB（公共 key-value，secret 只是用来过接口，不是安全边界） —— */
  var API = 'https://tinywebdb.appinventor.space/api';
  var USER = 'danaiwa';
  var SECRET = '6f52518c';

  /* 换前缀 = 另开一个榜。老榜的数据是 {n,s,t} 没有回放，新规则下一律不算数，
     所以直接换个前缀重新开始，顺带把那些刷屏的垃圾记录留在旧前缀里。 */
  var PREFIX = 'dnw2_';

  var NAME_KEY = 'danaiwa.name';
  var DEFAULT_NAME = '默认用户';

  var MAX_SCORE = 99999999;   // 纯粹的便宜预筛，真正作数的是回放
  var WINDOW_DAYS = 30;       // 榜单窗口：最近 30 天
  var TOP = 20;               // 榜单条数
  /* 先多捞一些候选再验证：有人可以交一堆「分数很高但回放是编的」记录，
     如果一开始就按分数切成 20 条，这些假记录会把真成绩挡在外面
     （要等验证跑完才沉底，但那时候真成绩已经被切掉了）。
     验一条假回放几乎是瞬间的（没球，物理是空转），贵的是真回放，
     而验证按分数从高到低排，所以假记录会先被秒拒，不占预算。 */
  var CANDIDATES = 40;
  var SCAN_PAGES = 3;         // 读 3 页 × 100 条
  var MUTE_MIN_GAP = 3000;    // 两次提交至少隔 3 秒（防手抖，不是安全措施）
  var MAX_VALUE_LEN = 12000;  // 回放太长就不上传了（TinyWebDB 也未必收得下）
  var CACHE_PREFIX = 'danaiwa.vf.';
  var SELF_KEY = 'danaiwa.self';    // 自己那条记录，被人删了/改了会自己补回去
  var HEAL_GAP = 60000;             // 补档最多一分钟一次

  /* 本地存档：最近 10 局，重放按钮的数据源。
     上传失败的、验证不通过的，这里照样留着 —— 看回放本来就不需要它通过。 */
  var SAVES_KEY = 'danaiwa.saves.v1';
  var SAVES_MAX = 10;

  var Sim = window.SUIKA_SIM;
  var $ = function (id) { return document.getElementById(id); };

  /* =========================================================
   *  1. 传输
   * ======================================================= */
  function post(params) {
    var body = new URLSearchParams();
    body.set('user', USER);
    body.set('secret', SECRET);
    for (var k in params) body.set(k, params[k]);

    function once() {
      return fetch(API, { method: 'POST', body: body }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (text) {
        var s = (text || '').trim();
        if (!s) return {};
        if (s.charAt(0) === '<') throw new Error('网关开小差了（502）');
        try { return JSON.parse(s); }
        catch (e) { throw new Error('服务器返回看不懂：' + s.slice(0, 60)); }
      });
    }

    /* 服务端 502 很常见，多试几次 */
    return once().catch(function (err) {
      return new Promise(function (r) { setTimeout(r, 700); })
        .then(once)
        .catch(function () { throw err; });
    });
  }

  /* =========================================================
   *  2. 读榜
   * ======================================================= */

  /* FNV-1a：给回放出个短指纹，用来去重和做本地缓存的 key。
     刻意**不把声称的分数算进去** —— 同一局操作换个分数再交一次，
     应该被当成同一条记录去重，而不是多出一条新纪录。 */
  function replayKey(enc) {
    var p = String(enc).split(';');
    if (p.length < 5) return String(enc);
    return p[0] + ';' + p[1] + ';' + p[2] + ';' + p.slice(4).join(';');
  }

  function fingerprint(str) {
    var s = replayKey(str);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function scan() {
    var out = {};
    var no = 1;
    function step() {
      return post({
        action: 'search', no: String(no), count: '100',
        tag: PREFIX, type: 'both'
      }).then(function (obj) {
        for (var k in obj) {
          if (k.indexOf(PREFIX) === 0 && typeof obj[k] === 'string') out[k] = obj[k];
        }
        no += 100;
        if (no > SCAN_PAGES * 100) return out;
        return step();
      });
    }
    return step();
  }

  /* 一条记录要过三关才算候选：
       a. 时间戳在合理范围内（读的人自己算 now，不听服务端的）
       b. 分数范围正常、回放能解码
       c. 内容去重 */
  function parseAll(obj) {
    var now = Date.now();
    var minT = now - WINDOW_DAYS * 86400000;
    var maxT = now + 120000;              // 允许 2 分钟的时钟误差
    var byPrint = {};
    var dropped = { time: 0, score: 0, noreplay: 0, mismatch: 0, dup: 0 };

    for (var tag in obj) {
      var raw = obj[tag];
      if (typeof raw !== 'string') continue;

      var rec;
      try { rec = JSON.parse(raw); } catch (e) { continue; }

      var t = Number(rec.t);
      if (!isFinite(t) || t < minT || t > maxT) { dropped.time++; continue; }

      var s = Number(rec.s);
      if (!isFinite(s) || s <= 0 || s > MAX_SCORE) { dropped.score++; continue; }

      if (typeof rec.r !== 'string' || !Sim) { dropped.noreplay++; continue; }

      var dec = Sim.decode(rec.r);
      if (!dec) { dropped.noreplay++; continue; }

      /* 证据链要闭合，三个数必须是同一个：
           JSON 里写的 s  ←→  回放里编码的 score  ←→  重跑模拟算出来的分数
         前一环在这儿对，最后一环交给验证。
         少了这一环，「真回放 + 假 s」就能直接上榜（榜显示的是 s）。 */
      if (dec.score !== s) { dropped.mismatch++; continue; }

      var fp = fingerprint(rec.r);
      var item = {
        tag: tag,
        name: String(rec.n || '匿名玩家').slice(0, 16),
        score: s,
        t: t,
        r: rec.r,
        fp: fp,
        status: 'pending'      // pending | ok | bad
      };

      /* 同一份回放重复提交 → 保留时间戳最靠后的那条 */
      if (byPrint[fp]) {
        dropped.dup++;
        if (item.t < byPrint[fp].t) continue;
      }
      byPrint[fp] = item;
    }

    var list = [];
    for (var k in byPrint) list.push(byPrint[k]);
    list.sort(function (a, b) { return (b.score - a.score) || (b.t - a.t); });
    return { list: list.slice(0, CANDIDATES), dropped: dropped };
  }

  /* =========================================================
   *  3. 验证（Worker 里重跑一遍）
   * ======================================================= */
  var worker = null;
  var workerBroken = false;
  var queue = [];
  var inflight = null;        // 已经发出去、还没回话的那条
  var running = false;
  var verifyToken = 0;

  function cacheGet(fp, score) {
    try {
      var v = localStorage.getItem(CACHE_PREFIX + fp);
      if (!v) return null;
      var p = v.split(':');
      if (Number(p[0]) !== score) return null;      // 分数变了就重新验
      return p[1];
    } catch (e) { return null; }
  }
  function cachePut(fp, score, st) {
    try { localStorage.setItem(CACHE_PREFIX + fp, score + ':' + st); } catch (e) { }
  }

  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    if (typeof Worker === 'undefined') { workerBroken = true; return null; }
    try {
      worker = new Worker('leaderboard.worker.js');
      worker.onmessage = function (e) { onVerified(e.data); };
      worker.onerror = function () {           // file:// 打开时 Worker 可能被浏览器禁掉
        workerBroken = true;
        worker = null;
        drainMainThread();
      };
      return worker;
    } catch (e) {
      workerBroken = true;
      return null;
    }
  }

  function finish(item, res) {
    if (item) {
      item.status = res.ok ? 'ok' : 'bad';
      item.reason = res.reason || '';
      item.ms = res.ms || 0;
      if (res.ok) cachePut(item.fp, item.score, 'ok');
      else if (res.reason && res.reason.indexOf('太慢') < 0) cachePut(item.fp, item.score, 'bad');
      /* 结论同步写回本地存档，上传页那边才说得出「你这局为什么没过」 */
      saveSetStatus(item.fp, item.score, item.status, item.reason);
      paintRows();
    }
    inflight = null;
    running = false;
    pump();
  }

  function onVerified(res) {
    if (!res) return;
    finish(inflight, res);
  }

  /* 兜底：Worker 不可用（比如 file:// 直接双击打开）就在主线程一条一条来。
     会卡一下，但至少能验证。 */
  function drainMainThread() {
    if (running || inflight) return;
    var item = queue.shift();
    if (!item) return;
    running = true;
    inflight = item;
    setTimeout(function () {
      var t0 = Date.now();
      var r;
      try { r = Sim.verify(item.r); }
      catch (e) { r = { ok: false, score: 0, reason: '验证出错：' + e.message }; }
      var ms = Date.now() - t0;
      if (ms > 90000) r = { ok: false, score: 0, reason: '验证太慢，跳过' };
      finish(item, { ok: !!r.ok, score: r.score || 0, reason: r.reason || '', ms: ms });
    }, 30);
  }

  function pump() {
    if (running || inflight) return;
    if (workerBroken) { drainMainThread(); return; }

    var w = getWorker();
    if (workerBroken) { drainMainThread(); return; }
    if (!w) return;

    var item = queue.shift();
    if (!item) return;
    running = true;
    inflight = item;
    w.postMessage({ id: item.fp, replay: item.r });
  }

  function verifyAll(rows) {
    verifyToken++;
    queue.length = 0;
    running = false;
    var token = verifyToken;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cached = cacheGet(row.fp, row.score);
      if (cached === 'ok') { row.status = 'ok'; saveSetStatus(row.fp, row.score, 'ok', ''); continue; }
      if (cached === 'bad') {
        row.status = 'bad';
        row.reason = '（本地已判定不通过）';
        saveSetStatus(row.fp, row.score, 'bad', row.reason);
        continue;
      }
      row.status = 'pending';
      queue.push(row);
    }
    /* 分数高的先验，榜单顶部最有说服力 */
    queue.sort(function (a, b) { return b.score - a.score; });
    paintRows();
    if (token === verifyToken) pump();
  }

  /* =========================================================
   *  4. 界面
   * ======================================================= */
  var listEl = $('boardList');
  var modal = $('boardModal');
  var msgEl = $('submitMsg');
  var nickInput = $('nickInput');
  var nameLabel = $('myNameLabel');
  var submitBtn = $('submitBtn');
  var replayBtn = $('replayBtn');
  var submitBox = $('submitBox');
  var lastSubmitAt = 0;
  var submitting = false;
  var pendingScore = 0;
  var pendingReplay = '';
  var currentRows = [];
  var currentMine = null;

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }
  function showRetry(show) { if (submitBtn) submitBtn.hidden = !show; }

  function cleanName(raw) {
    var n = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    return n;
  }
  function loadName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { return ''; }
  }
  function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (e) { } }
  function myName() { return loadName() || DEFAULT_NAME; }

  function paintName() {
    var n = myName();
    if (nameLabel) nameLabel.textContent = n;
    if (nickInput && document.activeElement !== nickInput) nickInput.value = loadName();
  }

  function boardMessage(text) {
    if (!listEl) return;
    listEl.textContent = '';
    var p = document.createElement('p');
    p.className = 'board-empty';
    p.textContent = text;
    listEl.appendChild(p);
  }

  function rankClass(i) { return i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''; }

  var BADGE = { pending: '⏳', ok: '✅', bad: '❌' };
  var TITLE = {
    pending: '正在重跑这局验证分数…',
    ok: '分数已由回放复现，确认无误',
    bad: '重跑的结果和声称的分数对不上'
  };

  function sortedRows() {
    /* 没验出来的先按分数排（等验证回来会重排），验出来是假的垫底 */
    return currentRows.slice().sort(function (a, b) {
      var af = a.status === 'bad' ? 1 : 0, bf = b.status === 'bad' ? 1 : 0;
      if (af !== bf) return af - bf;
      return (b.score - a.score) || (b.t - a.t);
    });
  }

  function paintRows() {
    if (!listEl) return;
    var rows = sortedRows().slice(0, TOP);
    if (!rows.length) {
      boardMessage('还没有通过验证的成绩，快去玩一局！');
      return;
    }
    var pendingCount = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].status === 'pending') pendingCount++;

    listEl.textContent = '';

    if (pendingCount) {
      var head = document.createElement('p');
      head.className = 'board-checking';
      head.textContent = '⏳ 正在重跑 ' + pendingCount + ' 局以验证分数…';
      listEl.appendChild(head);
    }

    var marked = false;
    rows.forEach(function (row, i) {
      var line = document.createElement('div');
      line.className = 'board-row ' + rankClass(i) + (row.status === 'bad' ? ' is-fake' : '');
      line.title = TITLE[row.status] + (row.reason ? '：' + row.reason : '');

      var rank = document.createElement('span');
      rank.className = 'board-rank';
      rank.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);

      var name = document.createElement('span');
      name.className = 'board-name';
      name.textContent = row.name;

      var score = document.createElement('span');
      score.className = 'board-score';
      score.textContent = row.score;

      var badge = document.createElement('span');
      badge.className = 'board-verify is-' + row.status;
      badge.textContent = BADGE[row.status];

      /* 每行一个 ▶：榜上只要进了榜就一定带回放，点它就能整局重放。
         ❌ 那行的按钮在样式里做得更显眼 —— 越可疑，越该让人亲眼看一遍。 */
      var play = document.createElement('button');
      play.className = 'board-play';
      play.type = 'button';
      play.textContent = '▶';
      play.title = row.status === 'bad'
        ? '重放这一局（' + (row.reason || '没通过校验') + '）'
        : '重放这一局';
      play.setAttribute('aria-label', '重放 ' + row.name + ' 的这一局');
      play.addEventListener('click', function (ev) {
        if (ev.stopPropagation) ev.stopPropagation();
        playRow(row);
      });

      line.appendChild(rank);
      line.appendChild(name);
      line.appendChild(score);
      line.appendChild(badge);
      line.appendChild(play);

      if (!marked && currentMine != null && row.score === currentMine && row.status === 'ok') {
        line.classList.add('is-mine');
        marked = true;
      }
      listEl.appendChild(line);
    });
  }

  function refreshBoard(myScore) {
    currentMine = myScore == null ? null : myScore;
    boardMessage('正在读取排行榜…');
    return scan().then(function (obj) {
      return selfHeal(obj).then(function () { return obj; });
    }).then(function (obj) {
      var res = parseAll(obj);
      currentRows = res.list;
      if (!res.list.length) {
        var d = res.dropped;
        var bad = (d.noreplay || d.mismatch || d.time)
          ? '（这一版之前的旧记录没有回放，一律不算数）' : '';
        boardMessage('还没有通过验证的成绩，快去玩一局！' + bad);
        return [];
      }
      paintRows();
      verifyAll(res.list);
      return res.list;
    }).catch(function (err) {
      boardMessage('读取失败：' + err.message + '（检查一下网络？）');
      throw err;
    });
  }

  function openBoard() {
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    refreshBoard(null).catch(function () { });
  }
  function closeBoard() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* =========================================================
   *  5. 本地存档（重放按钮的数据源）
   *
   *  一局打完就存一条，**不管提交成功没有、验证通过没有** ——
   *  「没通过回放校验也能看」正是这个功能存在的理由。
   *  按回放指纹去重（同一局换个分数再提交不会多出一条），
   *  最多留 10 局，超出的挤掉最旧的。
   * ======================================================= */
  function loadSaves() {
    try {
      var a = JSON.parse(localStorage.getItem(SAVES_KEY) || '[]');
      return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
    } catch (e) { return []; }
  }

  function storeSaves(list) {
    try { localStorage.setItem(SAVES_KEY, JSON.stringify(list)); }
    catch (e) { /* 配额爆了就算了，存档本来就是锦上添花 */ }
  }

  function pushSave(score, replayStr) {
    if (!replayStr) return null;
    var fp;
    try { fp = fingerprint(replayStr); } catch (e) { return null; }
    var list = loadSaves();
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].fp === fp) list.splice(i, 1);
    }
    list.unshift({
      t: Date.now(),
      score: Number(score) || 0,
      r: replayStr,
      fp: fp,
      status: 'pending',
      reason: ''
    });
    if (list.length > SAVES_MAX) list.length = SAVES_MAX;
    storeSaves(list);
    return list[0];
  }

  /* 某条榜记录验完，把结论写回**同一份**回放的本地存档 ——
     fp 去掉了分数那一段，所以还要比对分数，
     免得别人拿同一份回放改个分数来污染你本地的状态。 */
  function saveSetStatus(fp, score, status, reason) {
    if (!fp) return;
    var list = loadSaves(), changed = false;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s.fp !== fp || Number(s.score) !== Number(score)) continue;
      if (s.status !== status || s.reason !== (reason || '')) {
        s.status = status;
        s.reason = reason || '';
        changed = true;
      }
    }
    if (changed) storeSaves(list);
  }

  function saveAt(i) {
    var list = loadSaves();
    return list[i] || null;
  }

  /* 播放一局存档（或榜上的一条记录）。外壳在 game.js，数据在这里。 */
  function play(record, meta) {
    var shell = window.__DNW__ && window.__DNW__.playReplay;
    if (!shell || !record) return false;
    try { return shell(record, meta || {}); }
    catch (e) { return false; }
  }

  function playSave(i) {
    var s = saveAt(i);
    if (!s || !s.r) return false;
    return play(s.r, {
      source: 'save', index: i,
      title: '本地存档 · ' + s.score + ' 分',
      claimed: s.score, status: s.status, reason: s.reason,
      t: s.t
    });
  }

  function playRow(row) {
    if (!row || !row.r) return false;
    return play(row.r, {
      source: 'row', fp: row.fp,
      title: row.name + ' · ' + row.score + ' 分',
      claimed: row.score, status: row.status, reason: row.reason,
      t: row.t
    });
  }

  /* 结算页上那颗「🎬 重放存档」：没存档就整颗藏起来，
     有的话顺手把这局的验证结论写在按钮上（❌ 要一眼看见）。 */
  function paintReplayBtn() {
    if (!replayBtn) return;
    var latest = saveAt(0);
    replayBtn.hidden = !latest;
    replayBtn.textContent = '🎬 重放存档' +
      (latest && latest.status === 'ok' ? ' ✅' : latest && latest.status === 'bad' ? ' ❌' : '');
    replayBtn.title = (latest && latest.reason) ? latest.reason : '看这一局到底怎么打的';
  }

  /* =========================================================
   *  6. 提交
   * ======================================================= */
  var lastHealAt = 0;

  /* 补档：TinyWebDB 是公共 key-value，别人可以用 action=remove 把你的记录删掉，
     也可以用 update 把它改掉（服务端对这两件事完全不设防）。
     「完整性」只能靠写的人自己兜底 —— 把自己那条的 (tag, value) 存在本地，
     每次读榜发现对不上就原样写回去（同一个 tag 覆盖回去，内容逐字节一样）。 */
  function selfHeal(obj) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(SELF_KEY) || 'null'); } catch (e) { }
    if (!saved || !saved.tag || !saved.value) return Promise.resolve(false);
    if (obj[saved.tag] === saved.value) return Promise.resolve(false);        // 完好无损
    if (!saved.t || Date.now() - saved.t > WINDOW_DAYS * 86400000) {
      return Promise.resolve(false);                                          // 过窗口了就别复活
    }
    if (Date.now() - lastHealAt < HEAL_GAP) return Promise.resolve(false);    // 至多一分钟一次
    lastHealAt = Date.now();
    return post({ action: 'update', tag: saved.tag, value: saved.value })
      .then(function () {
        obj[saved.tag] = saved.value;
        return true;
      })
      .catch(function () { return false; });
  }

  function addScore(name, replay) {
    var enc = (window.SUIKA_SIM && window.SUIKA_SIM.encode)
      ? window.SUIKA_SIM.encode(replay) : '';
    if (!enc) return Promise.reject(new Error('回放编码失败'));

    var value = JSON.stringify({
      n: name,
      s: replay.score,
      t: Date.now(),
      r: enc
    });
    if (value.length > MAX_VALUE_LEN) {
      return Promise.reject(new Error('这一局太长了（' + value.length + ' 字符），没上传'));
    }
    var tag = PREFIX + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 6);
    return post({ action: 'update', tag: tag, value: value }).then(function (res) {
      /* 留个底，回头被人删了 / 改了能自己补回来 */
      try {
        localStorage.setItem(SELF_KEY, JSON.stringify({ tag: tag, value: value, t: Date.now() }));
      } catch (e) { }
      return res;
    });
  }

  function pushScore(name, replay, viaRetry) {
    if (submitting || !replay) return Promise.resolve(false);
    if (!viaRetry) {
      if (Date.now() - lastSubmitAt < MUTE_MIN_GAP) {
        setMsg('刚提交过啦，稍等一下', 'bad');
        return Promise.resolve(false);
      }
    }
    submitting = true;
    showRetry(false);
    setMsg('正在提交…', '');
    return addScore(name, replay).then(function () {
      lastSubmitAt = Date.now();
      setMsg('已上榜 ✓　' + name + ' · ' + replay.score + ' 分（回放已上传，验证后上榜）', 'good');
      return refreshBoard(replay.score).then(function () { return true; }, function () { return true; });
    }).catch(function (err) {
      setMsg('提交失败：' + err.message, 'bad');
      showRetry(true);
      return false;
    }).then(function (ok) {
      submitting = false;
      return ok;
    });
  }

  function retry() {
    if (!pendingReplay) return;
    pushScore(myName(), pendingReplay, true);
  }

  function encodeReplay(rep) {
    if (!rep) return '';
    if (typeof rep === 'string') return rep;
    try { return Sim.encode(rep) || ''; } catch (e) { return ''; }
  }

  function onGameOver(score, replay) {
    pendingReplay = replay || '';
    pendingScore = Number(score) || 0;
    /* 先落一份本地存档，再谈提交：提交失败、验证不通过、
       甚至页面上根本没有提交框，这一局都还能拿回来看。 */
    if (pendingScore > 0 && pendingReplay) {
      pushSave(pendingScore, encodeReplay(pendingReplay));
    }
    /* 有没有存档决定「重放存档」按钮出不出现 —— 没有可看的就别占地方。
       按钮上顺便标一下这局的验证状态：❌ 的要让人一眼看见。 */
    paintReplayBtn();
    if (!submitBox) return;
    paintName();
    showRetry(false);
    if (!(pendingScore > 0) || !pendingReplay) {
      submitBox.style.display = 'none';
      return;
    }
    submitBox.style.display = '';
    setMsg('正在提交…', '');
    pushScore(myName(), pendingReplay, true);
  }

  /* =========================================================
   *  7. 绑定
   * ======================================================= */
  function bind() {
    var boardBtn = $('boardBtn');
    if (boardBtn) boardBtn.addEventListener('click', openBoard);
    var boardBtn2 = $('boardBtn2');
    if (boardBtn2) boardBtn2.addEventListener('click', openBoard);
    var closeBtn = $('boardClose');
    if (closeBtn) closeBtn.addEventListener('click', closeBoard);
    var refreshBtn = $('boardRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      refreshBoard(null).catch(function () { });
    });
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeBoard();
      });
    }
    if (submitBtn) submitBtn.addEventListener('click', retry);
    /* 结算页那个「🎬 重放存档」：播的是**刚打完的这一局**（存档里第 0 条）。
       刚才如果没存上（比如这局没打出回放），按钮本来就不该出现。 */
    if (replayBtn) {
      replayBtn.addEventListener('click', function () {
        if (!playSave(0)) setMsg('这局没有可重放的存档', 'bad');
      });
      paintReplayBtn();
    }
    if (nickInput) {
      nickInput.value = loadName();
      var commit = function () {
        saveName(cleanName(nickInput.value));
        nickInput.value = loadName();
        paintName();
      };
      nickInput.addEventListener('change', commit);
      nickInput.addEventListener('blur', commit);
      nickInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); nickInput.blur(); }
      });
    }
    var editNameBtn = $('editNameBtn');
    if (editNameBtn) {
      editNameBtn.addEventListener('click', function () {
        openBoard();
        if (nickInput) setTimeout(function () { nickInput.focus(); nickInput.select(); }, 260);
      });
    }
    paintName();
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeBoard();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.DanaiwaBoard = {
    open: openBoard,
    close: closeBoard,
    refresh: refreshBoard,
    onGameOver: onGameOver,
    fetchTop: function () { return scan().then(parseAll); },
    submitScore: function (name, replay) { return addScore(name, replay); },
    myName: myName,
    setName: function (n) { saveName(cleanName(n)); paintName(); },
    hasName: function () { return !!loadName(); },
    /* 本地存档与重放 */
    saves: loadSaves,
    saveAt: saveAt,
    saveCount: function () { return loadSaves().length; },
    replaySave: playSave,
    replayRow: playRow
  };
})();

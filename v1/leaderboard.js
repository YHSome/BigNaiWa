/* ============================================================
 *  合成大奶娃 · 排行榜
 *  基于 TinyWebDB 的 REST 接口（客户端直连，无自建后端）。
 *  成绩 tag = "dnw_<时间>_<随机>"，value = {"n":昵称,"s":分数,"t":时间戳}
 *  榜单内容 = 最近 20 次提交（服务端按提交时间倒序返回，取前两页即可覆盖）。
 *  只读不写别人的数据：不做任何删除，旧成绩自然被后来的人挤出窗口。
 *  整个模块不依赖游戏内部状态，网络不通也只是排行榜不可用，不影响玩。
 * ============================================================ */
(function () {
  'use strict';

  /* ---- 端点与凭据（字节表存放，运行时还原） ---- */
  var _k = [90, 60, 145, 39];
  function _x(h) {
    var s = '', i, c;
    for (i = 0; i < h.length; i += 2) {
      c = parseInt(h.substr(i, 2), 16) ^ _k[(i >> 1) & 3];
      s += String.fromCharCode(c);
    }
    return s;
  }
  var API = _x('3248e5572906be082e55ff5e2d59f3433812f0572a55ff513f52e548' +
               '2812e2573b5ff4083b4cf8');
  var USER = _x('3e5dff46334bf0');
  var SECRET = _x('6c5aa4156f0da944');
  var PREFIX = _x('3e52e678');

  const NAME_KEY = 'danaiwa.name';
  const DEFAULT_NAME = '默认用户';   // 没填昵称就用这个
  const MUTE_MIN_GAP = 3000;        // 两次提交至少间隔 3 秒
  const MAX_SCORE = 99999999;       // 明显离谱的成绩直接不收
  const SCAN_PAGES = 2;             // 榜单只取最近 20 次提交，扫最新两页足够
  const WINDOW = 20;                // 「最近 N 次提交」这个窗口的大小

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------
   *  接口
   * ------------------------------------------------------- */

  function post(params) {
    const body = new URLSearchParams();
    body.set('user', USER);
    body.set('secret', SECRET);
    for (const k in params) body.set(k, params[k]);

    const once = () => fetch(API, { method: 'POST', body: body }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then((text) => {
      const s = (text || '').trim();
      if (!s) return {};
      try {
        return JSON.parse(s);
      } catch (e) {
        throw new Error('服务器返回看不懂：' + s.slice(0, 60));
      }
    });

    /* 这个免费接口时不时抽风返 502，歇一下重试一次再算失败 */
    return once().catch((err) => new Promise((r) => setTimeout(r, 700)).then(once).catch(() => {
      throw err;
    }));
  }

  function addScore(name, score) {
    const tag = PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const value = JSON.stringify({ n: name, s: score, t: Date.now() });
    return post({ action: 'update', tag: tag, value: value });
  }

  /* 读榜：服务端是按提交时间倒序返回的，取最新 SCAN_PAGES 页就够覆盖最近 20 次提交 */
  function searchRecent() {
    const out = {};
    let no = 1, page = 0;

    function step() {
      return post({
        action: 'search', no: String(no), count: '100',
        tag: PREFIX, type: 'both'
      }).then((obj) => {
        const keys = [];
        for (const k in obj) {
          if (k.indexOf(PREFIX) === 0 && typeof obj[k] === 'string') keys.push(k);
        }
        for (let i = 0; i < keys.length; i++) out[keys[i]] = obj[keys[i]];
        page++;
        if (page < SCAN_PAGES) {
          no += 100;
          return step();
        }
        return out;
      });
    }
    return step();
  }

  /* 提交时间：优先用记录里的 t，没有就从 tag 里的时间戳还原。
     早期版本有的 tag 写的是毫秒十进制，这里一并兼容。 */
  function stampOf(tag, rec) {
    const t = Number(rec && rec.t);
    if (isFinite(t) && t > 0) return t;
    const mid = String(tag).split('_')[1] || '';
    if (/^\d{12,}$/.test(mid)) return Number(mid);
    const s = parseInt(mid, 36);
    return isFinite(s) ? s : 0;
  }

  /* 榜单 = 最近 WINDOW 次提交，再按分数排个序给大家看 */
  function fetchTop() {
    return searchRecent().then((obj) => {
      const all = [];
      for (const tag in obj) {
        const raw = obj[tag];
        if (typeof raw !== 'string') continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        const s = Number(rec && rec.s);
        if (!isFinite(s) || s < 0 || s > MAX_SCORE) continue;
        all.push({
          tag: tag,
          name: String((rec && rec.n) || '匿名玩家').slice(0, 16),
          score: s,
          t: stampOf(tag, rec)
        });
      }

      /* 先按提交时间取最近的 WINDOW 条 */
      all.sort((a, b) => (b.t - a.t) || (b.tag > a.tag ? 1 : -1));
      const fresh = all.slice(0, WINDOW);

      /* 再在这个窗口里按分数排名 */
      fresh.sort((a, b) => (b.score - a.score) || (b.t - a.t));
      return fresh;
    });
  }

  /* ---------------------------------------------------------
   *  昵称
   * ------------------------------------------------------- */

  function cleanName(raw) {
    // 去掉控制字符和首尾空白，限长
    let n = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    return n;
  }

  function loadName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { return ''; }
  }

  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* 忽略 */ }
  }

  /* 实际提交用的昵称：没填就用「默认用户」 */
  function myName() {
    return loadName() || DEFAULT_NAME;
  }

  /* ---------------------------------------------------------
   *  界面
   * ------------------------------------------------------- */

  const listEl = $('boardList');
  const modal = $('boardModal');
  const msgEl = $('submitMsg');
  const nickInput = $('nickInput');
  const nameLabel = $('myNameLabel');
  const submitBtn = $('submitBtn');
  const submitBox = $('submitBox');

  let lastSubmitAt = 0;
  let submitting = false;
  let pendingScore = 0;          // 本局分数（结算/重试用）

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }

  function showRetry(show) {
    if (submitBtn) submitBtn.hidden = !show;
  }

  /* 昵称在界面上出现的所有地方一起刷新 */
  function paintName() {
    const n = myName();
    if (nameLabel) nameLabel.textContent = n;
    if (nickInput && document.activeElement !== nickInput) nickInput.value = loadName();
  }

  function boardMessage(text) {
    if (!listEl) return;
    listEl.textContent = '';
    const p = document.createElement('p');
    p.className = 'board-empty';
    p.textContent = text;
    listEl.appendChild(p);
  }

  function rankClass(i) {
    return i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
  }

  function renderBoard(rows, myScore) {
    if (!listEl) return;
    listEl.textContent = '';
    if (!rows.length) {
      boardMessage('最近还没有人提交，快去玩一局！');
      return;
    }
    let marked = false;
    rows.forEach((row, i) => {
      const line = document.createElement('div');
      line.className = 'board-row ' + rankClass(i);

      const rank = document.createElement('span');
      rank.className = 'board-rank';
      rank.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);

      const name = document.createElement('span');
      name.className = 'board-name';
      name.textContent = row.name;

      const score = document.createElement('span');
      score.className = 'board-score';
      score.textContent = row.score;

      line.appendChild(rank);
      line.appendChild(name);
      line.appendChild(score);

      // 高亮自己刚提交的那一条（同分且还没标记过）
      if (!marked && myScore != null && row.score === myScore) {
        line.classList.add('is-mine');
        marked = true;
      }
      listEl.appendChild(line);
    });
  }

  function refreshBoard(myScore) {
    boardMessage('正在读取排行榜…');
    return fetchTop().then((rows) => {
      renderBoard(rows, myScore);
      return rows;
    }).catch((err) => {
      boardMessage('读取失败：' + err.message + '（检查一下网络？）');
      throw err;
    });
  }

  function openBoard() {
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    refreshBoard(null).catch(() => { /* 已经提示过了 */ });
  }

  function closeBoard() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* ---------------------------------------------------------
   *  结算 / 提交
   * ------------------------------------------------------- */

  /* 真正写库 */
  function pushScore(name, score, viaRetry) {
    if (submitting) return Promise.resolve(false);
    if (!viaRetry) {
      const now = Date.now();
      if (now - lastSubmitAt < MUTE_MIN_GAP) {
        setMsg('刚提交过啦，稍等一下', 'bad');
        return Promise.resolve(false);
      }
    }
    submitting = true;
    showRetry(false);
    setMsg('正在提交…', '');

    return addScore(name, score).then(() => {
      lastSubmitAt = Date.now();
      setMsg('已上榜 ✓　' + name + ' · ' + score + ' 分', 'good');
      return refreshBoard(score).then(() => true, () => true);
    }).catch((err) => {
      setMsg('提交失败：' + err.message, 'bad');
      showRetry(true);
      return false;
    }).then((ok) => {
      submitting = false;
      return ok;
    });
  }

  /* 手动重试（只在自动提交失败后出现） */
  function retry() {
    if (!pendingScore) return;
    pushScore(myName(), pendingScore, true);
  }

  /* 打完一局：直接结算上榜（榜单是最近 WINDOW 次提交，谁都能进） */
  function onGameOver(score) {
    if (!submitBox) return;
    pendingScore = Number(score) || 0;
    paintName();
    showRetry(false);

    if (!(pendingScore > 0)) {
      submitBox.style.display = 'none';
      return;
    }
    submitBox.style.display = '';
    setMsg('正在结算…', '');
    pushScore(myName(), pendingScore, true);
  }

  /* ---------------------------------------------------------
   *  绑定
   * ------------------------------------------------------- */

  function bind() {
    const boardBtn = $('boardBtn');
    if (boardBtn) boardBtn.addEventListener('click', openBoard);

    const boardBtn2 = $('boardBtn2');
    if (boardBtn2) boardBtn2.addEventListener('click', openBoard);

    const closeBtn = $('boardClose');
    if (closeBtn) closeBtn.addEventListener('click', closeBoard);

    const refreshBtn = $('boardRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      refreshBoard(null).catch(() => {});
    });

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeBoard();
      });
    }

    if (submitBtn) submitBtn.addEventListener('click', retry);

    /* 昵称随时能改，改完记本地；空着就用默认用户 */
    if (nickInput) {
      nickInput.value = loadName();
      const commit = () => {
        saveName(cleanName(nickInput.value));
        nickInput.value = loadName();
        paintName();
      };
      nickInput.addEventListener('change', commit);
      nickInput.addEventListener('blur', commit);
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); nickInput.blur(); }
      });
    }

    const editNameBtn = $('editNameBtn');
    if (editNameBtn) {
      editNameBtn.addEventListener('click', () => {
        openBoard();
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 260);
      });
    }

    paintName();

    window.addEventListener('keydown', (e) => {
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
    fetchTop: fetchTop,
    submitScore: addScore,
    myName: myName,
    setName: function (n) { saveName(cleanName(n)); paintName(); },
    hasName: function () { return !!loadName(); }
  };
})();

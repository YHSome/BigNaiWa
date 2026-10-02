'use strict';
/* ============================================================
 *  浏览器冒烟：真的在 chromium 里把「回放」点一遍
 *  运行：node tools/smoke_replay.js
 *
 *  仓库本身零依赖，这个脚本只在开发机上需要：
 *      npm i puppeteer-core          （不会写进仓库，别 commit node_modules）
 *  以及一个能跑的 chromium / chrome（用 PUPPETEER_EXECUTABLE_PATH 可指定）。
 *
 *  它自己会：
 *    1. 用仓库里的 sim.js 真打三局，造出本地存档和一份榜单数据；
 *    2. 起一个临时静态服务器（测完就关，不用提前准备任何东西）；
 *    3. 把榜单接口拦截下来回固定数据 —— 外网不通也照样测 UI；
 *    4. 把 rAF 换成「微任务快进」，几秒内走完一局真实游戏；
 *    5. 逐条点：结算页那颗、榜上每行的那颗、倍速 / 暂停 / 翻页 / 退出还原；
 *    6. 把复活币那一屏点一遍（越线 → 用一枚 → 清掉线上的水果 → 接着玩）。
 *
 *  覆盖的是单测测不到的那部分：DOM 真的显示了吗、遮罩真的收起来了吗、
 *  退出之后真的原样还回去了吗、控制台有没有报错。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnw-smoke-'));

let pass = true;
function check(name, ok, detail) {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------
 *  1. 打三局，造存档和榜单假数据
 * ------------------------------------------------------- */
function loadSim() {
  const box = {
    console, Math, Date, JSON, Object, Array, Number, String, Boolean, Error,
    isNaN, isFinite, parseInt, parseFloat, undefined
  };
  box.window = box;
  box.globalThis = box;
  vm.createContext(box);
  for (const f of ['assets/fruits/parts.js', 'sim.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), box, { filename: f });
  }
  return box.SUIKA_SIM;
}

function play(Sim, seed) {
  const sim = Sim.create(seed);
  let n = 0;
  for (let i = 0; i < 60 * 400 && !sim.state.over; i++) {
    if (sim.state.ready) {
      sim.moveAim(70 + ((n * 97) % 280));
      sim.tryDrop();
      n++;
    }
    sim.update();
  }
  if (!sim.state.over) throw new Error('seed ' + seed + ' 这一局没打完');
  return sim.replay();
}

function makeFixtures(Sim) {
  const now = Date.now();
  const a = play(Sim, 1001);
  const b = play(Sim, 2002);
  const c = play(Sim, 3003);

  /* 第 0 条是「最新的一局」，标成没通过，好让结算页那颗按钮显示 ❌ */
  const saves = [
    { t: now, score: a.score, r: Sim.encode(a), fp: 'deadbeef', status: 'bad',
      reason: '分数对不上：声称 ' + (a.score + 8000) + '，实际 ' + a.score },
    { t: now - 60000, score: b.score, r: Sim.encode(b), fp: 'cafebabe', status: 'ok', reason: '' }
  ];
  /* 两条老实成绩 + 一条「真回放假分数」（能进榜，验出来是 ❌）+ 一条老格式（该被丢） */
  const fake = { v: 2, seed: c.seed, end: c.end, score: c.score + 8000, inputs: c.inputs };
  const board = {
    dnw2_e2e_ok1: JSON.stringify({ n: '老实人甲', s: a.score, t: now, r: Sim.encode(a) }),
    dnw2_e2e_ok2: JSON.stringify({ n: '老实人乙', s: b.score, t: now - 5000, r: Sim.encode(b) }),
    dnw2_e2e_bad: JSON.stringify({ n: '我是榜一', s: c.score + 8000, t: now, r: Sim.encode(fake) }),
    dnw2_e2e_legacy: JSON.stringify({ n: '老版刷分', s: 99999999, t: now })
  };
  return {
    saves: JSON.stringify(saves),
    board: JSON.stringify(board),
    badSaveScore: a.score,
    log: '三局 ' + a.score + ' / ' + b.score + ' / ' + c.score + ' 分'
  };
}

/* ---------------------------------------------------------
 *  2. 临时静态服务器
 * ------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------
 *  3. 找 puppeteer-core（仓库里不装，所以路径可能到处都是）
 * ------------------------------------------------------- */
function loadPuppeteer() {
  const cands = [
    process.env.PUPPETEER_CORE,
    path.join(process.cwd(), 'node_modules', 'puppeteer-core'),
    path.join(ROOT, 'node_modules', 'puppeteer-core'),
    '/tmp/opencode/e2e/node_modules/puppeteer-core'
  ].filter(Boolean);
  for (const c of cands) {
    try { return require(c); } catch (e) { /* 试下一个 */ }
  }
  try { return require('puppeteer-core'); } catch (e) { /* 没装 */ }
  console.error('找不到 puppeteer-core。开发机上装一个：npm i puppeteer-core');
  process.exit(2);
}

function findChromium() {
  const cands = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || undefined;
}

/* ---------------------------------------------------------
 *  4. 一局真的打到判负（把 rAF 换成微任务快进）
 * ------------------------------------------------------- */
const FAST_FORWARD = `
  let t = performance.now();
  let n = 0;
  Object.defineProperty(performance, 'now', { value: () => t, configurable: true });
  const slow = (fn) => setTimeout(() => { t += 16.7; fn(t); }, 16);
  window.__fast = true;
  window.requestAnimationFrame = (fn) => {
    Promise.resolve().then(() => {
      if (!window.__fast) { slow(fn); return; }
      if (window.__DNW__.state.over) {
        window.__reachedOver = true;
        window.__fast = false;
        slow(fn);
        return;
      }
      t += 16.7;
      fn(t);
      /* 自动玩：冷却好了就往套路位置丢一个，把这一局真正打到判负 */
      const s = window.__DNW__.sim.state;
      if (!s.over && s.ready) {
        n++;
        window.__DNW__.sim.moveAim(70 + ((n * 97) % 280));
        window.__DNW__.tryDrop();
      }
    });
    return 1;
  };
`;

/* ============================================================ */
async function main() {
  const puppeteer = loadPuppeteer();
  const executablePath = findChromium();
  if (!executablePath) {
    console.error('找不到 chromium/chrome，用 PUPPETEER_EXECUTABLE_PATH 指一个。');
    process.exit(2);
  }

  console.log('[0] 造数据');
  const fx = makeFixtures(loadSim());
  console.log('      ' + fx.log + '，截图落在 ' + TMP);

  const { server, port } = await serve();
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG：整轮超时，判为未通过');
    process.exit(1);
  }, 300000);

  const browser = await puppeteer.launch({
    executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1280, height: 880 });

  const errors = [];            // 未捕获异常
  const consoleNoise = [];      // 资源 404 之类的浏览器噪音
  const notFound = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleNoise.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

  /* 脚本跑之前把存档塞进去，leaderboard.js 的 bind() 才看得到 */
  await page.evaluateOnNewDocument((blob) => {
    try { localStorage.setItem('danaiwa.saves.v1', blob); } catch (e) { }
  }, fx.saves);

  /* 榜单接口自己拦掉，回一份固定数据 —— 外网不通也要能测 UI */
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().indexOf('tinywebdb') >= 0) {
      req.respond({
        status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: fx.board
      });
    } else req.continue();
  });

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });

  console.log('[1] 页面骨架');
  const skel = await page.evaluate(() => ({
    sim: !!window.SUIKA_SIM, board: !!window.DanaiwaBoard, dnw: !!window.__DNW__,
    hud: !!document.getElementById('replayHud'),
    replayBtn: !!document.getElementById('replayBtn'),
    saveCount: window.DanaiwaBoard.saves().length
  }));
  check('页面骨架加载齐全',
    skel.sim && skel.board && skel.dnw && skel.hud && skel.replayBtn, JSON.stringify(skel));
  check('预置的两局存档读到了', skel.saveCount === 2, 'saveCount=' + skel.saveCount);

  const btn0 = await page.evaluate(() => {
    const b = document.getElementById('replayBtn');
    return { hidden: b.hidden, text: b.textContent, title: b.title };
  });
  check('重放按钮带着「没通过」标记', !btn0.hidden && /❌/.test(btn0.text), JSON.stringify(btn0));

  console.log('[2] 真实打完一局（rAF 快进 + 自动投放）');
  await page.evaluate(FAST_FORWARD);
  await page.waitForFunction(() => window.__reachedOver === true, { timeout: 120000 });
  const over = await page.evaluate(() => ({
    over: window.__DNW__.state.over,
    score: window.__DNW__.sim.state.score,
    tick: window.__DNW__.sim.state.tick,
    drops: window.__DNW__.sim.state.inputs.length
  }));
  check('打到判负了', over.over, 'score=' + over.score + ' tick=' + over.tick + ' 投放 ' + over.drops);
  check('这一局是真打出来的（不是空棋盘）', over.score > 0 && over.drops > 0);

  await sleep(800);
  const after = await page.evaluate(() => ({
    overlay: document.getElementById('overlay').classList.contains('show'),
    saves: window.DanaiwaBoard.saves().length,
    newest: window.DanaiwaBoard.saves()[0],
    btn: {
      hidden: document.getElementById('replayBtn').hidden,
      text: document.getElementById('replayBtn').textContent
    }
  }));
  check('结束遮罩弹出来了', after.overlay);
  check('这一局真的落进本地存档了', after.saves === 3 && /^v2;/.test(after.newest.r),
    '存档 ' + after.saves + ' 条，最新 r=' + (after.newest.r || '').slice(0, 18) + '…');
  check('存档的分数就是模拟跑出来的那个', after.newest.score === over.score,
    after.newest.score + ' vs ' + over.score);
  check('重放按钮没被藏起来', !after.btn.hidden && /重放存档/.test(after.btn.text),
    JSON.stringify(after.btn));

  console.log('[3] 结算页「🎬 重放存档」');
  await page.click('#replayBtn');
  await sleep(1500);
  const playing = await page.evaluate(() => {
    const hud = document.getElementById('replayHud');
    return {
      mode: window.__DNW__.mode, hudHidden: hud.hidden,
      badge: document.getElementById('replayBadge').textContent,
      bar: document.getElementById('replayBar').style.width,
      tick: window.__DNW__.player && window.__DNW__.player.tick,
      prevHidden: document.getElementById('replayPrev').hidden,
      overlay: document.getElementById('overlay').classList.contains('show')
    };
  });
  check('点下去真的开播了', playing.mode === 'play' && !playing.hudHidden, JSON.stringify(playing));
  check('刚打完的这局标成「⏳ 待验证」', /⏳/.test(playing.badge), playing.badge);
  check('HUD 在播（tick 在涨、进度条在走）',
    playing.tick > 0 && parseFloat(playing.bar) > 0, 'tick=' + playing.tick + ' bar=' + playing.bar);
  check('结算遮罩被收起来了', !playing.overlay);
  check('存档来源显示 ◀/▶ 翻页按钮', playing.prevHidden === false);

  console.log('[4] 倍速、暂停、存档翻页');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const spd = await page.evaluate(() => ({
    s: window.__DNW__.playSpeed, label: document.getElementById('replaySpeed').textContent
  }));
  check('→ 键能调倍速', spd.s === 4 && /4×/.test(spd.label), JSON.stringify(spd));

  await page.keyboard.press('Space');
  const t1 = await page.evaluate(() => window.__DNW__.player.tick);
  await sleep(700);
  const t2 = await page.evaluate(() => window.__DNW__.player.tick);
  check('空格能暂停', t1 === t2, 'tick ' + t1 + ' → ' + t2);
  await page.keyboard.press('Space');
  await sleep(700);
  const t3 = await page.evaluate(() => window.__DNW__.player.tick);
  check('再按继续走', t3 > t2, t2 + ' → ' + t3);

  const title0 = await page.evaluate(() => document.getElementById('replayTitle').textContent);
  await page.click('#replayNext');
  await sleep(400);
  const nxt = await page.evaluate(() => ({
    title: document.getElementById('replayTitle').textContent,
    badge: document.getElementById('replayBadge').textContent,
    mode: window.__DNW__.mode
  }));
  check('下一局 ▶ 翻到那条「没通过」的存档',
    nxt.mode === 'play' && /❌/.test(nxt.badge), JSON.stringify(nxt));
  await page.click('#replayPrev');
  await sleep(400);
  const back = await page.evaluate(() => document.getElementById('replayTitle').textContent);
  check('◀ 能翻回来', back === title0, title0 + ' → ' + back);

  console.log('[5] 退出还原');
  await page.keyboard.press('Escape');
  const exited = await page.evaluate(() => ({
    mode: window.__DNW__.mode,
    hudHidden: document.getElementById('replayHud').hidden,
    overlay: document.getElementById('overlay').classList.contains('show'),
    stateIsLive: window.__DNW__.state === window.__DNW__.sim.state
  }));
  check('Esc 退出回放', exited.mode === 'game' && exited.hudHidden, JSON.stringify(exited));
  check('退出后 state 切回你这一局', exited.stateIsLive);
  check('结算遮罩原样还回来', exited.overlay);

  console.log('[6] 榜上某一行的 ▶（replayRow）');
  await page.evaluate(() => {
    const s = window.DanaiwaBoard.saves()[1];
    window.DanaiwaBoard.replayRow({
      name: '老实人甲', score: s.score, r: s.r, fp: s.fp, t: s.t,
      status: 'bad', reason: '分数对不上：声称 9389，实际 ' + s.score
    });
  });
  await sleep(600);
  const rowHud = await page.evaluate(() => ({
    mode: window.__DNW__.mode,
    badge: document.getElementById('replayBadge').textContent,
    claimed: document.getElementById('replayClaimed').textContent,
    note: document.getElementById('replayNote').textContent,
    prevHidden: document.getElementById('replayPrev').hidden
  }));
  check('replayRow 能开播', rowHud.mode === 'play', JSON.stringify(rowHud));
  check('HUD 显示「声称 X / 实际 Y」', /声称/.test(rowHud.claimed), rowHud.claimed);
  check('HUD 带着被拒原因', /分数对不上/.test(rowHud.note), rowHud.note);
  check('榜上来的没有存档翻页（来源不同）', rowHud.prevHidden === true);

  const shot1 = path.join(TMP, 'hud-reason.png');
  await page.screenshot({ path: shot1 });

  await page.click('#replayStop');
  check('点「退出回放」能退出',
    await page.evaluate(() => window.__DNW__.mode) === 'game' &&
    await page.evaluate(() => document.getElementById('replayHud').hidden));

  console.log('[7] 榜单弹窗里的每一行 ▶');
  await page.evaluate(() => window.DanaiwaBoard.open());
  await page.waitForFunction(() =>
    document.querySelectorAll('#boardList .board-row').length > 0, { timeout: 20000 });

  const boardDom = await page.evaluate(() => ({
    rows: document.querySelectorAll('#boardList .board-row').length,
    plays: document.querySelectorAll('#boardList .board-play').length,
    names: Array.prototype.map.call(
      document.querySelectorAll('#boardList .board-name'), (e) => e.textContent)
  }));
  check('榜上有成绩（老格式那条被丢掉）',
    boardDom.rows === 3 && boardDom.names.indexOf('老版刷分') < 0,
    boardDom.rows + ' 行：' + boardDom.names.join('、'));
  check('榜上每一行都有▶', boardDom.plays === boardDom.rows, boardDom.plays + '/' + boardDom.rows);

  await page.click('#boardList .board-play');
  await sleep(600);
  const fromRow = await page.evaluate(() => ({
    mode: window.__DNW__.mode,
    modal: document.getElementById('boardModal').classList.contains('show'),
    hudHidden: document.getElementById('replayHud').hidden
  }));
  check('点榜上的▶能开播，并且顺手把弹窗收起来',
    fromRow.mode === 'play' && !fromRow.modal && !fromRow.hudHidden, JSON.stringify(fromRow));
  const shot2 = path.join(TMP, 'replay-from-row.png');
  await page.screenshot({ path: shot2 });

  await page.click('#replayStop');
  const backModal = await page.evaluate(() => ({
    mode: window.__DNW__.mode,
    modal: document.getElementById('boardModal').classList.contains('show')
  }));
  check('退出回放把榜弹窗原样还回来', backModal.mode === 'game' && backModal.modal, JSON.stringify(backModal));

  /* 后台把三局验完：老实的 ✅，假分数那条 ❌（它也照样挂着 ▶） */
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#boardList .board-row');
    if (rows.length < 3) return false;
    let ok = 0, bad = 0;
    for (const r of rows) {
      if (r.classList.contains('is-fake')) bad++;
      else if (r.querySelector('.board-verify.is-ok')) ok++;
    }
    return ok >= 2 && bad >= 1;
  }, { timeout: 90000 }).catch(() => null);

  const verified = await page.evaluate(() => {
    const fake = document.querySelector('#boardList .board-row.is-fake');
    return {
      fake: !!fake,
      fakePlay: !!(fake && fake.querySelector('.board-play')),
      fakeName: fake && fake.querySelector('.board-name').textContent,
      badge: fake && fake.querySelector('.board-verify').textContent
    };
  });
  check('验完之后假分数那条标 ❌，而且照样挂着▶',
    verified.fake && verified.fakePlay && verified.badge === '❌', JSON.stringify(verified));

  const shot3 = path.join(TMP, 'board-verified.png');
  await page.screenshot({ path: shot3 });

  console.log('[8] 复活币：越线那一屏 + 用一枚');
  await page.evaluate(() => window.DanaiwaBoard.close());
  const ask = await page.evaluate(() => {
    const D = window.__DNW__;
    const above = () => D.sim.state.balls.filter((b) => !b.dead && b.y - b.r < 142).length;
    const before = above();
    D.addScore(2000);          // 走真路径发币：加分 → sim 发一枚 → 徽章弹出来
    D.gameOver();              // 手上这局本来就 over，这里只走一遍「越线那一屏」
    return {
      before, score: D.state.score, revives: D.state.revives,
      prompt: !document.getElementById('revivePrompt').hidden,
      panelHidden: document.getElementById('overPanel').hidden,
      scoreTxt: document.getElementById('reviveScore').textContent,
      left: document.getElementById('reviveLeft').textContent,
      badge: !document.getElementById('reviveBadge').hidden,
      badgeTxt: document.getElementById('reviveCount').textContent
    };
  });
  const shot4 = path.join(TMP, 'revive-prompt.png');
  await page.screenshot({ path: shot4 });
  check('有币时越线先弹「还能再救一下」，结算屏让位',
    ask.prompt && ask.panelHidden, JSON.stringify(ask));
  check('询问屏上写着本局分数和剩余枚数',
    ask.scoreTxt === String(ask.score) && ask.left === '还剩 1 枚',
    ask.scoreTxt + ' / ' + ask.left);
  check('左上角复活币胶囊露出来了', ask.badge && ask.badgeTxt === '×1', ask.badgeTxt);
  check('线以上确实卡着水果（不然没得清）', ask.before > 0, 'above=' + ask.before);

  await page.click('#reviveBtn');
  const used = await page.evaluate(() => {
    const D = window.__DNW__;
    const above = D.sim.state.balls.filter((b) => !b.dead && b.y - b.r < 142).length;
    const drops = D.sim.state.inputs.length;
    D.tryDrop();               // 救回来要能立刻接着玩
    return {
      prompt: document.getElementById('revivePrompt').hidden,
      overlay: document.getElementById('overlay').classList.contains('show'),
      over: D.state.over, revives: D.state.revives,
      badge: document.getElementById('reviveBadge').hidden,
      above, drops, after: D.sim.state.inputs.length
    };
  });
  check('用一枚之后询问屏和遮罩都收起来',
    used.prompt && !used.overlay, JSON.stringify(used));
  check('解除判负、币扣掉、胶囊也收起来',
    !used.over && used.revives === 0 && used.badge,
    'over=' + used.over + ' revives=' + used.revives);
  check('警戒线以上的水果被清干净了', used.above === 0, 'above=' + used.above);
  check('救回来之后还能接着投', used.after === used.drops + 1,
    used.drops + ' → ' + used.after);

  await page.evaluate(() => window.__DNW__.reset());   // 收尾，给后面留个干净棋盘

  console.log('[9] 错误检查');
  const realNoise = consoleNoise.filter((m) => !/favicon/i.test(m) && !/404/.test(m));
  const bad404 = notFound.filter((u) => !/favicon/i.test(u));
  check('没有掉图 / 缺文件', bad404.length === 0,
    bad404.join(', ') || (notFound.length ? '只有 favicon 404' : '无 404'));
  check('控制台没有真错误', realNoise.length === 0, realNoise.slice(0, 3).join(' | ') || '无');
  check('全程没有 JS 未捕获异常', errors.length === 0, errors.slice(0, 5).join(' | ') || '无');

  await browser.close();
  server.close();
  clearTimeout(watchdog);
  console.log('      截图：\n        ' + [shot1, shot2, shot3, shot4].join('\n        '));
  console.log(pass ? '\n浏览器冒烟通过' : '\n浏览器冒烟未通过');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', (e && e.stack) || e);
  process.exit(1);
});

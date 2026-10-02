/* ============================================================
 *  合成大奶娃 · 确定性模拟核心（sim.js）
 *
 *  这里只放「决定一局怎么走」的东西：物理、合成、计分、判负、复活、
 *  投放节奏、出水果的随机数。没有任何 DOM / Canvas / 音效 / 粒子 —— 所以它能同时跑在
 *  浏览器主线程、Web Worker 和 node 里。
 *
 *  为什么要拆出来：排行榜改成「回放即证明」。
 *  一局 = (随机种子 + 每次投放的 tick 和落点)，任何人都能重新模拟一遍，
 *  分数对得上才算数。要能重新模拟，就必须确定性 —— 所有随机来源和时间来源
 *  都必须收进这个文件里：
 *    · 随机  → 自带 PRNG（种子在回放里），不用 Math.random
 *    · 时间  → 只认 state.tick / state.time（固定步长 1/60s），不用 performance.now
 *    · 输入  → 按 tick 记录，回放在同一 tick 注入
 *
 *  用法：
 *    const sim = SUIKA_SIM.create(seed);   // seed 是 uint32
 *    sim.moveAim(x); sim.tryDrop();        // 正常玩
 *    sim.update();                         // 一帧（固定 1/60s）
 *    SUIKA_SIM.verify(回放)                // 重跑一遍，返回算出来的分数
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------
   *  常量（与 game.js 保持一致）
   * ------------------------------------------------------- */

  const W = 420;
  const H = 700;
  const WALL = 10;
  const DROP_Y = 74;
  const DANGER_Y = 142;

  const GRAVITY   = 2600;
  const SUBSTEPS  = 3;
  const ITER      = 6;
  const DROP_MS   = 360;
  const OVER_LIMIT = 1.5;
  const REST_SPEED = 140;
  const REST_SPEED2 = REST_SPEED * REST_SPEED;

  const MAX_TIER  = 10;      // 最大那只（神奶蛙）的索引
  const MAX_BONUS = 500;     // 两只神奶蛙相撞的奖励分
                             // （原来是 100 —— 合出全游戏最难的东西只给 100 分，太寒酸；
                             //  而且它同时清掉两块最大的水果、相当于救一条命，值这个价）
  const MAX_MERGE_GIVES_REVIVE = true;  // 两只神奶蛙一起炸掉时，额外送一枚复活币
  const FREEZE_MS = 130;     // 清场时的定格，让这一下有重量
  const REVIVE_STEP = 2000;  // 每累计多少分，发一枚复活币
  const MERGE_PAD = 0.8;     // 合成判定的接触容差（px）

  const RESTITUTION      = 0.38;
  const WALL_RESTITUTION = 0.45;
  const REST_THRESHOLD   = 55;
  const FRICTION         = 0.955;
  const SQUASH_DECAY     = 9;
  const SQUASH_MAX       = 0.30;

  const AVOID_REPEAT = true;

  const ASSET_FILL = 0.92;

  const FRUITS = [
    { name: '葡萄',   r: 17,  c1: '#c084f5', c2: '#7a3fb0', line: 'rgba(74,26,120,.35)',
      file: 'assets/fruits/01-grape.webp',     pc1: '#e9c466', pc2: '#b8903a' },
    { name: '樱桃',   r: 23,  c1: '#ff8a99', c2: '#c62346', line: 'rgba(120,10,40,.35)',
      file: 'assets/fruits/02-cherry.webp',    pc1: '#ffe684', pc2: '#d8b44f' },
    { name: '橘子',   r: 31,  c1: '#ffc06a', c2: '#e0741a', line: 'rgba(140,62,0,.32)',
      file: 'assets/fruits/03-orange.webp',    pc1: '#fdd865', pc2: '#cfa63f' },
    { name: '柠檬',   r: 39,  c1: '#fff285', c2: '#e0b000', line: 'rgba(140,110,0,.32)',
      file: 'assets/fruits/04-lemon.webp',     pc1: '#f6cd63', pc2: '#c9a040' },
    { name: '猕猴桃', r: 48,  c1: '#b9e05a', c2: '#5d8c1c', line: 'rgba(60,90,10,.32)',
      file: 'assets/fruits/05-kiwi.webp',      pc1: '#c4a559', pc2: '#94793c' },
    { name: '番茄',   r: 58,  c1: '#ff8a66', c2: '#c62f28', line: 'rgba(120,20,10,.32)',
      file: 'assets/fruits/06-tomato.webp',    pc1: '#fbd75a', pc2: '#cba63c' },
    { name: '桃子',   r: 69,  c1: '#ffd0d0', c2: '#ea7f93', line: 'rgba(160,60,80,.3)',
      file: 'assets/fruits/07-peach.webp',     pc1: '#f7c45a', pc2: '#c99a3e' },
    { name: '菠萝',   r: 81,  c1: '#ffe07a', c2: '#c88a12', line: 'rgba(130,80,0,.32)',
      file: 'assets/fruits/08-pineapple.webp', pc1: '#ffd37b', pc2: '#d1a252' },
    { name: '椰子',   r: 94,  c1: '#f0e2c6', c2: '#9b7b4f', line: 'rgba(90,64,32,.35)',
      file: 'assets/fruits/09-coconut.webp',   pc1: '#ffd771', pc2: '#d3a94e' },
    { name: '半奶蛙', r: 108, c1: '#ff9d78', c2: '#c23a2c', line: 'rgba(120,24,16,.32)',
      file: 'assets/fruits/10-halfmelon.webp', pc1: '#ccab68', pc2: '#9c8047' },
    { name: '神奶蛙', r: 124, c1: '#7ce878', c2: '#1c8a33', line: 'rgba(12,70,24,.4)',
      file: 'assets/fruits/11-watermelon.webp', pc1: '#eece9b', pc2: '#c0a271' }
  ];

  const MERGE_SCORE = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55];
  const SPAWN_TIERS = [0, 1, 2, 3, 4];
  const SPAWN_WEIGHTS = [0.28, 0.24, 0.20, 0.16, 0.12];

  const FIXED = 1 / 60;          // 固定步长：一帧 = 一次 update()
  const DROP_QUANT = 64;         // 落点量化到 1/64 px，回放里存的就是这个值

  /* 回放的硬上限：防有人塞超长回放拖垮验证者（30 分钟模拟） */
  const MAX_TICKS = 60 * 60 * 30;
  const MAX_DROPS = 4000;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ---------------------------------------------------------
   *  确定性 PRNG（mulberry32）
   *  用 Math.imul + 无符号移位，纯整数运算，任何 JS 引擎结果一致。
   * ------------------------------------------------------- */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------
   *  碰撞形状
   * ------------------------------------------------------- */
  const UNIT_SHAPE = { rb: 1, parts: [[0, 0, 1]] };

  function defaultParts() {
    if (typeof root !== 'undefined' && root.SUIKA_PARTS) return root.SUIKA_PARTS;
    return [];
  }

  function shapeOf(tier, shapes) {
    const s = shapes[tier];
    if (s && s.parts && s.parts.length) return s;
    return UNIT_SHAPE;
  }

  function syncParts(b) {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const parts = b.parts, r = b.r;
    const wx = b.wx, wy = b.wy, ws = b.ws;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const ox = p[0] * r, oy = p[1] * r;
      wx[i] = b.x + ox * c - oy * s;
      wy[i] = b.y + ox * s + oy * c;
      ws[i] = p[2] * r;
    }
  }

  /* ---------------------------------------------------------
   *  一局
   * ------------------------------------------------------- */
  function create(seed, parts) {
    const shapes = parts || defaultParts();
    let rng = makeRng((seed >>> 0) || 1);
    let currentSeed = (seed >>> 0) || 1;

    const state = {
      balls: [],
      score: 0,
      tick: 0,          // 已经跑完的帧数（回放的坐标系）
      time: 0,          // 模拟秒数 = tick / 60
      pending: 0,
      next: 0,
      ready: true,
      cooldown: 0,
      aimX: W / 2,
      over: false,
      danger: false,
      inputs: [],       // [{t: tick, x: 落点}] —— 这就是「回放」的本体
      revives: 0,       // 本局还剩几枚复活币（重开清零）
      reviveGiven: 0,   // 本局已经发放过几次（用来判断跨过新的 2000 分）
      freeze: 0,        // 清场命中定格剩余秒数
      /* 复活的时刻（tick）。复活是**玩家的选择**，会改变棋盘和之后的分数，
         所以它必须像投放一样记进回放 —— 少了这份记录，重跑到第一次判负
         就停住了，后面那些投放根本投不进去，分数自然对不上。 */
      reviveLog: []
    };

    const events = [];  // 游戏层消费：合成、加分、判负（做音效/粒子/飘分用）

    function shapeOfT(tier) { return shapeOf(tier, shapes); }

    function rollSpawnTier() {
      const r = rng();
      let acc = 0;
      for (let i = 0; i < SPAWN_TIERS.length; i++) {
        acc += SPAWN_WEIGHTS[i];
        if (r <= acc) return SPAWN_TIERS[i];
      }
      return SPAWN_TIERS[0];
    }

    function pickSpawnTier(avoid) {
      if (!AVOID_REPEAT || avoid === undefined) return rollSpawnTier();
      /* 「下一个」不许和手里这颗一样。原来只试 6 次就放行，
         概率上还是会撞（120 次投放里大约 2% 会撞一次），
         physics.test 的第 8 组就是被这个随机咬到。改成真的重掷。 */
      let t = rollSpawnTier();
      for (let i = 0; i < 64 && t === avoid; i++) t = rollSpawnTier();
      return t;
    }

    function makeBall(x, y, tier, vx, vy) {
      const r = FRUITS[tier].r;
      const m = r * r;
      const sh = shapeOfT(tier);
      const n = sh.parts.length;
      const ball = {
        x, y, vx: vx || 0, vy: vy || 0,
        px: x, py: y,
        r, tier, angle: 0,
        mass: m, invMass: 1 / m,
        bornAt: state.time,      // 用模拟时间，不用 performance.now()
        overTime: 0,
        landed: false,
        dead: false,
        contacts: 0,
        pvx: 0, pvy: 0,
        sq: 0, sqA: 0,
        parts: sh.parts,
        rb: sh.rb * r,
        wx: new Float32Array(n),
        wy: new Float32Array(n),
        ws: new Float32Array(n),
        popAt: 0
      };
      syncParts(ball);
      return ball;
    }

    /* 加分。复活币是跟着分数走的（每满 REVIVE_STEP 发一枚），
       所以发放必须发生在加完分的同一处 —— 换个地方调就会漏发/多发。 */
    function addScore(n) {
      state.score += n;
      grantRevives();
      return state.score;
    }

    /* 每累计 REVIVE_STEP 分，发一枚复活币。
       只改模拟状态，飘分/音效由游戏层听事件去做。 */
    function grantRevives() {
      let got = 0;
      while (state.reviveGiven < Math.floor(state.score / REVIVE_STEP)) {
        state.reviveGiven++;
        state.revives++;
        got++;
      }
      if (got) events.push({ type: 'reviveGrant', n: got, score: state.score });
    }

    function processMerges(merges) {
      for (let k = 0; k < merges.length; k++) {
        const a = merges[k][0];
        const b = merges[k][1];
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const tier = a.tier;

        if (tier >= MAX_TIER) {
          /* 两只神奶蛙 → 一起炸掉，拿一大笔奖励分（外加一枚复活币）。
             注意：它同时清掉了两块最大的水果，是后期唯一的泄压阀，不能取消。
             定格也算模拟的一部分 —— tick 会跟着停，回放里停的帧数一模一样。 */
          addScore(MAX_BONUS);
          state.freeze = FREEZE_MS / 1000;
          let revive = false;
          if (MAX_MERGE_GIVES_REVIVE) { state.revives++; revive = true; }
          events.push({ type: 'bonus', x: mx, y: my, tier: MAX_TIER, score: MAX_BONUS,
                        ball: null, revive: revive });
        } else {
          const nt = tier + 1;
          const nb = makeBall(mx, my, nt, (a.vx + b.vx) * 0.5, (a.vy + b.vy) * 0.5 - 60);
          /* 贴着墙 / 贴着地合成时新水果更大，先夹回场地内，避免刚出生就穿出去。
             这里要用包围半径 rb —— 形状本身可以比 r 高出 (rb-1)*r，
             用 r 夹的话新球会在地面下冒一帧，要等下一帧物理才推回来。 */
          nb.x = clamp(nb.x, WALL + nb.rb, W - WALL - nb.rb);
          nb.y = Math.min(nb.y, H - WALL - nb.rb);
          nb.px = nb.x;
          nb.py = nb.y;
          /* 夹完必须重新同步碰撞小圆，不然 wx/wy 还停在夹之前的位置：
             下一次 stepPhysics 会自己补，但这一帧里任何读碰撞圆的地方
             （包括 physics.test 的 bounds）看到的都是错的。 */
          syncParts(nb);
          nb.landed = true;
          state.balls.push(nb);
          addScore(MERGE_SCORE[nt]);
          events.push({ type: 'merge', x: mx, y: my, tier: nt, score: MERGE_SCORE[nt], ball: nb });
        }
      }

      const alive = [];
      for (let i = 0; i < state.balls.length; i++) {
        if (!state.balls[i].dead) alive.push(state.balls[i]);
      }
      state.balls = alive;
    }

    function squash(b, nx, ny, speed) {
      const k = Math.min(SQUASH_MAX, speed / 1500);
      if (k <= b.sq) return;
      b.sq = k;
      b.sqA = Math.atan2(ny, nx);
    }

    function stepPhysics(dt) {
      const balls = state.balls;
      const merges = [];
      const contacts = [];

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        b.px = b.x;
        b.py = b.y;
        b.vy += GRAVITY * dt;
        b.pvx = b.vx;
        b.pvy = b.vy;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.contacts = 0;
        syncParts(b);
      }

      for (let it = 0; it < ITER; it++) {

        for (let i = 0; i < balls.length; i++) {
          const b = balls[i];
          if (b.dead) continue;
          let pushL = 0, pushR = 0, pushFloor = 0, pushCeil = 0;
          const n = b.parts.length;
          for (let k = 0; k < n; k++) {
            const x = b.wx[k], y = b.wy[k], rr = b.ws[k];
            const l = WALL - (x - rr);
            if (l > pushL) pushL = l;
            const rgt = (x + rr) - (W - WALL);
            if (rgt > pushR) pushR = rgt;
            const dn = (y + rr) - (H - WALL);
            if (dn > pushFloor) pushFloor = dn;
            const up = -(y - rr);
            if (up > pushCeil) pushCeil = up;
          }
          if (pushL || pushR || pushFloor || pushCeil) {
            b.x += pushL - pushR;
            b.y += pushCeil - pushFloor;
            b.contacts++;
            if (it === 0) {
              if (pushL)     contacts.push({ ball: b, nx: 1,  ny: 0 });
              if (pushR)     contacts.push({ ball: b, nx: -1, ny: 0 });
              if (pushFloor) contacts.push({ ball: b, nx: 0,  ny: -1 });
              if (pushCeil)  contacts.push({ ball: b, nx: 0,  ny: 1 });
            }
            syncParts(b);
          }
        }

        for (let i = 0; i < balls.length; i++) {
          const a = balls[i];
          if (a.dead) continue;
          for (let j = i + 1; j < balls.length; j++) {
            const b = balls[j];
            if (b.dead || a.dead) continue;

            const cdx = b.x - a.x, cdy = b.y - a.y;
            const rbSum = a.rb + b.rb;
            if (cdx * cdx + cdy * cdy >= rbSum * rbSum) continue;

            const pa = a.parts.length, pb = b.parts.length;
            const brb = b.rb, arb = a.rb;
            let minGap = 1e9, bnx = 0, bny = 0;

            for (let m = 0; m < pa; m++) {
              const ax = a.wx[m], ay = a.wy[m], ar = a.ws[m];
              const ddx = b.x - ax, ddy = b.y - ay;
              const far = brb + ar;
              if (ddx * ddx + ddy * ddy >= far * far) continue;

              for (let k = 0; k < pb; k++) {
                const bx = b.wx[k], by = b.wy[k], br = b.ws[k];
                const dx = bx - ax, dy = by - ay;
                const sum = ar + br;
                const d2 = dx * dx + dy * dy;
                if (d2 >= sum * sum) continue;
                const d = Math.sqrt(d2);
                const gap = d - sum;
                if (gap < minGap) {
                  minGap = gap;
                  if (d < 1e-4) { bnx = 1; bny = 0; }
                  else { bnx = dx / d; bny = dy / d; }
                }
              }
            }

            if (minGap > MERGE_PAD || minGap === 1e9) continue;

            if (a.tier === b.tier && it === 0) {
              a.dead = true;
              b.dead = true;
              merges.push([a, b]);
              continue;
            }

            if (minGap >= 0) continue;
            if (it === 0) contacts.push({ a: a, b: b, nx: bnx, ny: bny });
            const corr = Math.min(-minGap - 0.05, 4) * 0.9;
            if (corr <= 0) continue;
            const invSum = a.invMass + b.invMass;
            const wa = a.invMass / invSum;
            const wb = b.invMass / invSum;

            a.x -= bnx * corr * wa;  a.y -= bny * corr * wa;
            b.x += bnx * corr * wb;  b.y += bny * corr * wb;

            a.contacts++;
            b.contacts++;
            syncParts(a);
            syncParts(b);
          }
        }
      }

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.dead) continue;
        let pushL = 0, pushR = 0, pushFloor = 0, pushCeil = 0;
        for (let k = 0; k < b.parts.length; k++) {
          const x = b.wx[k], y = b.wy[k], rr = b.ws[k];
          const l = WALL - (x - rr);         if (l > pushL) pushL = l;
          const rgt = (x + rr) - (W - WALL); if (rgt > pushR) pushR = rgt;
          const dn = (y + rr) - (H - WALL);  if (dn > pushFloor) pushFloor = dn;
          const up = -(y - rr);              if (up > pushCeil) pushCeil = up;
        }
        if (pushL || pushR || pushFloor || pushCeil) {
          b.x += pushL - pushR;
          b.y += pushCeil - pushFloor;
          b.contacts++;
          syncParts(b);
        }
      }

      const invDt = 1 / dt;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.dead) continue;

        const dx = b.x - b.px;
        const dy = b.y - b.py;

        let vx = dx * invDt;
        let vy = dy * invDt;

        if (b.contacts > 0) vx *= FRICTION;
        if (b.sq > 0) b.sq = Math.max(0, b.sq - b.sq * SQUASH_DECAY * dt);

        b.vx = vx;
        b.vy = vy;
        b.angle += dx / b.r * 0.85;

        if (!b.landed) {
          if (b.contacts > 0 || state.time - b.bornAt > 0.9) b.landed = true;
        }
      }

      for (let k = 0; k < contacts.length; k++) {
        const ct = contacts[k];

        if (ct.ball) {
          const b = ct.ball;
          if (b.dead) continue;
          const vnPre = b.pvx * ct.nx + b.pvy * ct.ny;
          if (vnPre < -REST_THRESHOLD) {
            const vnPost = b.vx * ct.nx + b.vy * ct.ny;
            const target = -WALL_RESTITUTION * vnPre;
            const j = target - vnPost;
            if (j > 0) {
              b.vx += j * ct.nx;
              b.vy += j * ct.ny;
              squash(b, ct.nx, ct.ny, -vnPre);
            }
          }
        } else {
          const a = ct.a, b = ct.b;
          if (a.dead || b.dead) continue;
          const nx = ct.nx, ny = ct.ny;
          const vnPre = (a.pvx - b.pvx) * nx + (a.pvy - b.pvy) * ny;
          if (vnPre > REST_THRESHOLD) {
            const vnPost = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
            const target = -RESTITUTION * vnPre;
            const j = (vnPost - target) / (a.invMass + b.invMass);
            if (j > 0) {
              a.vx -= j * a.invMass * nx;  a.vy -= j * a.invMass * ny;
              b.vx += j * b.invMass * nx;  b.vy += j * b.invMass * ny;
              squash(a, -nx, -ny, vnPre);
              squash(b, nx, ny, vnPre);
            }
          }
        }
      }

      if (merges.length) processMerges(merges);
    }

    function aimLimit(tier) {
      const r = FRUITS[tier].r * shapeOfT(tier).rb;
      return [WALL + r + 0.5, W - WALL - r - 0.5];
    }

    function moveAim(x) {
      const lim = aimLimit(state.pending);
      state.aimX = clamp(x, lim[0], lim[1]);
    }

    /* 投放。record=true 时把这次投放写进回放（正常游玩用）；
       回放时用 dropAt(x, t) 按记录的 tick 注入，不再重复记录。 */
    function tryDrop() {
      if (state.over || !state.ready) return false;
      const tier = state.pending;
      const lim = aimLimit(tier);
      const x = Math.round(clamp(state.aimX, lim[0], lim[1]) * DROP_QUANT) / DROP_QUANT;

      const ball = makeBall(x, DROP_Y, tier, 0, 130);
      state.balls.push(ball);

      state.inputs.push({ t: state.tick, x: x });
      state.ready = false;
      state.cooldown = DROP_MS / 1000;
      state.pending = state.next;
      state.next = pickSpawnTier(state.pending);
      if (state.balls.length > 90) state.balls = state.balls.filter(b => !b.dead);
      events.push({ type: 'drop', x: x, tier: ball.tier });
      return true;
    }

    /* 回放专用：规则和 tryDrop 完全一致（冷却、判负都不能绕），
       唯一区别是不写 inputs —— 不然边跑边涨会变成死循环。 */
    function injectDrop(x, t) {
      if (state.over || !state.ready) return false;
      const tier = state.pending;
      const lim = aimLimit(tier);
      const q = Math.round(clamp(x, lim[0], lim[1]) * DROP_QUANT) / DROP_QUANT;
      const ball = makeBall(q, DROP_Y, tier, 0, 130);
      state.balls.push(ball);
      state.ready = false;
      state.cooldown = DROP_MS / 1000;
      state.pending = state.next;
      state.next = pickSpawnTier(state.pending);
      if (state.balls.length > 90) state.balls = state.balls.filter(b => !b.dead);
      events.push({ type: 'drop', x: q, tier: ball.tier });
      return true;
    }

    function checkGameOver(dt) {
      let danger = false;
      for (let i = 0; i < state.balls.length; i++) {
        const b = state.balls[i];
        if (b.dead || !b.landed) continue;
        const top = b.y - b.r;

        if (top < DANGER_Y) {
          danger = true;
          if (b.vx * b.vx + b.vy * b.vy < REST_SPEED2) {
            b.overTime += dt;
            if (b.overTime > OVER_LIMIT) { gameOver(); return; }
          } else {
            b.overTime = Math.max(0, b.overTime - dt * 2);
          }
        } else {
          b.overTime = Math.max(0, b.overTime - dt * 2);
          if (b.overTime > 0) danger = true;
        }
      }
      state.danger = danger;
    }

    function gameOver() {
      if (state.over) return;
      state.over = true;
      events.push({ type: 'over', score: state.score });
    }

    /* 复活：清掉警戒线以上的水果、解除判负，接着玩。
       规则全在这一层（游戏层只管把界面收起来），
       这样「清了哪几颗」才和回放里跑出来的完全一致。
         record=true  → 正常游玩，把这个 tick 记进回放
         record=false  → 回放注入，不许往记录里再写一遍 */
    function doRevive(record) {
      if (!state.over || state.revives <= 0) return false;

      /* 1) 找最顶上的：按「上边缘」比，最小的最靠上 */
      let top = -1;
      let topEdge = Infinity;
      for (let i = 0; i < state.balls.length; i++) {
        const b = state.balls[i];
        if (b.dead) continue;
        const edge = b.y - b.r;
        if (edge < topEdge) { topEdge = edge; top = i; }
      }
      if (top >= 0) state.balls.splice(top, 1);

      /* 2) 还压在警戒线以上的，一并清掉（只清一颗的话会立刻再输） */
      state.balls = state.balls.filter((b) => !b.dead && (b.y - b.r) >= DANGER_Y + 6);

      /* 3) 越线计时清零，给玩家一个反应窗口 */
      for (let i = 0; i < state.balls.length; i++) state.balls[i].overTime = 0;

      state.revives--;
      state.over = false;
      state.danger = false;
      state.ready = true;
      state.cooldown = 0;
      if (record) state.reviveLog.push(state.tick);
      events.push({ type: 'revive', x: state.aimX, y: 0 });
      return true;
    }

    function revive() { return doRevive(true); }
    function injectRevive() { return doRevive(false); }

    /* 跑一帧固定步长。返回本帧产生的事件（也可以之后用 drainEvents() 取）。 */
    function update(dt) {
      if (dt === undefined) dt = FIXED;

      /* 清场命中定格：世界停一下（tick、冷却、判负计时全部跟着停），
         画面照常重绘 —— 所以定格必须在模拟这一层，回放里才会停得一模一样。 */
      if (state.freeze > 0) {
        state.freeze = Math.max(0, state.freeze - dt);
        return [];
      }

      if (state.over) return [];

      if (!state.ready) {
        state.cooldown -= dt;
        if (state.cooldown <= 0) state.ready = true;
      }

      const sub = dt / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) stepPhysics(sub);

      checkGameOver(dt);

      state.tick++;
      state.time = state.tick * FIXED;
      return [];
    }

    /* 一局的开始。传 seed 会重新播种 —— 每局都必须换新种子，
       回放靠它把整条随机序列拉回同一个起点。 */
    function reset(seed) {
      if (seed !== undefined) {
        let s = seed >>> 0;
        if (!s) s = 1;
        rng = makeRng(s);
        currentSeed = s;
      }
      state.balls.length = 0;
      state.score = 0;
      state.tick = 0;
      state.time = 0;
      state.over = false;
      state.ready = true;
      state.cooldown = 0;
      state.danger = false;
      state.aimX = W / 2;
      state.inputs.length = 0;
      state.revives = 0;         // 复活币只在本局有效，重开清零
      state.reviveGiven = 0;
      state.freeze = 0;
      state.reviveLog.length = 0;
      state.pending = pickSpawnTier();
      state.next = pickSpawnTier(state.pending);
      events.length = 0;
    }

    reset(seed);

    return {
      state, events, get shapes() { return shapes; },
      get seed() { return currentSeed; },
      update, reset, tryDrop, injectDrop, moveAim, aimLimit, makeBall, stepPhysics,
      addScore, revive, injectRevive,
      shapeOf: shapeOfT,
      drainEvents() { const e = events.slice(); events.length = 0; return e; },
      /* 当前这一局的回放（记录 tick 数、分数和复活的时刻） */
      replay() {
        return {
          v: 2, seed: currentSeed, end: state.tick,
          score: state.score, inputs: state.inputs.slice(),
          revives: state.reviveLog.slice()
        };
      }
    };
  }

  /* ---------------------------------------------------------
   *  回放编解码
   *
   *  文本格式（好调试、好复制粘贴、TinyWebDB 直接存）：
   *    v2;<seed base36>;<end tick base36>;<score>;
   *    <dt base36>:<x*64 base36>,...
   *    [;<dt base36>,...]           ← 复活的时刻（没有复活就不写这一段）
   *  dt 是和上一次投放的 tick 差（第一次是绝对 tick），
   *  落点存的是 x*64 的整数，正好回代成 1/64 px。
   *  分隔符必须避开 base36 的字符表（0-9a-z），所以用 ':' 而不是 'x'。
   *
   *  复活那段是可选的：老记录没有它，解出来就是「这局没复活过」，
   *  校验结果和以前一模一样 —— 存量榜单记录不受影响。
   * ------------------------------------------------------- */
  function encode(replay) {
    if (!replay || !replay.inputs) return '';
    const parts = [];
    let prev = 0;
    for (let i = 0; i < replay.inputs.length; i++) {
      const it = replay.inputs[i];
      const dt = it.t - prev;
      prev = it.t;
      parts.push(dt.toString(36) + ':' + Math.round(it.x * DROP_QUANT).toString(36));
    }
    let out = 'v2;' + (replay.seed >>> 0).toString(36) + ';' +
      (replay.end | 0).toString(36) + ';' + (replay.score | 0) + ';' + parts.join(',');

    const revs = replay.revives;
    if (revs && revs.length) {
      const rs = [];
      let rp = 0;
      for (let i = 0; i < revs.length; i++) {
        const t = revs[i] | 0;
        rs.push((t - rp).toString(36));
        rp = t;
      }
      out += ';' + rs.join(',');
    }
    return out;
  }

  function decode(str) {
    if (typeof str !== 'string' || str.indexOf('v2;') !== 0) return null;
    const seg = str.split(';');
    if (seg.length < 5) return null;
    const seed = parseInt(seg[1], 36);
    const end = parseInt(seg[2], 36);
    const score = parseInt(seg[3], 10);
    if (!isFinite(seed) || !isFinite(end) || !isFinite(score)) return null;

    const inputs = [];
    let tick = 0;
    /* 老记录的投放体只占第 5 段（里面没有 ';'），第 6 段起才是复活 */
    const body = seg[4];
    if (body) {
      const items = body.split(',');
      if (items.length > MAX_DROPS) return null;
      for (let i = 0; i < items.length; i++) {
        const p = items[i].split(':');
        if (p.length !== 2) return null;
        const dt = parseInt(p[0], 36);
        const xq = parseInt(p[1], 36);
        if (!isFinite(dt) || !isFinite(xq) || dt < 0) return null;
        tick += dt;
        inputs.push({ t: tick, x: xq / DROP_QUANT });
      }
    }

    const revives = [];
    if (seg.length > 5 && seg[5]) {
      const items = seg[5].split(',');
      if (items.length > MAX_DROPS) return null;
      let rt = 0;
      for (let i = 0; i < items.length; i++) {
        const dt = parseInt(items[i], 36);
        if (!isFinite(dt) || dt < 0) return null;
        rt += dt;
        revives.push(rt);
      }
    }

    if (end > MAX_TICKS || end <= 0) return null;
    return { v: 2, seed: seed >>> 0, end: end, score: score, inputs: inputs, revives: revives };
  }

  /* ---------------------------------------------------------
   *  播放器：把一局回放一帧一帧地推进，给「观看」用。
   *
   *  verify() 就是建立在同一段推进逻辑上 —— 看到的和判分的用同一份代码，
   *  不会出现「播出来是这样、验出来是那样」的走偏。
   *
   *  makePlayer(replay) → {
   *    state, tick, score,   // 当前模拟状态（可以拿去渲染）
   *    end, claimed, total,  // 回放声称的时长 / 分数 / 投放次数
   *    consumed,             // 已经喂进去的投放次数
   *    done, error,          // 播完了吗 / 出了什么错
   *    step()                // 推进 1 tick；返回 false = 播完或出错
   *  }
   *
   *  播放不会写 inputs（injectDrop 本来就不写），复活也一样
   *  （injectRevive 不写 reviveLog），所以同一份存档
   *  播多少遍都不会被污染 —— 这一点由 replay.test 断言。
   * ------------------------------------------------------- */
  function normalizeReplay(record) {
    let rep = record;
    if (typeof record === 'string') {
      rep = decode(record);
      if (!rep) return { error: '回放格式不对' };
    }
    if (!rep || typeof rep !== 'object') return { error: '回放为空' };
    if (!isFinite(rep.end) || rep.end <= 0 || rep.end > MAX_TICKS)
      return { error: '时长不合法' };
    if (!rep.inputs || rep.inputs.length > MAX_DROPS)
      return { error: '投放次数不合法' };
    /* 复活记录（可选）：必须是不递减的 tick 列表 */
    if (rep.revives !== undefined && rep.revives !== null) {
      if (!Array.isArray(rep.revives) || rep.revives.length > MAX_DROPS)
        return { error: '复活记录不合法' };
      for (let i = 0; i < rep.revives.length; i++) {
        const t = rep.revives[i];
        if (typeof t !== 'number' || !isFinite(t) || t < 0 || Math.floor(t) !== t ||
            (i > 0 && t < rep.revives[i - 1]))
          return { error: '复活记录不合法' };
      }
    } else {
      rep.revives = [];
    }
    return { rep: rep };
  }

  function makePlayer(record, parts) {
    const norm = normalizeReplay(record);
    const rep = norm.rep;
    const sim = rep ? create(rep.seed, parts) : null;
    const inputs = rep ? rep.inputs : [];
    const revs = rep ? (rep.revives || []) : [];
    const n = inputs.length;
    let i = 0, ri = 0;
    let err = norm.error || '';

    /* 这一 tick 有复活记录吗 —— 判负只是暂时的，还能被救回来 */
    function reviveDue(t) { return ri < revs.length && revs[ri] === t; }

    function finished() {
      if (err || !sim) return true;
      if (reviveDue(sim.state.tick)) return false;
      /* 已经判负又没有复活可打就停（剩下的投放本就不该存在，
         verify 会用 consumed 拦下） */
      if (sim.state.over) return true;
      return sim.state.tick >= rep.end;
    }

    function step() {
      if (finished()) return false;
      const t = sim.state.tick;

      /* 0) 这个 tick 到期的复活：先救回来再谈投放 ——
            游戏里也是这个顺序（判负 → 点「用一枚复活币」→ 同一 tick 上还能投一颗） */
      while (ri < revs.length && revs[ri] === t) {
        if (!sim.injectRevive()) {
          err = '复活时机不合法（没判负或没有复活币）';
          return false;
        }
        ri++;
      }
      if (ri < revs.length && revs[ri] < t) {
        err = '复活记录的 tick 顺序不对';
        return false;
      }

      /* 1) 这个 tick 到期的投放 */
      while (i < n && inputs[i].t === t) {
        if (!sim.injectDrop(inputs[i].x, t)) {
          err = '投放时机不合法（冷却中或已结束）';
          return false;
        }
        i++;
      }
      if (i < n && inputs[i].t < t) {
        err = 'tick 顺序不对';
        return false;
      }

      /* 2) 判负之后就不再推进了 */
      if (sim.state.over) return false;

      sim.update();
      return true;
    }

    return {
      get sim() { return sim; },
      get state() { return sim ? sim.state : null; },
      get tick() { return sim ? sim.state.tick : 0; },
      get score() { return sim ? sim.state.score : 0; },
      get done() { return finished(); },
      get error() { return err; },
      get consumed() { return i; },
      end: rep ? rep.end : 0,
      claimed: rep ? rep.score : 0,
      total: n,
      step: step
    };
  }

  /* ---------------------------------------------------------
   *  验证：把回放重新模拟一遍，分数对得上才算真。
   *
   *  返回 { ok, score, reason }
   *    ok=true   → 这个分数确实能由这份回放跑出来
   *    ok=false  → 篡改过（分数、落点、tick、种子任一不匹配）
   *
   *  注意：这只证明「分数和操作一致」，不证明「操作是人手打的」——
   *  用脚本跑出来的合法回放照样过。这是纯静态方案的边界，见 README。
   * ------------------------------------------------------- */
  function verify(record, parts) {
    const p = makePlayer(record, parts);
    if (p.error) return { ok: false, score: 0, reason: p.error };

    while (p.step()) { /* 推到结束为止 */ }

    if (p.error) return { ok: false, score: 0, reason: p.error };
    if (p.consumed < p.total) return { ok: false, score: 0, reason: '有投放没被模拟到' };
    if (!p.state.over) return { ok: false, score: 0, reason: '回放跑完还没有结束' };
    if (p.tick !== p.end) {
      return { ok: false, score: 0, reason: '时长对不上：声称 ' + p.end + '，实际 ' + p.tick };
    }

    const got = p.score;
    if (got !== p.claimed) {
      return { ok: false, score: got, reason: '分数对不上：声称 ' + p.claimed + '，实际 ' + got };
    }
    return { ok: true, score: got, reason: '', drops: p.total, ticks: p.tick };
  }

  const api = {
    /* 常量，游戏层和验证层共用一份，避免两边改了不同步 */
    W, H, WALL, DROP_Y, DANGER_Y, GRAVITY, SUBSTEPS, ITER, DROP_MS,
    OVER_LIMIT, MAX_TIER, MAX_BONUS, MERGE_PAD, FIXED, DROP_QUANT,
    MAX_MERGE_GIVES_REVIVE, FREEZE_MS, REVIVE_STEP,
    MAX_TICKS, MAX_DROPS,
    FRUITS, MERGE_SCORE, SPAWN_TIERS, SPAWN_WEIGHTS, ASSET_FILL,
    makeRng, create, shapeOf, encode, decode, makePlayer, verify, clamp
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SUIKA_SIM = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);

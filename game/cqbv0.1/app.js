/* CQB 二期 · 应用层:主菜单 / 小地图 / WebAudio 合成音效 / 事件泵 / 联机 UI
 * 引擎能力复用自 engine.js(window.CQB1 导出 + CQB_BOOT 延迟启动)
 *
 * 联机 UI(本拍 = SDP 文本互传,零服务器):
 *   window.CQB_DEV_HOST(botCount) → Promise<{code, channel}> 建房
 *     内部 RTCChannel.createOffer → 把 SDP base64 显示给用户
 *     用户复制给加入者后,弹"等粘贴 answer"面板
 *     用户粘贴 → acceptAnswer → 等待 channel open → resolve
 *   window.CQB_DEV_JOIN(code) → Promise<{channel}>  加入
 *     弹"粘贴建房者 offer"输入框 → acceptOffer → 显示 answer
 *     用户复制给建房者后,等 channel open → resolve
 *   window.CQB_DEV_ROOMCODE() → string                4 位房间号
 *   window.CQB_DEV_COPY(text) → void                  复制到剪贴板
 */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const { RTCChannel, SignalChannel, MqttChannel, encodeSignal, decodeSignal } = window.CQB_CHANNEL;

/* 信令传输优先级:
 *   URL ?signal= / localStorage("cqb-signal-url") / localhost 开发默认 → SignalChannel(WS 信令)
 *   浏览器环境未配置 → MqttChannel(公共 broker,生产默认,6 位房间码)
 *   headless 测试(无 location) → 旧 SDP 流程回退(既有 smoke 不变)
 */
function signalUrl() {
  try {
    const qs = new URLSearchParams(location.search).get("signal");
    if (qs) return qs;
  } catch (e) { /* 无 location(headless) */ }
  try {
    const ls = localStorage.getItem("cqb-signal-url");
    if (ls) return ls;
  } catch (e) { /* 无 localStorage */ }
  try {
    if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
      return "ws://" + location.hostname + ":8787/signal";
    }
  } catch (e) { /* 无 location */ }
  return window.CQB_SIGNAL_URL || "";
}

/* 联机 UI 兜底(SDP 互传,真通道接入后被覆盖) */
if (typeof window.CQB_DEV_ROOMCODE !== "function") {
  const _clip = { text: "" };
  window.CQB_DEV_ROOMCODE = function () {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return "cqb-" + s;
  };
  window.CQB_DEV_COPY = function (text) {
    _clip.text = String(text);
    /* 尝试浏览器剪贴板;失败也不致命,用户手动复制 */
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).catch(() => {});
    }
  };
  window.CQB_DEV_CLIP_READ = function () { return _clip.text; };

  /* 建房:offer → 等 answer → open
   * 流程:
   *   1. 内部 createOffer
   *   2. 显示 offer 文本(让用户复制给加入者)
   *   3. 显示"等用户粘贴 answer 文本"输入框
   *   4. acceptAnswer → 等 open → 返回 channel + 房间码 */
  window.CQB_DEV_HOST = function () {
    return new Promise((res, rej) => {
      (async () => {
        try {
          const ch = new RTCChannel();
          const offer = await ch.createOffer();
          const offerText = encodeSignal(offer);
          const code = window.CQB_DEV_ROOMCODE();
          /* 通过全局事件让 UI 接管面板:显示 offer + 收 answer */
          window.dispatchEvent(new CustomEvent("cqb:host-offer", {
            detail: { offerText, channel: ch, code, resolve: res, reject: rej },
          }));
        } catch (e) { rej(e); }
      })();
    });
  };

  /* 加入:粘 offer → 生成 answer → 等 open
   * 流程:
   *   1. 用户粘贴 offer 文本 → acceptOffer
   *   2. 显示 answer 文本(让用户复制给建房者)
   *   3. 等 channel open → 返回 channel */
  window.CQB_DEV_JOIN = function (code) {
    return new Promise((res, rej) => {
      /* 让 UI 弹"粘贴 offer"输入框;用户提交后调 _joinSubmit */
      window.dispatchEvent(new CustomEvent("cqb:client-prompt-offer", {
        detail: { code, resolve: res, reject: rej },
      }));
    });
  };
}

/* ============================ SDP 流程的具体 UI 实现 ============================ */
/* 这是 host/client SDP 互传 UI 的"后半段",由 CQB_DEV_HOST / JOIN 派发事件触发 */
window.CQB_DEV_JOIN_SUBMIT = async function (offerText) {
  /* 客户端:用户粘贴 offer 文本,生成 answer,显示让用户复制给 host,等 open */
  const ch = new RTCChannel();
  const answer = await ch.acceptOffer(decodeSignal(offerText));
  const answerText = encodeSignal(answer);
  window.dispatchEvent(new CustomEvent("cqb:client-show-answer", { detail: { answerText, channel: ch } }));
  /* 等 open,失败 5s 超时 */
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open-timeout")), 8000);
    ch.onstatechange = (s) => {
      if (s === "open") { clearTimeout(t); resolve({ channel: ch }); }
      else if (s === "closed") { clearTimeout(t); reject(new Error("closed")); }
    };
  });
};

window.CQB_DEV_HOST_ACCEPT_ANSWER = async function (answerText) {
  /* 接收 host 端在 _hostOffer 事件中保存的 channel */
  const ch = window.__CQB_HOST_CHANNEL;
  if (!ch) throw new Error("no host channel in flight");
  await ch.acceptAnswer(decodeSignal(answerText));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("open-timeout")), 8000);
    ch.onstatechange = (s) => {
      if (s === "open") { clearTimeout(t); resolve({ channel: ch }); }
      else if (s === "closed") { clearTimeout(t); reject(new Error("closed")); }
    };
  });
};

/* ============================ 音频(WebAudio 合成) ============================ */
let AC = null, master = null, sfxPlayed = 0;

function ensureAudio() {
  if (!AC) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    AC = new Ctx();
    master = AC.createGain();
    master.gain.value = 0.4;
    master.connect(AC.destination);
  }
  if (AC.state === "suspended") AC.resume();
  return AC;
}

function tone({ f0 = 440, f1 = 0, type = "square", dur = 0.1, vol = 0.4, delay = 0 }) {
  if (!AC) return;
  const t0 = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function noiseBurst({ dur = 0.1, vol = 0.5, freq = 1500 }) {
  if (!AC) return;
  const t0 = AC.currentTime;
  const len = Math.max(1, Math.floor(AC.sampleRate * dur));
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource(); src.buffer = buf;
  const flt = AC.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = freq;
  const g = AC.createGain(); g.gain.value = vol;
  src.connect(flt); flt.connect(g); g.connect(master);
  src.start(t0);
}

const SFX = {
  shotRifle(a) { noiseBurst({ dur:.09, vol:.5*a, freq:1600 });
                 tone({ f0:170, f1:60, type:"square", dur:.07, vol:.22*a }); },
  shotPistol(a){ noiseBurst({ dur:.07, vol:.45*a, freq:2400 });
                 tone({ f0:330, f1:90, type:"square", dur:.05, vol:.26*a }); },
  knife(a)     { noiseBurst({ dur:.06, vol:.28*a, freq:5000 }); },
  reload()     { tone({ f0:900, type:"square", dur:.04, vol:.2 });
                 tone({ f0:700, type:"square", dur:.04, vol:.2, delay:.16 }); },
  /* 受击无音效(2026-09-05 用户拍板):红闪+镜头震动已足够,锯齿音混在枪声里像第二声枪响 */
  death(a)     { tone({ f0:150, f1:40, type:"sawtooth", dur:.4, vol:.38*a }); },
  win()        { [523,659,784,1046].forEach((f,i)=>tone({ f0:f, type:"square",
                                     dur:.14, vol:.3, delay:i*.13 })); },
  lose()       { [392,311,247,196].forEach((f,i)=>tone({ f0:f, type:"sawtooth",
                                     dur:.2, vol:.3, delay:i*.16 })); },
  door(a)      { tone({ f0:140, f1:70, type:"square", dur:.12, vol:.3*a });
                 noiseBurst({ dur:.08, vol:.2*a, freq:600 }); },
  pickup(a)    { tone({ f0:660, type:"square", dur:.05, vol:.22*a });
                 tone({ f0:990, type:"square", dur:.07, vol:.22*a, delay:.07 }); },
  nade(a)      { noiseBurst({ dur:.05, vol:.18*a, freq:900 }); },          // 抛出
  flashBang(a) { noiseBurst({ dur:.25, vol:.6*a, freq:3000 });             // 闪光炸
                 tone({ f0:1200, f1:200, type:"sawtooth", dur:.3, vol:.3*a }); },
  smokePop(a)  { noiseBurst({ dur:.35, vol:.4*a, freq:700 }); },           // 烟雾炸
};

/* 事件泵:引擎事件 → 音效(按距离衰减) */
function pumpEvents() {
  if (!window.CQB_DRAIN_EVENTS) return;
  const D = window.__CQB_DEBUG || {};
  const p = D.player;
  const events = window.CQB_DRAIN_EVENTS();
  for (const e of events) {
    sfxPlayed++;
    let a = 1;
    if (p && e.x != null && e.who !== "你") {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      a = Math.max(0.15, Math.min(1, 1 - d / (8 * (window.CQB1 ? window.CQB1.CELL : 32))));
    }
    switch (e.t) {
      case "shot":   (e.w === "rifle" ? SFX.shotRifle : SFX.shotPistol)(a); break;
      case "knife":  SFX.knife(a); break;
      case "reload": SFX.reload(); break;
      case "death":  SFX.death(e.who === "你" ? 1 : a); break;
      case "win":    SFX.win(); break;
      case "lose":   SFX.lose(); break;
      case "door":   SFX.door(a); break;
      case "pickup": SFX.pickup(a); break;
      case "nade":   SFX.nade(a); break;
      case "flash":  SFX.flashBang(a); break;
      case "smoke":  SFX.smokePop(a); break;
    }
  }
}

/* ============================ 小地图(全信息版) ============================ */
const mmCv = $("minimap");
const mctx = mmCv.getContext("2d");
const MS = 3;                                    // 每格像素
let MAP_W = 56, MAP_H = 40;
let terr = null, rev = null, rctx = null, seen = null;

/* 按当前所选地图初始化小地图(进入对局前调用一次) */
let miniMd = null;    // 当前对局地图数据(房间标注用)

function initMinimap() {
  const md = (window.CQB_MAPS && window.CQB_MAPS[window.__CQB_MAP_KEY])
    || window.CQB1.MAP_DATA;
  miniMd = md;
  MAP_W = md.w; MAP_H = md.h;
  mmCv.width = MAP_W * MS; mmCv.height = MAP_H * MS;

  /* 击杀/死亡两框作为整体移到小地图正下方:
   * 左边距与小地图一致(14px),与小地图的间距 = 两框之间的间距(10px)。
   * top 按小地图实际高度动态计算 → 任何地图都不重叠、不远离 */
  const chips = document.getElementById("chips");
  if (chips) {
    chips.style.left = "14px";
    chips.style.top = (14 + mmCv.height + 10) + "px";
  }

  /* 地形层预渲染 */
  terr = document.createElement("canvas");
  terr.width = mmCv.width; terr.height = mmCv.height;
  const t = terr.getContext("2d");
  t.fillStyle = "#10141F"; t.fillRect(0, 0, terr.width, terr.height);
  for (const [, x, y, w, h] of md.rooms) {
    t.fillStyle = "#232B3E";
    t.fillRect(x * MS, y * MS, w * MS, h * MS);
  }
  for (const [x, y] of md.doors) {
    t.fillStyle = "#8a6d33";
    t.fillRect(x * MS, y * MS, MS, MS);
  }
  for (const [x, y] of md.crates) {
    t.fillStyle = "#4A5578";
    t.fillRect(x * MS, y * MS, MS, MS);
  }
  for (const [x, y] of (md.half || [])) {
    t.fillStyle = "rgba(94,208,180,.5)";
    t.fillRect(x * MS, y * MS, MS, MS);
  }

  /* 已探索层:初始全黑,格子被看见时从地形层盖章一次 */
  rev = document.createElement("canvas");
  rev.width = mmCv.width; rev.height = mmCv.height;
  rctx = rev.getContext("2d");
  rctx.fillStyle = "#0A0D16"; rctx.fillRect(0, 0, rev.width, rev.height);
  seen = new Uint8Array(MAP_W * MAP_H);
}

function updateMinimap(now) {
  const D = window.__CQB_DEBUG;
  if (!D || !D.player || !D.player.alive) {
    mctx.clearRect(0, 0, mmCv.width, mmCv.height);
    const elRoom0 = $("roomname");
    if (elRoom0) elRoom0.textContent = "";
    return;
  }
  const ENG = window.CQB1;
  const poly = D.lastPoly || [];
  const px = D.player.x, py = D.player.y;
  const R = ENG.VISION_R;

  /* 标记已探索格(视野多边形覆盖到的格子中心) */
  const i0 = Math.max(0, ((px - R) / ENG.CELL) | 0);
  const i1 = Math.min(MAP_W - 1, ((px + R) / ENG.CELL) | 0);
  const j0 = Math.max(0, ((py - R) / ENG.CELL) | 0);
  const j1 = Math.min(MAP_H - 1, ((py + R) / ENG.CELL) | 0);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const idx = j * MAP_W + i;
      if (seen[idx]) continue;
      if (ENG.entityVisible(poly, px, py, (i + .5) * ENG.CELL, (j + .5) * ENG.CELL)) {
        seen[idx] = 1;
        rctx.drawImage(terr, i * MS, j * MS, MS, MS, i * MS, j * MS, MS, MS);
      }
    }
  }

  mctx.clearRect(0, 0, mmCv.width, mmCv.height);
  mctx.drawImage(rev, 0, 0);

  /* 自身位置与朝向扇形 */
  const sx = px / ENG.CELL * MS, sy = py / ENG.CELL * MS;
  mctx.save();
  mctx.translate(sx, sy); mctx.rotate(D.player.facing);
  mctx.fillStyle = "#E8ECF5";
  mctx.beginPath(); mctx.moveTo(6, 0); mctx.lineTo(-4, -4); mctx.lineTo(-4, 4);
  mctx.closePath(); mctx.fill();
  mctx.restore();

  /* 视野内敌人红点 / 队友绿点(团队模式遍历全部战斗员) */
  /* 视野内敌人红点 / 队友绿点。
   * 联机:队友/敌人来自快照下发列表(D.netMates / D.netEnemies,敌我按来源标记),
   *   不再遍历 D.fighters——其 bot 占位的 team 是本地硬编码值,加入方(team 1)会把
   *   敌人误判成队友并跳过视野判定(小地图透视泄漏,2026-09-05 修复)。
   * 单机:遍历本地 fighters,敌我按 team。 */
  {
    const remote = !!window.__CQB_REMOTE_MODE;
    const matesArr = remote ? (D.netMates || [])
      : (D.fighters || []).filter((f) => f !== D.player && f.alive && f.team === D.player.team);
    const enemiesArr = remote ? (D.netEnemies || [])
      : (D.fighters || []).filter((f) => f.alive && f.team !== D.player.team);
    for (const m of matesArr) {
      if (m.alive === false) continue;   // 队友整份下发,位置恒已知(共享视野设计)
      mctx.fillStyle = "#6FD98F";
      mctx.beginPath();
      mctx.arc(m.x / ENG.CELL * MS, m.y / ENG.CELL * MS, 3, 0, Math.PI * 2);
      mctx.fill();
    }
    for (const e of enemiesArr) {
      if (e.alive === false) continue;
      /* 敌人按队伍视野并集判定(共享视野) */
      const views = D.lastTeamVision;
      const vis = (views && views.length)
        ? views.some((v) => {
            const d = Math.hypot(e.x - v.x, e.y - v.y);
            return d <= ENG.NEAR_R || (d < ENG.VISION_R && ENG.pip(v.poly, e.x, e.y));
          })
        : ENG.pip(poly, e.x, e.y);
      if (!vis) continue;
      mctx.fillStyle = "#FF5C5C";
      mctx.beginPath();
      mctx.arc(e.x / ENG.CELL * MS, e.y / ENG.CELL * MS, 3, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  /* 目标模式据点(公共情报,常显):己方绿 / 敌方红 / 中性灰,争夺中黄圈 */
  const OBJ = D.obj;
  if (OBJ && OBJ.zones) {
    for (const z of OBJ.zones) {
      const zx = z.x / ENG.CELL * MS, zy = z.y / ENG.CELL * MS;
      const myT = D.player ? D.player.team : 0;
      const col = OBJ.play === "rescue"
        ? (z.name === "E" ? "#6FD98F" : "#FFC24B")
        : (z.owner === -1 ? "#B9BEE8" : z.owner === myT ? "#6FD98F" : "#FF5C5C");
      mctx.strokeStyle = col;
      mctx.lineWidth = 1.5;
      mctx.beginPath();
      mctx.arc(zx, zy, Math.max(3, z.r / ENG.CELL * MS), 0, Math.PI * 2);
      mctx.stroke();
      mctx.fillStyle = col;
      mctx.font = "bold 7px system-ui, sans-serif";
      mctx.textAlign = "center";
      mctx.textBaseline = "middle";
      mctx.fillText(z.name, zx, zy);
    }
  }

  /* 噪波闪点(他人、5 格内;联机快照涟漪带 net 标记,只排除自己单人侧涟漪) */
  for (const r of D.ripples || []) {
    if (r.who === D.player && !r.net) continue;
    const d = Math.hypot(r.x - px, r.y - py);
    if (d > 5 * ENG.CELL) continue;
    const age = (now - (r._recv ?? r.born)) / 650;
    if (age >= 1) continue;
    mctx.fillStyle = `rgba(124,92,255,${(1 - age) * .9})`;
    mctx.beginPath();
    mctx.arc(r.x / ENG.CELL * MS, r.y / ENG.CELL * MS, 2.5, 0, Math.PI * 2);
    mctx.fill();
  }

  /* 房间名标注(方案 A+C):屏幕顶部悬浮 + 小地图左下角 */
  const cx = Math.floor(px / ENG.CELL), cy = Math.floor(py / ENG.CELL);
  let rn = "";
  for (const [name, rx, ry, rw, rh] of (miniMd ? miniMd.rooms : [])) {
    if (cx >= rx && cx < rx + rw && cy >= ry && cy < ry + rh) {
      rn = name.replace(/^[A-Z]{1,2}\s+/, "");    // 去掉"TL "这类代码前缀
      break;
    }
  }
  const elRoom = $("roomname");
  if (elRoom) elRoom.textContent = rn;
  if (rn) {
    mctx.fillStyle = "rgba(232,236,245,.8)";
    mctx.font = "10px sans-serif";
    mctx.textAlign = "left"; mctx.textBaseline = "bottom";
    mctx.fillText(rn, 3, mmCv.height - 3);
  }
}

/* ============================ 游戏说明面板 ============================
 * 内容数据驱动:武器/备弹数值读 rules.js 的 WEAPONS/RESERVE,
 * 地图缩略图用 maps.js 现场绘制——调数值/改图后说明自动跟随,不写死两份。
 */
const MAP_INTRO = {
  office: "室内 CQB 经典:房间 + 走廊 + 大厅玻璃隔断,注意拐角与半遮挡",
  harbor: "集装箱码头:箱墙巷道 + 龙门吊 + 货船泊位,岸线阶梯地形",
  alley: "城中村巷战:街巷环路 + 长直道对枪 + 晒谷场凸出地块",
  metro: "地铁站:站台/站厅/出入口三层横排,闸机单格咽喉,左右镜像",
  mall: "商场中庭:椭圆中庭阶梯 + 3 格观景桥 + 回字环廊 + 不规则店铺",
};

function drawMapThumb(cv, md) {
  const g = window.CQB_RULES.buildGrid(md);
  const S = 3;
  const ctx2 = cv.getContext("2d");
  ctx2.fillStyle = "#0D1220";                       // 地图外(墙/水)
  ctx2.fillRect(0, 0, cv.width, cv.height);
  const inLand = (x, y) => !md.land || md.land.some(([lx, ly, lw, lh]) =>
    x >= lx && x < lx + lw && y >= ly && y < ly + lh);
  for (let y = 0; y < md.h; y++) {
    for (let x = 0; x < md.w; x++) {
      const v = g[y][x];
      if (v === 2) ctx2.fillStyle = "rgba(94,208,180,.75)";           // 半挡
      else if (v === 1) ctx2.fillStyle = inLand(x, y) ? "#4A5578" : "#0D1220";
      else ctx2.fillStyle = "#2A3247";                                // 可行走
      ctx2.fillRect(x * S, y * S, S, S);
    }
  }
  for (const [dx, dy] of (md.doors || [])) {
    ctx2.fillStyle = "#FFC24B";
    ctx2.fillRect(dx * S, dy * S, S, S);
  }
  for (const [sx, sy] of md.spawns) {
    ctx2.fillStyle = "#7C5CFF";
    ctx2.beginPath();
    ctx2.arc(sx * S + S / 2, sy * S + S / 2, S + 0.5, 0, Math.PI * 2);
    ctx2.fill();
  }
}

function buildHelpContent() {
  if ($("helpBody")._built) return;
  $("helpBody")._built = true;
  const R = window.CQB_RULES;
  const W = R.WEAPONS.filter((w) => !w.grenade), RES = R.RESERVE, CAP = R.RESERVE_CAP;
  const fmtRate = (w) => w.melee ? `${w.cdMs / 1000}s/次` : (w.auto ? `${w.rpm} 发/分 全自动` : "半自动(点射)");
  const fmtDmg = (w) => w.melee ? `${w.dmg} / 背刺 <span class="hl">${w.backstabDmg}</span>` : `<b>${w.dmg}</b>`;
  const fmtMag = (w) => w.melee ? "∞" : w.mag;
  const fmtRes = (w, i) => w.melee ? "—" : `<span class="hl">${RES[i]}</span>`;
  const fmtCap = (w, i) => w.melee ? "—" : CAP[i];
  const wrows = W.map((w, i) =>
    `<tr><td><b>${w.name}</b></td><td>${fmtRate(w)}</td><td>${fmtMag(w)}</td>` +
    `<td>${fmtRes(w, i)}</td><td>${fmtCap(w, i)}</td><td>${fmtDmg(w)}</td>` +
    `<td>${w.melee ? "—" : (w.reloadMs / 1000) + "s"}</td></tr>`).join("");

  $("helpBody").innerHTML = `
    <h3>🎯 三种玩法</h3>
    <b>死斗</b> —— 击杀达到阈值获胜:1v1 先到 <span class="hl">15</span> 杀 · 2v2 <span class="hl">20</span> ·
    3v3 <span class="hl">25</span>(按<span class="hl">全队击杀合计</span>计算)。
    <b>解救</b> —— 营救方(进攻)对守卫方(防守;合作模式你与队友全为进攻方),时限
    <span class="hl">${R.RESCUE_TIME_MS / 60000} 分钟</span>:站进<b>人质区</b>引导
    <span class="hl">${R.RESCUE_CHANNEL_MS / 1000} 秒</span>接管人质(每多 1 人加速,防守方同区僵持,
    无人引导会退),触发者成为<b>携行者</b>(头顶金圈标记,对防守方<b>恒定可见</b>);
    带人质站进<b>撤离区</b> <span class="hl">${R.EXTRACT_CHANNEL_MS / 1000} 秒</span>完成营救即胜。
    携行者阵亡人质原地掉落(可被重新接管);时限到未营救成功则防守方胜。
    <b>占点</b> —— 争夺地图上 <span class="hl">A / B / C</span> 三个据点,时限
    <span class="hl">${R.POINT_TIME_MS / 60000} 分钟</span>:区域内站桩
    <span class="hl">${R.CAPTURE_MS / 1000} 秒</span>占领(每多 1 人加速,双方同区僵持),
    每个己方据点每 <span class="hl">${R.POINT_TICK_MS / 1000} 秒</span> +1 分,
    <span class="hl">先到 ${R.POINT_SCORE_TARGET} 分</span>获胜;时限到比分高者胜,平分平局。
    被击杀后 <span class="hl">${R.RESPAWN_MS / 1000} 秒</span>复活(解救模式回到己方固定出生点,其余模式随机出生点),
    复活有 2 秒保护(半透明闪烁,主动开枪立即解除)。
    <h3>🎮 操作</h3>
    <b>WASD</b> 移动 · <b>鼠标</b> 瞄准(角色恒居屏幕正中) · <b>左键</b> 开火 ·
    <b>1 / 2 / 3</b> 切换步枪/手枪/刀 · <b>E</b> 循环投掷物 · <b>R</b> 换弹 · <b>Shift</b> 静步慢移(无声) ·
    <b>ESC</b> 暂停(仅单人:继续/重新开始/回到主菜单)。
    <h3>👁 视野与声音</h3>
    视野半径 <span class="hl">12 格</span>,视野锥 ±55°,贴身 2 格内恒可见——墙后与锥外一片漆黑,拐角必探。
    正常移动每 0.4s 发出一圈<span class="hl">穿墙噪音涟漪</span>(半径 4 格,敌人看得到);静步完全无声但慢一半。
    <span class="hl">半遮挡物</span>(玻璃/围栏/桌椅等青绿色格)挡脚步,<b>不挡视线和子弹</b>——躲在椅子后不安全。
    <h3>🔫 武器数据</h3>
    <table><tr><th>武器</th><th>射击模式</th><th>弹匣</th><th>初始备弹</th><th>备弹上限</th><th>单发伤害</th><th>换弹</th></tr>${wrows}</table>
    步枪连发散布圈渐大(松开枪回稳),手枪精准无散布,刀贴身 1.3 格内挥砍、从背后接近可背刺秒杀。
    <h3>📦 弹药规则</h3>
    步枪初始 <span class="hl">30 + 备弹 ${RES[0]}</span>,手枪 <span class="hl">12 + 备弹 ${RES[1]}</span>,
    备弹上限均为 <span class="hl">${CAP[0]}</span>,两套备弹池各自独立。
    换弹从备弹扣除装入数量;备弹耗尽按 R 无效;<b>死亡不清空备弹</b>;
    复活时自动换弹——补满弹匣的部分同步扣备弹,<span class="hl">备弹见底就带着残弹复活</span>,记得打弹药箱。
    地图上散布弹药箱(满箱 步枪+60 / 手枪+15 + <span class="hl">1 个随机投掷物</span>,箱子本身是半遮挡掩体),靠近按 <b>F</b> 拾取——
    <span class="hl">需要争夺的补给点</span>,取空 75 秒后刷新。
    <h3>💥 投掷物</h3>
    按 <b>E</b> 循环切换:闪光弹 ↔ 烟雾弹(枪械由 1/2/3 切回),持弹时 <b>左键</b> 朝准星方向抛出(定距 6 格,落地滑行)。
    备弹上限各 <span class="hl">5</span> 颗,死亡不清空(获取:<span class="hl">弹药箱随机补给</span>,独立额度不占弹药;类型满了给另一种,都满留在箱里)。<span class="hl">烟雾弹</span>挡视线(半径 3 格,持续 8 秒)——
    烟里往外看不见,子弹和脚步照常穿透,是掩进/撤离/绕后的核心道具;
    <span class="hl">闪光弹</span>面向炸点全致盲 2.5 秒、背对减半,隔墙与隔烟无效——清角前先丢一颗。
    爆炸声会暴露位置,敌人 Bot 也会闻声赶来。
    <h3>🗺 地图一览(紫点 = 出生点,青绿 = 半遮挡)</h3>`;

  /* 地图缩略图(maps.js 现场绘制) */
  const wrap = document.createElement("div");
  for (const [key, md] of Object.entries(window.CQB_MAPS)) {
    const row = document.createElement("div");
    row.className = "help-maprow";
    const cv = document.createElement("canvas");
    cv.width = md.w * 3; cv.height = md.h * 3;
    cv.className = "help-mapcv";
    drawMapThumb(cv, md);
    const info = document.createElement("div");
    info.className = "help-mapinfo";
    info.innerHTML = `<b>${md.name}</b><br>${md.w}×${md.h} 格 · ${md.spawns.length} 个出生点<br>${MAP_INTRO[key] || ""}`;
    row.appendChild(cv);
    row.appendChild(info);
    wrap.appendChild(row);
  }
  $("helpBody").appendChild(wrap);
}

/* ============================ 菜单与流程 ============================ */
let minimapOn = false;

/* cqb1 引擎用 rAF 调度主循环,这里 cqb2 再用 rAF 注册一个独立循环跑
 * 事件泵 + 小地图。两个 rAF 互不抢占(浏览器按顺序调全部 callback) */
function mmLoop(t) {
  pumpEvents();
  if (minimapOn) updateMinimap(t);
  requestAnimationFrame(mmLoop);
}
requestAnimationFrame(mmLoop);

const PANEL_IDS = ["menu", "panelSettings", "panelJoin", "panelWait", "panelSignal", "panelHelp"];

function hideAllPanels() {
  for (const id of PANEL_IDS) {
    const el = $(id);
    if (el) el.classList.add("hidden");
  }
}

function startSolo() {
  hideAllPanels();
  ensureAudio();
  initMinimap();
  $("gamehud").classList.remove("hidden");
  $("minimap").classList.remove("hidden");
  window.CQB_BOOT();                    // 引擎启动
  $("startBtn").click();                // 直接进入对局
  minimapOn = true;
}

let _settingsEntry = "solo";
let _matchSettings = { map: "office", mode: "1v1", playMode: "tdm", teamStyle: "adversarial" };

function bindSettings() {
const mapButtons = [
  ["mapOffice", "office"],
  ["mapPort", "harbor"],
  ["mapAlley", "alley"],
  ["mapMetro", "metro"],
  ["mapMall", "mall"],
];
const modeButtons = [
  ["mode1v1", "1v1"],
  ["mode2v2", "2v2"],
  ["mode3v3", "3v3"],
];
/* 玩法模式:死斗可用;解救/占点占位(disabled,HTML 层) */
const playButtons = [
  ["playTdm", "tdm"],
  ["playRescue", "rescue"],
  ["playPoint", "point"],
];
/* 阵营结构:联机建房专属(对抗/团队) */
const styleButtons = [
  ["styleAdversarial", "adversarial"],
  ["styleCoop", "coop"],
];
for (const [id, value] of mapButtons) {
  $(id).onclick = () => {
    _matchSettings.map = value;
    for (const [buttonId] of mapButtons) $(buttonId).classList.toggle("sel", buttonId === id);
  };
}
for (const [id, value] of modeButtons) {
  $(id).onclick = () => {
    _matchSettings.mode = value;
    for (const [buttonId] of modeButtons) $(buttonId).classList.toggle("sel", buttonId === id);
    syncTeamStyleRow();
  };
}
for (const [id, value] of playButtons) {
  const el = $(id);
  if (el.disabled) continue;               // 防御式跳过(当前三模式全部可用)
  el.onclick = () => {
    _matchSettings.playMode = value;
    for (const [buttonId] of playButtons) $(buttonId).classList.toggle("sel", buttonId === id);
  };
}
for (const [id, value] of styleButtons) {
  $(id).onclick = () => {
    _matchSettings.teamStyle = value;
    for (const [buttonId] of styleButtons) $(buttonId).classList.toggle("sel", buttonId === id);
  };
}
}

/* 阵营结构行显隐:仅建房入口且 2v2/3v3(1v1 固定对抗,单人无此维度);选择跨切换记忆 */
function syncTeamStyleRow() {
  const show = _settingsEntry === "host" && _matchSettings.mode !== "1v1";
  $("teamStyleWrap").classList.toggle("hidden", !show);
}

function showSettings(entry) {
_settingsEntry = entry;
bindSettings();
$("settingsStartBtn").textContent = entry === "host" ? "开始建房" : "开始";
/* 打开面板时同步阵营行显隐(点击规模按钮时也会联动) */
syncTeamStyleRow();
showPanel("panelSettings");
}

function startFromSettings() {
window.__CQB_MATCH_SETTINGS = { ..._matchSettings };
window.__CQB_MAP_KEY = _matchSettings.map;   // 引擎/小地图按所选地图初始化
if (_settingsEntry === "solo") {
  startSolo(_matchSettings);
} else startHost();
}

$("signalCopyBtn").onclick = () => {
  const text = $("signalText").value;
  if (text) {
    window.CQB_DEV_COPY(text);
    $("signalPhase").textContent = "已复制到剪贴板";
  }
};
$("signalCancelBtn").onclick = cancelSignal;

/* ============================ 联机状态机(SDP 文本互传) ============================
 * 流程:建房设置 → 开始建房 → 内部 createOffer,切到 panelSignal(显示 offer 文本)
 *   → 用户复制给加入者
 *   → panelSignal 切到"等粘贴 answer"模式
 *   → 用户粘贴 answer → acceptAnswer → open → enterGame
 *
 * 流程:加入 → panelJoin(输 4 位房间码) → joinOkBtn
 *   → 内部要求用户粘贴 offer → joinOfferInput 框
 *   → acceptOffer → 切到"显示 answer"模式
 *   → 用户复制给建房者
 *   → 等 open → enterGame
 */
function showPanel(panel) {
  for (const id of PANEL_IDS) {
    const el = $(id); if (!el) continue;
    el.classList.toggle("hidden", id !== panel);
  }
}

/* ============================ panelSignal UI 工具 ============================ */
let _signalChannel = null;
let _signalResolve = null;
let _signalReject = null;

function showSignalAsHost(offerText, code) {
  showPanel("panelSignal");
  $("signalText").readOnly = true;
  $("signalTitle").textContent = "1. 把这段 offer 复制给加入者";
  $("signalCode").textContent = `房间号: ${code}`;
  $("signalText").value = offerText;
  $("signalPhase").textContent = "等待对方粘贴 answer…";
  $("signalAnswerWrap").classList.add("hidden");
  $("signalOkBtn").textContent = "已复制,等待 answer";
  $("signalOkBtn").disabled = true;
  /* 用户点"已复制"→ 等 answer 输入 */
  $("signalOkBtn").onclick = () => {
    $("signalTitle").textContent = "2. 粘贴对方发回的 answer";
    $("signalAnswerWrap").classList.remove("hidden");
    $("signalOkBtn").textContent = "完成连接";
    $("signalOkBtn").disabled = false;
    $("signalOkBtn").onclick = async () => {
      const answerText = $("signalAnswerInput").value.trim();
      if (!answerText) { $("signalPhase").textContent = "请粘贴 answer 文本"; return; }
      $("signalOkBtn").disabled = true;
      $("signalPhase").textContent = "正在连接…";
      try {
        const { channel } = await window.CQB_DEV_HOST_ACCEPT_ANSWER(answerText);
        $("signalPhase").textContent = "✓ 已连接!";
        if (_signalResolve) _signalResolve({ channel, code });
      } catch (e) {
        $("signalPhase").textContent = "连接失败:" + (e.message || "未知错误");
        $("signalOkBtn").disabled = false;
      }
    };
  };
}

function showSignalAsClient() {
  showPanel("panelSignal");
  $("signalText").readOnly = false;
  $("signalText").focus();
  $("signalTitle").textContent = "1. 粘贴建房者发来的 offer";
  $("signalCode").textContent = "";
  $("signalText").value = "";
  $("signalPhase").textContent = "粘贴后点「生成 answer」";
  $("signalAnswerWrap").classList.add("hidden");
  $("signalOkBtn").textContent = "生成 answer";
  $("signalOkBtn").disabled = false;
  $("signalOkBtn").onclick = async () => {
    const offerText = $("signalText").value.trim();
    if (!offerText) { $("signalPhase").textContent = "请粘贴 offer 文本"; return; }
    $("signalOkBtn").disabled = true;
    $("signalPhase").textContent = "正在生成 answer…";
    /* 走 CQB_DEV_JOIN_SUBMIT:acceptOffer → 显示 answer → 等 open */
    window.CQB_DEV_JOIN_SUBMIT(offerText).then(({ channel }) => {
      $("signalPhase").textContent = "✓ 已连接!";
      if (_signalResolve) _signalResolve({ channel });
    }).catch((e) => {
      $("signalPhase").textContent = "连接失败:" + (e.message || "未知错误");
      $("signalOkBtn").disabled = false;
    });
  };
}

/* 建房:显式信令地址 → WS 信令;headless → SDP 回退;浏览器默认 → 公共 MQTT */
function startHost() {
  const sUrl = signalUrl();
  if (sUrl) { startHostSignaling(sUrl); return; }
  if (typeof location === "undefined") { startHostSdp(); return; }
  startHostMqtt();
}

function startHostSdp() {
  hideAllPanels();
  _signalChannel = null; _signalResolve = null; _signalReject = null;
  const hostPromise = window.CQB_DEV_HOST();
  hostPromise.then((r) => {
    /* channel 已 open,进入对局 */
    enterGameAsHost(r);
  }).catch((e) => {
    console.error("startHost failed:", e);
    showPanel("menu");
    if (typeof alert === "function") {
      alert("建房失败:" + (e.message || "未知错误"));
    } else {
      $("waitStatus") && ($("waitStatus").textContent = "建房失败:" + (e.message || "未知错误"));
    }
  });
}

/* 公共 MQTT 信令建房:panelWait 显示 6 位房间码,连接建立后自动进对局 */
function startHostMqtt() {
  hideAllPanels();
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += A[Math.floor(Math.random() * A.length)];
  $("roomCode").textContent = "cqb-" + code;
  $("waitStatus").textContent = "等待玩家加入…(公共 MQTT 信令)";
  showPanel("panelWait");
  const ch = new MqttChannel(window.CQB_MQTT_BROKERS || undefined, code);
  _signalChannel = ch;
  ch.onstatechange = (s) => {
    if (s === "open") enterGameAsHost({ channel: ch, code });
  };
  ch.host().catch((e) => {
    try { ch.close(); } catch (err) { /* 容错 */ }
    _signalChannel = null;
    showPanel("menu");
    if (typeof alert === "function") {
      alert("建房失败:" + (e.message || "未知错误") + "\n(公共信令暂不可用,稍后重试或换一局)");
    }
  });
}

/* 房间码建房:panelWait 显示房间码与等待状态,连接建立后自动进对局 */
function startHostSignaling(sUrl) {
  hideAllPanels();
  const code = window.CQB_DEV_ROOMCODE().slice(4);   // 4 位码(去 cqb- 前缀)
  $("roomCode").textContent = "cqb-" + code;
  $("waitStatus").textContent = "等待玩家加入…";
  showPanel("panelWait");
  const ch = new SignalChannel(sUrl, code);
  _signalChannel = ch;
  ch.onstatechange = (s) => {
    if (s === "open") enterGameAsHost({ channel: ch, code });
  };
  ch.onpeerleft = () => {
    /* 对局中断线提示;后续批次可做"对方已离开"界面 */
    if (typeof alert === "function") alert("对方已断开连接");
  };
  ch.host().catch((e) => {
    try { ch.close(); } catch (err) { /* 容错 */ }
    _signalChannel = null;
    showPanel("menu");
    if (typeof alert === "function") {
      alert("建房失败:" + (e.message || "未知错误"));
    }
  });
}

/* 取消 SDP 流程 */
function cancelSignal() {
  if (_signalChannel) try { _signalChannel.close(); } catch (e) {}
  showPanel("menu");
}

/* 监听 CQB_DEV_HOST 派发的事件:它内部 createOffer 后弹 host-offer */
window.addEventListener("cqb:host-offer", (e) => {
  const { offerText, channel, code, resolve, reject } = e.detail;
  _signalChannel = channel;
  _signalResolve = resolve;
  _signalReject = reject;
  /* 把 channel 也存到全局,让 CQB_DEV_HOST_ACCEPT_ANSWER 能拿到 */
  window.__CQB_HOST_CHANNEL = channel;
  showSignalAsHost(offerText, code);
});

/* 监听 CQB_DEV_JOIN 派发的事件:它要求用户粘贴 offer */
window.addEventListener("cqb:client-prompt-offer", (e) => {
  const { resolve, reject } = e.detail;
  _signalResolve = resolve;
  _signalReject = reject;
  showSignalAsClient();
});

/* 取消建房/加入 */
function cancelWait() {
  if (_signalChannel) {
    try { _signalChannel.close(); } catch (e) { /* 容错 */ }
    _signalChannel = null;
  }
  showPanel("menu");
}

/* 复制房间码(只复制码本身:加入框不需要 cqb- 前缀,粘贴即用) */
function copyRoomCode() {
  const code = $("roomCode").textContent.replace(/^cqb-/, "");
  window.CQB_DEV_COPY(code);
}

/* 加入 → 校验 → 显式信令 / MQTT(生产默认) / SDP(headless 回退) */
function startJoin() {
  const raw = $("joinInput").value.trim().toUpperCase();
  $("joinError").textContent = "\u00a0";
  if (!/^[A-HJ-NP-Z2-9]{4,6}$/.test(raw)) {
    $("joinError").textContent = "格式无效(4~6 位大写字母数字,排除 I/O/0/1)";
    return;
  }
  const sUrl = signalUrl();
  if (!sUrl && typeof location === "undefined") {
    /* 旧 SDP 流程兜底(headless 测试) */
    $("joinOkBtn").textContent = "加入中…";
    $("joinOkBtn").disabled = true;
    window.CQB_DEV_JOIN("cqb-" + raw).then(() => {
      /* CQB_DEV_JOIN 内部 dispatch client-prompt-offer,UI 接管 → SDP 完成 → enterGameAsClient */
    }).catch((e) => {
      $("joinError").textContent = "加入失败:" + (e.message || "未知错误");
      $("joinOkBtn").textContent = "加入";
      $("joinOkBtn").disabled = false;
    });
    return;
  }
  if (!sUrl) {
    /* 生产默认:公共 MQTT 信令 */
    $("joinOkBtn").textContent = "加入中…";
    $("joinOkBtn").disabled = true;
    const ch = new MqttChannel(window.CQB_MQTT_BROKERS || undefined, raw);
    _signalChannel = ch;
    ch.onstatechange = (s) => {
      if (s === "open") enterGameAsClient({ channel: ch });
    };
    ch.join().catch((e) => {
      try { ch.close(); } catch (err) { /* 容错 */ }
      _signalChannel = null;
      $("joinError").textContent = "加入失败:" + (e.message || "未知错误");
      $("joinOkBtn").textContent = "加入";
      $("joinOkBtn").disabled = false;
    });
    return;
  }
  $("joinOkBtn").textContent = "加入中…";
  $("joinOkBtn").disabled = true;
  const ch = new SignalChannel(sUrl, raw);
  _signalChannel = ch;
  ch.onstatechange = (s) => {
    if (s === "open") enterGameAsClient({ channel: ch });
  };
  ch.join().catch((e) => {
    try { ch.close(); } catch (err) { /* 容错 */ }
    _signalChannel = null;
    $("joinError").textContent = "加入失败:" + (e.message || "未知错误");
    $("joinOkBtn").textContent = "加入";
    $("joinOkBtn").disabled = false;
  });
}

/* 输入实时转大写 */
function bindJoinInput() {
  const input = $("joinInput");
  input.addEventListener("input", () => {
    const v = input.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
    if (v !== input.value) input.value = v;
    $("joinError").textContent = "\u00a0";
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") startJoin(); });
}

function enterGame() {
  hideAllPanels();
  ensureAudio();
  initMinimap();
  $("gamehud").classList.remove("hidden");
  $("minimap").classList.remove("hidden");
  minimapOn = true;
  if (!window.__CQB_NET) {
    window.CQB_BOOT();
    $("startBtn").click();
  }
}

/* 联机 host 模式 enterGame:实例化 host + attachNetSession + 把 host snapshot 推回渲染层
 *
 * 职责拆分(修复"两边看到同一个角色且都无法操作"):
 *   - channel 是"房主↔加入者"的对端通道,只承载加入者的 input(下行 snapshot 由 host 推)
 *   - 房主自己是本地玩家:input 不经 channel,由 attachNetSession("host") 直喂 host.feedInput
 *   - enterGameAsHost 在 channel open 后被调 → 对端此刻已连上,立即为其建 fighter 并绑 channel */
function enterGameAsHost({ channel, code }) {
  hideAllPanels();
  ensureAudio();
  initMinimap();
  $("gamehud").classList.remove("hidden");
  $("minimap").classList.remove("hidden");
  minimapOn = true;
  /* host 实例(按所选地图/模式建 state) */
  const Host = window.CQB_HOST;
  const settings = window.__CQB_MATCH_SETTINGS || {};
  const mode = settings.mode || "1v1";
  const host = new Host.HostSession(window.__CQB_MAP_KEY || "office", mode,
                                    settings.playMode || "tdm");
  /* 阵营结构(房主在设置面板决定,仅联机):对抗 = 两队真人;团队 = 真人同队合作 */
  const guestTeam = settings.teamStyle === "coop" ? 0 : 1;
  /* 真人先占名额,fillBots 按规模补齐两队 */
  const myId = host.addPlayer({ name: "你", isBot: false, team: 0 });
  host.addPlayer({ name: "玩家2", isBot: false, team: guestTeam, channel });
  host.fillBots(mode);                  // 按规模自动补 Bot(1v1 时两队已满,不加)
  /* 对局信息随快照下发(加入者本地无设置面板,HUD 模式说明行以 host 为准) */
  host.setMatchInfo({
    map: host.state.md.name,
    mapKey: window.__CQB_MAP_KEY || "office",   // 加入者据此建本地网格(2026-09-05 修复加入者建错地图)
    mode,
    team: mode !== "1v1" ? (settings.teamStyle === "coop" ? "coop" : "adversarial") : null,
    play: settings.playMode || "tdm",
  });
  /* 暴露 host 实例供 attachNetSession 内部用(input 直接喂 host) */
  window.__CQB_HOST_INSTANCE = host;
  window.__CQB_HOST_MY_ID = myId;
  /* 本地渲染层 + 本地 input 直喂 host */
  window.CQB_ATTACH_NET(channel, "host");
  /* host snapshot 给"我"时推回 cqb1 渲染;加入者的 snapshot 由 host 直接发其 channel */
  host.onSnapshot((pid, snap) => { if (pid === myId) window.__CQB_PUSH_SNAPSHOT(snap); });
  host.start();
}

/* 联机 client 模式 enterGame:仅 attachNetSession(无 host) */
function enterGameAsClient({ channel }) {
  hideAllPanels();
  ensureAudio();
  /* 小地图/引擎建图延迟到首份快照(需 host 下发的 mapKey;此前加入者固定建 office,
   * 与 host 实际地图逐格错位 → 穿墙/空气墙,2026-09-05 修复) */
  $("gamehud").classList.remove("hidden");
  $("minimap").classList.remove("hidden");
  minimapOn = true;
  window.CQB_ATTACH_NET(channel, "client");
  window.__CQB_HOST_INSTANCE = null;
}

/* ============================ 联机 NetSession 接入 ============================
 * 职责:
 *   - 把"网络一侧"的 channel(snapshot 下行)接到 cqb1 渲染层
 *   - 把"本地一侧"的键鼠(input 上行)打包成 input 消息发到 channel
 *
 * 设计:
 *   - host 模式:cqb2 同时是 host(跑 cqb-host.js)+ client(渲染 host snapshot)
 *   - client 模式:cqb2 只是 client,host 跑在远端
 *   - 两种模式共用同一份 input → channel 发送逻辑
 *
 * 留作 stub 的部分(下个会话接 PeerJS):
 *   - 实际建连的代码:目前 enterGame() 不调 attachNetSession,本地仍是单 Bot
 *   - URL ?room=XXX 检测(自动 join)
 */
function attachNetSession(channel, role) {
  /* 进入联机模式:cqb1 引擎的 update 短路,只渲染(host 由 snapshot 驱动,client 由远端 snapshot 驱动)
   * client 建图延迟(2026-09-05 修复):加入者无设置面板,地图键要等 host 首份快照的
   * match.mapKey——此前固定建 office,与 host 实际地图逐格错位(穿墙/空气墙) */
  window.__CQB_REMOTE_MODE = true;
  let _clientBooted = false;
  const bootClientWithMap = (mapKey) => {
    if (_clientBooted) return;
    _clientBooted = true;
    window.__CQB_MAP_KEY = mapKey || "office";
    initMinimap();
    window.CQB_BOOT();
    $("startBtn").click();
  };

  const isHost = role === "host";
  if (isHost) bootClientWithMap(window.__CQB_MAP_KEY);   // host 本地已有地图键:立即建图

  /* client:channel 收 snapshot → 推回 cqb1 闭包渲染。
   * host:channel 由 HostSession.addPlayer 绑定(收加入者 input),
   *   本地渲染走 host.onSnapshot → __CQB_PUSH_SNAPSHOT,这里绝不能覆盖 onmessage */
  if (!isHost) {
    channel.onmessage = (msg) => {
      if (msg && msg.type === "snapshot") {
        bootClientWithMap(msg.match && msg.match.mapKey);   // 首份快照:按 host 地图建图
        window.__CQB_PUSH_SNAPSHOT(msg);
      }
    };
  }

  /* 本地 input → host(client:发给远端;host:直喂本地 HostSession) */
  let _seq = 0;
  const _localKeys = {};
  let _localFire = false, _localFireEdge = false;
  let _localAim = 0;
  let _localReload = false, _localSwitch = -1;
  let _localInteract = false;

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowup","arrowdown","arrowleft","arrowright","w","a","s","d","shift","r","f","1","2","3","e"].includes(k)) {
      _localKeys[k] = true;
      if (k === "r") _localReload = true;
      if (k === "f") _localInteract = true;
      if (k === "1") _localSwitch = 0;
      if (k === "2") _localSwitch = 1;
      if (k === "3") _localSwitch = 2;
      if (k === "e") {
        /* E 键循环投掷物:闪光(3) ↔ 烟雾(4);枪械由 1/2/3 切回(复用 switch 消息) */
        const D = window.__CQB_DEBUG || {};
        const cur = (D.player && typeof D.player.weapon === "number") ? D.player.weapon : 3;
        _localSwitch = cur === 3 ? 4 : 3;
      }
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    _localKeys[e.key.toLowerCase()] = false;
  });
  const cv = document.getElementById("cv");
  cv.addEventListener("mousemove", (e) => {
    const D = window.__CQB_DEBUG || {};
    const p = D.player;
    if (!p) return;
    const cam = D.cam;
    const zoom = D.zoom || 1;
    const wx = cam.x - (window.innerWidth / 2) / zoom + e.clientX / zoom;
    const wy = cam.y - (window.innerHeight / 2) / zoom + e.clientY / zoom;
    _localAim = Math.atan2(wy - p.y, wx - p.x);
  });
  cv.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      _localFire = true;
      _localFireEdge = true;
    }
  });
  window.addEventListener("mouseup", () => {
    _localFire = false;
  });

  /* 每帧 60Hz 发 input 包 */
  let _lastInputSent = 0;
  function buildInputMsg() {
    return {
      type: "input",
      seq: _seq++,
      keys: {
        w: !!_localKeys.w, a: !!_localKeys.a,
        s: !!_localKeys.s, d: !!_localKeys.d,
        shift: !!_localKeys.shift,
      },
      aim: _localAim,
      fire: _localFire,
      fireEdge: _localFireEdge,
      reload: _localReload,
      switch: _localSwitch,
      interact: _localInteract,
    };
  }
  function resetInputEdges() {
    _localFireEdge = false;
    _localReload = false;
    _localSwitch = -1;
    _localInteract = false;
  }
  function inputLoop() {
    const now = performance.now();
    if (now - _lastInputSent >= 16) {
      _lastInputSent = now;
      const msg = buildInputMsg();
      try {
        if (isHost) {
          /* 房主:input 直喂本地 host(不经 channel,channel 上是加入者的 input) */
          const h = window.__CQB_HOST_INSTANCE;
          if (h) h.feedInput(window.__CQB_HOST_MY_ID, msg);
        } else if (channel.state === "open") {
          channel.send(msg);
        }
      } catch (err) { /* 容错 */ }
      window.__CQB_LAST_INPUT_SEQ = msg.seq;   // 引擎自体预测打时间戳用(2026-09-05)
      resetInputEdges();
    }
    requestAnimationFrame(inputLoop);
  }
  requestAnimationFrame(inputLoop);
}

/* 暴露给上层(host/PeerJS 接入后调用) */
window.CQB_ATTACH_NET = attachNetSession;
/* headless 测试钩子:startHost* 系列都经此装配函数进对局 */
window.__CQB_ENTER_GAME_AS_HOST = enterGameAsHost;
/* 单人退出钩子:engine 的结算/暂停菜单「回到主菜单」按钮经此回主菜单 */
window.__CQB_ON_EXIT_TO_MENU = () => {
  hideAllPanels();
  showPanel("menu");
  $("gamehud").classList.add("hidden");
  $("minimap").classList.add("hidden");
  minimapOn = false;
};

$("btnSolo").onclick = () => showSettings("solo");
$("btnHost").onclick = () => showSettings("host");
$("btnHelp").onclick = () => { buildHelpContent(); showPanel("panelHelp"); };
$("helpBackBtn").onclick = () => showPanel("menu");
$("settingsStartBtn").onclick = startFromSettings;
$("settingsBackBtn").onclick = () => showPanel("menu");
$("btnJoin").onclick = () => { showPanel("panelJoin"); $("joinInput").value = ""; $("joinError").textContent = "\u00a0"; $("joinInput").focus(); bindJoinInput(); };
$("waitCancelBtn").onclick = cancelWait;
$("copyCodeBtn").onclick = copyRoomCode;
$("joinOkBtn").onclick = startJoin;
$("joinCancelBtn").onclick = () => showPanel("menu");

})();

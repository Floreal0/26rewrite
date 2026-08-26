/* CQB 一期原型 · 游戏逻辑与渲染
 * 文件约定:cqb1.html + cqb1.js 为第一期冻结版本;二期待建。
 * 设计依据:同目录 DESIGN.md(v0.2+,56×40 扩建办公楼,R=12 视野)
 *
 * 结构说明:
 *   - 纯算法(射线/寻路/碰撞/可见性)不依赖 DOM,可在 node 无头测试;
 *   - 渲染与输入仅在浏览器环境启动(window/document 存在时)。
 */
(function (global) {
"use strict";

/* ============================ 配置 ============================ */
const CELL = 32;                    // 世界单位:每格 32
const VISION_R_TILES = 12;          // 视野半径(格)
const VISION_R = VISION_R_TILES * CELL;
const CONE_HALF = 55 * Math.PI / 180;
const NEAR_R = 2 * CELL;            // 贴身恒可见半径
const SPEED = 4.5 * CELL;           // 正常移速
const SHIFT_SPEED = 2.2 * CELL;     // 静步速度
const NOISE_INTERVAL = 400;         // 噪波间隔 ms
const NOISE_RADIUS = 4 * CELL;      // 涟漪最大半径(穿墙)
const RESPAWN_MS = 2000;
const PROTECT_MS = 2000;
const KILL_TARGET = 15;
const PLAYER_R = 13;

const WEAPONS = [
  { key:"rifle",  name:"步枪",   auto:true,  rpm:600, mag:30, dmg:20,
    reloadMs:2000, spreadBase:0.010, bloomAdd:0.014, bloomMax:0.055 },
  { key:"pistol", name:"手枪",   auto:false, rpm:280, mag:12, dmg:34,
    reloadMs:1400, spreadBase:0.004, bloomAdd:0.008, bloomMax:0.028 },
  { key:"knife",  name:"战术刀", melee:true, cdMs:500, dmg:55, backstabDmg:100,
    range:1.3 * CELL, arc: Math.PI/4 },
];

/* ============================ 地图数据 ============================ */
/* 由 map-office.generator.js 生成后注入 */
const MAP_DATA = {"name":"办公楼·扩建版","w":56,"h":40,"cell":32,"visionR":12,"rooms":[["TL 左上房",1,1,8,8],["LS 西储物间",1,10,8,6],["BL 西楼梯间北",1,17,8,8],["SW 西楼梯间南",1,27,8,12],["西走廊",10,1,4,38],["中央大厅",15,1,10,31],["大会议室",15,33,10,6],["东走廊",26,1,4,38],["TR 右上房",31,1,8,8],["MR 东储物间",31,10,8,6],["BR 右楼梯间北",31,17,8,8],["开放办公区",31,27,24,12],["北档案室",40,3,15,9],["南档案室",40,13,15,10]],"doors":[[9,3],[9,4],[9,11],[9,12],[9,18],[9,19],[14,5],[14,6],[14,16],[14,17],[14,10],[14,11],[25,5],[25,6],[25,18],[25,19],[25,13],[25,14],[30,3],[30,4],[30,11],[30,12],[30,18],[30,19],[9,29],[9,30],[9,35],[9,36],[19,32],[20,32],[30,29],[30,30],[39,5],[39,6],[39,18],[39,19],[47,12]],"crates":[[17,5],[22,8],[16,13],[21,16],[18,21],[19,11],[4,4],[35,4],[4,20],[35,20],[20,28],[17,34],[22,36],[4,30],[6,35],[34,30],[40,33],[46,29],[50,35],[43,37],[45,6],[51,9],[44,16],[51,19]],"spawns":[[2,2],[37,2],[2,23],[37,23],[11,12],[28,12],[19,36],[4,32],[47,32],[47,7]]};

/* ============================ 网格构建 ============================ */
function buildGrid(md) {
  const g = [];
  for (let y = 0; y < md.h; y++) {
    const row = new Array(md.w).fill(1);
    g.push(row);
  }
  for (const [, x, y, w, h] of md.rooms)
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) g[j][i] = 0;
  for (const [x, y] of md.doors) g[y][x] = 0;
  for (const [x, y] of md.crates) g[y][x] = 1;
  return g;
}
function solidAt(grid, ix, iy) {
  if (ix < 0 || iy < 0 || iy >= grid.length || ix >= grid[0].length) return true;
  return grid[iy][ix] === 1;
}

/* ============================ 几何:射线 ============================ */
/* DDA 网格射线:返回命中实心格的距离 */
function dda(grid, ox, oy, ang, maxDist) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let ix = Math.floor(ox / CELL), iy = Math.floor(oy / CELL);
  if (solidAt(grid, ix, iy)) return 0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(CELL / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((ix + (dx > 0 ? 1 : 0)) * CELL - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((iy + (dy > 0 ? 1 : 0)) * CELL - oy) / dy : Infinity;
  let t = 0;
  while (t <= maxDist) {
    if (tMaxX <= tMaxY) { t = tMaxX; tMaxX += tDeltaX; ix += stepX; }
    else                { t = tMaxY; tMaxY += tDeltaY; iy += stepY; }
    if (t > maxDist) break;
    if (solidAt(grid, ix, iy)) return t;
  }
  return maxDist;
}

function losClear(grid, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d === 0) return !solidAt(grid, Math.floor(x1 / CELL), Math.floor(y1 / CELL));
  return dda(grid, x1, y1, Math.atan2(dy, dx), d) >= d - 0.001 &&
         !solidAt(grid, Math.floor(x2 / CELL), Math.floor(y2 / CELL));
}

function normAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/* 可见多边形:视野锥 ∩ 半径圆 内对实心格角点投射 */
function visibilityPolygon(grid, px, py, facing, R) {
  const a0 = facing - CONE_HALF, a1 = facing + CONE_HALF;
  const angles = [a0, a1];
  const minI = Math.max(0, Math.floor((px - R) / CELL));
  const maxI = Math.min(grid[0].length - 1, Math.floor((px + R) / CELL));
  const minJ = Math.max(0, Math.floor((py - R) / CELL));
  const maxJ = Math.min(grid.length - 1, Math.floor((py + R) / CELL));
  for (let iy = minJ; iy <= maxJ; iy++) {
    for (let ix = minI; ix <= maxI; ix++) {
      if (!grid[iy][ix]) continue;
      for (const cx of [ix, ix + 1]) {
        for (const cy of [iy, iy + 1]) {
          const wx = cx * CELL, wy = cy * CELL;
          const d = Math.hypot(wx - px, wy - py);
          if (d > R + CELL) continue;
          const da = normAngle(Math.atan2(wy - py, wx - px) - facing);
          if (Math.abs(da) <= CONE_HALF + 0.03) {
            angles.push(facing + da - 0.0008, facing + da + 0.0008);
          }
        }
      }
    }
  }
  angles.sort((p, q) => normAngle(p - facing) - normAngle(q - facing));
  // 去除重复角(同一角点的 ±ε 对),再在相邻角之间补一条中点射线,
  // 消除掠射角处多边形向原点塌陷的细长伪影
  const uniq = [];
  for (const a of angles) {
    if (!uniq.length ||
        Math.abs(normAngle(a - uniq[uniq.length - 1])) > 1e-6) uniq.push(a);
  }
  const dense = [];
  for (let i = 0; i < uniq.length; i++) {
    dense.push(uniq[i]);
    if (i + 1 < uniq.length) {
      dense.push(facing + normAngle((uniq[i] + uniq[i + 1]) / 2 - facing));
    }
  }
  const pts = [];
  for (const a of dense) {
    const aa = facing + Math.max(-CONE_HALF, Math.min(CONE_HALF, normAngle(a - facing)));
    const d = dda(grid, px, py, aa, R);
    pts.push([px + Math.cos(aa) * d, py + Math.sin(aa) * d]);
  }
  return pts;
}

/* 点在多边形内 */
function pip(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* 实体可见性:贴身环恒可见;视野外不可见;其余按多边形 */
function entityVisible(poly, ox, oy, ex, ey) {
  const d = Math.hypot(ex - ox, ey - oy);
  if (d <= NEAR_R) return true;
  if (d >= VISION_R) return false;
  return pip(poly, ex, ey);
}

/* ============================ 几何:寻路 ============================ */
/* 网格 A*(四方向),返回格子中心世界坐标路径 */
function astar(grid, sx, sy, gx, gy) {
  const W = grid[0].length, H = grid.length;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H ||
      gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  if (grid[sy][sx] || grid[gy][gx]) return null;
  const sIdx = sy * W + sx, gIdx = gy * W + gx;
  const open = [{ i: sIdx, f: 0, g: 0 }];
  const came = new Map(); came.set(sIdx, -1);
  const gScore = new Map(); gScore.set(sIdx, 0);
  const closed = new Set();
  const h = (idx) => {
    const x = idx % W, y = (idx / W) | 0;
    return Math.abs(x - gx) + Math.abs(y - gy);
  };
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;
    const cur = open.splice(bi, 1)[0];
    if (cur.i === gIdx) {
      const path = [];
      let n = gIdx;
      while (n !== -1) {
        path.push([(n % W) * CELL + CELL / 2, ((n / W) | 0) * CELL + CELL / 2]);
        n = came.get(n);
      }
      path.reverse();
      return path;
    }
    if (closed.has(cur.i)) continue;
    closed.add(cur.i);
    const cx = cur.i % W, cy = (cur.i / W) | 0;
    for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx2 = cx + ddx, ny2 = cy + ddy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
      if (grid[ny2][nx2]) continue;
      const ni = ny2 * W + nx2;
      if (closed.has(ni)) continue;
      const ng = cur.g + 1;
      if (!gScore.has(ni) || ng < gScore.get(ni)) {
        gScore.set(ni, ng);
        came.set(ni, cur.i);
        open.push({ i: ni, f: ng + h(ni), g: ng });
      }
    }
  }
  return null;
}

/* ============================ 移动碰撞 ============================ */
/* 圆体分轴滑动:沿移动方向扫描跨越的列/行,撞到第一个实心即钳制 */
function moveCircle(grid, f, dx, dy) {
  const EPS = 0.01;
  // ---- X 轴 ----
  if (dx !== 0) {
    f.x += dx;
    const yTop = Math.floor((f.y - f.r + EPS) / CELL);
    const yBot = Math.floor((f.y + f.r - EPS) / CELL);
    if (dx < 0) {
      const startCol = Math.floor((f.x - dx - f.r + EPS) / CELL);   // 原左缘列
      const endCol = Math.floor((f.x - f.r) / CELL);                // 新左缘列
      for (let col = startCol; col >= endCol; col--) {
        let solid = false;
        for (let row = yTop; row <= yBot; row++)
          if (solidAt(grid, col, row)) { solid = true; break; }
        if (solid) { f.x = (col + 1) * CELL + f.r + EPS; break; }
      }
    } else {
      const startCol = Math.floor((f.x - dx + f.r - EPS) / CELL);
      const endCol = Math.floor((f.x + f.r) / CELL);
      for (let col = startCol; col <= endCol; col++) {
        let solid = false;
        for (let row = yTop; row <= yBot; row++)
          if (solidAt(grid, col, row)) { solid = true; break; }
        if (solid) { f.x = col * CELL - f.r - EPS; break; }
      }
    }
  }
  // ---- Y 轴 ----
  if (dy !== 0) {
    f.y += dy;
    const xLft = Math.floor((f.x - f.r + EPS) / CELL);
    const xRgt = Math.floor((f.x + f.r - EPS) / CELL);
    if (dy < 0) {
      const startRow = Math.floor((f.y - dy - f.r + EPS) / CELL);
      const endRow = Math.floor((f.y - f.r) / CELL);
      for (let row = startRow; row >= endRow; row--) {
        let solid = false;
        for (let col = xLft; col <= xRgt; col++)
          if (solidAt(grid, col, row)) { solid = true; break; }
        if (solid) { f.y = (row + 1) * CELL + f.r + EPS; break; }
      }
    } else {
      const startRow = Math.floor((f.y - dy + f.r - EPS) / CELL);
      const endRow = Math.floor((f.y + f.r) / CELL);
      for (let row = startRow; row <= endRow; row++) {
        let solid = false;
        for (let col = xLft; col <= xRgt; col++)
          if (solidAt(grid, col, row)) { solid = true; break; }
        if (solid) { f.y = row * CELL - f.r - EPS; break; }
      }
    }
  }
}

/* ============================ 武器与射击 ============================ */
/* 射击几何解算(纯函数):墙距与目标圆截距取最近 */
function resolveShotGeometry(grid, sx, sy, ang, targets, range) {
  const wallD = dda(grid, sx, sy, ang, range);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let best = null;
  for (const t of targets) {
    if (t.dead) continue;
    const vx = t.x - sx, vy = t.y - sy;
    const proj = vx * dx + vy * dy;
    if (proj <= 0) continue;
    const perp2 = vx * vx + vy * vy - proj * proj;
    const rr = (t.r || 13);
    if (perp2 > rr * rr) continue;
    const hitT = proj - Math.sqrt(rr * rr - perp2);
    if (hitT > wallD) continue;
    if (!best || hitT < best.t) best = { t: hitT, target: t };
  }
  const end = best ? best.t : wallD;
  return {
    endX: sx + dx * end, endY: sy + dy * end,
    wallD, target: best ? best.target : null, t: end,
  };
}

function makeFighter(o) {
  return Object.assign({
    x: 0, y: 0, r: PLAYER_R, facing: 0,
    hp: 100, alive: true, protectT: 0, deadUntil: 0,
    weapon: 0, mags: [WEAPONS[0].mag, WEAPONS[1].mag],
    reloadEnd: 0, nextFire: 0, bloom: 0,
    kills: 0, deaths: 0, isBot: false, name: "?",
    noiseT: 0, movingFast: false,
  }, o);
}

/* ============================ Bot(一期最简交战版) ============================ */
const BOT_CFG = {
  reaction: 320,        // 首次看见到开枪的延迟 ms
  aimError: 0.085,      // 基础瞄准误差(弧度)
  burstMs: 420,         // 连射时长
  pauseMs: 380,         // 连射间歇
};

class BotBrain {
  constructor(grid, self) {
    this.grid = grid; this.self = self;
    this.state = "patrol";
    this.path = null; this.pathI = 0;
    this.lastSeen = null;
    this.reactUntil = 0;
    this.burstUntil = 0; this.pauseUntil = 0;
    this.repathT = 0;
  }

  canSee(target) {
    const s = this.self;
    if (!target.alive || target.protectT > 0 && target.isBot) return false;
    const d = Math.hypot(target.x - s.x, target.y - s.y);
    if (d > VISION_R) return false;
    const a = Math.atan2(target.y - s.y, target.x - s.x);
    if (Math.abs(normAngle(a - s.facing)) > CONE_HALF) return false;
    return losClear(this.grid, s.x, s.y, target.x, target.y);
  }

  hear(x, y) {
    // 听到噪波:进入搜索状态(即使正在巡逻)
    if (this.state === "patrol" || this.state === "hunt") {
      this.lastSeen = { x, y };
      this.state = "hunt";
      this.path = null;
    }
  }

  update(dt, now, target, onFire) {
    const s = this.self;
    if (!s.alive) return;
    const see = this.canSee(target);

    if (see) {
      if (this.state !== "combat") {
        this.state = "combat";
        this.reactUntil = now + BOT_CFG.reaction;
      }
      this.lastSeen = { x: target.x, y: target.y };
      s.facing = Math.atan2(target.y - s.y, target.x - s.x);
      s.movingFast = false;
      // 交战:小幅度侧向走位,保持武器节奏
      if (now >= this.reactUntil) {
        if (now >= this.burstUntil && now >= this.pauseUntil) {
          this.burstUntil = now + BOT_CFG.burstMs;
        }
        if (now < this.burstUntil) {
          const w = WEAPONS[s.weapon];
          if (now >= s.nextFire && s.mags[0] > 0 && s.reloadEnd <= now) {
            s.nextFire = now + 60000 / w.rpm;
            const err = BOT_CFG.aimError * (0.6 + Math.random() * 0.8);
            onFire(s, s.facing + (Math.random() - 0.5) * 2 * err);
          }
        } else if (now >= this.pauseUntil) {
          this.pauseUntil = now + BOT_CFG.pauseMs;
        }
      }
      return;
    }

    // 丢失视线
    if (this.state === "combat") { this.state = "hunt"; this.path = null; }

    if (this.state === "hunt" && this.lastSeen) {
      this.followPath(dt, this.lastSeen.x, this.lastSeen.y, now);
      const arrived = Math.hypot(this.lastSeen.x - s.x, this.lastSeen.y - s.y) < CELL;
      if (arrived) { this.state = "patrol"; this.lastSeen = null; this.path = null; }
      return;
    }

    // 巡逻:随机漫游
    this.patrolT = (this.patrolT || 0) - dt;
    if (!this.path || this.pathI >= this.path.length || this.patrolT <= 0) {
      this.patrolT = 4000 + Math.random() * 3000;
      const tx = Math.floor(Math.random() * this.grid[0].length);
      const ty = Math.floor(Math.random() * this.grid.length);
      this.path = astar(this.grid,
        Math.floor(s.x / CELL), Math.floor(s.y / CELL), tx, ty);
      this.pathI = 0;
    }
    this.followPath(dt, null, null, now);
  }

  followPath(dt, gx, gy, now) {
    const s = this.self;
    if ((!this.path || this.pathI >= this.path.length) && gx != null) {
      this.path = astar(this.grid,
        Math.floor(s.x / CELL), Math.floor(s.y / CELL),
        Math.floor(gx / CELL), Math.floor(gy / CELL));
      this.pathI = 0;
    }
    if (!this.path || this.pathI >= this.path.length) return;
    const [wx, wy] = this.path[this.pathI];
    const dx = wx - s.x, dy = wy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) { this.pathI++; return; }
    const sp = SHIFT_SPEED;                 // bot 用静步速度巡逻(无声,公平)
    s.movingFast = false;
    s.facing = Math.atan2(dy, dx);
    moveCircle(this.grid, s, (dx / d) * sp * dt, (dy / d) * sp * dt);
  }
}

/* ============================ 导出(无头测试用) ============================ */
const EXPORTS = {
  CELL, VISION_R, VISION_R_TILES, CONE_HALF, NEAR_R, WEAPONS, MAP_DATA,
  buildGrid, solidAt, dda, losClear, normAngle, visibilityPolygon, pip,
  entityVisible, astar, moveCircle, resolveShotGeometry, makeFighter,
  BotBrain, BOT_CFG,
};
global.CQB1 = EXPORTS;
if (typeof module !== "undefined" && module.exports) module.exports = EXPORTS;

/* ============================ 浏览器启动区 ============================ */
function bootBrowser() {
  if (bootBrowser.done) return; bootBrowser.done = true;

  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const fogCv = document.createElement("canvas");
  const fctx = fogCv.getContext("2d");

  const el = (id) => document.getElementById(id);
  const hud = {
    kills: el("kills"), deaths: el("deaths"), feed: el("killfeed"),
    wname: el("wname"), mag: el("mag"), reloadFill: el("reloadFill"),
    hpfill: el("hpfill"), hptext: el("hptext"), vignette: el("vignette"),
    center: el("center"), ovTitle: el("ovTitle"), ovText: el("ovText"),
    startBtn: el("startBtn"), respawnTxt: el("respawnTxt"),
  };

  let cssW = 0, cssH = 0, ZOOM = 1;
  /* 事件总线:cqb2 的音效/统计层通过 CQB_DRAIN_EVENTS() 消费 */
  const EVENTS = [];
  global.CQB_EVENTS = EVENTS;
  global.CQB_DRAIN_EVENTS = () => EVENTS.splice(0);
  let lastPoly = [];
  function resize() {
    cssW = window.innerWidth; cssH = window.innerHeight;
    cv.width = cssW; cv.height = cssH;
    fogCv.width = cssW; fogCv.height = cssH;
    ZOOM = (cssH * 0.78) / (VISION_R * 2);
  }
  window.addEventListener("resize", resize);

  /* ---- 状态 ---- */
  const grid = buildGrid(MAP_DATA);
  let player, bot, brain, ripples, tracers, flashes, cam, shake;
  let started = false, over = false, lastT = 0, animId = 0;
  const keys = {};
  let mouseX = 0, mouseY = 0, firing = false, fireEdge = false;

  function pickSpawn(awayFrom) {
    let best = MAP_DATA.spawns[0], bd = -1;
    for (const [sx, sy] of MAP_DATA.spawns) {
      const x = (sx + 0.5) * CELL, y = (sy + 0.5) * CELL;
      let d = Infinity;
      for (const e of awayFrom) if (e.alive) d = Math.min(d, Math.hypot(e.x - x, e.y - y));
      if (awayFrom.every((e) => !e.alive)) d = Math.random();
      if (d > bd) { bd = d; best = [sx, sy]; }
    }
    return [(best[0] + 0.5) * CELL, (best[1] + 0.5) * CELL];
  }

  function spawnFighter(f) {
    const other = f === player ? bot : player;
    const [sx, sy] = pickSpawn([other]);
    f.x = sx; f.y = sy;
    f.hp = 100; f.alive = true; f.protectT = PROTECT_MS;
    f.mags = [WEAPONS[0].mag, WEAPONS[1].mag];
    f.reloadEnd = 0; f.nextFire = 0; f.bloom = 0;
  }

  function reset() {
    player = makeFighter({ name: "你", x: 0, y: 0 });
    bot = makeFighter({ name: "BOT", isBot: true });
    brain = new BotBrain(grid, bot);
    spawnFighter(player); spawnFighter(bot);
    ripples = []; tracers = []; flashes = [];
    cam = { x: player.x, y: player.y, shake: 0 };
    over = false;
    hud.feed.innerHTML = "";
    updateHUD();
    // 注意:此处不隐藏开场面板——它应等待玩家点击「开始行动」
    hud.respawnTxt.classList.add("hidden");
  }

  /* ---- 输入 ---- */
  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if (["arrowup","arrowdown","arrowleft","arrowright"].includes(e.key.toLowerCase()))
      e.preventDefault();
    if (!started || over) return;
    if (e.key === "r" || e.key === "R") tryReload(player);
    if (e.key === "1") switchWeapon(player, 0);
    if (e.key === "2") switchWeapon(player, 1);
    if (e.key === "3") switchWeapon(player, 2);
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
  cv.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; });
  cv.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      firing = true; fireEdge = true;
      if (player.protectT > 0) player.protectT = 0;   // 开枪解除保护
    }
  });
  window.addEventListener("mouseup", () => { firing = false; });
  hud.startBtn.onclick = () => {
    started = true;
    hideOverlay();
    reset();
  };

  /* 调试钩子:供无头冒烟测试读取内部状态 */
  Object.defineProperty(global, "__CQB_DEBUG", {
    get() {
      return {
        get started() { return started; },
        get player() { return player; },
        get bot() { return bot; },
        get tracers() { return tracers; },
        get cam() { return cam; },
        get zoom() { return ZOOM; },
        get lastPoly() { return lastPoly; },
        get ripples() { return ripples; },
        keys,
      };
    },
    configurable: true,
  });

  /* ---- 战斗流程 ---- */
  function addFeed(text) {
    const div = document.createElement("div");
    div.textContent = text;
    hud.feed.prepend(div);
    setTimeout(() => div.remove(), 4000);
    while (hud.feed.children.length > 4) hud.feed.lastChild.remove();
  }

  function applyDamage(attacker, victim, dmg) {
    if (!victim.alive || victim.protectT > 0) return;
    victim.hp -= dmg;
    if (victim === player) {
      hud.vignette.style.opacity = "0.85";
      setTimeout(() => (hud.vignette.style.opacity = "0"), 120);
      cam.shake = Math.max(cam.shake, 5);
      EVENTS.push({ t: "hurt" });
    }
    if (victim.hp <= 0) {
      victim.hp = 0; victim.alive = false;
      victim.deaths++; attacker.kills++;
      EVENTS.push({ t: "death", who: victim.name });
      attacker.name === "你"
        ? addFeed("你 ⚔ BOT")
        : addFeed("BOT ⚔ 你");
      victim.deadUntil = performance.now() + RESPAWN_MS;
      if (victim === player) showRespawn();
      if (player.kills >= KILL_TARGET) win();
    }
  }

  function showRespawn() {
    hud.respawnTxt.textContent = "重生中…";
    hud.respawnTxt.classList.remove("hidden");
  }

  function hideOverlay() {
    hud.center.classList.add("hidden");
  }

  function win() {
    over = true;
    EVENTS.push({ t: "win" });
    hud.ovTitle.textContent = "🏆 行动完成";
    hud.ovText.innerHTML = `击杀 ${player.kills} · 死亡 ${player.deaths}<br>BOT 已被压制。`;
    const btn = hud.startBtn.cloneNode(true);
    btn.textContent = "再来一局";
    hud.center.querySelector("button").replaceWith(btn);
    btn.onclick = () => { started = true; hud.center.classList.add("hidden"); reset(); };
    hud.center.classList.remove("hidden");
  }

  function tryReload(f) {
    const w = WEAPONS[f.weapon];
    if (w.melee || f.reloadEnd > performance.now()) return;
    if (f.mags[f.weapon] >= w.mag) return;
    f.reloadEnd = performance.now() + w.reloadMs;
    EVENTS.push({ t: "reload" });
  }

  function switchWeapon(f, idx) {
    if (idx === f.weapon) return;
    f.weapon = idx; f.reloadEnd = 0; f.nextFire = performance.now() + 250;
    f.bloom = 0;
  }

  function finishReloadIfDue(f, now) {
    const w = WEAPONS[f.weapon];
    if (!w.melee && f.reloadEnd && now >= f.reloadEnd) {
      f.mags[f.weapon] = w.mag; f.reloadEnd = 0;
    }
  }

  function emitNoise(f) {
    ripples.push({ x: f.x, y: f.y, born: performance.now(), who: f });
    if (f === bot) return;                       // bot 的听觉由主循环处理玩家噪波
    // 玩家噪波 → bot 听觉
    if (brain && bot.alive &&
        Math.hypot(bot.x - f.x, bot.y - f.y) <= NOISE_RADIUS + CELL * 0.5) {
      brain.hear(f.x, f.y);
    }
  }

  function doFire(f, ang, now) {
    const w = WEAPONS[f.weapon];
    if (w.melee) {
      // 近战扇形判定
      const target = f === player ? bot : player;
      if (target.alive) {
        const d = Math.hypot(target.x - f.x, target.y - f.y);
        if (d <= w.range + target.r) {
          const ta = Math.atan2(target.y - f.y, target.x - f.x);
          if (Math.abs(normAngle(ta - ang)) <= w.arc) {
            // 背刺:攻击方向与目标面朝方向同向(从背后接近)
            const facingDot = Math.cos(target.facing - ta);
            const dmg = facingDot > 0.5 ? w.backstabDmg : w.dmg;
            applyDamage(f, target, dmg);
          }
        }
      }
      tracers.push({ x1: f.x, y1: f.y, x2: f.x + Math.cos(ang) * w.range,
                     y2: f.y + Math.sin(ang) * w.range, t: now, melee: true });
      EVENTS.push({ t: "knife" });
      return;
    }
    if (f.mags[f.weapon] <= 0 || f.reloadEnd > now) return;
    if (!f.isBot) f.mags[f.weapon]--;   // BOT 弹药无限
    const spread = w.spreadBase + f.bloom;
    const a = ang + (Math.random() - 0.5) * 2 * spread;
    f.bloom = Math.min(w.bloomMax, f.bloom + w.bloomAdd);
    const targets = f === player ? [bot] : [player];
    const res = resolveShotGeometry(grid, f.x, f.y, a, targets, 40 * CELL);
    tracers.push({ x1: f.x + Math.cos(ang) * 18, y1: f.y + Math.sin(ang) * 18,
                   x2: res.endX, y2: res.endY, t: now });
    flashes.push({ x: f.x + Math.cos(ang) * 20, y: f.y + Math.sin(ang) * 20, t: now });
    EVENTS.push({ t: "shot", w: w.key });
    if (res.target) applyDamage(f, res.target, w.dmg);
  }

  /* ---- 主更新 ---- */
  function update(now, dt) {
    // —— 玩家 —— //
    if (player.alive && started && !over) {
      let mx = 0, my = 0;
      if (keys["w"]) my -= 1;
      if (keys["s"]) my += 1;
      if (keys["a"]) mx -= 1;
      if (keys["d"]) mx += 1;
      const shift = keys["shift"];
      const sp = shift ? SHIFT_SPEED : SPEED;
      const len = Math.hypot(mx, my);
      player.movingFast = len > 0 && !shift;
      if (len > 0) {
        moveCircle(grid, player, (mx / len) * sp * dt, (my / len) * sp * dt);
        player.noiseT -= dt * 1000;
        if (player.noiseT <= 0) {
          player.noiseT = NOISE_INTERVAL;
          if (player.movingFast) emitNoise(player);
        }
      }
      // 瞄准(鼠标 → 世界)
      const wx = cam.x - cssW / (2 * ZOOM) + mouseX / ZOOM;
      const wy = cam.y - cssH / (2 * ZOOM) + mouseY / ZOOM;
      player.facing = Math.atan2(wy - player.y, wx - player.x);
      finishReloadIfDue(player, now);
      if (player.protectT > 0) player.protectT -= dt * 1000;
      // 开火
      const w = WEAPONS[player.weapon];
      const wantFire = w.auto ? firing : fireEdge;
      if (wantFire && now >= player.nextFire && player.reloadEnd <= now) {
        if (player.mags[player.weapon] > 0 || w.melee) {
          player.nextFire = w.melee ? now + w.cdMs : now + 60000 / w.rpm;
          doFire(player, player.facing, now);
          if (firing && !w.auto) firing = false;
          fireEdge = false;
        }
      } else fireEdge = false;
    } else { fireEdge = false; }
    if (!player.alive && started && !over) {
      if (performance.now() >= player.deadUntil) {
        spawnFighter(player);
        hud.respawnTxt.classList.add("hidden");
      } else {
        const left = Math.ceil((player.deadUntil - performance.now()) / 1000);
        hud.respawnTxt.textContent = `重生中 ${left}s`;
      }
    }

    // —— BOT —— //
    if (bot.alive && started && !over) {
      if (bot.protectT > 0) bot.protectT -= dt * 1000;
      finishReloadIfDue(bot, now);
      bot.noiseT -= dt * 1000;
      brain.update(dt, now, player, (b, ang) => doFire(b, ang, now));
    } else if (!bot.alive && started && !over) {
      if (performance.now() >= bot.deadUntil) spawnFighter(bot);
    }

    // 特效衰减
    const cut = now - 90;
    tracers = tracers.filter((t) => t.t > cut);
    flashes = flashes.filter((f) => f.t > cut - 60);
    ripples = ripples.filter((r) => now - r.born < 650);
    player.bloom = Math.max(0, player.bloom - dt * 0.09);
    cam.shake *= Math.pow(0.001, dt);

    // 相机跟随:角色恒居屏幕正中(刚性跟随,地图边缘之外以黑暗呈现)
    cam.x = player.x;
    cam.y = player.y;
    updateHUD();
  }

  function updateHUD() {
    hud.kills.textContent = player ? player.kills : 0;
    hud.deaths.textContent = player ? player.deaths : 0;
    if (!player) return;
    const w = WEAPONS[player.weapon];
    hud.wname.textContent = w.name;
    hud.mag.textContent = w.melee ? "—" : player.mags[player.weapon];
    const rt = player.reloadEnd - performance.now();
    hud.reloadFill.style.width =
      rt > 0 ? Math.min(100, (1 - rt / w.reloadMs) * 100) + "%" : "0%";
    hud.hpfill.style.width = player.hp + "%";
    hud.hpfill.style.background = player.hp > 50 ? "#5AD07A" :
                                  player.hp > 25 ? "#FFC24B" : "#FF6B6B";
    hud.hptext.textContent = `${player.hp} / 100`;
  }

  /* ============================ 渲染 ============================ */
  const COLORS = {
    floor: "#1B2233", floorLine: "rgba(124,160,255,.05)",
    wall: "#39415A", wallEdge: "#4A5578",
    crate: "#55607A", crateEdge: "#7A86A8",
    door: "rgba(255,194,75,.28)",
    tracer: "rgba(255,220,150,.9)",
    meleec: "rgba(180,200,255,.5)",
    ripple: "rgba(124,92,255,.35)",
    self: "#E8ECF5", bot: "#FF7B7B",
  };

  function worldTransform(c2) {
    c2.setTransform(ZOOM, 0, 0, ZOOM,
      cssW / 2 - cam.x * ZOOM + shakeOX, cssH / 2 - cam.y * ZOOM + shakeOY);
  }
  let shakeOX = 0, shakeOY = 0;

  function drawWorldTiles(view) {
    const { x0, y0, x1, y1 } = view;
    const i0 = Math.max(0, Math.floor(x0 / CELL)), i1 = Math.min(MAP_DATA.w - 1, Math.ceil(x1 / CELL));
    const j0 = Math.max(0, Math.floor(y0 / CELL)), j1 = Math.min(MAP_DATA.h - 1, Math.ceil(y1 / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i * CELL, py = j * CELL;
        if (grid[j][i] === 1) {
          const isCrate = MAP_DATA.crates.some(([cx, cy]) => cx === i && cy === j);
          ctx.fillStyle = isCrate ? COLORS.crate : COLORS.wall;
          ctx.fillRect(px, py, CELL, CELL);
          ctx.strokeStyle = isCrate ? COLORS.crateEdge : COLORS.wallEdge;
          ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
        } else {
          ctx.fillStyle = COLORS.floor;
          ctx.fillRect(px, py, CELL, CELL);
          if (MAP_DATA.doors.some(([dx, dy]) => dx === i && dy === j)) {
            ctx.fillStyle = COLORS.door;
            ctx.fillRect(px, py, CELL, CELL);
          }
        }
      }
    }
  }

  function drawFighter(f, now) {
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.facing);
    if (f.protectT > 0 && Math.floor(now / 120) % 2 === 0) ctx.globalAlpha = 0.45;
    // 身体
    ctx.fillStyle = f.isBot ? COLORS.bot : COLORS.self;
    ctx.beginPath(); ctx.arc(0, 0, f.r, 0, Math.PI * 2); ctx.fill();
    // 持枪手臂 + 枪
    const w = WEAPONS[f.weapon];
    ctx.strokeStyle = "#12151E"; ctx.lineWidth = 5; ctx.lineCap = "round";
    if (w.melee) {
      ctx.beginPath(); ctx.moveTo(4, 6); ctx.lineTo(f.r + 12, 2); ctx.stroke();
    } else {
      const gl = w.key === "rifle" ? 26 : 17;
      ctx.beginPath(); ctx.moveTo(2, 7); ctx.lineTo(gl, 3); ctx.stroke();
    }
    // 朝向指示
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, f.r + 4, -0.42, 0.42); ctx.stroke();
    ctx.restore();
  }

  function render(now) {
    shakeOX = (Math.random() - 0.5) * cam.shake * 2;
    shakeOY = (Math.random() - 0.5) * cam.shake * 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const viewHalfW = cssW / (2 * ZOOM), viewHalfH = cssH / (2 * ZOOM);
    const view = { x0: cam.x - viewHalfW, y0: cam.y - viewHalfH,
                   x1: cam.x + viewHalfW, y1: cam.y + viewHalfH };

    worldTransform(ctx);
    drawWorldTiles(view);

    // 玩家可见多边形
    const poly = player.alive
      ? visibilityPolygon(grid, player.x, player.y, player.facing, VISION_R)
      : [];
    lastPoly = poly;

    // 噪波涟漪(仅可见的绘制)
    for (const r of ripples) {
      const age = (now - r.born) / 650;
      if (age >= 1) continue;
      if (r.who !== player && !entityVisible(poly, player.x, player.y, r.x, r.y)) continue;
      const rr = age * NOISE_RADIUS;
      ctx.strokeStyle = COLORS.ripple;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // BOT(仅可见)
    if (bot.alive && entityVisible(poly, player.x, player.y, bot.x, bot.y)) {
      drawFighter(bot, now);
    }

    // 曳光弹与枪口火光
    for (const t of tracers) {
      const a = Math.max(0, (t.t + 90 - now) / 90);
      ctx.strokeStyle = t.melee ? COLORS.meleec : COLORS.tracer;
      ctx.globalAlpha = a;
      ctx.lineWidth = t.melee ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(t.x1, t.y1); ctx.lineTo(t.x2, t.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const f of flashes) {
      const a = Math.max(0, (f.t + 50 - now) / 50);
      ctx.fillStyle = `rgba(255,210,130,${a * 0.9})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, 6 * a + 2, 0, Math.PI * 2); ctx.fill();
    }

    // 自己
    if (player.alive) drawFighter(player, now);

    // ---------- 迷雾 ----------
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, cssW, cssH);
    fctx.fillStyle = "rgba(4,6,12,.92)";
    fctx.fillRect(0, 0, cssW, cssH);
    fctx.save();
    worldTransform(fctx);
    fctx.globalCompositeOperation = "destination-out";
    fctx.filter = "blur(7px)";
    fctx.fillStyle = "rgba(255,255,255,1)";
    if (poly.length) {
      fctx.beginPath();
      fctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) fctx.lineTo(poly[i][0], poly[i][1]);
      fctx.closePath(); fctx.fill(); fctx.fill();
    }
    fctx.beginPath();
    fctx.arc(player.x, player.y, NEAR_R, 0, Math.PI * 2);
    fctx.fill(); fctx.fill();
    fctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fogCv, 0, 0);

    // ---------- 准星 ----------
    if (started && !over && player.alive) {
      const gap = 6 + player.bloom * 260;
      ctx.strokeStyle = "rgba(232,236,245,.95)";
      ctx.lineWidth = 1.6;
      for (const [ax, ay] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        ctx.beginPath();
        ctx.moveTo(mouseX + ax * gap, mouseY + ay * gap);
        ctx.lineTo(mouseX + ax * (gap + 7), mouseY + ay * (gap + 7));
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(232,236,245,.95)";
      ctx.fillRect(mouseX - 1, mouseY - 1, 2, 2);
    }
  }

  /* ---- 主循环 ---- */
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
    lastT = t;
    if (started && !over) update(performance.now(), dt);
    render(performance.now());
    animId = requestAnimationFrame(frame);
  }

  resize();
  reset();
  lastT = performance.now();
  animId = requestAnimationFrame(frame);
}
global.CQB_BOOT = bootBrowser;
if (!global.CQB_NO_AUTOBOOT &&
    typeof window !== "undefined" && typeof document !== "undefined") {
  bootBrowser();
}
})(typeof window !== "undefined" ? window : globalThis);

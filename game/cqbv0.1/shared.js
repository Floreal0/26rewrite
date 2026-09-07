/* CQB 公共纯逻辑核心(单源)
 * 单机(engine.js)与联机(rules.js)共用的纯函数层——消除两份手写同步(架构治理 2026-09-05)。
 * 以 engine(单机)实现为基准:带半径的扫掠碰撞、DDA 精确射线、墙角投影视野多边形、
 * 射线-圆相交弹道解算——单机手感即未来联机手感。
 *
 * 范围(v2):纯算法层(网格构建 / 射线 / 视野 / 寻路 / 移动碰撞 / 弹道解算 /
 * fighter 工厂 / 玩法模式区域推导)+ 状态层(2026-09-05 二期抽取:doFire / applyDamage /
 * updateFighters / BotBrain / 投掷物 / 交互 / 玩法模式推进 / createState)。
 * 状态层以 rules.js(联机权威)实现为模板:全部函数第一参为 state 对象,
 * 副作用只经 state.* 数组与 state.events 事件通道表达。
 * 约束:不依赖 DOM / 闭包;Node require 与浏览器 global 双端导出(同 maps.js)。
 */
(function (global) {
"use strict";

/* ============================ 共享常量(抽取函数所需) ============================ */
const CELL = 32;                    // 世界单位:每格 32
const VISION_R_TILES = 12;          // 视野半径(格)
const VISION_R = VISION_R_TILES * CELL;
const CONE_HALF = 55 * Math.PI / 180;
const NEAR_R = 2 * CELL;            // 贴身恒可见半径
const PLAYER_R = 13;

const WEAPONS = [
  { key:"rifle",  name:"步枪",   auto:true,  rpm:600, mag:30, dmg:20,
    reloadMs:2000, spreadBase:0.010, bloomAdd:0.014, bloomMax:0.055 },
  { key:"pistol", name:"手枪",   auto:false, rpm:280, mag:12, dmg:34,
    reloadMs:1400, spreadBase:0.004, bloomAdd:0.008, bloomMax:0.028 },
  { key:"knife",  name:"战术刀", melee:true, cdMs:500, dmg:55, backstabDmg:100,
    range:1.3 * CELL, arc: Math.PI/4 },
  { key:"flash",  name:"闪光弹", grenade:true, cdMs:500 },
  { key:"smoke",  name:"烟雾弹", grenade:true, cdMs:500 },
];

const RESERVE = [90, 90];           // 初始备弹(步枪/手枪)
const BOX_FILL = { rifle: 60, pistol: 15 };   // 弹药箱单次补给量(2026-09-05 手枪砍半)
const BOX_RESPAWN_MS = 75000;       // 弹药箱取空后刷新(60s→75s,用户拍板)
/* 箱子第三格投掷物:随机类型,rollNadeType() 在箱子刷新时决定 */
function rollNadeType() { return Math.random() < 0.5 ? "flash" : "smoke"; }

/* ============================ 网格构建 ============================ */
function buildGrid(md) {
  const g = [];
  for (let y = 0; y < md.h; y++) {
    const row = new Array(md.w).fill(1);
    g.push(row);
  }
  if (md.land) {
    /* 矩形组合地块(水域图):可通行 = 点在任一 land 矩形内,矩形外为水(实心) */
    for (const [lx, ly, lw, lh] of md.land)
      for (let j = ly; j < ly + lh; j++)
        for (let i = lx; i < lx + lw; i++) g[j][i] = 0;
  } else {
    for (const [, x, y, w, h] of md.rooms)
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) g[j][i] = 0;
  }
  for (const [x, y] of md.doors) g[y][x] = 0;
  for (const [x, y] of md.crates) g[y][x] = 1;
  for (const [x, y] of (md.half || [])) g[y][x] = 2;
  for (const [x, y] of (md.ammoBoxes || [])) g[y][x] = 2;   // 弹药箱 = 半遮挡
  return g;
}

/* 移动阻挡:全挡(1)与半挡(2)都不可走 */
function solidAt(grid, ix, iy) {
  if (ix < 0 || iy < 0 || iy >= grid.length || ix >= grid[0].length) return true;
  const v = grid[iy][ix];
  return v === 1 || v === 2;
}

/* 视线/弹道遮挡:仅全挡(1)挡,半挡(2)穿透;出图边界视为挡 */
function blocksSight(grid, ix, iy) {
  if (ix < 0 || iy < 0 || iy >= grid.length || ix >= grid[0].length) return true;
  return grid[iy][ix] === 1;
}

/* ============================ 几何:射线 ============================ */
function normAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/* DDA 网格射线:返回命中实心格的距离;带斜角容忍(同时跨横竖线时查三个候选格) */
function dda(grid, ox, oy, ang, maxDist) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let ix = Math.floor(ox / CELL), iy = Math.floor(oy / CELL);
  if (blocksSight(grid, ix, iy)) return 0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(CELL / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((ix + (dx > 0 ? 1 : 0)) * CELL - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((iy + (dy > 0 ? 1 : 0)) * CELL - oy) / dy : Infinity;
  let t = 0;
  const cornerTolerance = 0.1;
  while (t <= maxDist) {
    if (Math.abs(tMaxX - tMaxY) <= cornerTolerance) {
      t = Math.min(tMaxX, tMaxY);
      if (blocksSight(grid, ix + stepX, iy) ||
          blocksSight(grid, ix, iy + stepY) ||
          blocksSight(grid, ix + stepX, iy + stepY)) return t;
      tMaxX += tDeltaX; tMaxY += tDeltaY;
      ix += stepX; iy += stepY;
    } else if (tMaxX < tMaxY) {
      t = tMaxX; tMaxX += tDeltaX; ix += stepX;
    } else {
      t = tMaxY; tMaxY += tDeltaY; iy += stepY;
    }
    if (t > maxDist) break;
    if (blocksSight(grid, ix, iy)) return t;
  }
  return maxDist;
}

function losClear(grid, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d === 0) return !blocksSight(grid, Math.floor(x1 / CELL), Math.floor(y1 / CELL));
  return dda(grid, x1, y1, Math.atan2(dy, dx), d) >= d - 0.001 &&
         !blocksSight(grid, Math.floor(x2 / CELL), Math.floor(y2 / CELL));
}

/* 可见多边形:视野锥 ∩ 半径圆 内对实心格角点投射(墙角投影 + 密集角度扫,消掠射伪影) */
function visibilityPolygon(grid, px, py, facing, R) {
  const a0 = facing - CONE_HALF, a1 = facing + CONE_HALF;
  const angles = [a0, a1];
  const minI = Math.max(0, Math.floor((px - R) / CELL));
  const maxI = Math.min(grid[0].length - 1, Math.floor((px + R) / CELL));
  const minJ = Math.max(0, Math.floor((py - R) / CELL));
  const maxJ = Math.min(grid.length - 1, Math.floor((py + R) / CELL));
  for (let iy = minJ; iy <= maxJ; iy++) {
    for (let ix = minI; ix <= maxI; ix++) {
      if (grid[iy][ix] !== 1) continue;   // 仅全挡参与视野裁剪,半挡不挡视线
      for (const cx of [ix, ix + 1]) {
        for (const cy of [iy, iy + 1]) {
          const wx = cx * CELL, wy = cy * CELL;
          const d = Math.hypot(wx - px, wy - py);
          if (d > R + CELL) continue;
          const da = normAngle(Math.atan2(wy - py, wx - px) - facing);
          if (Math.abs(da) <= CONE_HALF + 0.03) {
            angles.push(facing + da - 0.003, facing + da + 0.003);
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
      dense.push(facing + normAngle((uniq[i] + uniq[i + 1]) / 2 - facing) + 0.0005);
    }
  }
  const pts = [];
  for (const a of dense) {
    const aa = facing + Math.max(-CONE_HALF, Math.min(CONE_HALF, normAngle(a - facing)));
    const d = dda(grid, px, py, aa, R);
    pts.push([px + Math.cos(aa) * d, py + Math.sin(aa) * d]);
  }
  pts.push([px, py]);
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
/* 网格 A*(四方向),返回格子中心世界坐标路径
 * doorSet:门格集——关门时门格实心,但寻路视为可走(Bot 会自动开门) */
function astar(grid, sx, sy, gx, gy, doorSet) {
  const W = grid[0].length, H = grid.length;
  const passable = (x, y) => {
    const v = (x < 0 || y < 0 || y >= H || x >= W) ? 1 : grid[y][x];
    if (v === 0) return true;
    return !!(doorSet && doorSet.has(x + "," + y));   // 关门格可寻路(走过去自动开)
  };
  if (sx < 0 || sy < 0 || sx >= W || sy >= H ||
      gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  if (!passable(sx, sy) || !passable(gx, gy)) return null;
  const sIdx = sy * W + sx, gIdx = gy * W + gx;
  /* 类型化数组替代 Map/Set(2026-09-05 性能:bot 高频寻路是 host 帧尖峰主源)。
   * 缓冲按需分配、跨调用复用(astar 同步不可重入;短途寻路每次分配 ~11KB 是大头) */
  const N = W * H;
  if (!astar._came || astar._came.length < N) {
    astar._came = new Int32Array(N);
    astar._g = new Int32Array(N);
    astar._closed = new Uint8Array(N);
  }
  const came = astar._came, gScore = astar._g, closed = astar._closed;
  came.fill(-1, 0, N); gScore.fill(-1, 0, N); closed.fill(0, 0, N);
  /* 二叉堆开放列表(键 = f, 次键 = -g 更深优先, 再 seq 确定性):
   * 等 f 时优先展开更接近目标者,大幅减少等 f 大平台的展开格数(标准 A* 技巧,
   * 最短路长度不变);O(log n) 取代旧 O(n) 线性扫描 */
  const hf = [], hidx = [], hg = [], hseq = [];
  let hseqN = 0;
  const hLess = (a, b) => hf[a] < hf[b] ||
    (hf[a] === hf[b] && (hg[a] > hg[b] || (hg[a] === hg[b] && hseq[a] < hseq[b])));
  const hpush = (f, idx, g) => {
    let k = hf.length;
    hf.push(f); hidx.push(idx); hg.push(g); hseq.push(hseqN++);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hLess(p, k)) break;
      [hf[p], hf[k]] = [hf[k], hf[p]];
      [hidx[p], hidx[k]] = [hidx[k], hidx[p]];
      [hg[p], hg[k]] = [hg[k], hg[p]];
      [hseq[p], hseq[k]] = [hseq[k], hseq[p]];
      k = p;
    }
  };
  const hpop = () => {
    const top = hidx[0];
    const lf = hf.pop(), li = hidx.pop(), lg = hg.pop(), ls = hseq.pop();
    if (hf.length) {
      hf[0] = lf; hidx[0] = li; hg[0] = lg; hseq[0] = ls;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < hf.length && hLess(l, m)) m = l;
        if (r < hf.length && hLess(r, m)) m = r;
        if (m === k) break;
        [hf[m], hf[k]] = [hf[k], hf[m]];
        [hidx[m], hidx[k]] = [hidx[k], hidx[m]];
        [hg[m], hg[k]] = [hg[k], hg[m]];
        [hseq[m], hseq[k]] = [hseq[k], hseq[m]];
        k = m;
      }
    }
    return top;
  };
  gScore[sIdx] = 0;
  hpush(Math.abs(sx - gx) + Math.abs(sy - gy), sIdx, 0);
  while (hf.length) {
    const cur = hpop();
    if (cur === gIdx) {
      const path = [];
      let n = gIdx;
      while (n !== -1) {
        path.push([(n % W) * CELL + CELL / 2, ((n / W) | 0) * CELL + CELL / 2]);
        n = came[n];
      }
      path.reverse();
      return path;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W, cy = (cur / W) | 0;
    const cg = gScore[cur];
    for (const [ddx, ddy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx2 = cx + ddx, ny2 = cy + ddy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
      if (!passable(nx2, ny2)) continue;
      const ni = ny2 * W + nx2;
      if (closed[ni]) continue;
      const ng = cg + 1;
      if (gScore[ni] === -1 || ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        hpush(ng + Math.abs(nx2 - gx) + Math.abs(ny2 - gy), ni, ng);
      }
    }
  }
  return null;
}

/* ============================ 移动碰撞 ============================ */
/* 圆与格 (ix,iy) 是否相交(格上最近点距离 < r)——关门检查与嵌墙自愈共用 */
function circleHitsCell(x, y, r, ix, iy) {
  const cx = Math.max(ix * CELL, Math.min(x, ix * CELL + CELL));
  const cy = Math.max(iy * CELL, Math.min(y, iy * CELL + CELL));
  return Math.hypot(x - cx, y - cy) < r;
}
/* 圆体分轴滑动:沿移动方向扫描跨越的列/行,撞到第一个实心即钳制(带半径,身体不嵌墙) */
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
/* 射击几何解算(纯函数):射线-圆相交取最近,墙面遮挡经 dda 判定 */
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
    endX: sx + dx * end, endY: sy + dy * end, wallD, target: best ? best.target : null, t: end,
  };
}

/* ============================ Fighter 工厂 ============================ */
function makeFighter(o) {
  return Object.assign({
    x: 0, y: 0, r: PLAYER_R, facing: 0,
    hp: 100, alive: true, protectT: 0, deadUntil: 0,
    weapon: 0, mags: [WEAPONS[0].mag, WEAPONS[1].mag],
    reserve: [RESERVE[0], RESERVE[1]],
    nades: { flash: 2, smoke: 2 },              // 投掷物(初始 2/上限 NADE_CAP,respawn 不重置)
    blindUntil: 0,
    alertUntil: 0,                              // 受击/闻声警觉窗口
    reloadEnd: 0, nextFire: 0, bloom: 0,
    kills: 0, deaths: 0, isBot: false, name: "?",
    team: 0,                                    // 默认队伍(engine/rules 语义一致)
    id: "?",                                    // 联机 host 端必须赋值;单机不消费
    noiseT: 0, movingFast: false,
  }, o);
}

/* ============================ 玩法模式:区域推导(纯函数) ============================ */
/* 全部确定性:同地图数据两份调用推导一致(行优先扫描、严格比较保首个)。
 * 合格点 = 可站立格(非实心/非半挡/非门格);返回格坐标。 */
function deriveStandableCells(grid, doorSet) {
  const W = grid[0].length, H = grid.length, out = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (grid[y][x] === 0 && !(doorSet && doorSet.has(x + "," + y))) out.push([x, y]);
  return out;
}

/* argmax(到 ref 点集的最小距离)——最远点采样核心 */
function _farthestCell(cells, ref) {
  let best = null, bestD = -1;
  for (const c of cells) {
    let m = Infinity;
    for (const r of ref) {
      const dx = c[0] - r[0], dy = c[1] - r[1], d = dx * dx + dy * dy;
      if (d < m) m = d;
    }
    if (m > bestD) { bestD = m; best = c; }
  }
  return best;
}

/* 占点:A/B/C = 合格点上做最远点采样(两两 ≥12 格、离任一出生点 ≥4 格,无解时放宽) */
function derivePointZones(md, grid, doorSet) {
  const cells = deriveStandableCells(grid, doorSet);
  const spawns = md.spawns.map(([x, y]) => [x, y]);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const pool = cells.filter((c) =>
      spawns.every((s) => (c[0] - s[0]) ** 2 + (c[1] - s[1]) ** 2 >= 16) &&
      out.every((r) => (c[0] - r[0]) ** 2 + (c[1] - r[1]) ** 2 >= 144));
    const c = _farthestCell(pool.length ? pool : cells, spawns.concat(out));
    out.push(c);
  }
  return out;
}

/* 解救:攻/防固定出生点 = 出生点池中相距最远的一对(行优先扫描、严格 > 保首个,两 core 一致);
 * H 人质区 = 距防守方出生 2~6 格的最近可站格;E 撤离区 = 距 H 最远的可站格(不锚定攻方出生)。
 * 返回 [h, e, att, def],att/def 为 md.spawns 原始元组(可能含朝向)。 */
function deriveRescueZones(md, grid, doorSet) {
  const cells = deriveStandableCells(grid, doorSet);
  const spawns = md.spawns;
  let att = spawns[0], def = spawns[1 % spawns.length], best = -1;
  for (let i = 0; i < spawns.length; i++)
    for (let j = i + 1; j < spawns.length; j++) {
      const d = (spawns[i][0] - spawns[j][0]) ** 2 + (spawns[i][1] - spawns[j][1]) ** 2;
      if (d > best) { best = d; att = spawns[i]; def = spawns[j]; }
    }
  const nearH = (lo, hi) => {
    let bestC = null, bestD = Infinity;
    for (const c of cells) {
      const d = Math.hypot(c[0] - def[0], c[1] - def[1]);
      if (d >= lo && d <= hi && d < bestD) { bestD = d; bestC = c; }
    }
    return bestC;
  };
  const h = nearH(2, 6) || nearH(2, Infinity) || _farthestCell(cells, [att]);
  const e = _farthestCell(cells, [h]);
  return [h, e, att, def];
}

/* 世界坐标 → 最近可站格(人质掉落点夹取用) */
function nearestStandableCell(grid, doorSet, wx, wy) {
  const W = grid[0].length, H = grid.length;
  const ix = Math.max(0, Math.min(W - 1, Math.floor(wx / CELL)));
  const iy = Math.max(0, Math.min(H - 1, Math.floor(wy / CELL)));
  if (grid[iy][ix] === 0 && !(doorSet && doorSet.has(ix + "," + iy))) return [ix, iy];
  for (let r = 1; r < 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x2 = ix + dx, y2 = iy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
        if (grid[y2][x2] === 0 && !(doorSet && doorSet.has(x2 + "," + y2))) return [x2, y2];
      }
  return [ix, iy];
}

/* ============================ 状态层常量(2026-09-05 二期单源) ============================ */
const SPEED = 4.5 * CELL;           // 正常移速
const SHIFT_SPEED = 2.2 * CELL;     // 静步速度
const NOISE_INTERVAL = 400;         // 噪波间隔 ms
const NOISE_RADIUS = 4 * CELL;      // 涟漪最大半径(穿墙)
const RESPAWN_MS = 6000;
const PROTECT_MS = 2000;
const KILL_TARGET = 15;
/* 枪声噪音半径(2026-08-29 用户拍板):步枪 24 格/手枪 16 格,刀无声 */
const SHOT_NOISE_R = [24 * CELL, 16 * CELL];
/* 投掷物(2026-08-31 用户拍板):定距抛掷+滑行,各 1 颗/条命且 respawn 不重置;
 * Bot 只受影响不使用。烟只挡视线(视线层叠格 sightGrid),不挡子弹/移动 */
const NADE_THROW_DIST = 6 * CELL;      // 总里程(定距)
const NADE_V0 = 480;                   // 初速 px/s(里程 = v0 / 摩擦系数 = 192px = 6 格)
const NADE_FRICTION = 2.5;             // 指数摩擦(每秒速度衰减率)
const NADE_STOP_SPEED = 40;            // 低于此速度视为停止
const NADE_FUSE = 1000;                // 抛出后起爆 ms
const FLASH_R = 6 * CELL;              // 闪光有效半径(需视线可达)
const FLASH_BLIND_FULL = 2500;         // 面向炸点全致盲
const FLASH_BLIND_BACK = 800;          // 背对炸点减半
const FLASH_FADE = 500;                // 渐隐窗口
const FLASH_NOISE_R = 8 * CELL;        // 起爆声波半径
const SMOKE_R = 3 * CELL;              // 烟雾半径
const SMOKE_DUR = 8000;                // 持续
const SMOKE_FADE = 1000;               // 消散(视觉渐隐,视线持续到移除)
const SMOKE_NOISE_R = 6 * CELL;        // 起爆声波半径
const NADE_CAP = 5;                    // 投掷物备弹上限
const BOT_DODGE_DELAY = 200;           // Bot 看见飞行闪光弹后背身延迟(ms)
const HIT_TURN_DELAY = 200;            // Bot 受击后转向伤害来源延迟(ms)
const ALERT_MS = 3000;                 // 受击/闻声警觉窗口(转入交战免除反应延迟)
const BOT_SEARCH_MS = 2500;            // Bot 丢失目标后原地环顾时长(防秒失忆)
const BOT_HUNT_TIMEOUT = 8000;         // hunt 朝 lastSeen 无实质进展的放弃时限(防永久傻站)
/* 玩法模式(2026-09-05 用户拍板):解救/占点,⚙ 全部可调 */
const RESCUE_TIME_MS = 240000;         // 解救时限(守到即防守方胜)
const RESCUE_CHANNEL_MS = 3000;        // 营救引导时长(2 人站桩减半)
const EXTRACT_CHANNEL_MS = 2000;       // 撤离引导时长
const POINT_TIME_MS = 300000;          // 占点时限(比分高者胜,平分平局)
const CAPTURE_MS = 4000;               // 单人占点时长(2 人减半)
const POINT_TICK_MS = 2000;            // 每据点计分间隔(+1 分)
const POINT_SCORE_TARGET = 100;        // 占点目标分
const ZONE_R = 2.5 * CELL;             // 目标区半径
const BOT_NADE_CD = 4500;              // Bot 投掷全局冷却(ms)
const BOT_FLASH_INFO_AGE = 2000;       // lastSeen 新鲜度:超过不丢闪(情报过期)
const BOT_FLASH_MIN_DIST = 4 * CELL;   // 丢闪最小距离(贴脸自闪无意义)
const BOT_SMOKE_HP = 35;               // 低血量拉烟阈值
const BOT_SMOKE_MAX_DIST = 10 * CELL;  // 拉烟最大交战距离
const BOT_SMOKE_MIN_DIST = 3 * CELL;   // 拉烟最小距离(贴脸无意义)
const BOT_RETREAT_MS = 1500;           // 拉烟后背向撤离时长
const BOT_COMBAT_MOVE_MS = 900;        // 单次战斗走位(strafe/换位)时长上限
const BOT_REPOSITION_MS = 2400;        // ⚙ 交战中主动换位平均间隔(±30% 抖动)
const BOT_MISSION_HEAR_R = 8 * CELL;   // ⚙ Bot 任务中免疫远端情报的半径(玩法模式,见 DESIGN「架构与双核治理」)
/* 备用弹药:初始统一 90,上限统一 240(弹药箱为争夺资源,见 DESIGN.md) */
const RESERVE_CAP = [240, 240];
/* 门与弹药箱(2026-08-29 用户拍板) */
const DOOR_INTERACT_R = 1.5 * CELL;    // F 交互距离(门)
const BOX_INTERACT_R = 1.3 * CELL;     // F 交互距离(弹药箱)
const DOOR_NOISE_R = 3 * CELL;         // 开/关门噪音涟漪半径
const DOOR_AUTO_OPEN_R = 1.2 * CELL;   // Bot 贴近自动开门
/* 团队胜利阈值:全队击杀合计先达标者胜(2026-08-28 用户拍板) */
const TEAM_KILL_TARGET = { "1v1": 15, "2v2": 20, "3v3": 25 };

const BOT_CFG = {
  reaction: 320,        // 首次看见到开枪的延迟 ms
  aimError: 0.085,      // 基础瞄准误差(弧度)
  burstMs: 420,         // 连射时长
  pauseMs: 380,         // 连射间歇
};

/* ============================ 战斗:伤害 / 开火 / 换弹 ============================ */
function applyDamage(state, attacker, victim, dmg) {
  if (!victim.alive || victim.protectT > 0) return false;
  victim.hp -= dmg;
  if (victim.isBot && victim.alive) {
    /* 受击感知:0.2s 后转向伤害来源并警觉(背后中枪不再无反应) */
    const brain = state.brainById[victim.id];
    if (brain) brain.onHit(attacker.x, attacker.y, state.now);
  }
  if (victim.hp <= 0) {
    victim.hp = 0; victim.alive = false;
    victim.deaths++;
    attacker.kills++;
    victim.deadUntil = state.now + RESPAWN_MS;
    /* 阵亡通报:同队存活 Bot 前往阵亡位置查看(全图范围) */
    for (const t of state.fighters) {
      if (t === victim || !t.alive || t.team !== victim.team) continue;
      const brain = state.brainById[t.id];
      if (brain) brain.hear(victim.x, victim.y, state.now);
    }
    state.events.push({ t: "death", who: victim.name, killer: attacker.name });
    checkTeamWin(state);
    return true;
  }
  state.events.push({ t: "hurt", who: victim.name, by: attacker.name });
  return false;
}
function doFire(state, f, ang, now, targets) {
  const w = WEAPONS[f.weapon];
  if (w.melee) {
    if (now < f.nextFire) return null;
    f.nextFire = now + w.cdMs;
    for (const t of targets) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - f.x, t.y - f.y);
      if (d > w.range + t.r) continue;
      const ta = Math.atan2(t.y - f.y, t.x - f.x);
      if (Math.abs(normAngle(ta - ang)) > w.arc) continue;
      const facingDot = Math.cos(t.facing - ta);
      const dmg = facingDot > 0.5 ? w.backstabDmg : w.dmg;
      applyDamage(state, f, t, dmg);
    }
    state.tracers.push({ x1: f.x, y1: f.y,
      x2: f.x + Math.cos(ang) * w.range, y2: f.y + Math.sin(ang) * w.range,
      t: now, melee: true });
    state.flashes.push({ x: f.x + Math.cos(ang) * 18, y: f.y + Math.sin(ang) * 18, t: now });
    state.events.push({ t: "knife", by: f.name });
    return { kind: "knife" };
  }
    if (w.grenade) {
      /* 投掷物:定距抛掷+滑行,引信起爆;不进弹匣/备弹体系 */
      if (now < f.nextFire) return null;
      if ((f.nades[w.key] || 0) <= 0) return null;
      f.nextFire = now + w.cdMs;
      f.nades[w.key] = (f.nades[w.key] || 0) - 1;
      state.grenades.push({
        x: f.x + Math.cos(ang) * PLAYER_R, y: f.y + Math.sin(ang) * PLAYER_R,
        vx: Math.cos(ang) * NADE_V0, vy: Math.sin(ang) * NADE_V0,
        type: w.key, born: now, thrower: f.id, team: f.team,
      });
      state.events.push({ t: "nade", w: w.key, by: f.name, x: f.x, y: f.y });
      return { kind: "nade" };
    }
  if (f.mags[f.weapon] <= 0 || f.reloadEnd > now) return null;
  if (!f.isBot) f.mags[f.weapon]--;
  const spread = w.spreadBase + f.bloom;
  const a = ang + (Math.random() - 0.5) * 2 * spread;
  f.bloom = Math.min(w.bloomMax, f.bloom + w.bloomAdd);
  const res = resolveShotGeometry(state.grid, f.x, f.y, a, targets, 40 * CELL);
  state.tracers.push({ x1: f.x + Math.cos(ang) * 18, y1: f.y + Math.sin(ang) * 18,
                       x2: res.endX, y2: res.endY, t: now });
  state.flashes.push({ x: f.x + Math.cos(ang) * 20, y: f.y + Math.sin(ang) * 20, t: now });
  state.events.push({ t: "shot", w: w.key, by: f.name, x: f.x, y: f.y });
  emitNoise(state, f, now, SHOT_NOISE_R[f.weapon] || NOISE_RADIUS);   // 枪声涟漪(惊动敌队 Bot + 客户端声波指示器)
  if (res.target) applyDamage(state, f, res.target, w.dmg);
  return { kind: "shot", weapon: w.key, hit: !!res.target };
}
function tryReload(state, f, now) {
  const w = WEAPONS[f.weapon];
  if (w.melee || w.grenade || f.reloadEnd > now) return false;
  if (f.mags[f.weapon] >= w.mag) return false;        // 弹匣已满
  if (f.isBot) {
    /* Bot 弹药无限,装满 */
    f.reloadEnd = now + w.reloadMs;
    state.events.push({ t: "reload", by: f.name });
    return true;
  }
  if ((f.reserve[f.weapon] || 0) <= 0) return false;  // 备弹池空
  f.reloadEnd = now + w.reloadMs;
  state.events.push({ t: "reload", by: f.name });
  return true;
}
function switchWeapon(f, idx, now) {
  if (idx === f.weapon || idx < 0 || idx >= WEAPONS.length) return false;
  f.weapon = idx;
  f.reloadEnd = 0;
  f.nextFire = Math.max(f.nextFire, now + 250);
  f.bloom = 0;
  return true;
}
function finishReloadIfDue(f, now) {
  const w = WEAPONS[f.weapon];
  if (!w.melee && f.reloadEnd && now >= f.reloadEnd) {
    /* 装弹:从 reserve 池扣,装多少算多少(备弹不足时装不满) */
    if (f.isBot) {
      f.mags[f.weapon] = w.mag;
    } else {
      const need = w.mag - f.mags[f.weapon];
      const avail = Math.min(need, f.reserve[f.weapon] || 0);
      f.mags[f.weapon] += avail;
      f.reserve[f.weapon] = (f.reserve[f.weapon] || 0) - avail;
    }
    f.reloadEnd = 0;
  }
}

/* TDM 团队胜负(2026-09-05 二期补齐:此前 rules 侧缺失,联机击杀达标不结算)。
 * 目标模式(state.obj)不适用——胜负由 updateObj 判定 */
function checkTeamWin(state) {
  if (state.obj || state.matchOver) return;
  const target = (state.teamTarget != null) ? state.teamTarget : KILL_TARGET;
  const kills = (team) =>
    state.fighters.reduce((s, f) => s + (f.team === team ? f.kills : 0), 0);
  let winner = -2;
  if (kills(0) >= target) winner = 0;
  else if (kills(1) >= target) winner = 1;
  if (winner === -2) return;
  state.matchOver = true;
  const k = [kills(0), kills(1)];
  state.events.push({ t: "matchover", winner, kind: "tdm", score: k,
    text: `比分 ${k[0]} : ${k[1]}。` });
}

/* ============================ 投掷物:飞行 / 起爆 / 烟雾 / 闪光 ============================ */
/* 视线层叠格 = 基础 grid + 活跃烟雾覆盖格;原地重写(BotBrain 持有引用不能换数组)。
 * 烟只挡视线:移动/寻路/子弹仍用基础 grid */
function rebuildSightGrid(state) {
  const sg = state.sightGrid;
  for (let j = 0; j < state.grid.length; j++) {
    for (let i = 0; i < state.grid[0].length; i++) sg[j][i] = state.grid[j][i];
  }
  for (const s of state.smokes) {
    const cx = s.x / CELL, cy = s.y / CELL, rr = s.r / CELL;
    const i0 = Math.max(0, Math.floor(cx - rr)), i1 = Math.min(sg[0].length - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cy - rr)), j1 = Math.min(sg.length - 1, Math.ceil(cy + rr));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        if (Math.hypot(i + 0.5 - cx, j + 0.5 - cy) <= rr) sg[j][i] = 1;
  }
}
function explosionNoise(state, x, y, now, radius, thrower) {
  state.ripples.push({ x, y, born: now, who: thrower ? thrower.id : "?", r: radius });
  for (const o of state.fighters) {
    if (!o.alive || !o.isBot) continue;
    if (thrower && o.team === thrower.team) continue;
    const brain = state.brainById[o.id];
    if (brain && Math.hypot(o.x - x, o.y - y) <= radius + CELL * 0.5) brain.hear(x, y, now);
  }
}
function explodeNade(state, g, now) {
  const thrower = state.fighters.find((f) => f.id === g.thrower) || null;
  if (g.type === "smoke") {
    state.smokes.push({ x: g.x, y: g.y, born: now, r: SMOKE_R });
    rebuildSightGrid(state);
    explosionNoise(state, g.x, g.y, now, SMOKE_NOISE_R, thrower);
    state.events.push({ t: "smoke", x: g.x, y: g.y, by: thrower ? thrower.name : "?" });
    } else {
    explosionNoise(state, g.x, g.y, now, FLASH_NOISE_R, thrower);
    state.events.push({ t: "flash", x: g.x, y: g.y, by: thrower ? thrower.name : "?",
      team: g.team });
    for (const o of state.fighters) {
      if (!o.alive) continue;
      const d = Math.hypot(o.x - g.x, o.y - g.y);
      if (d > FLASH_R) continue;
      if (!losClear(state.sightGrid, g.x, g.y, o.x, o.y)) continue;   // 隔墙/隔烟不致盲
      /* 友方雷(自己+队友):一律背对短致盲(默认已转身);敌方雷:按朝向判定 */
      if (thrower && thrower.team === o.team) {
        o.blindUntil = now + FLASH_BLIND_BACK;
      } else {
        const dir = Math.atan2(g.y - o.y, g.x - o.x);   // 从 fighter 指向炸点(面向=全盲)
        const dot = Math.cos(o.facing - dir);
        o.blindUntil = now + (dot > 0.3 ? FLASH_BLIND_FULL : FLASH_BLIND_BACK);
      }
    }
  }
  }
function updateGrenades(state, dt, now) {
  let exploded = false;
  for (const g of state.grenades) {
    if (now - g.born >= NADE_FUSE) { g.dead = true; explodeNade(state, g, now); exploded = true; continue; }
    if (g.vx || g.vy) {
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
      if (!solidAt(state.grid, Math.floor(nx / CELL), Math.floor(ny / CELL))) { g.x = nx; g.y = ny; }
      else { g.vx = 0; g.vy = 0; }                     // 撞墙停(不反弹)
      const sp = Math.hypot(g.vx, g.vy);
      if (sp > 0) {
        const ns = sp * Math.exp(-NADE_FRICTION * dt);
        if (ns < NADE_STOP_SPEED) { g.vx = 0; g.vy = 0; }
        else { g.vx *= ns / sp; g.vy *= ns / sp; }
      }
    }
  }
  if (exploded) state.grenades = state.grenades.filter((g) => !g.dead);
}
function updateSmokes(state, now) {
  const before = state.smokes.length;
  state.smokes = state.smokes.filter((s) => now - s.born < SMOKE_DUR + SMOKE_FADE);
  if (state.smokes.length !== before) rebuildSightGrid(state);   // 烟消散 → 还原视线层叠格
}

/* ============================ Fighter / spawn ============================ */
function pickSpawn(grid, spawns, awayFrom) {
  let best = spawns[0], bd = -1;
  for (const [sx, sy] of spawns) {
    const x = (sx + 0.5) * CELL, y = (sy + 0.5) * CELL;
    let d = Infinity;
    for (const e of awayFrom) if (e.alive) d = Math.min(d, Math.hypot(e.x - x, e.y - y));
    if (awayFrom.every((e) => !e.alive)) d = Math.random();
    if (d > bd) { bd = d; best = [sx, sy]; }
  }
  const out = [(best[0] + 0.5) * CELL, (best[1] + 0.5) * CELL];
  if (best.length > 2) out.push(best[2]);          // 带朝向的地图(v2):[x,y,heading°]
  return out;
}
function spawnFighter(state, f) {
  let sx, sy, heading;
  if (state.obj && state.obj.play === "rescue" && state.obj.spawns) {
    /* 解救模式:固定阵营出生点,同队 3×3 邻域随机散布防重叠 */
    const sp = state.obj.spawns[f.team] || state.obj.spawns[0];
    const bx = Math.floor(sp[0] / CELL), by = Math.floor(sp[1] / CELL);
    const cands = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x2 = bx + dx, y2 = by + dy;
        if (state.grid[y2] && state.grid[y2][x2] === 0 && !state.doorSet.has(x2 + "," + y2))
          cands.push([x2, y2]);
      }
    const c = cands.length ? cands[(Math.random() * cands.length) | 0] : [bx, by];
    sx = (c[0] + 0.5) * CELL;
    sy = (c[1] + 0.5) * CELL;
    heading = sp[2];
  } else {
    const others = state.fighters.filter((x) => x !== f);
    [sx, sy, heading] = pickSpawn(state.grid, state.md.spawns, others);
  }
  f.x = sx; f.y = sy;
  if (typeof heading === "number") f.facing = heading * Math.PI / 180;
  f.hp = 100; f.alive = true; f.protectT = PROTECT_MS;
  /* 复活自动换弹:等同按 R——弹匣补满并同步扣备弹(弹药经济成立的前提是"死前会打空子弹");
   * 备弹见底则带着残弹复活。初始出生满弹 need=0 不扣;Bot 弹匣从不消耗,行为不变 */
  for (let wi = 0; wi < 2; wi++) {
    const w = WEAPONS[wi];
    const cur = f.mags ? (f.mags[wi] || 0) : 0;
    const avail = Math.min(Math.max(0, w.mag - cur), f.reserve ? (f.reserve[wi] || 0) : 0);
    if (!f.mags) f.mags = [0, 0];
    f.mags[wi] = cur + avail;
    if (f.reserve) f.reserve[wi] = (f.reserve[wi] || 0) - avail;
  }
  f.blindUntil = 0; f.alertUntil = 0;
  f.reloadEnd = 0; f.nextFire = 0; f.bloom = 0;
  f.__lastSafe = null;                                // 出生位由 resolveOverlap 重新记录
  /* nades(投掷物)不重置:同备弹哲学,死亡不掉 */
  if (f.isBot) {
    const brain = state.brainById[f.id];
    if (brain) {
      /* 重生清空大脑残留:旧 lastSeen/旧路径/卡死计数会把 Bot 钉死在 hunt 里傻站 */
      brain.state = "patrol";
      brain.path = null; brain.pathI = 0;
      brain.lastSeen = null; brain.lastSeenAt = 0;
      brain.reactUntil = 0; brain.burstUntil = 0; brain.pauseUntil = 0;
      brain.dodge = null; brain.hitReact = null;
      brain.pendingNade = null; brain.nadeCdUntil = 0;
      brain.retreatUntil = 0; brain.retreatFrom = null; brain.smokeCheckAt = 0;
      brain.searchUntil = 0; brain.patrolT = 0;
      brain.objMission = false;
      brain.combatMove = null; brain.bursts = 0;
      brain.nextRepositionAt = 0; brain.strafeCdUntil = 0;
      brain.huntUntil = 0; brain._huntDist = Infinity;
      brain._stuckX = undefined; brain._stuckY = undefined; brain._stuckT = 0;
    }
  }
}

/* ============================ 噪波 / 涟漪 ============================ */
/* radius 可选(门 3 格/跑步 4 格);噪音惊动半径内敌队 Bot 进入调查 */
function emitNoise(state, f, now, radius = NOISE_RADIUS) {
  state.ripples.push({ x: f.x, y: f.y, born: now, who: f.id, r: radius });
  for (const o of state.fighters) {
    if (o === f || !o.alive || !o.isBot || o.team === f.team) continue;
    const brain = state.brainById[o.id];
    if (brain && Math.hypot(o.x - f.x, o.y - f.y) <= radius + CELL * 0.5) brain.hear(f.x, f.y, now);
  }
}

/* ============================ F 交互:门 / 弹药箱 ============================ */
function nearestInteractive(state, f) {
  let best = null, bd = Infinity;
  for (const d of state.doors) {
    const dist = Math.hypot(d.x * CELL + 16 - f.x, d.y * CELL + 16 - f.y);
    if (dist < DOOR_INTERACT_R && dist < bd) { bd = dist; best = { kind: "door", obj: d }; }
  }
  for (const b of state.ammoBoxes) {
    const dist = Math.hypot(b.x * CELL + 16 - f.x, b.y * CELL + 16 - f.y);
    if (dist < BOX_INTERACT_R && dist < bd) { bd = dist; best = { kind: "box", obj: b }; }
  }
  return best;
}
/* 开/关门的噪音涟漪(半径 3 格,惊动敌队 Bot) */
function doorNoise(state, f, door, now) {
  const x = door.x * CELL + 16, y = door.y * CELL + 16;
  state.ripples.push({ x, y, born: now, who: f.id, r: DOOR_NOISE_R });
  for (const o of state.fighters) {
    if (o === f || !o.alive || !o.isBot || o.team === f.team) continue;
    const brain = state.brainById[o.id];
    if (brain && Math.hypot(o.x - x, o.y - y) <= DOOR_NOISE_R + CELL * 0.5) brain.hear(x, y, now);
  }
}
function interact(state, f, now) {
  const t = nearestInteractive(state, f);
  if (!t) return false;
  if (t.kind === "door") {
    const d = t.obj;
    if (d.open) {
      /* 关门前检查:有人身体与门格相交则拒绝关门,防把人关进实心格。
       * 圆 vs 门格精确检测(2026-09-05 修复):旧"center 距门格中心 <0.8 格"检查
       * 放行 25.6~35.6px 窄带(身体半径 13,轴向相交半径 29px/对角 35.6px),
       * 关门即把人嵌进实心门格,后续 moveCircle 远侧钳制会瞬移穿墙或稳定嵌墙 */
      const blocked = state.fighters.some((o) => o.alive &&
        circleHitsCell(o.x, o.y, o.r, d.x, d.y));
      if (blocked) return false;
    }
    d.open = !d.open;
    state.grid[d.y][d.x] = d.open ? 0 : 1;
    rebuildSightGrid(state);                       // 门也挡视线,层叠格需重建
    doorNoise(state, f, d, now);
    state.events.push({ t: "door", open: d.open, x: d.x * CELL + 16, y: d.y * CELL + 16 });
    return true;
  }
  const b = t.obj;
  if (f.isBot) return false;                         // Bot 无限备弹,不取箱
  if (b.respawnAt && now < b.respawnAt) return false; // 空箱刷新中
  const gotR = Math.max(0, Math.min(RESERVE_CAP[0] - (f.reserve[0] || 0), b.rifle));
  const gotP = Math.max(0, Math.min(RESERVE_CAP[1] - (f.reserve[1] || 0), b.pistol));
  /* 第三格投掷物:独立额度不占弹药;随机类型满了给另一种,都满则留在箱里 */
  let gotN = null;
  if (b.nade) {
    if ((f.nades[b.nade] || 0) < NADE_CAP) gotN = b.nade;
    else {
      const other = b.nade === "flash" ? "smoke" : "flash";
      if ((f.nades[other] || 0) < NADE_CAP) gotN = other;
    }
  }
  if (gotR <= 0 && gotP <= 0 && !gotN) return false;  // 弹药满且投掷物拿不下 → 不消耗库存
  f.reserve[0] = (f.reserve[0] || 0) + gotR;
  f.reserve[1] = (f.reserve[1] || 0) + gotP;
  b.rifle -= gotR; b.pistol -= gotP;
  if (gotN) { f.nades[gotN] = (f.nades[gotN] || 0) + 1; b.nade = null; }
  if (b.rifle <= 0 && b.pistol <= 0 && !b.nade) b.respawnAt = now + BOX_RESPAWN_MS;
  state.events.push({ t: "pickup", x: b.x * CELL + 16, y: b.y * CELL + 16, gotR, gotP, gotN, by: f.name });
  return true;
}
/* Bot 贴近关门格自动开门(同样出声,玩家可闻) */
function botAutoOpen(state, f, now) {
  for (const d of state.doors) {
    if (d.open) continue;
    const x = d.x * CELL + 16, y = d.y * CELL + 16;
    if (Math.hypot(x - f.x, y - f.y) < DOOR_AUTO_OPEN_R) {
      d.open = true;
      state.grid[d.y][d.x] = 0;
      rebuildSightGrid(state);
      doorNoise(state, f, d, now);
      state.events.push({ t: "door", open: true, x, y });
      return;
    }
  }
}
/* 弹药箱刷新(单箱取空后回满,刷新时 roll 第三格投掷物类型) */
function updateBoxes(state, now) {
  for (const b of state.ammoBoxes) {
    if (b.respawnAt && now >= b.respawnAt) {
      b.rifle = BOX_FILL.rifle; b.pistol = BOX_FILL.pistol; b.nade = rollNadeType(); b.respawnAt = 0;
    }
  }
}

/* ============================ Bot 决策(无副作用)============================
 * updateBrain 返回 {fireRequests: [{fighter, angle}]}
 * 原因:core 严格无副作用,Brain 不直接调 doFire,调用方拿到请求再统一处理
 */
class BotBrain {
  constructor(grid, self, rooms, doorSet, sightGrid) {
    this.moveGrid = grid;                       // 移动/寻路用(烟不挡走位)
    this.sightGrid = sightGrid || grid;         // 视线用(烟/墙挡视线)
    this.self = self;
    this.rooms = rooms || null;         // 房间列表:巡逻目标优先取自房间内部
    this.doorSet = doorSet || null;     // 门格集:关门格寻路可走(Bot 会开门)
    this.state = "patrol";
    this.path = null; this.pathI = 0;
    this.lastSeen = null;
    this.reactUntil = 0;
    this.burstUntil = 0; this.pauseUntil = 0;
    this.repathT = 0;
    this.patrolT = 0;
    this.objMission = false;            // 目标任务:走向/驻守 objHint 点期间免疫远端声音情报
    this.combatMove = null;             // 战斗走位:{path, pathI, until}(strafe/换位共用)
    this.bursts = 0;                    // 本轮交战 burst 计数
    this.nextRepositionAt = 0;          // 下次主动换位时刻
    this.strafeCdUntil = 0;             // 走位防抖冷却
    this.huntUntil = 0;                 // hunt 无进展放弃时限(每次有进展续期)
    this._huntDist = Infinity;
    this._stuckX = undefined; this._stuckY = undefined; this._stuckT = 0;
  }
  canSee(target, now) {
    const s = this.self;
    if (!target.alive || (target.protectT > 0 && target.isBot)) return false;
    if (now < (s.blindUntil || 0)) return false;    // 被闪光致盲:不索敌不开枪
    const d = Math.hypot(target.x - s.x, target.y - s.y);
    if (d > VISION_R) return false;
    const a = Math.atan2(target.y - s.y, target.x - s.x);
    if (Math.abs(normAngle(a - s.facing)) > CONE_HALF) return false;
    return losClear(this.sightGrid, s.x, s.y, target.x, target.y);
  }
  hear(x, y, now) {
    /* 任务中(走向/驻守目标点):远端枪声(> BOT_MISSION_HEAR_R)不打断——否则玩法模式下
     * 枪声涟漪半径 24 格≈跨全图,bot 永远走不到目标点、占点引导总在 4s 内被打断
     * (2026-09-05 用户报告"bot 几乎不会占点")。近身威胁仍正常响应并中止任务。 */
    if (this.objMission &&
        Math.hypot(x - this.self.x, y - this.self.y) > BOT_MISSION_HEAR_R) return;
    this.objMission = false;
    if (this.state === "patrol" || this.state === "hunt" || this.state === "search") {
      this.lastSeen = { x, y };
      this.state = "hunt";
      this.path = null;
      this.huntUntil = 0;   // 新目标重置无进展计时
    }
    this.self.alertUntil = Math.max(this.self.alertUntil || 0, now + ALERT_MS);
  }
  /* 同队共享视野(与玩家团队视野并集同源):队友看见的敌人 → lastSeen 跟踪 + hunt 走过去,
   * 不直接共享瞄准(交战仍需 Bot 自己看见),每 tick 更新 */
  report(x, y) {
    if (this.objMission &&
        Math.hypot(x - this.self.x, y - this.self.y) > BOT_MISSION_HEAR_R) return;
    this.objMission = false;
    if (this.state === "patrol" || this.state === "hunt" || this.state === "search") {
      this.lastSeen = { x, y };
      this.state = "hunt";
      this.path = null;
      this.huntUntil = 0;   // 新目标重置无进展计时
    }
  }
  /* 受击感知(applyDamage 调用):0.2s 后转向伤害来源 */
  onHit(x, y, now) {
    this.objMission = false;              // 受击:任务中止,自保优先
    this.combatMove = null;               // 受击:走位中止(转向伤害来源优先)
    if (!this.hitReact || this.hitReact.at > now + HIT_TURN_DELAY)
      this.hitReact = { x, y, at: now + HIT_TURN_DELAY };
  }
  /* 不修改 s.nextFire/s.mags,只返回意图。调用方调 doFire 时会处理这些副作用
   * target 可为 null(周围无活敌人)→ 只巡逻/调查,不开火
   * flashNade:本帧出现在视野内的飞行闪光弹(无则 null)→ 触发背身闪避 */
  update(dt, now, target, onFire, flashNade) {
    const s = this.self;
    if (!s.alive) return { fireRequests: [], nadeRequests: [] };
    const out = { fireRequests: [], nadeRequests: [] };

    /* 受击反应:0.2s 后转向伤害来源,进入警觉(交战免反应延迟) */
    if (this.hitReact && now >= this.hitReact.at) {
      s.facing = Math.atan2(this.hitReact.y - s.y, this.hitReact.x - s.x);
      this.lastSeen = { x: this.hitReact.x, y: this.hitReact.y };
      if (this.state !== "combat") { this.state = "hunt"; this.path = null; this.huntUntil = 0; }
      s.alertUntil = now + ALERT_MS;
      this.hitReact = null;
    }

    /* 闪光弹闪避:发现(锥内+视线可达)→ 0.2s 后背身站定;引信+致盲窗口结束后
     * 恢复原朝向,状态机全程未动 → 无缝继续之前的任务 */
    if (this.dodge) {
      const d = this.dodge;
      if (now >= d.g.born + NADE_FUSE) {
        if (now < (s.blindUntil || 0)) {
          s.facing = d.away;                    // 仍处致盲:继续背身
        } else {
          s.facing = d.savedFacing;             // 恢复原朝向,继续原任务
          this.dodge = null;
        }
        return out;
      }
      if (!d.started && now - d.spottedAt >= BOT_DODGE_DELAY) {
        d.started = true;
        d.savedFacing = s.facing;
      }
      if (d.started) {
        d.away = Math.atan2(s.y - d.g.y, s.x - d.g.x);   // 背对雷的当前方向
        s.facing = d.away;
        s.movingFast = false;
        return out;                             // 站定背身:不开枪不移动
      }
      // 0.2s 观察期内:按正常逻辑行动
    } else if (flashNade) {
      this.dodge = { g: flashNade, spottedAt: now, started: false,
                     savedFacing: s.facing, away: s.facing };
    }

    /* 待投掷请求:切枪冷却期间每 tick 重发;投出(数量减少)或超时则撤销 */
    if (this.pendingNade) {
      const p = this.pendingNade;
      if ((s.nades[p.type] || 0) < p.count || now > p.until) this.pendingNade = null;
      else out.nadeRequests.push({ type: p.type, x: p.x, y: p.y });
    }

    /* 拉烟撤离:背向敌人跑路(跑动有声,对玩家诚实),结束就地转巡逻 */
    if (this.retreatUntil && now < this.retreatUntil) {
      this.combatMove = null;
      const dx = s.x - this.retreatFrom.x, dy = s.y - this.retreatFrom.y;
      const dd = Math.hypot(dx, dy) || 1;
      s.facing = Math.atan2(dy, dx);
      s.movingFast = true;
      moveCircle(this.moveGrid, s, Math.cos(s.facing) * SPEED * dt, Math.sin(s.facing) * SPEED * dt);
      return out;
    }
    if (this.retreatUntil && now >= this.retreatUntil) {
      this.retreatUntil = 0;
      this.state = "patrol"; this.lastSeen = null; this.path = null;
    }

    const see = target ? this.canSee(target, now) : false;

    if (see) {
      this.objMission = false;              // 亲眼见敌:战斗优先,任务中止
      if (this.state !== "combat") {
        this.state = "combat";
        /* 警觉窗口内(刚受击/闻声)立即就绪,免除反应延迟 */
        this.reactUntil = now < (s.alertUntil || 0) ? now : now + BOT_CFG.reaction;
        this.bursts = 0;
        this.nextRepositionAt = now + BOT_REPOSITION_MS * (0.7 + Math.random() * 0.6);
      }
      this.lastSeen = { x: target.x, y: target.y };
      this.lastSeenAt = now;
      s.facing = Math.atan2(target.y - s.y, target.x - s.x);
      s.movingFast = false;
      /* 低血量:朝敌人拉烟并背向撤离(每 0.5s 检查一次) */
      if (now >= (this.smokeCheckAt || 0)) {
        this.smokeCheckAt = now + 500;
        const dEnemy = Math.hypot(target.x - s.x, target.y - s.y);
        if (s.hp <= BOT_SMOKE_HP && (s.nades.smoke || 0) > 0 && now >= (this.nadeCdUntil || 0) &&
            dEnemy <= BOT_SMOKE_MAX_DIST && dEnemy >= BOT_SMOKE_MIN_DIST) {
          this.pendingNade = { type: "smoke", x: target.x, y: target.y,
            count: s.nades.smoke, until: now + 2000 };
          this.nadeCdUntil = now + BOT_NADE_CD;
          this.retreatUntil = now + BOT_RETREAT_MS;
          this.retreatFrom = { x: target.x, y: target.y };
        }
      }
      if (now >= this.reactUntil) {
        if (now >= this.burstUntil && now >= this.pauseUntil) {
          this.burstUntil = now + BOT_CFG.burstMs;
          this.bursts++;
        }
        if (now < this.burstUntil) {
          const w = WEAPONS[s.weapon];
          if (now >= s.nextFire && s.mags[0] > 0 && s.reloadEnd <= now) {
            const err = BOT_CFG.aimError * (0.6 + Math.random() * 0.8);
            out.fireRequests.push({ fighter: s, angle: s.facing + (Math.random() - 0.5) * 2 * err });
          }
        } else if (now >= this.pauseUntil) {
          this.pauseUntil = now + BOT_CFG.pauseMs;
        }
      }
      this._combatMove(dt, now, target);
      return out;
    }

    if (this.state === "combat") {
      this.state = "hunt"; this.path = null; this.huntUntil = 0;
      this.combatMove = null;
      /* 丢失视线瞬间:情报最新鲜 → 朝最后目击点丢闪光(压上继续推进) */
      if ((s.nades.flash || 0) > 0 && now >= (this.nadeCdUntil || 0) &&
          this.lastSeen && this.lastSeenAt && now - this.lastSeenAt < BOT_FLASH_INFO_AGE &&
          Math.hypot(this.lastSeen.x - s.x, this.lastSeen.y - s.y) >= BOT_FLASH_MIN_DIST) {
        this.pendingNade = { type: "flash", x: this.lastSeen.x, y: this.lastSeen.y,
          count: s.nades.flash, until: now + 2000 };
        this.nadeCdUntil = now + BOT_NADE_CD;
      }
    }

    if (this.state === "hunt" && this.lastSeen) {
      /* 无进展保护:8s 内未向 lastSeen 接近 ≥1 格 → 放弃转搜索(防寻路失败/反复卡角导致永久傻站) */
      const distNow = Math.hypot(this.lastSeen.x - s.x, this.lastSeen.y - s.y);
      if (!this.huntUntil) { this.huntUntil = now + BOT_HUNT_TIMEOUT; this._huntDist = distNow; }
      else if (distNow < this._huntDist - CELL) {
        this._huntDist = distNow;
        this.huntUntil = now + BOT_HUNT_TIMEOUT;
      }
      if (now >= this.huntUntil) {
        this.state = "search";
        this.searchUntil = now + BOT_SEARCH_MS;
        this.lastSeen = null;
        this.path = null;
        this.huntUntil = 0;
        return out;
      }
      this._followPath(dt, this.lastSeen.x, this.lastSeen.y);
      const arrived = Math.hypot(this.lastSeen.x - s.x, this.lastSeen.y - s.y) < CELL;
      if (arrived) {
        /* 到点未发现 → 原地环顾搜索(防秒失忆),闻声/受击/队友情报可重新激活 */
        this.state = "search";
        this.searchUntil = now + BOT_SEARCH_MS;
        this.lastSeen = null;
        this.path = null;
        this.huntUntil = 0;
      }
      return out;
    }
    if (this.state === "search") {
      if (now >= this.searchUntil) {
        this.state = "patrol";
        this.patrolT = 0;                     // 搜索结束立即选新巡逻目标
      } else {
        s.movingFast = false;
        s.facing += dt * 1.8;                 // 原地缓慢环顾
        return out;
      }
    }

    // 巡逻:到点短暂停留后选新目标;目标优先取自房间内部(避免游荡卡在地图边角)
    if (!this.path || this.pathI >= this.path.length) {
      this.patrolT = (this.patrolT || 0) - dt * 1000;   // patrolT 单位 ms,dt 单位 s
      if (this.patrolT <= 0) {
        this.patrolT = 600 + Math.random() * 900;   // 停留 0.6~1.5s
        this._pickPatrolTarget();
      }
      if (!this.path) return out;
    }
    this._followPath(dt, null, null);
    return out;
  }
  /* 战斗走位:burst 间隙横向小步(strafe);持续交战按间隔主动换位(优先断视线掩体)。
   * 走位期间保持面向敌人侧移,静步速度(无声,公平性同巡逻静步),被打断即弃。 */
  _combatMove(dt, now, target) {
    const s = this.self;
    if (this.combatMove &&
        (this.combatMove.pathI >= this.combatMove.path.length || now >= this.combatMove.until))
      this.combatMove = null;
    if (!this.combatMove && now >= (this.strafeCdUntil || 0)) {
      const pausing = now >= this.burstUntil && now < this.pauseUntil;
      const wantRepos = now >= (this.nextRepositionAt || 0);
      if (pausing || wantRepos) {
        let cell = wantRepos ? this._pickCombatCell(target) : null;
        if (!cell) cell = this._pickStrafeCell(target);
        if (cell) {
          const path = astar(this.moveGrid, Math.floor(s.x / CELL), Math.floor(s.y / CELL),
            cell[0], cell[1], this.doorSet);
          if (path && path.length > 1)
            this.combatMove = { path, pathI: 1, until: now + BOT_COMBAT_MOVE_MS };
        }
        if (wantRepos)
          this.nextRepositionAt = now + BOT_REPOSITION_MS * (0.7 + Math.random() * 0.6);
        this.strafeCdUntil = now + 150;    // 防抖:一次走位结束后短暂冷却
      }
    }
    if (!this.combatMove) return;
    const [wx, wy] = this.combatMove.path[this.combatMove.pathI];
    const dx = wx - s.x, dy = wy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) { this.combatMove.pathI++; return; }
    const px = s.x, py = s.y;
    moveCircle(this.moveGrid, s, (dx / d) * SHIFT_SPEED * dt, (dy / d) * SHIFT_SPEED * dt);
    if (Math.hypot(s.x - px, s.y - py) < 0.5) this.combatMove = null;   // 顶墙:放弃本次走位
  }
  /* strafe 选位:垂直于敌向 1~2 格的可站格(随机一侧) */
  _pickStrafeCell(target) {
    const s = this.self;
    const ang = Math.atan2(target.y - s.y, target.x - s.x);
    const side = Math.random() < 0.5 ? 1 : -1;
    const px = Math.cos(ang + side * Math.PI / 2), py = Math.sin(ang + side * Math.PI / 2);
    const bx = Math.floor(s.x / CELL), by = Math.floor(s.y / CELL);
    const W = this.moveGrid[0].length, H = this.moveGrid.length;
    for (const dist of [1, 2]) {
      const tx = Math.round(bx + px * dist), ty = Math.round(by + py * dist);
      if (tx >= 0 && ty >= 0 && tx < W && ty < H && this.moveGrid[ty][tx] === 0) return [tx, ty];
    }
    return null;
  }
  /* 换位选位:2~5 格内可站格,优先相对目标断视线(掩体后);无掩体位退化为随机近位 */
  _pickCombatCell(target) {
    const s = this.self;
    const W = this.moveGrid[0].length, H = this.moveGrid.length;
    const bx = Math.floor(s.x / CELL), by = Math.floor(s.y / CELL);
    const cand = [];
    for (let r = 2; r <= 5; r++)
      for (let k = 0; k < 12; k++) {
        const ang = Math.random() * Math.PI * 2;
        const tx = bx + Math.round(Math.cos(ang) * r);
        const ty = by + Math.round(Math.sin(ang) * r);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (this.moveGrid[ty][tx] !== 0) continue;
        const wx = (tx + 0.5) * CELL, wy = (ty + 0.5) * CELL;
        cand.push({ tx, ty, cover: !losClear(this.sightGrid, target.x, target.y, wx, wy) });
      }
    if (!cand.length) return null;
    const covered = cand.filter((c) => c.cover);
    const pick = covered.length ? covered[(Math.random() * covered.length) | 0]
                                : cand[(Math.random() * cand.length) | 0];
    return [pick.tx, pick.ty];
  }
  /* 选巡逻目标:优先在随机房间内部取点;连续失败则退回全图随机。
   * 目标模式:首选取点尝试 objHint(据点/人质区/护航位,±3 格抖动) */
  _pickPatrolTarget() {
    const s = this.self;
    const W = this.moveGrid[0].length, H = this.moveGrid.length;
    for (let tries = 0; tries < 8; tries++) {
      let tx, ty;
      if (this.objHint && tries < 3) {
        /* 目标点 = 据点/人质区中心 ±1 格:中心是推导保证的可站格,±1 对角 ≈1.4 格 < 2.5 格半径,恒在圈内;
         * hint 尝试 3 次(抖动不同),全部失败才落回房间/随机,避免把驻留浪费在非目标点 */
        tx = Math.floor(this.objHint.x / CELL) + ((Math.random() * 3) | 0) - 1;
        ty = Math.floor(this.objHint.y / CELL) + ((Math.random() * 3) | 0) - 1;
      } else if (this.rooms && this.rooms.length && tries < 6) {
        const [, rx, ry, rw, rh] = this.rooms[(Math.random() * this.rooms.length) | 0];
        tx = rx + ((Math.random() * rw) | 0);
        ty = ry + ((Math.random() * rh) | 0);
      } else {
        tx = Math.floor(Math.random() * W);
        ty = Math.floor(Math.random() * H);
      }
      const path = astar(this.moveGrid, Math.floor(s.x / CELL), Math.floor(s.y / CELL), tx, ty, this.doorSet);
      if (path) {
        this.path = path; this.pathI = 0;
        if (this.objHint && tries < 3) {
          this.patrolT = 4500 + Math.random() * 1500;   // 目标点驻留 4.5~6s:覆盖占点/营救引导时长
          this.objMission = true;             // 接下目标任务:免疫远端声音情报,直至交战/受击/闻近声
        }
        return;
      }
    }
    this.path = null; this.pathI = 0;
  }
  _followPath(dt, gx, gy) {
    const s = this.self;
    if ((!this.path || this.pathI >= this.path.length) && gx != null) {
      this.path = astar(this.moveGrid, Math.floor(s.x / CELL), Math.floor(s.y / CELL),
        Math.floor(gx / CELL), Math.floor(gy / CELL), this.doorSet);
      this.pathI = 0;
    }
    if (!this.path || this.pathI >= this.path.length) return;
    /* 卡死检测:1.2s 内几乎无位移则弃当前路径重规划(防卡墙角) */
    if (this._stuckX === undefined) { this._stuckX = s.x; this._stuckY = s.y; }
    this._stuckT += dt;
    if (this._stuckT >= 1.2) {
      if (Math.hypot(s.x - this._stuckX, s.y - this._stuckY) < 10) {
        this.path = null; this.pathI = 0;
        this.patrolT = 0;           // 跳过停留,下一帧立即重选目标
        /* 计时/参考点必须一并重置:否则下一帧立刻再判卡死,新路径永远迈不出第一步 */
        this._stuckX = s.x; this._stuckY = s.y; this._stuckT = 0;
        return;                     // path 已置空,本帧不再取路径点
      }
      this._stuckX = s.x; this._stuckY = s.y; this._stuckT = 0;
    }
    const [wx, wy] = this.path[this.pathI];
    const dx = wx - s.x, dy = wy - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) { this.pathI++; return; }
    s.movingFast = false;
    s.facing = Math.atan2(dy, dx);
    moveCircle(this.moveGrid, s, (dx / d) * SHIFT_SPEED * dt, (dy / d) * SHIFT_SPEED * dt);
  }
}

/* ============================ 玩法模式:目标推进 ============================ */
/* 状态挂在 state.obj,联机经 buildSnapshot 的 obj 字段广播;单机引擎直接消费同一 state。 */
function initObjState(state, play) {
  if (play !== "point" && play !== "rescue") { state.obj = null; return; }
  if (play === "point") {
    const cells = derivePointZones(state.md, state.grid, state.doorSet);
    state.obj = { play, time: POINT_TIME_MS, score: [0, 0], over: false, winner: null,
      carrierRef: null, carrierId: null, carrierTeam: -1,
      zones: cells.map(([x, y], i) => ({ name: "ABC"[i], x: (x + 0.5) * CELL, y: (y + 0.5) * CELL,
        r: ZONE_R, owner: -1, prog: 0, capTeam: -1 })) };
    } else {
      const [h, e, att, def] = deriveRescueZones(state.md, state.grid, state.doorSet);
      const sp = (c) => {
        const out = [(c[0] + 0.5) * CELL, (c[1] + 0.5) * CELL];
        if (c.length > 2) out.push(c[2]);   // 出生朝向(v2 地图)
        return out;
      };
      state.obj = { play, time: RESCUE_TIME_MS, score: [0, 0], over: false, winner: null,
        stage: "secure", carrierRef: null, carrierId: null, carrierTeam: -1,
        homeH: { x: (h[0] + 0.5) * CELL, y: (h[1] + 0.5) * CELL, r: ZONE_R },   // 人质房(守方押回目标)
        spawns: { 0: sp(att), 1: sp(def) },   // 阵营固定出生点(世界坐标,spawnFighter 消费)
        zones: [
          { name: "H", x: (h[0] + 0.5) * CELL, y: (h[1] + 0.5) * CELL, r: ZONE_R, prog: 0, capTeam: -1 },
          { name: "E", x: (e[0] + 0.5) * CELL, y: (e[1] + 0.5) * CELL, r: ZONE_R, prog: 0 },
        ] };
    }
}
function updateObj(state, dt) {
  const o = state.obj;
  if (!o || o.over) return;
  o.time -= dt * 1000;
  const fighters = state.fighters;
  const inZone = (f, z) => f.alive && Math.hypot(f.x - z.x, f.y - z.y) <= z.r;
  const endWith = (winner) => {
    if (o.over) return;
    o.over = true;
    o.winner = winner;
    const s = `${Math.floor(o.score[0])} : ${Math.floor(o.score[1])}`;
    const text = o.play === "point"
      ? (winner === -1 ? `比分 ${s},平分平局。`
        : winner === 0 ? `据点压制达成(比分 ${s})。` : `据点失守(比分 ${s})。`)
      : (winner === 0 ? "人质已成功营救并撤离。" : "时限已到,人质未能营救。");
    state.events.push({ t: "matchover", winner, score: [Math.floor(o.score[0]), Math.floor(o.score[1])], text });
  };
  if (o.play === "point") {
    for (const z of o.zones) {
      const n0 = fighters.filter((f) => f.team === 0 && inZone(f, z)).length;
      const n1 = fighters.filter((f) => f.team === 1 && inZone(f, z)).length;
      if (n0 > 0 && n1 > 0) continue;
      if (n0 > 0 && z.owner !== 0) {
        if (z.capTeam !== 0) { z.capTeam = 0; z.prog = 0; }
        z.prog = Math.min(1, z.prog + dt * 1000 * Math.min(n0, 2) / CAPTURE_MS);
        if (z.prog >= 1) { z.owner = 0; z.prog = 0; z.capTeam = -1; state.events.push({ t: "objcap", z: z.name, team: 0 }); }
      } else if (n1 > 0 && z.owner !== 1) {
        if (z.capTeam !== 1) { z.capTeam = 1; z.prog = 0; }
        z.prog = Math.min(1, z.prog + dt * 1000 * Math.min(n1, 2) / CAPTURE_MS);
        if (z.prog >= 1) { z.owner = 1; z.prog = 0; z.capTeam = -1; state.events.push({ t: "objcap", z: z.name, team: 1 }); }
      } else if (n0 === 0 && n1 === 0 && z.capTeam !== -1 && z.owner !== z.capTeam) {
        z.prog -= dt * 1000 * 1.5 / CAPTURE_MS;
        if (z.prog <= 0) { z.prog = 0; z.capTeam = -1; }
      }
    }
    for (const z of o.zones) if (z.owner >= 0) o.score[z.owner] += dt * 1000 / POINT_TICK_MS;
    } else {
      const hz = o.zones[0], ez = o.zones[1];
      if (o.stage === "secure") {
        /* 双向争夺:攻守双方均可引导接管(对方同区冻结,无人衰减) */
        const n0 = fighters.filter((f) => f.team === 0 && inZone(f, hz)).length;
        const n1 = fighters.filter((f) => f.team === 1 && inZone(f, hz)).length;
        if (n0 > 0 && n1 > 0) {
          /* 争夺冻结 */
        } else if (n0 > 0 || n1 > 0) {
          const team = n0 > 0 ? 0 : 1;
          const hzAtHome = Math.hypot(hz.x - o.homeH.x, hz.y - o.homeH.y) < 2;
          if (team === 1 && hzAtHome) {
            /* 人质已在自己家:守方引导无效果(无可接管) */
          } else {
            if (hz.capTeam !== team) { hz.capTeam = team; hz.prog = 0; }
            hz.prog = Math.min(1, hz.prog + dt * 1000 * Math.min(n0 + n1, 2) / RESCUE_CHANNEL_MS);
            if (hz.prog >= 1) {
              const carrier = fighters.find((f) => f.team === team && inZone(f, hz));
              o.stage = "escort";
              o.carrierRef = carrier;
              o.carrierId = carrier.id;
              o.carrierTeam = team;
              ez.prog = 0;
              state.events.push({ t: "objstage", stage: "escort", team });
            }
          }
        } else if (hz.capTeam !== -1) {
          hz.prog = Math.max(0, hz.prog - dt * 1000 * 2 / RESCUE_CHANNEL_MS);
          if (hz.prog <= 0) { hz.prog = 0; hz.capTeam = -1; }
        }
      } else {
        const c = o.carrierRef;
        if (!c || !c.alive) {
          /* 携行者阵亡(无论哪方):人质掉落在阵亡点,回阶段 1 双方再争 */
          const [nx, ny] = nearestStandableCell(state.grid, state.doorSet,
            c ? c.x : hz.x, c ? c.y : hz.y);
          hz.x = (nx + 0.5) * CELL;
          hz.y = (ny + 0.5) * CELL;
          hz.prog = 0;
          hz.capTeam = -1;
          o.stage = "secure";
          o.carrierRef = null; o.carrierId = null; o.carrierTeam = -1;
          state.events.push({ t: "objstage", stage: "drop" });
        } else if (o.carrierTeam === 0) {
          /* 攻方携行 → 撤离区 */
          if (inZone(c, ez)) {
            ez.prog = Math.min(1, ez.prog + dt * 1000 / EXTRACT_CHANNEL_MS);
            if (ez.prog >= 1) { endWith(0); return; }   // 撤离完成 → 进攻方胜
          } else if (ez.prog > 0) {
            ez.prog = Math.max(0, ez.prog - dt * 1000 * 2 / EXTRACT_CHANNEL_MS);
          }
        } else {
          /* 守方携行 → 押回人质房,重新看管 */
          if (inZone(c, o.homeH)) {
            hz.prog = Math.min(1, hz.prog + dt * 1000 / EXTRACT_CHANNEL_MS);
            if (hz.prog >= 1) {
              hz.x = o.homeH.x; hz.y = o.homeH.y;
              hz.prog = 0; hz.capTeam = -1;
              o.stage = "secure";
              o.carrierRef = null; o.carrierId = null; o.carrierTeam = -1;
              state.events.push({ t: "objstage", stage: "resec" });
            }
          } else if (hz.prog > 0) {
            hz.prog = Math.max(0, hz.prog - dt * 1000 * 2 / EXTRACT_CHANNEL_MS);
          }
        }
      }
    }
  /* 胜负判定:事件广播(客户端按己方视角渲染结算画面) */
  if (o.over) return;
  if (o.play === "point") {
    if (o.score[0] >= POINT_SCORE_TARGET) endWith(0);
    else if (o.score[1] >= POINT_SCORE_TARGET) endWith(1);
    else if (o.time <= 0)
      endWith(o.score[0] > o.score[1] ? 0 : o.score[1] > o.score[0] ? 1 : -1);
  } else if (o.time <= 0) endWith(1);
}
/* Bot 目标提示:占点偏向非己方据点;解救攻方偏向人质区/护航、守方驻守(交战不受影响) */
function objHintFor(state, f) {
  const o = state.obj;
  const fighters = state.fighters;
  if (o.play === "point") {
    const hostile = o.zones.filter((z) => z.owner !== f.team);
    if (!hostile.length) return null;     // 全图己方:自由巡逻
    /* 70% 最近 / 30% 非己方随机:分散覆盖,避免全员堆同一点 */
    const near = hostile.reduce((a, b) =>
      Math.hypot(f.x - a.x, f.y - a.y) <= Math.hypot(f.x - b.x, f.y - b.y) ? a : b);
    const pick = (Math.random() < 0.7 || hostile.length === 1)
      ? near : hostile[(Math.random() * hostile.length) | 0];
    return { x: pick.x, y: pick.y };
  }
  if (o.stage === "escort") {
    /* 携行者本人 → 押送目标(攻方撤离区 / 守方人质房);其余 → 护航或猎杀携行者 */
    if (o.carrierRef === f)
      return o.carrierTeam === 0 ? { x: o.zones[1].x, y: o.zones[1].y }
                                 : { x: o.homeH.x, y: o.homeH.y };
    return { x: o.carrierRef.x, y: o.carrierRef.y };
  }
  return { x: o.zones[0].x, y: o.zones[0].y };   // 阶段 1:双方都往人质区压
}

/* ============================ 索敌辅助 ============================ */
function _nearestEnemy(state, f) {
  let best = null, bd = Infinity;
  for (const o of state.fighters) {
    if (o === f || !o.alive || o.team === f.team) continue;   // 只索敌对方
    const d = Math.hypot(o.x - f.x, o.y - f.y);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
/* 同队共享视野:队友(含真人)视野内的最近敌人 → Bot lastSeen 跟踪 + hunt 走过去。
 * 判定与玩家团队视野并集同源(锥 + 视野距离 + sightGrid 视线);交战仍需 Bot 自己看见 */
function _sharedVisionSpot(state, f) {
  for (const o of state.fighters) {
    if (!o.alive || o.team === f.team) continue;
    for (const m of state.fighters) {
      if (m === f || m === o || !m.alive || m.team !== f.team) continue;
      const d = Math.hypot(o.x - m.x, o.y - m.y);
      if (d > VISION_R) continue;
      const ang = Math.atan2(o.y - m.y, o.x - m.x);
      if (Math.abs(normAngle(ang - m.facing)) > CONE_HALF) continue;
      if (!losClear(state.sightGrid, m.x, m.y, o.x, o.y)) continue;
      return { x: o.x, y: o.y };
    }
  }
  return null;
}
/* 视野锥内 + 视线可达的飞行闪光弹(Bot 背身闪避触发) */
function _flashNadeInCone(state, f) {
  for (const g of state.grenades) {
    if (g.type !== "flash") continue;
    if (g.team === f.team) continue;                    // 友方雷不背身(短致盲平权)
    const d = Math.hypot(g.x - f.x, g.y - f.y);
    if (d > VISION_R) continue;
    const ang = Math.atan2(g.y - f.y, g.x - f.x);
    if (Math.abs(normAngle(ang - f.facing)) > CONE_HALF) continue;
    if (!losClear(state.sightGrid, f.x, f.y, g.x, g.y)) continue;
    return g;
  }
  return null;
}

/* 嵌墙自愈(兜底):正常移动由 moveCircle 保证身体不与实心格重叠;若因异常路径
 * 已嵌入,回滚到上一帧安全位(≤1 tick 位移,不穿墙);无安全位(异常出生)才从格心
 * 沿 8 方向 ray-out。禁止沿轴推到无重叠——那会把人穿墙弹到实心格远侧,与
 * moveCircle 远侧钳制同病(2026-09-05 联机卡墙修复)。 */
function resolveOverlap(state, f) {
  const overlapped = (x, y) => {
    const ix0 = Math.floor((x - f.r) / CELL), ix1 = Math.floor((x + f.r) / CELL);
    const iy0 = Math.floor((y - f.r) / CELL), iy1 = Math.floor((y + f.r) / CELL);
    for (let iy = iy0; iy <= iy1; iy++)
      for (let ix = ix0; ix <= ix1; ix++)
        if (solidAt(state.grid, ix, iy) && circleHitsCell(x, y, f.r, ix, iy)) return true;
    return false;
  };
  if (overlapped(f.x, f.y)) {
    /* 回滚上一帧安全位(≤1 tick 位移,不穿墙);无安全位(异常出生)才从格心 ray-out */
    if (f.__lastSafe && !overlapped(f.__lastSafe.x, f.__lastSafe.y)) {
      f.x = f.__lastSafe.x; f.y = f.__lastSafe.y;
    } else {
      const ccx = Math.floor(f.x / CELL) * CELL + CELL / 2;
      const ccy = Math.floor(f.y / CELL) * CELL + CELL / 2;
      const dist = CELL * 0.5 * Math.SQRT2 + f.r;      // 稳出格对角 + 半径
      for (let k = 0; k < 8; k++) {
        const nx = ccx + Math.cos(k * Math.PI / 4) * dist;
        const ny = ccy + Math.sin(k * Math.PI / 4) * dist;
        if (!overlapped(nx, ny)) { f.x = nx; f.y = ny; break; }
      }
    }
  }
  if (!overlapped(f.x, f.y)) f.__lastSafe = { x: f.x, y: f.y };
}

/* ============================ 单帧更新核心 ============================
 * state: { fighters, ripples, tracers, flashes, grenades, smokes, sightGrid,
 *          events, grid, md, doors, ammoBoxes, doorSet, brainById, now, obj }
 * inputs: 按 fighter.id 索引 { keys:{w,a,s,d,shift}, aim, fire, reload, switch }
 *   玩家(非 Bot)用 aim=鼠标朝角,fire=按下,reload=R,switch=数字键
 *   Bot 不读 inputs(由 brain 决定)
 * 返回: 同一个 state(events 已追加)
 */
function updateFighters(state, inputs, dt, now) {
  state.now = now;
  if (state.obj && !state.obj.over) updateObj(state, dt);   // 玩法模式目标推进

  updateBoxes(state, now);                  // 弹药箱刷新计时

  // 玩家/Bot 统一处理
  for (const f of state.fighters) {
    if (!f.alive) {
      if (now >= f.deadUntil) {
        spawnFighter(state, f);
      }
      continue;
    }

    resolveOverlap(state, f);              // 嵌墙自愈兜底(见函数注释)

    let mx = 0, my = 0;
    let wantFire = false, fireEdge = false;
    let wantReload = false, wantSwitch = -1, wantInteract = false;

    if (f.isBot) {
      // Bot:调 brain,但 fire 改成"返回请求"再统一处理
      // Bot 也需要先 reset 视觉相关的 nextFire/protectT 等
      if (f.protectT > 0) f.protectT -= dt * 1000;
      finishReloadIfDue(f, now);
      botAutoOpen(state, f, now);              // Bot 贴近关门自动开门
      // 找一个对手(最近活着的敌队 fighter;无活敌 → target=null,Bot 照常巡逻)
      const target = _nearestEnemy(state, f);
      const brain = state.brainById[f.id];
      if (brain) {
        /* 目标模式:注入巡逻提示(占点抢点/解救营救-护航-驻守;交战逻辑不受影响) */
        brain.objHint = (state.obj && !state.obj.over) ? objHintFor(state, f) : null;
        /* 同队共享视野:队友看见的敌人 → lastSeen 跟踪 + hunt(交战仍需自己看见) */
        if (brain.state !== "combat") {
          const spot = _sharedVisionSpot(state, f);
          if (spot) brain.report(spot.x, spot.y);
        }
        const flashNade = _flashNadeInCone(state, f);   // 视野内敌方飞行闪光弹 → 背身闪避
        const req = brain.update(dt, now, target, null, flashNade);
        for (const r of req.fireRequests) {
          /* 射速闸门:brain 只返回意图、不设 nextFire(原 engine 版闸门在 brain 内,
           * 单源后由消费方执行)。缺失时 bot 每 tick 开火 = 6000 RPM,曳光成扇。 */
          if (now < r.fighter.nextFire) continue;
          const rw = WEAPONS[r.fighter.weapon];
          if (!rw.melee && !rw.grenade) r.fighter.nextFire = now + 60000 / rw.rpm;
          const enemies = state.fighters.filter((x) => x.team !== r.fighter.team);
          doFire(state, r.fighter, r.angle, now, enemies);
        }
        /* 投掷请求:切槽(吃 250ms 切换冷却)→ 面向目标投出 → 自动切回步枪 */
        for (const r of (req.nadeRequests || [])) {
          if ((f.nades[r.type] || 0) <= 0) continue;
          const idx = r.type === "flash" ? 3 : 4;
          if (f.weapon !== idx) { switchWeapon(f, idx, now); continue; }
          const ang = Math.atan2(r.y - f.y, r.x - f.x);
          f.facing = ang;
          doFire(state, f, ang, now, state.fighters.filter((x) => x.team !== f.team));
          if (f.weapon >= 3) switchWeapon(f, 0, now);   // 投完立即切回枪械
        }
        /* 保险:持投掷物槽但弹已用尽 → 切回步枪 */
        if (f.weapon >= 3 && (f.nades[f.weapon === 3 ? "flash" : "smoke"] || 0) <= 0)
          switchWeapon(f, 0, now);
      }
      f.noiseT -= dt * 1000;
      if (f.noiseT <= 0) {
        f.noiseT = NOISE_INTERVAL;
        if (f.movingFast) emitNoise(state, f, now);
      }
      continue;
    }

    // 玩家:从 inputs 读(缺 input = 玩家暂时无网络包,按"全 0"继续推计时器)
    const inp = inputs[f.id] || {};
    const keys = inp.keys || {};
    if (keys.w) my -= 1;
    if (keys.s) my += 1;
    if (keys.a) mx -= 1;
    if (keys.d) mx += 1;
    const shift = !!keys.shift;
    const sp = shift ? SHIFT_SPEED : SPEED;
    const len = Math.hypot(mx, my);
    f.movingFast = len > 0 && !shift;
    if (len > 0) {
      moveCircle(state.grid, f, (mx / len) * sp * dt, (my / len) * sp * dt);
      f.noiseT -= dt * 1000;
      if (f.noiseT <= 0) {
        f.noiseT = NOISE_INTERVAL;
        if (f.movingFast) emitNoise(state, f, now);
      }
    }
    if (typeof inp.aim === "number") f.facing = inp.aim;
    finishReloadIfDue(f, now);
    if (f.protectT > 0) f.protectT -= dt * 1000;
    wantFire = !!inp.fire;
    fireEdge = !!inp.fireEdge;
    wantReload = !!inp.reload;
    wantSwitch = (typeof inp.switch === "number") ? inp.switch : -1;
    wantInteract = !!inp.interact;

    if (wantSwitch >= 0) switchWeapon(f, wantSwitch, now);
    if (wantReload) tryReload(state, f, now);
    if (wantInteract) interact(state, f, now);

    const w = WEAPONS[f.weapon];
    const wf = w.auto ? wantFire : fireEdge;
    if (wf && now >= f.nextFire && f.reloadEnd <= now) {
      if (f.mags[f.weapon] > 0 || w.melee || w.grenade) {
        /* 枪械射速闸门在此设置;近战/投掷的 cd 闸门由 doFire 内部设置
         * (此处预赋值会让 doFire 的 now < f.nextFire 闸门恒真返回,刀永远挥不出) */
        if (!w.melee && !w.grenade) f.nextFire = now + 60000 / w.rpm;
        const enemies = state.fighters.filter((x) => x.team !== f.team);  // 友伤关闭:只以敌队为目标
        doFire(state, f, f.facing, now, enemies);
      }
    }
  }

  // 特效衰减
  const cut = now - 90;
  state.tracers = state.tracers.filter((t) => t.t > cut);
  state.flashes = state.flashes.filter((fl) => fl.t > cut - 60);
  state.ripples = state.ripples.filter((rp) => now - rp.born < 650);
  updateGrenades(state, dt, now);          // 投掷物飞行/起爆
  updateSmokes(state, now);                // 烟雾持续/消散(联动 sightGrid)
  for (const fighter of state.fighters) {
    fighter.bloom = Math.max(0, fighter.bloom - dt * 0.09);
  }

  return state;
}

/* ============================ 对局状态初始化 ============================ */
/* mapKey:maps.js 里的地图键(如 "office"/"harbor"),缺省办公楼主图 */
function _mapData(mapKey) {
  if (mapKey && global.CQB_MAPS && global.CQB_MAPS[mapKey]) return global.CQB_MAPS[mapKey];
  if (typeof require !== "undefined") return require("./maps.js").office;
  return global.CQB_MAPS ? global.CQB_MAPS.office : null;
}
function createState(mapKey, play) {
  const md = _mapData(mapKey);
  if (!md) throw new Error("maps.js 未加载:请先于本文件引入 maps.js");
  const grid = buildGrid(md);
  /* 门:开局全关(关 = 门格置实心) */
  const doors = md.doors.map(([x, y]) => ({ x, y, open: false }));
  for (const d of doors) grid[d.y][d.x] = 1;
  /* 弹药箱:箱子本体是半遮挡格(buildGrid 已置 2),这里只记弹药余量 */
  const ammoBoxes = (md.ammoBoxes || []).map(([x, y], i) =>
    ({ i, x, y, rifle: BOX_FILL.rifle, pistol: BOX_FILL.pistol, nade: rollNadeType(), respawnAt: 0 }));
  const state = {
    fighters: [],
    ripples: [],
    tracers: [],
    flashes: [],
    grenades: [],                         // 飞行中的投掷物
    smokes: [],                           // 激活烟雾
    sightGrid: grid.map((row) => row.slice()),   // 视线层叠格(基础 grid + 烟雾格)
    events: [],
    grid,
    md,                                   // 本局地图数据(spawn 等按图取用)
    doors, ammoBoxes,
    doorSet: new Set(md.doors.map(([x, y]) => x + "," + y)),
    brainById: {},
    now: 0,
    matchOver: false,                     // TDM 结算已触发(checkTeamWin 只发一次)
  };
  initObjState(state, play);              // 玩法模式目标区(tdm = null)
  return state;
}

/* ============================ 暂停计时平移(单人暂停用) ============================ */
/* 恢复时把绝对时间戳整体平移暂停时长,否则投掷物引信/烟雾/重生/换弹/
 * 致盲/Bot 各计时器会在长时间暂停后瞬间跳完。涟漪/曳光/火光为 ≤650ms
 * 纯视觉件:不平移,暂停期间自然淡出。 */
function shiftTimers(state, d) {
  if (d <= 0) return;
  for (const f of state.fighters) {
    /* 值为 0 即"未在计时",跳过(否则会把未换弹的弹匣瞬间装满等) */
    if (f.nextFire) f.nextFire += d;
    if (f.reloadEnd) f.reloadEnd += d;
    if (f.blindUntil) f.blindUntil += d;
    if (f.alertUntil) f.alertUntil += d;
    if (f.deadUntil) f.deadUntil += d;
  }
  for (const id in state.brainById) {
    const br = state.brainById[id];
    if (!br) continue;
    if (br.reactUntil) br.reactUntil += d;
    if (br.burstUntil) br.burstUntil += d;
    if (br.pauseUntil) br.pauseUntil += d;
    if (br.nadeCdUntil) br.nadeCdUntil += d;
    if (br.retreatUntil) br.retreatUntil += d;
    if (br.searchUntil) br.searchUntil += d;
    if (br.huntUntil) br.huntUntil += d;
    if (br.smokeCheckAt) br.smokeCheckAt += d;
    if (br.lastSeenAt) br.lastSeenAt += d;
    if (br.hitReact) br.hitReact.at += d;
    if (br.pendingNade) br.pendingNade.until += d;
    if (br.nextRepositionAt) br.nextRepositionAt += d;
    if (br.strafeCdUntil) br.strafeCdUntil += d;
    if (br.combatMove) br.combatMove.until += d;
  }
  for (const g of state.grenades) g.born += d;
  for (const s of state.smokes) s.born += d;
  for (const b of state.ammoBoxes) if (b.respawnAt) b.respawnAt += d;
}

/* ============================ 导出 ============================ */
const api = {
  /* 常量(纯算法层) */
  CELL, VISION_R_TILES, VISION_R, CONE_HALF, NEAR_R, PLAYER_R, WEAPONS, RESERVE,
  BOX_FILL, BOX_RESPAWN_MS,
  /* 纯算法函数 */
  buildGrid, solidAt, blocksSight, dda, losClear, normAngle, visibilityPolygon,
  pip, entityVisible, astar, moveCircle, resolveShotGeometry, makeFighter,
  rollNadeType,
  deriveStandableCells, derivePointZones, deriveRescueZones, nearestStandableCell,
  /* 状态层常量(2026-09-05 二期单源) */
  SPEED, SHIFT_SPEED, NOISE_INTERVAL, NOISE_RADIUS, SHOT_NOISE_R,
  RESPAWN_MS, PROTECT_MS, KILL_TARGET, TEAM_KILL_TARGET, RESERVE_CAP,
  NADE_THROW_DIST, NADE_V0, NADE_FRICTION, NADE_STOP_SPEED, NADE_FUSE,
  FLASH_R, FLASH_BLIND_FULL, FLASH_BLIND_BACK, FLASH_FADE, FLASH_NOISE_R,
  SMOKE_R, SMOKE_DUR, SMOKE_FADE, SMOKE_NOISE_R, NADE_CAP,
  BOT_DODGE_DELAY, HIT_TURN_DELAY, ALERT_MS, BOT_SEARCH_MS, BOT_HUNT_TIMEOUT,
  BOT_NADE_CD, BOT_FLASH_INFO_AGE, BOT_FLASH_MIN_DIST,
  BOT_SMOKE_HP, BOT_SMOKE_MAX_DIST, BOT_SMOKE_MIN_DIST, BOT_RETREAT_MS,
  RESCUE_TIME_MS, RESCUE_CHANNEL_MS, EXTRACT_CHANNEL_MS,
  POINT_TIME_MS, CAPTURE_MS, POINT_TICK_MS, POINT_SCORE_TARGET, ZONE_R,
  DOOR_INTERACT_R, BOX_INTERACT_R, DOOR_NOISE_R, DOOR_AUTO_OPEN_R, BOT_CFG,
  BOT_COMBAT_MOVE_MS, BOT_REPOSITION_MS,
  /* 状态层函数(2026-09-05 二期单源) */
  doFire, applyDamage, tryReload, switchWeapon, finishReloadIfDue, checkTeamWin,
  rebuildSightGrid, explosionNoise, explodeNade, updateGrenades, updateSmokes,
  emitNoise, doorNoise, nearestInteractive, interact, botAutoOpen, updateBoxes,
  circleHitsCell, resolveOverlap,
  pickSpawn, spawnFighter, BotBrain,
  _nearestEnemy, _sharedVisionSpot, _flashNadeInCone,
  initObjState, updateObj, objHintFor, updateFighters,
  createState, shiftTimers,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.CQB_SHARED = api;
})(typeof window !== "undefined" ? window : globalThis);

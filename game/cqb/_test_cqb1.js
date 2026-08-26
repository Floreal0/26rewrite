/* cqb1.js 关键算法无头测试 */
const CQB = require("./cqb1.js");
const C = CQB.CELL;

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else { passed++; console.log("PASS:", msg); }
}
const approx = (a, b, eps) => Math.abs(a - b) <= (eps || 0.5);

/* ---- 网格构建 ---- */
const grid = CQB.buildGrid(CQB.MAP_DATA);
ok(grid.length === 40 && grid[0].length === 56, "网格尺寸 56×40");
ok(CQB.solidAt(grid, 0, 0) && CQB.solidAt(grid, 55, 39), "边界为墙");
ok(!grid[16][20], "大厅中心是地板");
ok(grid[11][19] === 1, "掩体箱(19,11)实心");
ok(!grid[5][14], "门洞(14,5)可通行");

/* ---- 射线 DDA ---- */
{
  const d = CQB.dda(grid, 19.5 * C, 1.5 * C, Math.PI / 2, 40 * C);
  ok(approx(d, 9.5 * C, 1), `大厅向下射线命中掩体距离 304(实际 ${d.toFixed(1)})`);
}
{
  const d = CQB.dda(grid, 19.5 * C, 1.5 * C, 0, 40 * C);
  ok(approx(d, 5.5 * C, 1), `向右射到大厅东墙 5.5 格(实际 ${(d / C).toFixed(1)} 格)`);
}

/* ---- 视线判定 ---- */
ok(CQB.losClear(grid, 18.5 * C, 5.5 * C, 21.5 * C, 5.5 * C),
   "大厅同行无遮挡视线畅通");
ok(!CQB.losClear(grid, 18.5 * C, 11.5 * C, 21.5 * C, 11.5 * C),
   "横穿掩体箱的视线被阻断");

/* ---- A* 寻路 ---- */
{
  const p = CQB.astar(grid, 2, 2, 20, 36);
  ok(Array.isArray(p) && p.length >= 53, "TL→大会议室 路径存在且长度合理");
  let valid = true;
  for (let i = 0; i < p.length; i++) {
    const gx = Math.floor(p[i][0] / C), gy = Math.floor(p[i][1] / C);
    if (grid[gy][gx]) { valid = false; break; }
    if (i > 0) {
      const pxg = Math.floor(p[i - 1][0] / C), pyg = Math.floor(p[i - 1][1] / C);
      if (Math.abs(gx - pxg) + Math.abs(gy - pyg) !== 1) { valid = false; break; }
    }
  }
  ok(valid, "路径每步相邻且不穿墙");
}

/* ---- 圆体碰撞钳制 ---- */
{
  const f = { x: 1.2 * C, y: 3.5 * C, r: 13 };
  CQB.moveCircle(grid, f, -50, 0);
  ok(approx(f.x, C + 13 + 0.01, 0.1), "左移被边界墙钳制");
}

/* ---- 射击解算:遮挡优先于目标 ---- */
{
  const targets = [{ x: 19.5 * C, y: 15.5 * C, r: 13, id: "bot" }];
  const res = CQB.resolveShotGeometry(grid, 19.5 * C, 2.5 * C, Math.PI / 2, targets, 40 * C);
  ok(res.target === null, "掩体后的目标不会被击中");
  ok(approx(res.endY, 11 * C, 1), "曳光终止在掩体表面");
}
{
  const targets = [{ x: 19.5 * C, y: 15.5 * C, r: 13, id: "bot" }];
  const res = CQB.resolveShotGeometry(grid, 19.5 * C, 12.5 * C, Math.PI / 2, targets, 40 * C);
  ok(res.target !== null, "无遮挡时命中目标");
  ok(approx(res.t, 3 * C - 13, 1.5), "命中点在目标圆边缘");
}

/* ---- 可见多边形 ---- */
{
  const poly = CQB.visibilityPolygon(grid, 20 * C, 16 * C, -Math.PI / 2, CQB.VISION_R);
  ok(poly.length > 8, "可见多边形顶点充足");
  let within = true;
  for (const [px, py] of poly)
    if (Math.hypot(px - 20 * C, py - 16 * C) > CQB.VISION_R + 1) within = false;
  ok(within, "多边形全部位于视野半径内");
  // 贴身环内的点由 entityVisible 的近距规则保证可见(不依赖裸 pip)
  ok(CQB.entityVisible(poly, 20 * C, 16 * C, 20 * C, 15 * C),
     "正前方贴身处可见(entityVisible 近距规则)");
  // 中远距离:pip 判定 —— 掠射补密后近轴区域应可靠
  ok(CQB.pip(poly, 20 * C, 16 * C - 100), "正前方 100px 在多边形内");
  // 出生点与掩体右缘同列,阴影锥偏左:x=615 处于阴影带内
  ok(!CQB.pip(poly, 20 * C - 25, 16 * C - 250), "掩体后方(阴影带内)不可见");
  ok(CQB.pip(poly, 20 * C + 10, 16 * C - 250), "掩体外侧(非阴影)可见");
}

/* ---- Bot 状态机联跑:可见目标 → 反应 → 开枪 ---- */
{
  const bot = CQB.makeFighter({ name: "BOT", isBot: true,
    x: 20 * C, y: 16 * C, facing: Math.PI / 2 });
  const player = CQB.makeFighter({ name: "你", x: 20 * C, y: 24 * C });
  const brain = new CQB.BotBrain(grid, bot);
  let fired = 0;
  let moved = false;
  const lastPos = [bot.x, bot.y];
  for (let i = 0; i < 600; i++) {
    brain.update(1 / 60, i * (1000 / 60), player, () => { fired++; });
    if (!moved && Math.hypot(bot.x - lastPos[0], bot.y - lastPos[1]) > 4) moved = true;
    // 目标偶尔挪动,触发追踪/丢失分支
    if (i === 200) player.x = 30 * C;
    if (i === 400) player.x = 20 * C;
  }
  ok(moved, "Bot 在巡逻/搜索中发生位移");
  ok(fired > 0, `Bot 完成反应并开枪(${fired} 次)`);
}

console.log(failedGlobal());
function failedGlobal() {
  return process.exitCode ? "\nSOME TESTS FAILED" : `\nALL ${passed} CQB TESTS PASSED`;
}

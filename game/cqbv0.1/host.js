/* CQB host 主循环(权威调度,无 DOM 依赖)
 *
 * 设计:
 *   - host 维护一份 core state(所有 fighter + brain + 特效)
 *   - 每个 player(玩家/Bot)有自己的 channel;host 自己走"本地 channel"(同代码路径)
 *   - 60Hz tick:core.updateFighters(state, inputs, dt, now)
 *   - 30Hz snapshot:给每个 channel 算一份 buildSnapshot,附 events
 *   - input 接收走 channel.onmessage:host 把消息按 playerId 路由到 inputs[id]
 *
 * 客户端协议:
 *   client → host:
 *     { type: "input", seq, keys:{...}, aim, fire, fireEdge, reload, switch }
 *     { type: "join",  name }                  // 首次连接
 *   host → client:
 *     { type: "snapshot", selfId, self, enemies, ripples, events, ts, tick }
 *     { type: "welcome", selfId }              // 首次回应,告知自己的 id
 *
 * 可靠性:
 *   - 状态高频不可靠:本设计内嵌(snapshot 30Hz 覆盖,丢了下帧补)
 *   - 事件随 snapshot 走(本帧内原子,延迟 0~50ms)
 *   - 不需要单独的可靠通道 — 简化实现
 */
(function (global) {
"use strict";
const C = (typeof require !== "undefined") ? require("./rules.js") : global.CQB_RULES;

const TICK_HZ = 60;                  // 模拟 tick 频率(逻辑频率)
const SNAPSHOT_HZ = 30;              // snapshot 频率
const SNAPSHOT_INTERVAL = 1000 / SNAPSHOT_HZ;   // ms
const TICK_INTERVAL = 1000 / TICK_HZ;            // ms

let _nextPlayerId = 1;

/* ============================ HostSession ============================
 * 一次游戏会话(对应一个房间)
 * 用法:
 *   const host = new HostSession();
 *   const pid = host.addPlayer({ name: "Alice", isBot: false, channel });
 *   const botId = host.addPlayer({ name: "BOT", isBot: true });
 *   host.start();
 *   // ... host 内部用 setInterval/setTimeout 驱动;测试里手动调 tick()
 */
class HostSession {
  constructor(mapKey, mode, play) {
    this.state = C.createState(mapKey, play || "tdm");
    this.mode = mode || "1v1";
    this.state.teamTarget = C.TEAM_KILL_TARGET[this.mode] || 15;
    this.players = [];                   // [{id, name, isBot, channel?, lastInputSeq, lastSnapshotTick}]
    this.brainById = Object.create(null);
    this._lastTick = 0;                  // 上次 tick 的 now
    this._lastSnapshot = 0;              // 上次 snapshot 的 now
    this._tickCount = 0;                 // tick 计数(用于 snapshot.tick)
    this._closed = false;
    this._snapshotListeners = [];        // 测试用:每次 snapshot 触发回调
    this._lastSeq = Object.create(null); // 每玩家最后消费的 input seq(客户端预测对账用)
    /* 对局信息(地图/规模/阵营/玩法):随快照下发,客户端 HUD 模式说明行消费 */
    this.matchInfo = null;
    /* 内部:从 channel 收 input 用的 dispatcher */
    this._channelHandlers = new Map();   // channel → (msg) => void
  }

  addPlayer({ name, isBot = false, channel = null, team = 0 } = {}) {
    const id = (isBot ? "B" : "P") + (_nextPlayerId++);
    const f = C.makeFighter({ id, name, isBot, team });
    this.state.fighters.push(f);
    this.players.push({
      id, name, isBot, channel,
      lastInputSeq: -1,                  // 旧 input 包丢弃
      lastSnapshotTick: -1,
    });
    if (isBot) {
      this.brainById[id] = new C.BotBrain(this.state.grid, f,
        this.state.md && this.state.md.rooms, this.state.doorSet, this.state.sightGrid);
      this.state.brainById[id] = this.brainById[id];
    } else {
      // 玩家也注册 brain(虽然不会用)— 保持数据一致,简化 updateFighters 分支
      // 实际:updateFighters 根据 isBot 走 Bot 分支,玩家不走 brain
      this.state.brainById[id] = null;
    }
    C.spawnFighter(this.state, f);
    if (channel) this._bindChannel(channel, id);
    return id;
  }

  /* 按 mode("1v1"/"2v2"/"3v3")给两队补 Bot 至满员(真人先占名额) */
  fillBots(mode) {
    const size = Math.max(1, parseInt((mode || this.mode), 10) || 1);
    let botNo = this.players.filter((p) => p.isBot).length;
    for (const team of [0, 1]) {
      while (this.state.fighters.filter((f) => f.team === team).length < size) {
        botNo++;
        this.addPlayer({ name: botNo === 1 ? "BOT" : "BOT·" + botNo, isBot: true, team });
      }
    }
  }

  _bindChannel(channel, playerId) {
    /* 同一 channel 只能绑一个 player(避免 id 路由歧义) */
    if (this._channelHandlers.has(channel)) {
      throw new Error("channel already bound to another player");
    }
    const handler = (msg) => this._onMessage(playerId, msg);
    this._channelHandlers.set(channel, handler);
    channel.onmessage = handler;
    /* 给新加入的 client 推送 welcome,告知自己的 id */
    try {
      channel.send({ type: "welcome", selfId: playerId });
    } catch (e) { /* channel not open yet, 忽略 */ }
  }

  _onMessage(playerId, msg) {
    if (this._closed) return;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "input") {
      /* 序号去重:旧包直接丢 */
      const p = this.players.find((x) => x.id === playerId);
      if (!p) return;
      if (typeof msg.seq === "number" && msg.seq <= p.lastInputSeq) return;
      p.lastInputSeq = msg.seq ?? p.lastInputSeq;
      /* 把 input 暂存到 state.fighters[i].__pendingInput,tick 时消费 */
      const f = this.state.fighters.find((x) => x.id === playerId);
      if (!f) return;
      f.__pendingInput = msg;
    }
    /* 其它消息类型(input 之外)目前不处理;扩展接口预留 */
  }

  /* 本地玩家(房主)input 直喂:host 不经 channel,与网络 input 走同一 _onMessage 路径 */
  feedInput(playerId, msg) {
    this._onMessage(playerId, msg);
  }

  /* 构造本帧的 inputs 字典,从 __pendingInput 收集 */
  _collectInputs() {
    const inputs = Object.create(null);
    for (const f of this.state.fighters) {
      if (f.__pendingInput) {
        inputs[f.id] = f.__pendingInput;
        /* 消费后即删除:下一帧 client 未发包则按零输入推进计时器 */
        delete f.__pendingInput;
      } else {
        inputs[f.id] = { keys: {} };    // 空 input(继续推计时器)
      }
    }
    return inputs;
  }

  /* 推一帧(测试 / 真实循环都调这个) */
  tick(now) {
    if (this._closed) return;
    const dt = (this._lastTick > 0)
      ? Math.min(0.05, (now - this._lastTick) / 1000)
      : 1 / TICK_HZ;
    this._lastTick = now;
    this._tickCount++;

    const inputs = this._collectInputs();
    for (const p of this.players) {
      const inp = inputs[p.id];
      if (inp && typeof inp.seq === "number") this._lastSeq[p.id] = inp.seq;
    }
    C.updateFighters(this.state, inputs, dt, now);

    /* 30Hz snapshot — 用整数 tick 数对齐,避免浮点漂移导致漏触发
     * 期望:每 SNAPSHOT_INTERVAL ms 一次 */
    if (this._lastSnapshot === 0) {
      this._lastSnapshot = now;
      this._broadcastSnapshots(now);
    } else if (now - this._lastSnapshot >= SNAPSHOT_INTERVAL - 1) {
      this._lastSnapshot = now;
      this._broadcastSnapshots(now);
    }
  }

  _broadcastSnapshots(now) {
    for (const p of this.players) {
      if (p.isBot) continue;            // Bot 不需要 snapshot
      const snap = C.buildSnapshot(this.state, p.id, this.state.fighters);
      if (!snap) continue;
      snap.tick = this._tickCount;
      /* 客户端预测对账:回声最后消费的 input seq(自体移动预测用,2026-09-05) */
      snap.self.seq = this._lastSeq[p.id];
      if (this.matchInfo) snap.match = this.matchInfo;
      /* 附加本帧 events(每个 player 看到自己的视角,这里统一附全 — client 按需过滤) */
      snap.events = this.state.events.slice();
      /* 测试 hook */
      for (const fn of this._snapshotListeners) fn(p.id, snap);
      /* 推到 channel */
      if (p.channel && p.channel.state === "open") {
        try { p.channel.send(snap); } catch (e) { /* 容错 */ }
      }
    }
    /* events 已经过 snapshot 下发,清空(避免下一帧重复) */
    this.state.events.length = 0;
  }

  /* 启动 setInterval 驱动(浏览器用);测试中不调,手动 tick */
  start() {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => this.tick(Date.now()), TICK_INTERVAL);
  }
  stop() {
    this._closed = true;
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
  }

  /* 测试辅助:订阅 snapshot */
  onSnapshot(fn) { this._snapshotListeners.push(fn); }

  /* 对局信息(enterGameAsHost 填充):随每份快照下发 */
  setMatchInfo(info) { this.matchInfo = info; }
}

const api = { HostSession, TICK_HZ, SNAPSHOT_HZ };
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.CQB_HOST = api;
})(typeof window !== "undefined" ? window : globalThis);

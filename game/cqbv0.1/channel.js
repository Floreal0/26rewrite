/* CQB 二期 B 批 · 数据通道抽象
 *
 * 两种实现:
 *   1. MemoryChannel(测试用,无依赖) — 内存队列 + 投递
 *   2. RTCChannel(生产用,基于浏览器原生 WebRTC) — DataChannel 封装
 *
 * 统一接口:
 *   - send(msg): 发送消息对象(由 protocol.js 编码)
 *   - onmessage: 接收消息回调(msg) => void
 *   - close(): 关闭通道
 *   - state: 'connecting' | 'open' | 'closed'
 *
 * RTCChannel 信令流程(双方手动复制 SDP 文本,零服务器):
 *   主动方:
 *     const a = new RTCChannel();
 *     const offer = await a.createOffer();
 *     // 把 offer.sdp + offer.ice 复制给对方
 *   被动方:
 *     const b = new RTCChannel();
 *     const answer = await b.acceptOffer({sdp, ice});
 *     // 把 answer.sdp + answer.ice 复制给主动方
 *   主动方:
 *     await a.acceptAnswer({sdp, ice});
 *     // a.state 变成 'open',DataChannel 就绪
 *
 * MemoryChannel 同步投递(同进程内),测试断言可读。
 * RTCChannel 异步投递(DataChannel 消息事件),生产使用。
 */
(function (global) {
"use strict";

/* Yield a task in both browsers and the Node-based mock test environment. */
function yieldTask() {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/* ============ MemoryChannel: 纯内存,测试用 ============ */
class MemoryChannel {
  constructor() {
    this.state = "open";
    this._onmessage = null;
    this._peer = null;     // 对方通道(由 link() 设置)
  }
  send(msg) {
    if (this.state === "closed") return;            // close 后静默失败,容错
    if (!this._peer) return;                         // 单边 send 不报错(对端未链接)
    this._peer._deliver(msg);
  }
  _deliver(msg) {
    if (this.state === "closed" || !this._onmessage) return;
    this._onmessage(msg);
  }
  set onmessage(fn) { this._onmessage = fn; }
  close() { this.state = "closed"; }
}

/* 互连两条 MemoryChannel 为一对话:任一端 send,另一端 onmessage 触发 */
function linkMemoryChannels(a, b) {
  a._peer = b;
  b._peer = a;
  a.state = "open";
  b.state = "open";
}

/* ============ RTCChannel: WebRTC DataChannel 封装(零信令服务器)============
 * 用法:
 *   const a = new RTCChannel();   // 主动方
 *   const b = new RTCChannel();   // 被动方
 *   const offer = await a.createOffer();
 *   const answer = await b.acceptOffer(offer);
 *   await a.acceptAnswer(answer);
 *   // a.state === b.state === 'open',可以 send / onmessage
 *
 * 流程:
 *   1. 主动方 createOffer → 内部 RTCPeerConnection + DataChannel
 *      把 offer SDP 转 base64,复制给被动方
 *   2. 被动方 acceptOffer(offer) → 自己 RTCPeerConnection,setRemote,生成 answer
 *      把 answer SDP 转 base64,复制回主动方
 *   3. 主动方 acceptAnswer(answer) → setRemote
 *   4. ICE candidates 通过 trickle 或 batch 互传(本实现用 batch 简单)
 *
 * 注意事项:
 *   - 房间码只是"标识",信令靠 SDP 文本复制
 *   - 不穿透 NAT(手动复制,需在同一网络/能直接访问对方剪贴板)
 *   - 生产环境应改成 PeerJS/信令服务器
 */
class RTCChannel {
  constructor() {
    this._pc = null;          // RTCPeerConnection
    this._dc = null;          // RTCDataChannel
    this._onmessage = null;
    this._onstatechange = null;
    this._iceCandidates = []; // 收集本地 candidates,等对方传完再 batch 加
    this._remoteCandidatesPending = [];
    this._sdpResolved = false;
    this._iceWaiterResolve = null;
    this._iceWaiterTimer = null;
    this.state = "idle";      // 'idle' | 'connecting' | 'open' | 'closed'
  }
  set onmessage(fn) { this._onmessage = fn; }
  set onstatechange(fn) { this._onstatechange = fn; }
  _emitState(s) {
    this.state = s;
    if (this._onstatechange) try { this._onstatechange(s); } catch (e) {}
  }

  /* 主动方:创建 offer。返回 { sdp, ice } 给对方。 */
  async createOffer() {
    this._pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this._dc = this._pc.createDataChannel("cqb", { ordered: false, maxRetransmits: 0 });
    this._bindDataChannel(this._dc);
    const iceDone = this._setupIceWaiter();
    this._collectIce();
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await iceDone;
    /* 让 setLocalDescription 触发的 onicecandidate setImmediate 跑完,_sdpResolved 设 true */
    await yieldTask();
    await yieldTask();
    /* 不强制 emit connecting:onopen 可能在 setLocalDescription 之后已经触发过,
     * state 已经是 open,这里再设回 connecting 会覆盖正确状态 */
    if (this.state === "idle") this._emitState("connecting");
    return {
      sdp: this._pc.localDescription.sdp,
      ice: this._iceCandidates.slice(),
    };
  }

  /* 被动方:接受 offer。返回 { sdp, ice } answer 给主动方。 */
  async acceptOffer(offer) {
    this._pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this._pc.ondatachannel = (e) => {
      this._dc = e.channel;
      this._bindDataChannel(this._dc);
    };
    const iceDone = this._setupIceWaiter();
    this._collectIce();
    await this._pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    /* 让 ondatachannel 触发的 setImmediate 跑完,确保 _dc 被设置(mock 用了 2 个 setImmediate) */
    await yieldTask();
    await yieldTask();
    for (const cand of (offer.ice || [])) {
      try { await this._pc.addIceCandidate(cand); } catch (e) { /* 容错 */ }
    }

    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    await iceDone;
    /* 让 setLocalDescription 触发的 onicecandidate setImmediate 跑完,_sdpResolved 设 true */
    await yieldTask();
    await yieldTask();
    if (this.state === "idle") this._emitState("connecting");
    return {
      sdp: this._pc.localDescription.sdp,
      ice: this._iceCandidates.slice(),
    };
  }

  /* 主动方:收 answer */
  async acceptAnswer(answer) {
    if (!this._pc) throw new Error("acceptAnswer: 主动方未创建 offer");
    await this._pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    for (const cand of (answer.ice || [])) {
      try { await this._pc.addIceCandidate(cand); } catch (e) { /* 容错 */ }
    }
  }

  _collectIce() {
    this._pc.onicecandidate = (e) => {
      if (e.candidate === null) {
        /* gathering 完成 */
        this._sdpResolved = true;
        if (this._iceWaiterResolve) {
          if (this._iceWaiterTimer !== null) clearTimeout(this._iceWaiterTimer);
          const resolve = this._iceWaiterResolve;
          this._iceWaiterResolve = null;
          this._iceWaiterTimer = null;
          resolve();
        }
      } else {
        this._iceCandidates.push(e.candidate.toJSON());
      }
    };
  }

  /* 等 ICE gathering 完成。在 setLocalDescription 之前调用,注册一个 promise;
   * setLocalDescription 之后由 onicecandidate(null) resolve 它。
   * 最多等 3s(同 WiFi 一般 < 500ms,跨网段可能 1~2s,3s 足够)。 */
  _setupIceWaiter() {
    if (this._sdpResolved) return Promise.resolve();
    return new Promise((resolve) => {
      this._iceWaiterResolve = resolve;
      this._iceWaiterTimer = setTimeout(() => {
        this._iceWaiterResolve = null;
        this._iceWaiterTimer = null;
        resolve();
      }, 3000);
    });
  }

  _bindDataChannel(dc) {
    dc.onmessage = (e) => {
      if (!this._onmessage) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      try { this._onmessage(msg); } catch (err) { /* 容错 */ }
    };
    dc.onopen = () => this._emitState("open");
    dc.onclose = () => this._emitState("closed");
    if (dc.readyState === "open") this._emitState("open");
  }

  send(msg) {
    if (this.state !== "open") throw new Error("RTCChannel: not open(state=" + this.state + ")");
    this._dc.send(JSON.stringify(msg));
  }
  close() {
    this._emitState("closed");
    if (this._dc) try { this._dc.close(); } catch (e) {}
    if (this._pc) try { this._pc.close(); } catch (e) {}
  }
}

/* ============ SignalChannel: WebSocket 信令 + WebRTC 自动连接 ============
 * 房间码联机(配合 signal/ Worker + Durable Objects):玩家只输 4~6 位房间码,
 * offer/answer/ICE 全自动交换,不出现 SDP 文本。
 *
 * 用法:
 *   const ch = new SignalChannel(signalingUrl, roomCode);
 *   await ch.host();   // 房主:建房 → 等人 → 自动 WebRTC → open
 *   await ch.join();   // 加入者:加入 → 自动 WebRTC → open
 *   ch.send(msg) / ch.onmessage / ch.onstatechange / ch.close()   接口同 RTCChannel
 *   ch.onpeerleft = fn  对方断开信令时回调
 * 信令错误(房间已存在/不存在/已满)→ host()/join() reject Error(message)。
 */
class SignalChannel {
  constructor(signalingUrl, room) {
    this._url = signalingUrl;
    this._room = room;
    this._ws = null;
    this._pc = null;
    this._dc = null;
    this._onmessage = null;
    this._onstatechange = null;
    this._onpeerleft = null;
    this._waiters = [];          // {match, resolve, reject, timer}
    this._pendingIce = [];       // 远端 ICE 早于 setRemoteDescription 到达时暂存
    this.state = "idle";         // 'idle' | 'connecting' | 'open' | 'closed'
  }
  set onmessage(fn) { this._onmessage = fn; }
  set onstatechange(fn) { this._onstatechange = fn; }
  set onpeerleft(fn) { this._onpeerleft = fn; }
  _emitState(s) {
    this.state = s;
    if (this._onstatechange) try { this._onstatechange(s); } catch (e) {}
  }

  _wsSend(obj) {
    if (this._ws && this._ws.readyState === 1) {
      try { this._ws.send(JSON.stringify(obj)); } catch (e) { /* 容错 */ }
    }
  }

  /* 注册一次性消息等待:match(msg) 命中即 resolve */
  _wait(match, timeoutMs, desc) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.match !== match);
        reject(new Error(desc + " 超时"));
      }, timeoutMs);
      this._waiters.push({
        match,
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  _rejectAll(err) {
    const ws = this._waiters.splice(0);
    for (const w of ws) w.reject(err);
  }

  _connectWs() {
    return new Promise((resolve, reject) => {
      this._emitState("connecting");
      let ws;
      try {
        ws = new WebSocket(this._url + "?room=" + encodeURIComponent(this._room));
      } catch (e) { reject(e); return; }
      this._ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => {
        reject(new Error("无法连接信令服务器"));
        this._rejectAll(new Error("无法连接信令服务器"));
      });
      ws.addEventListener("close", () => {
        if (this.state !== "open") this._emitState("closed");
      });
      ws.addEventListener("message", (e) => this._onWsMessage(e.data));
    });
  }

  _onWsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "error") {
      this._rejectAll(new Error(msg.message || "信令错误"));
      return;
    }
    if (msg.type === "peer-left") {
      if (this._onpeerleft) try { this._onpeerleft(); } catch (e) {}
      return;
    }
    if (msg.type === "signal" && msg.data) {
      if (msg.data.ice) {
        if (this._pc && this._remoteSet) {
          try { this._pc.addIceCandidate(msg.data.ice); } catch (e) { /* 容错 */ }
        } else {
          this._pendingIce.push(msg.data.ice);
        }
      }
      if (msg.data.sdp) {
        /* 握手期的 sdp 交给 waiter(offer/answer) */
        for (const w of this._waiters.slice()) {
          if (w.match(msg)) { this._waiters = this._waiters.filter((x) => x !== w); w.resolve(msg); }
        }
      }
      return;
    }
    /* created / room-ready 等 → 交给 waiter */
    for (const w of this._waiters.slice()) {
      if (w.match(msg)) { this._waiters = this._waiters.filter((x) => x !== w); w.resolve(msg); }
    }
  }

  _flushIce() {
    const list = this._pendingIce.splice(0);
    for (const c of list) {
      try { this._pc.addIceCandidate(c); } catch (e) { /* 容错 */ }
    }
  }

  _setupPc(isHost) {
    this._pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    if (isHost) {
      this._dc = this._pc.createDataChannel("cqb", { ordered: false, maxRetransmits: 0 });
      this._bindDataChannel(this._dc);
    } else {
      this._pc.ondatachannel = (e) => { this._dc = e.channel; this._bindDataChannel(this._dc); };
    }
    this._pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._wsSend({ type: "signal", to: isHost ? "guest" : "host",
          data: { ice: e.candidate.toJSON() } });
      }
    };
  }

  _waitOpen(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (this._dc && this._dc.readyState === "open") { resolve(); return; }
      const t = setTimeout(() => reject(new Error("连接超时(对方未就绪或网络不通)")), timeoutMs);
      this._openWaiter = () => { clearTimeout(t); resolve(); };
    });
  }

  _bindDataChannel(dc) {
    dc.onmessage = (e) => {
      if (!this._onmessage) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      try { this._onmessage(msg); } catch (err) { /* 容错 */ }
    };
    dc.onopen = () => {
      this._emitState("open");
      if (this._openWaiter) { const f = this._openWaiter; this._openWaiter = null; f(); }
    };
    dc.onclose = () => this._emitState("closed");
    if (dc.readyState === "open") {
      this._emitState("open");
      if (this._openWaiter) { const f = this._openWaiter; this._openWaiter = null; f(); }
    }
  }

  /* 房主:建房 → 等加入(room-ready) → offer/answer/ICE 自动交换 → open */
  async host() {
    await this._connectWs();
    this._wsSend({ type: "create", room: this._room });
    await this._wait((m) => m.type === "created", 8000, "建房");
    await this._wait((m) => m.type === "room-ready" && m.role === "host", 60000, "等待加入");
    this._setupPc(true);
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    this._wsSend({ type: "signal", to: "guest", data: { sdp: this._pc.localDescription.sdp } });
    const ans = await this._wait((m) => m.type === "signal" && m.data && m.data.sdp, 60000, "等待加入");
    await this._pc.setRemoteDescription({ type: "answer", sdp: ans.data.sdp });
    this._remoteSet = true;
    this._flushIce();
    await this._waitOpen();
    return this;
  }

  /* 加入者:加入 → 收 offer → 回 answer → open */
  async join() {
    await this._connectWs();
    this._wsSend({ type: "join", room: this._room });
    await this._wait((m) => m.type === "room-ready" && m.role === "guest", 8000, "加入");
    this._setupPc(false);
    const off = await this._wait((m) => m.type === "signal" && m.data && m.data.sdp, 60000, "等待 offer");
    await this._pc.setRemoteDescription({ type: "offer", sdp: off.data.sdp });
    this._remoteSet = true;
    this._flushIce();
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    this._wsSend({ type: "signal", to: "host", data: { sdp: this._pc.localDescription.sdp } });
    await this._waitOpen();
    return this;
  }

  send(msg) {
    if (this.state !== "open") throw new Error("SignalChannel: not open(state=" + this.state + ")");
    this._dc.send(JSON.stringify(msg));
  }
  close() {
    this._emitState("closed");
    if (this._dc) try { this._dc.close(); } catch (e) {}
    if (this._pc) try { this._pc.close(); } catch (e) {}
    if (this._ws) try { this._ws.close(); } catch (e) {}
  }
}

/* 编码/解码 SDP 信令包为 base64,便于在剪贴板/输入框传递
 * (SDP 含换行,直接传剪贴板不稳,base64 后变单行) */
function encodeSignal(signal) {
  return btoa(JSON.stringify(signal));
}
function decodeSignal(text) {
  return JSON.parse(atob(text));
}

/* ============ MqttChannel: 公共 MQTT broker 信令(国内可达备选) ============
 * 话题 cqb/signal/<6位房间码>,加入者先进房广播 hello,房主看到后再生成 offer;
 * P2P open 后自动断开 MQTT(游戏数据不走 broker)。
 * 接口同 SignalChannel:host()/join()/send()/onmessage/onstatechange/close。
 * 安全边界:公共话题无房间隔离——6 位码(枚举 10 亿级)+ 首个 host 声明生效 + guest 取首个 offer;
 * 对端断开无 MQTT 事件,联机中断由 DataChannel onclose 感知(state → closed)。
 * 依赖:浏览器全局 mqtt(vendor/mqtt.min.js)或 Node require("mqtt")。
 */
const MQTT_BROKERS_DEFAULT = [
  "wss://broker-cn.emqx.io:8084/mqtt",    // EMQX 国内节点(实测可达)
  "wss://broker.emqx.io:8084/mqtt",       // EMQX 全球节点(降级)
];

class MqttChannel {
  constructor(brokers, room, opts = {}) {
    this._brokers = Array.isArray(brokers) ? brokers : MQTT_BROKERS_DEFAULT;
    this._room = room;
    this._opts = Object.assign({ connectTimeoutMs: 12000, waitTimeoutMs: 60000 }, opts);
    this._topic = "cqb/signal/" + room;
    this._cid = "cqb-" + Math.random().toString(16).slice(2, 10);   // 过滤 broker 自身回显
    this._mqtt = null;
    this._pc = null;
    this._dc = null;
    this._onmessage = null;
    this._onstatechange = null;
    this._waiters = [];
    this._pendingIce = [];
    this._remoteSet = false;
    this._openWaiter = null;
    this._role = null;
    this.state = "idle";         // 'idle' | 'connecting' | 'open' | 'closed'
  }
  set onmessage(fn) { this._onmessage = fn; }
  set onstatechange(fn) { this._onstatechange = fn; }
  _emitState(s) {
    this.state = s;
    if (this._onstatechange) try { this._onstatechange(s); } catch (e) {}
  }

  _wait(match, timeoutMs, desc) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.match !== match);
        reject(new Error(desc + " 超时"));
      }, timeoutMs);
      this._waiters.push({
        match,
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }
  _resolveWaiters(msg) {
    for (const w of this._waiters.slice()) {
      if (w.match(msg)) { this._waiters = this._waiters.filter((x) => x !== w); w.resolve(msg); }
    }
  }
  _rejectAll(err) {
    for (const w of this._waiters.splice(0)) w.reject(err);
  }

  /* 依次尝试 broker 列表,第一个连上+订阅成功的胜出 */
  _connectMqtt() {
    const tryOne = (i) => {
      if (i >= this._brokers.length) {
        return Promise.reject(new Error("无法连接任何信令 broker"));
      }
      const mqttLib = global.mqtt ||
        (typeof require !== "undefined" ? require("mqtt") : null);
      if (!mqttLib) return Promise.reject(new Error("MQTT 库未加载(需要 vendor/mqtt.min.js)"));
      this._emitState("connecting");
      return new Promise((resolve, reject) => {
        let client;
        try {
          client = mqttLib.connect(this._brokers[i], {
            connectTimeout: this._opts.connectTimeoutMs,
            clientId: this._cid + "-" + i,
            clean: true,
          });
        } catch (e) { reject(e); return; }
        client.on("connect", () => resolve(client));
        client.on("error", (e) => {
          try { client.end(true); } catch (err) {}
          reject(e);
        });
        setTimeout(() => {
          if (!client.connected) {
            try { client.end(true); } catch (err) {}
            reject(new Error("connect 超时"));
          }
        }, this._opts.connectTimeoutMs + 2000);
      }).then((client) => {
        this._mqtt = client;
        client.on("message", (t, payload) => this._onMqttMessage(payload));
        return new Promise((resolve, reject) => {
          client.subscribe(this._topic, { qos: 1 }, (err) => {
            if (err) reject(new Error("订阅失败: " + err.message));
            else resolve();
          });
        });
      }).catch((e) => tryOne(i + 1));
    };
    return tryOne(0);
  }

  _sig(obj) {
    if (this._mqtt && this._mqtt.connected) {
      try { this._mqtt.publish(this._topic, JSON.stringify(obj), { qos: 1 }); } catch (e) {}
    }
  }

  _onMqttMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.cid === this._cid) return;              // 忽略 broker 回显的自家消息
    if (msg.data && msg.data.ice) {
      if (this._pc && this._remoteSet) {
        try { this._pc.addIceCandidate(msg.data.ice); } catch (e) {}
      } else {
        this._pendingIce.push(msg.data.ice);
      }
      return;
    }
    this._resolveWaiters(msg);
  }

  _setupPc(isHost) {
    this._pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    if (isHost) {
      this._dc = this._pc.createDataChannel("cqb", { ordered: false, maxRetransmits: 0 });
      this._bindDataChannel(this._dc);
    } else {
      this._pc.ondatachannel = (e) => { this._dc = e.channel; this._bindDataChannel(this._dc); };
    }
    this._pc.onicecandidate = (e) => {
      if (e.candidate) this._sig({ type: "ice", role: this._role, cid: this._cid, data: { ice: e.candidate.toJSON() } });
    };
  }
  _flushIce() {
    for (const c of this._pendingIce.splice(0)) {
      try { this._pc.addIceCandidate(c); } catch (e) {}
    }
  }
  _bindDataChannel(dc) {
    dc.onmessage = (e) => {
      if (!this._onmessage) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      try { this._onmessage(msg); } catch (err) {}
    };
    dc.onopen = () => {
      this._emitState("open");
      if (this._openWaiter) { const f = this._openWaiter; this._openWaiter = null; f(); }
      /* P2P 已建立,信令 broker 不再需要 */
      if (this._mqtt) try { this._mqtt.end(true); } catch (e) {}
    };
    dc.onclose = () => this._emitState("closed");
    if (dc.readyState === "open") {
      this._emitState("open");
      if (this._openWaiter) { const f = this._openWaiter; this._openWaiter = null; f(); }
    }
  }
  _waitOpen() {
    return new Promise((resolve, reject) => {
      if (this._dc && this._dc.readyState === "open") { resolve(); return; }
      const t = setTimeout(() => reject(new Error("连接超时(对方未就绪或网络不通)")), this._opts.waitTimeoutMs);
      this._openWaiter = () => { clearTimeout(t); resolve(); };
    });
  }

  /* 房主:订阅 → 等 guest hello → offer/answer/ICE → open */
  async host() {
    await this._connectMqtt();
    this._role = "host";
    await this._wait((m) => m.type === "hello" && m.role === "guest", this._opts.waitTimeoutMs, "等待加入");
    this._setupPc(true);
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    this._sig({ type: "sdp", role: "host", cid: this._cid, data: { sdp: this._pc.localDescription.sdp } });
    const ans = await this._wait((m) => m.type === "sdp" && m.role === "guest" && m.data && m.data.sdp,
      this._opts.waitTimeoutMs, "等待 answer");
    await this._pc.setRemoteDescription({ type: "answer", sdp: ans.data.sdp });
    this._remoteSet = true;
    this._flushIce();
    await this._waitOpen();
    return this;
  }

  /* 加入者:订阅 → 广播 hello(三次,防房主晚订阅) → 等 offer → answer → open */
  async join() {
    await this._connectMqtt();
    this._role = "guest";
    this._setupPc(false);
    this._sig({ type: "hello", role: "guest", cid: this._cid });
    const helloTimer = setInterval(() => {
      if (this.state === "open" || this._remoteSet) { clearInterval(helloTimer); return; }
      this._sig({ type: "hello", role: "guest", cid: this._cid });
    }, 2000);
    setTimeout(() => clearInterval(helloTimer), 20000);
    const off = await this._wait((m) => m.type === "sdp" && m.role === "host" && m.data && m.data.sdp,
      this._opts.waitTimeoutMs, "等待 offer");
    clearInterval(helloTimer);
    await this._pc.setRemoteDescription({ type: "offer", sdp: off.data.sdp });
    this._remoteSet = true;
    this._flushIce();
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    this._sig({ type: "sdp", role: "guest", cid: this._cid, data: { sdp: this._pc.localDescription.sdp } });
    await this._waitOpen();
    return this;
  }

  send(msg) {
    if (this.state !== "open") throw new Error("MqttChannel: not open(state=" + this.state + ")");
    this._dc.send(JSON.stringify(msg));
  }
  close() {
    this._emitState("closed");
    if (this._dc) try { this._dc.close(); } catch (e) {}
    if (this._pc) try { this._pc.close(); } catch (e) {}
    if (this._mqtt) try { this._mqtt.end(true); } catch (e) {}
  }
}

const api = { MemoryChannel, linkMemoryChannels, RTCChannel, SignalChannel, MqttChannel, MQTT_BROKERS_DEFAULT, encodeSignal, decodeSignal };
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.CQB_CHANNEL = api;
})(typeof window !== "undefined" ? window : globalThis);

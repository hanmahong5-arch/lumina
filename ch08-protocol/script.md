# Chapter 8: Protocol — 演讲逐字稿

> 时长：60 分钟 | 22 张幻灯片

---

## 👉 Slide 1 — Cover

**[00:00]**

Bridge 协议是 agent 的神经传导系统，从 v1 到 v2 经历了一次关键的架构瘦身。

**[00:15]**

v1 的环境注册就像先租办公室再上班：Register → Poll → Decode → Connect，四步三次往返才能开始流式传输。v2 直接刷工卡进门：create session → bridge 换 JWT → SSE 流，两步一次往返。Environment 抽象层整层砍掉——session 直接 OAuth 认证，不再经过 env 中间人。

**[00:45]**

60 分钟，22 张幻灯片。源码在 `src/bridge/` 下六七个文件。架构对比 → v2 epoch 机制 → 退避矩阵 → 三层去重 → 协议对比 → 模式总结。

---

## 👉 Slide 2 — SourceMap

**[01:10]**

核心源码地图：

- `src/bridge/bridgeEnabled.ts` — 入口门控：entitlement + GrowthBook flag
- `src/bridge/bridgeMain.ts` — v1 daemon 主循环：BackoffConfig、SPAWN_SESSIONS、poll loop
- `src/bridge/remoteBridgeCore.ts` — v2 env-less 核心：session create → /bridge → SSE → JWT refresh
- `src/bridge/initReplBridge.ts` — REPL 入口：gate 检查、title 派生、OAuth token 管理
- `src/bridge/replBridge.ts` — v1 env-based：HybridTransport、状态机、消息路由
- `src/bridge/bridgeMessaging.ts` — 共享传输层：类型守卫、BoundedUUIDSet、去重
- `src/bridge/replBridgeTransport.ts` — 传输抽象：统一 v1/v2 接口
- `src/bridge/envLessBridgeConfig.ts` — v2 配置：心跳、退避、超时、去重缓冲区

**[01:55]**

`initReplBridge.ts` 是入口，按 feature gate 路由到 `replBridge.ts`（v1）或 `remoteBridgeCore.ts`（v2）。两者共享 `bridgeMessaging.ts` 和 `replBridgeTransport.ts`。

---

## 👉 Slide 3 — Overview（v1 / v2）

**[02:40]**

**v1（Env-based）**——历史架构，核心是 "Environment" 中间层：
1. Register Environment → env_id + env_secret
2. Long-poll /work → work_secret（session_id + worker JWT）
3. Decode work_secret → WebSocket/HybridTransport
4. 执行会话 → POST /stop → 继续 poll

**[03:10]**

**v2（Env-less）**——砍掉 Environment API 层：
1. POST /v1/code/sessions → session_id（OAuth 认证，无 env_id）
2. POST /sessions/{id}/bridge → worker_jwt + expires_in + api_base_url + worker_epoch
3. createV2ReplTransport → SSE 读 + CCRClient 写
4. JWT 主动刷新 → 重新调 /bridge → 新 epoch → 重建 transport

**[03:40]**

```
// src/bridge/remoteBridgeCore.ts
"Env-less" = no Environments API layer. Distinct from "CCR v2" transport.
// This file is about removing the poll/dispatch layer.
```

Env-less 去的是 poll/dispatch 层，不是传输协议。v1 也能用 CCR v2 传输。

**[04:05]**

迁移动机：**理由一**，CCR /worker/* 端点需 worker 角色 JWT，历史上仅 work-dispatch 能铸造。Server PR #292605 新增 /bridge 端点，OAuth → worker_jwt 直换，env 层变可选。**理由二**，往返减半：四步 → 两步。

---

## 👉 Slide 4 — Handle（6 方法）

**[04:50]**

`ReplBridgeHandle` 六方法——消息 + 控制双通道：

```
// src/bridge/replBridge.ts
writeMessages(msgs)        -> 转换并发送用户/助手消息
writeSdkMessages(msgs)     -> 直接发送已转换 SDK 消息
sendControlRequest(req)    -> 控制信号（权限、模型切换）
sendControlResponse(resp)  -> 回复远端控制请求
sendControlCancelRequest(id)-> 取消待处理控制请求
sendResult()               -> 通知会话完成
teardown()                 -> 清理连接
```

**[05:30]**

消息通道传输对话内容，控制通道传输带外信号——权限授予、模型切换、中断。

---

## 👉 Slide 5 — V1 Flow

**[06:00]**

```
启动 → createBridgeApiClient → registerWorker
  → poll /work → work_secret
  → decodeWorkSecret → session_id + worker_jwt
  → safeSpawn(spawner) → SessionHandle
  → 监控状态 → POST /stop
  → 继续 poll
```

**[06:30]**

`runBridgeLoop` 签名暴露复杂度：
```
config, environmentId, environmentSecret, api,
spawner, logger, signal, backoffConfig, initialSessionId
```

有状态 long-poll 循环，server 需维护 environment 状态。`SPAWN_SESSIONS_DEFAULT = 32` — daemon 最大并发会话数。

---

## 👉 Slide 6 — V2 Flow

**[07:05]**

v2 显著更简洁——`remoteBridgeCore.ts`：

**Step 1：create session**
```
// POST /v1/code/sessions → session.id
withRetry(() => createCodeSession(baseUrl, accessToken, title, ...))
```

**Step 2：fetch bridge credentials**
```
// POST /sessions/{id}/bridge → {worker_jwt, expires_in, api_base_url, worker_epoch}
withRetry(() => fetchRemoteCredentials(...))
```

每次调 /bridge 都 bump epoch——**/bridge 即 register**，无单独 /worker/register。

**[07:45]**

**Step 3：build transport**
```
createV2ReplTransport({
  ingressToken: credentials.worker_jwt,
  epoch: credentials.worker_epoch,
  heartbeatIntervalMs: cfg.heartbeat_interval_ms,
})
```

**Step 4：JWT refresh scheduler**
```
createTokenRefreshScheduler({
  refreshBufferMs: 300_000, // 提前 5min
  onRefresh: (sid, oauthToken) => {
    // Re-fetch /bridge -> new JWT + new epoch -> rebuild transport
  }
})
```

**[08:15]**

Epoch 机制：重建 transport 带新 epoch → 旧 transport 心跳收到 409（epoch mismatch）自动停止 → 新 transport 从旧 transport 的 lastSequenceNum 恢复 → 不丢消息。Server 通过 epoch 识别最新 worker。

---

## 👉 Slide 7 — Daemon（backoff）

**[08:55]**

两组退避参数——`BackoffConfig`：

| 参数 | conn*（连接层） | general*（应用层） |
|---|---|---|
| initial | 2s | 500ms |
| cap | 120s | 30s |
| giveUp | 10min | 10min |

连接退避处理 DNS/TLS/TCP 层面故障，覆盖"合盖开盖"场景（Wi-Fi 重连 <30s）。通用退避处理 401/500/Rate limit，500ms 起步——应用层错误多瞬态。

**[09:35]**

对比 gRPC 默认 1s/120s 无限重试：本系统加 10 分钟总预算——10min 无法恢复即持久性故障，继续重试浪费资源。

---

## 👉 Slide 8 — Dedup（ring buffer）

**[10:05]**

两个去重场景：

1. **Echo dedup**：POST 消息在 SSE 读流中回到本地（server 广播），不去重则处理两次
2. **Re-delivery dedup**：transport 重建后 server 从较早 seq 重放

**[10:30]**

`BoundedUUIDSet`——容量 2000 的 FIFO 环形缓冲区：

```
// src/bridge/remoteBridgeCore.ts — 三层去重
recentPostedUUIDs = BoundedUUIDSet(2000)    // echo dedup
initialMessageUUIDs = Set<string>()         // 无界，后备
recentInboundUUIDs = BoundedUUIDSet(2000)   // inbound dedup
```

**[11:00]**

`initialMessageUUIDs` 无界——初始化时填充、不会增长。recentPostedUUIDs 环形缓冲区在大量 live write 后可能驱逐初始 UUID。这是**纵深防御**。

2000 容量理由：典型会话几百条消息 × 4-10 倍余量，36B × 2000 = 72KB。<100 旧消息驱逐后失去去重保护，>5000 不必要。

---

## 👉 Slide 9 — Messaging

**[11:40]**

`bridgeMessaging.ts` 被 v1/v2 共享：

```
类型守卫：isSDKMessage, isSDKControlResponse, isSDKControlRequest
消息过滤：isEligibleBridgeMessage — 仅 user/assistant turn + slash-command system events
  排除：tool_result、progress、virtual messages（REPL 内部调用）
Ingress 解析：handleIngressMessage — 区分三种消息路由回调
控制请求：handleServerControlRequest — set_model/set_permission_mode/interrupt
Title 提取：extractTitleText
```

Virtual 消息 display-only，bridge/SDK 消费者看到 REPL 摘要而非每一步。

---

## 👉 Slide 10 — Transport

**[12:20]**

`ReplBridgeTransport` 接口统一 v1/v2：

```
write(message) / writeBatch(messages) / close()
isConnectedStatus() / getStateLabel()
setOnData / setOnClose / setOnConnect / connect()
getLastSequenceNum() / droppedBatchCount
reportState / reportMetadata / reportDelivery / flush()
```

v1：包装 HybridTransport（WS读 + POST写到 Session-Ingress）。`getLastSequenceNum` 返回 0。

v2：SSETransport（读）+ CCRClient（写 CCR v2 /worker/*）。写路径走 `CCRClient.writeEvent -> SerialBatchEventUploader`，不走 SSETransport.write。

**[13:00]**

`droppedBatchCount` 静默失败检测——v1 HybridTransport 超过 `maxConsecutiveFailures` 后静默丢弃 batch，调用方对比 droppedBatchCount 检测。v2 返回 0——无此行为。

---

## 👉 Slide 11 — V2 Detail（seq-num recovery）

**[13:35]**

SSE + `Last-Event-ID` = 无缝恢复：

```
连接 A (epoch=1) → 收 seq 1,2,...,N → 断开
  getLastSequenceNum() = N
重建连接 B (epoch=2) → 带 Last-Event-ID: N → 从 N+1 开始
```

两个重建触发点：
1. **主动刷新**：JWT 接近过期 → 调 /bridge → 新 JWT + epoch → 从 lastSequenceNum 恢复
2. **401 恢复**：SSE 流 401 → 刷新 OAuth token → 同上

**[14:10]**

防并发 epoch bump——laptop 唤醒时两条恢复路径同时触发：

```
// src/bridge/remoteBridgeCore.ts
if (authRecoveryInFlight || tornDown) return
authRecoveryInFlight = true
// 现在调 /bridge，epoch bump
```

无保护则两者都调 /bridge → epoch bump 两次 → 先完成的 epoch 已过时 → 409。`authRecoveryInFlight` 保证同一时刻仅一条路径执行。

---

## 👉 Slide 12 — Gates（11+）

**[14:45]**

11+ 个 GrowthBook feature gate：

| Gate | 用途 |
|---|---|
| `tengu_ccr_bridge` | 总开关（per-org targeting） |
| `tengu_bridge_repl_v2` | 启用 v2 env-less |
| `tengu_ccr_bridge_multi_session` | --spawn / --capacity |
| `tengu_ccr_bridge_multi_environment` | 多 env per host:dir |
| `checkBridgeMinVersion` | 客户端强制升级 |
| `checkEnvLessBridgeMinVersion` | v2 独立版本下限 |

**[15:20]**

双层门控：

```
// src/bridge/bridgeEnabled.ts
return feature('BRIDGE_MODE')              // 编译时：eliminate string literals
  ? isClaudeAISubscriber()                 // 运行时：entitlement
      && getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge')
  : false
```

编译时门控确保外部构建连 flag 字符串都不存在（防逆向），运行时按 org 精确控制。

---

## 👉 Slide 13 — Init

**[16:00]**

六步初始化：

```
1. isBridgeEnabledBlocking() — 等 GrowthBook 初始化
2. waitForPolicyLimitsToLoad() → isPolicyAllowed('remote_control')
3. checkBridgeMinVersion() / checkEnvLessBridgeMinVersion()
4. getBridgeAccessToken() → checkAndRefreshOAuthTokenIfNeeded()
5. isEnvLessBridgeEnabled() → 选 v1 或 v2
6. initBridgeCore() 或 initEnvLessBridgeCore()
```

`initReplBridge.ts` 独立——bundle splitting：

```
// initReplBridge.ts
// sessionStorage import transitively pulls in
// src/commands.ts → entire slash command + React component tree (~1300 modules)
```

daemon 构建避免包含 ~1300 个不需要的模块。

---

## 👉 Slide 14 — Title derivation

**[17:00]**

标题派生：

- 第 1 条消息：截取前 N 字符作为临时标题
- 第 3 条消息：`generateSessionTitle()` 用 LLM 生成准确标题
- Latch：callback 返回 true 后停止（`userMessageCallbackDone`）

PATCH /sessions/{id} → server。v2 的 sessionId 是 const（无 re-create 路径），不需重置 latch。

---

## 👉 Slide 15 — Init fuse

**[17:40]**

初始化熔断器：

```
// envLessBridgeConfig.ts
init_retry_max_attempts: 3
init_retry_base_delay_ms: 500    // ±25% jitter
init_retry_max_delay_ms: 4000
```

3 次即熔断：~500ms + ~1000ms + ~2000ms ≈ 3.5s（带抖动 4-5s）。

- 1 次太激进——网络瞬断即可恢复
- 5 次太保守——3 次 + backoff 后成功概率极低
- 3 次甜点——覆盖瞬态，7s 内明确失败信号

---

## 👉 Slide 16 — Dead token

**[18:30]**

v2 401 处理：

```
SSE 401 → stale token 标记 → onAuth401(staleToken)
  → 刷新 OAuth（keychain 交互）→ 重调 /bridge
  → 新 worker_jwt + 新 epoch → 重建 transport（保持 seq-num）
```

跨进程死 token 退避——多个 bridge 实例同时发现 token 过期：比较 keychain 当前 token 与传入 stale token，若其他进程已刷新则直接用新 token。

**[19:05]**

连续 3 次认证失败触发上升——与 init fuse 阈值一致，统一"三振出局"策略。

---

## 👉 Slide 17 — Backoff 矩阵

**[19:40]**

| 场景 | 初始 | 上限 | 总预算 |
|---|---|---|---|
| v1 连接退避 | 2s | 120s | 10min |
| v1 通用退避 | 500ms | 30s | 10min |
| v2 初始化重试 | 500ms | 4s | 3次 |
| v2 JWT 刷新 | 提前 5min | — | — |
| v2 心跳 | 20s | — | — |
| v2 连接超时 | 15s | — | — |
| v2 teardown archive | 1.5s | — | — |
| 睡眠检测 | connCap×2 = 240s | — | — |

**[20:20]**

心跳 20s vs server TTL 60s：3 倍余量。丢失一次 40s 仍在 TTL 内。±10% jitter 防 fleet 同步。

---

## 👉 Slide 18 — Compare（WS / SSE / gRPC）

**[20:50]**

| 维度 | WS (v1) | SSE (v2) | gRPC |
|---|---|---|---|
| 方向 | 全双工 | 单向读 + 独立写 | 全双工 |
| 恢复 | 无内置 | Last-Event-ID | 流级 offset |
| 负载均衡 | 粘性会话 | 无状态 | 粘性连接 |
| 代理 | 需要 Upgrade | 标准 HTTP | 需要 HTTP/2 |
| 认证刷新 | 关闭重连 | 重建 transport 保序列号 | 元数据刷新 |

v1 → v2 收益：
1. Last-Event-ID = 免费断点恢复
2. 分离读写——写走 CCRClient/SerialBatchEventUploader，无消息大小限制
3. 代理友好——SSE 是标准 HTTP long connection

---

## 👉 Slide 19 — Patterns

**[22:10]**

**模式一：双层门控**
编译时消除字符串 + 运行时按 org 精确控制。

**模式二：Epoch-based worker rotation**
每次 /bridge bump epoch，旧 worker 心跳 409。比 revocation list 简单——无需撤销列表或 token introspection，仅单调递增计数器。

**模式三：FlushGate — 有序初始化**
```
// flush 完成前排队所有 live write
// 完成后释放：[history..., live...]
```

**模式四：Latch callback**
硬件锁存器模式——翻转后不可逆。第 3 条消息后标题已足够好，不再调 LLM。无 off-by-one 风险。

**模式五：纵深防御去重**
三层 UUID set 覆盖 echo-dedup、initial-fallback、re-delivery-dedup。每层不同故障模式，组合后 100% 去重。

---

## 👉 Slide 20 — Constants

**[24:10]**

```
SPAWN_SESSIONS_DEFAULT     = 32
connInitialMs = 2_000    connCapMs = 120_000    connGiveUpMs = 600_000
generalInitialMs = 500   generalCapMs = 30_000  generalGiveUpMs = 600_000
init_retry_max_attempts  = 3
uuid_dedup_buffer_size   = 2000
heartbeat_interval_ms    = 20_000   (server TTL 60s, 3x margin)
token_refresh_buffer_ms  = 300_000  (5min before expiry)
connect_timeout_ms       = 15_000
teardown_archive_timeout = 1_500
sleep detection          = connCapMs * 2 = 240s
```

每个常量附注释解释原因，关键常量间保持数学关系（heartbeat × 3 < TTL, sleepDetection = connCap × 2）。

---

## 👉 Slide 21 — Summary

**[25:20]**

五大核心洞察：

1. **v1 → v2 架构简化正确**：移除 env 层减少往返、消除 server 状态管理、v2 core ~500 行 vs v1 ~2400 行
2. **Epoch > Token Revocation**：单调递增 epoch 做 worker rotation，无需 revocation list
3. **SSE Last-Event-ID + 三层 UUID 去重 = exactly-once 基础**
4. **退避矩阵按故障域定制**：连接/应用/初始化各有参数，一刀切不够精细
5. **双层门控是敏感功能最佳实践**：编译时消除字符串 + 运行时精确控制

---

## 👉 Slide 22 — QA

**[26:00]**

预设问题：

**Q1：v2 何时完全替代 v1？**

v2 目前仅支持 REPL 模式。Daemon 的 work-dispatch 需 server 端实现 session-level work routing——更大的架构变更。

**Q2：心跳为什么 20s 而不是 5s？**

20s × 3 = server TTL 60s。5s 增加网络和 server 负载。±10% jitter 确保 fleet 分散——1000 client 在 18-22s 窗口内到达。

**Q3：BoundedUUIDSet 为什么 ring buffer 而非 LRU？**

Ring buffer O(1) 插入 + O(1) 驱逐，无 hash table 开销。去重只需 membership test + 驱逐最老——FIFO 足够。LRU 每个 entry 多 64 字节指针。

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: 01-cover
Slide 2: Ch 08 Protocol
Slide 3: Ch 08 Protocol
Slide 4: Ch 08 Protocol
Slide 5: Ch 08 Protocol
Slide 6: Ch 08 Protocol
Slide 7: Ch 08 Protocol
Slide 8: Ch 08 Protocol
Slide 9: Ch 08 Protocol
Slide 10: Ch 08 Protocol
Slide 11: Ch 08 Protocol
Slide 12: Ch 08 Protocol
Slide 13: Ch 08 Protocol
Slide 14: Ch 08 Protocol
Slide 15: Ch 08 Protocol
Slide 16: Ch 08 Protocol
Slide 17: Ch 08 Protocol
Slide 18: Ch 08 Protocol
Slide 19: Ch 08 Protocol
Slide 20: Ch 08 Protocol
Slide 21: Ch 08 Protocol
Slide 22: 22-qa
Slide 23: Learning Objectives
Slide 24: Key Terms
Slide 21: CHAPTER 08 | PROTOCOL
Slide 26: See Also
-->
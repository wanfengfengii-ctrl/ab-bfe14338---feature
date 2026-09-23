# 脉冲时标一致性复核台

多台脉冲记录器只有各自的**本地时标**。设记录器 `i` 的真实偏移为整数 `x[i]`，
则事件真实时刻 = 本地时标 + `x[i]`。逐条观测要求

```
真实接收时刻 − 真实发送时刻 ∈ [minDelay, maxDelay]（非负整数闭区间）
```

逐对校时看似合理，却可能：

- 拼出**多组**互不一致的真实时间解释（多解）；
- 甚至**不存在任何**一致解释（不可行）。

本工具是一个 **TypeScript/React 纯前端**复核台：导入或直接编辑模型 JSON，
即时审计偏移可行域，点选任意偏移端点查看**完整可行赋值见证**；全程不调用业务后端。

## 模型格式

```json
{
  "recorders": [
    { "id": "R0", "minOffset": 0, "maxOffset": 0, "reference": true },
    { "id": "R1", "minOffset": -100, "maxOffset": 100 }
  ],
  "events": [
    { "id": "e0", "recorder": "R0", "localTime": 1000 },
    { "id": "e1", "recorder": "R1", "localTime": 1010 }
  ],
  "observations": [
    { "id": "o1", "sendEvent": "e0", "receiveEvent": "e1", "minDelay": 1, "maxDelay": 30 }
  ]
}
```

约束（非法项全部带 `recorders[3].maxOffset` 这样的精确定位反馈）：

- 记录器 2–24 台，`id` 唯一；恰好一台 `reference: true` 且偏移界均为 0；
- 偏移为整数闭区间 `minOffset ≤ maxOffset`，绝对值 ≤ 10⁹；
- 事件全局唯一 `id`、至多 128 个；`localTime` 为绝对值 ≤ 10⁹ 的整数；
  同一记录器上的事件必须按时标**严格递增**；
- 观测至多 256 条，`id` 唯一，连接**不同记录器**上的发送/接收事件，
  `0 ≤ minDelay ≤ maxDelay ≤ 10⁹`，引用必须存在；
- 任何输入变更都会立即重新校验并**清除旧裁决**。

## 裁决原理（差分约束）

引入取值恒为 0 的地面节点 G，把所有约束写成边 `u→v` 表示 `x[v] − x[u] ≤ w`：

- 偏移上界 `x[i] ≤ hi`：`G→i`，权 `hi`；偏移下界 `x[i] ≥ lo`：`i→G`，权 `−lo`；
- 观测（发送机 s / 时标 ts，接收机 r / 时标 tr）：
  - `x[r] − x[s] ≤ ts − tr + maxDelay`（延迟上界）
  - `x[s] − x[r] ≤ tr − ts − minDelay`（延迟下界）

Floyd–Warshall 全源最短路后：

- `x[i]` 紧确最大值 = `dist[G][i]`，紧确最小值 = `−dist[i][G]`；
- 存在负自环 ⇒ 不可行，此时用 Bellman-Ford 提取一条**权值总和严格小于零的闭合约束链**，
  链上偏移项相加抵消，得到 `0 ≤ 负数` 的矛盾；
- 可行时 `xMin = −dist[·][G]` 同时达到全体最小值，`xMax = dist[G][·]`
  同时达到全体最大值（三角不等式保证两点赋值均可行）——它们就是每个端点的完整见证；
- 所有范围均为单点 ⇒ **唯一解**，否则 **多解**。

端点详情列出该见证下**全部偏移**与**每条观测的本地时标、偏移、真实时刻和实际延迟**，
可逐项核对是否落在给定闭区间内。

## 本地开发

```bash
npm ci
npm run dev        # 开发服务器
npm test           # node:test 算法/校验用例
npm run typecheck
npm run build      # 产出 dist/ 纯静态文件
```

## Docker（静态站点）

构建并启动（宿主机端口用 `HOST_PORT` 配置，默认 8080）：

```bash
HOST_PORT=9090 docker compose up -d --build
# 浏览器打开 http://localhost:9090 ；健康检查： GET /health -> ok
```

## 一次性 verify 服务

`verify` 服务**自行退出并以退出码报告结果**，依次执行：

1. 代码：`tsc --noEmit` 类型检查 + `node --test` 算法裁决单测；
2. 构建：Vite 生产构建；
3. HTTP 冒烟：等待 `web` 健康后检查 `/health`、首页、JS/CSS 静态资源，
   并经 HTTP 取得示例模型用同一套裁决代码复算（多解紧确界 / 不可行负链）。

```bash
docker compose run --build verify
# 退出码 0 = 全部通过；非 0 = 对应环节失败
```

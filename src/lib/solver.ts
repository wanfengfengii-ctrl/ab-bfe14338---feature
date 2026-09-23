import type {
  ConstraintChain,
  ConstraintEdge,
  EndpointWitness,
  NormalizedModel,
  RecorderRange,
  Verdict,
} from '../types';

/**
 * 差分约束求解。
 *
 * 设记录器 i 的真实偏移为 x[i]，另设地面节点 G（取值恒 0）。
 * 全部约束都写成边 u→v 表示 x[v] - x[u] <= w：
 *   - 偏移上界 x[i] <= hi          : G → i，权 hi
 *   - 偏移下界 x[i] >= lo          : i → G，权 -lo
 *   - 观测延迟 d ∈ [dmin,dmax]，发送机 s/发送时标 ts，接收机 r/接收时标 tr：
 *       (tr + x[r]) - (ts + x[s]) <= dmax  ⇒ x[r] - x[s] <= ts - tr + dmax  (s → r)
 *       (ts + x[s]) - (tr + x[r]) <= -dmin ⇒ x[s] - x[r] <= tr - ts - dmin  (r → s)
 *
 * Floyd–Warshall 后：
 *   x[i] 的紧确最大值 = dist[G][i]，紧确最小值 = -dist[i][G]；
 *   存在负自环（dist[i][i] < 0）即不可行。
 * 可行时 xMin[i] = -dist[i][G] 是全体最小值同时达到的完整可行赋值，
 * xMax[i] = dist[G][i] 是全体最大值同时达到的完整可行赋值（三角不等式保证）。
 */

export interface SolveArtifacts {
  verdict: Verdict;
  /** 节点编号 -> 记录器 id；最后一个为地面节点 */
  nodeOfRecorder: string[];
  groundNode: number;
  edges: ConstraintEdge[];
}

const nodeName = (recorderIds: string[], ground: number, node: number): string =>
  node === ground ? '0（地面常量）' : `偏移[${recorderIds[node]}]`;

export function audit(model: NormalizedModel): SolveArtifacts {
  const { recorders, events, observations } = model;
  const n = recorders.length;
  const ground = n;
  const N = n + 1;
  const recorderIds = recorders.map((r) => r.id);
  const indexById = new Map(recorders.map((r, i) => [r.id, i]));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const edges: ConstraintEdge[] = [];

  // 偏移界
  recorders.forEach((r, i) => {
    edges.push({
      from: ground,
      to: i,
      weight: r.maxOffset,
      witness: `${nodeName(recorderIds, ground, i)} ≤ ${r.maxOffset}（偏移上界）`,
      sourcePath: `recorders[${i}].maxOffset`,
    });
    edges.push({
      from: i,
      to: ground,
      weight: -r.minOffset,
      witness: `-${nodeName(recorderIds, ground, i)} ≤ ${-r.minOffset}（偏移下界 ${r.minOffset}）`,
      sourcePath: `recorders[${i}].minOffset`,
    });
  });

  // 观测延迟
  observations.forEach((o, oi) => {
    const se = eventById.get(o.sendEvent)!;
    const re = eventById.get(o.receiveEvent)!;
    const s = indexById.get(se.recorder)!;
    const r = indexById.get(re.recorder)!;
    const ts = se.localTime;
    const tr = re.localTime;
    edges.push({
      from: s,
      to: r,
      weight: ts - tr + o.maxDelay,
      witness:
        `偏移[${re.recorder}] - 偏移[${se.recorder}] ≤ ${ts - tr + o.maxDelay}` +
        `（观测 "${o.id}" 延迟上界 ${o.maxDelay}）`,
      sourcePath: `observations[${oi}].maxDelay`,
    });
    edges.push({
      from: r,
      to: s,
      weight: tr - ts - o.minDelay,
      witness:
        `偏移[${se.recorder}] - 偏移[${re.recorder}] ≤ ${tr - ts - o.minDelay}` +
        `（观测 "${o.id}" 延迟下界 ${o.minDelay}）`,
      sourcePath: `observations[${oi}].minDelay`,
    });
  });

  // Floyd–Warshall
  const INF = Number.POSITIVE_INFINITY;
  const dist: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(INF));
  for (let i = 0; i < N; i++) dist[i][i] = 0;
  // 记录最短路上的边，供需要时溯源（Floyd 本身不重建路径，负环用 BF 提取）
  for (const e of edges) {
    if (e.weight < dist[e.from][e.to]) dist[e.from][e.to] = e.weight;
  }
  for (let k = 0; k < N; k++) {
    const dk = dist[k];
    for (let i = 0; i < N; i++) {
      const dik = dist[i][k];
      if (dik === INF) continue;
      const di = dist[i];
      for (let j = 0; j < N; j++) {
        const cand = dik + dk[j];
        if (cand < di[j]) di[j] = cand;
      }
    }
  }

  let negNode = -1;
  for (let i = 0; i < N; i++) {
    if (dist[i][i] < 0) {
      negNode = i;
      break;
    }
  }

  if (negNode >= 0) {
    const chain = extractNegativeCycle(edges, N, ground, dist);
    return {
      verdict: { status: 'infeasible', chain },
      nodeOfRecorder: recorderIds,
      groundNode: ground,
      edges,
    };
  }

  const xMin: number[] = [];
  const xMax: number[] = [];
  for (let i = 0; i < n; i++) {
    xMin.push(-dist[i][ground]);
    xMax.push(dist[ground][i]);
  }

  const ranges: RecorderRange[] = recorders.map((r, i) => ({
    recorderId: r.id,
    min: xMin[i],
    max: xMax[i],
    reference: r.reference === true,
  }));

  const makeWitness = (endpoint: 'min' | 'max', x: number[]): EndpointWitness => {
    const offsets: Record<string, number> = {};
    recorders.forEach((r, i) => {
      offsets[r.id] = x[i];
    });
    const observationDelays = observations.map((o) => {
      const se = eventById.get(o.sendEvent)!;
      const re = eventById.get(o.receiveEvent)!;
      const sendTrue = se.localTime + x[indexById.get(se.recorder)!];
      const receiveTrue = re.localTime + x[indexById.get(re.recorder)!];
      const actualDelay = receiveTrue - sendTrue;
      return {
        observationId: o.id,
        sendEvent: o.sendEvent,
        receiveEvent: o.receiveEvent,
        sender: se.recorder,
        receiver: re.recorder,
        minDelay: o.minDelay,
        maxDelay: o.maxDelay,
        sendLocal: se.localTime,
        receiveLocal: re.localTime,
        sendTrue,
        receiveTrue,
        actualDelay,
        feasible: actualDelay >= o.minDelay && actualDelay <= o.maxDelay,
      };
    });
    return {
      recorderId: '',
      endpoint,
      value: 0,
      offsets,
      observationDelays,
    };
  };

  const allMinWitness = makeWitness('min', xMin);
  const allMaxWitness = makeWitness('max', xMax);

  const unique = ranges.every((rg) => rg.min === rg.max);

  return {
    verdict: {
      status: unique ? 'unique' : 'multiple',
      ranges,
      allMinWitness,
      allMaxWitness,
    },
    nodeOfRecorder: recorderIds,
    groundNode: ground,
    edges,
  };
}

/**
 * 用 Bellman-Ford 从地面节点提取一个真实的负权闭合约束链。
 * 所有变量节点同时存在出入地面的界边，故地面可到达全部节点。
 */
function extractNegativeCycle(
  edges: ConstraintEdge[],
  N: number,
  ground: number,
  _dist: number[][],
): ConstraintChain {
  const dist = new Array<number>(N).fill(Number.POSITIVE_INFINITY);
  const predNode = new Array<number>(N).fill(-1);
  const predEdge = new Array<number>(N).fill(-1);
  dist[ground] = 0;

  let relaxedNode = -1;
  for (let iter = 0; iter < N; iter++) {
    relaxedNode = -1;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const cand = dist[e.from] + e.weight;
      if (cand < dist[e.to]) {
        dist[e.to] = cand;
        predNode[e.to] = e.from;
        predEdge[e.to] = ei;
        relaxedNode = e.to;
      }
    }
  }

  // relaxedNode 在第 N 轮仍可松弛：沿前驱走 N 步必落入环中
  let cur = relaxedNode;
  for (let k = 0; k < N && cur >= 0; k++) cur = predNode[cur];
  if (cur < 0) {
    // 理论上不可达：Floyd 已发现负自环。退化为保护性报错链
    throw new Error('负环提取失败：前驱链中断');
  }

  const cycleEdges: ConstraintEdge[] = [];
  const seen = new Set<number>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const ei = predEdge[cur];
    if (ei < 0) throw new Error('负环提取失败：前驱边缺失');
    cycleEdges.push(edges[ei]);
    cur = predNode[cur];
  }
  // 收集顺序与环方向相反（先收进入环点的边），翻正后第一条边恰从 start 出发
  cycleEdges.reverse();

  const totalWeight = cycleEdges.reduce((s, e) => s + e.weight, 0);

  const lines: string[] = [];
  lines.push('以下约束依次相连形成闭合链：');
  cycleEdges.forEach((e, i) => {
    lines.push(
      `${i + 1}. ${e.witness}`,
    );
  });
  lines.push('将以上不等式左右分别相加，所有偏移项沿闭合链抵消，得到：');
  lines.push(`0 ≤ ${totalWeight}`);

  return {
    edges: cycleEdges,
    totalWeight,
    lines,
    contradiction: `0 ≤ ${totalWeight}（要求 ${totalWeight} ≥ 0，实为严格负数）`,
  };
}

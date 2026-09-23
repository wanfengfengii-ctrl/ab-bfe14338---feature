import type {
  ChosenTier,
  ConstraintChain,
  ConstraintEdge,
  CorrectionPlan,
  CorrectionSearchStats,
  DelayTier,
  EndpointWitness,
  NormalizedModel,
  Observation,
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

const INF = Number.POSITIVE_INFINITY;

const nodeName = (recorderIds: string[], ground: number, node: number): string =>
  node === ground ? '0（地面常量）' : `偏移[${recorderIds[node]}]`;

/** 每条观测解析后的端点信息（建边复用） */
interface ObsEndpoints {
  obs: Observation;
  index: number;
  s: number;
  r: number;
  ts: number;
  tr: number;
  senderId: string;
  receiverId: string;
}

function resolveEndpoints(model: NormalizedModel): ObsEndpoints[] {
  const recorderIds = model.recorders.map((r) => r.id);
  const indexById = new Map(recorderIds.map((id, i) => [id, i]));
  const eventById = new Map(model.events.map((e) => [e.id, e]));
  return model.observations.map((obs, index) => {
    const se = eventById.get(obs.sendEvent)!;
    const re = eventById.get(obs.receiveEvent)!;
    return {
      obs,
      index,
      s: indexById.get(se.recorder)!,
      r: indexById.get(re.recorder)!,
      ts: se.localTime,
      tr: re.localTime,
      senderId: se.recorder,
      receiverId: re.recorder,
    };
  });
}

/**
 * 构造全部差分约束边。
 * @param delays 可选的逐观测延迟覆盖（校正求解用）：
 *   - `[minDelay, maxDelay]`：使用给定区间（校正档位或原档）；
 *   - `null`：该观测不产生任何边（搜索基矩阵中暂未确定档位的观测）；
 *   - `undefined`（整参缺省或该项空缺）：使用观测原区间。
 */
function buildEdges(
  model: NormalizedModel,
  endpoints: ObsEndpoints[],
  ground: number,
  delays?: ((readonly [number, number]) | null)[],
): ConstraintEdge[] {
  const recorderIds = model.recorders.map((r) => r.id);
  const edges: ConstraintEdge[] = [];

  // 偏移界
  model.recorders.forEach((r, i) => {
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

  // 观测延迟（可被校正档位覆盖；null 表示暂不产生边）
  endpoints.forEach(({ obs, index: oi, s, r, ts, tr, senderId, receiverId }) => {
    if (delays && delays[oi] === null) return;
    const override = delays?.[oi];
    const dmin = override ? override[0] : obs.minDelay;
    const dmax = override ? override[1] : obs.maxDelay;
    const corrected = override !== undefined;
    const tag = corrected ? '（校正档位）' : '';
    edges.push({
      from: s,
      to: r,
      weight: ts - tr + dmax,
      witness:
        `偏移[${receiverId}] - 偏移[${senderId}] ≤ ${ts - tr + dmax}` +
        `（观测 "${obs.id}" 延迟上界 ${dmax}）${tag}`,
      sourcePath: `observations[${oi}].maxDelay`,
    });
    edges.push({
      from: r,
      to: s,
      weight: tr - ts - dmin,
      witness:
        `偏移[${senderId}] - 偏移[${receiverId}] ≤ ${tr - ts - dmin}` +
        `（观测 "${obs.id}" 延迟下界 ${dmin}）${tag}`,
      sourcePath: `observations[${oi}].minDelay`,
    });
  });

  return edges;
}

/** Floyd–Warshall 全源最短路（对角线上的负值即负环） */
function floyd(edges: ConstraintEdge[], N: number): number[][] {
  const dist: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(INF));
  for (let i = 0; i < N; i++) dist[i][i] = 0;
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
  return dist;
}

function hasNegativeCycle(dist: number[][]): boolean {
  for (let i = 0; i < dist.length; i++) {
    if (dist[i][i] < 0) return true;
  }
  return false;
}

function buildFeasibleVerdict(
  model: NormalizedModel,
  endpoints: ObsEndpoints[],
  ground: number,
  delays?: ((readonly [number, number]) | null)[],
): Extract<Verdict, { status: 'unique' | 'multiple' }> {
  const { recorders } = model;
  const n = recorders.length;
  const edges = buildEdges(model, endpoints, ground, delays);
  const dist = floyd(edges, n + 1);

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

  // 见证中每条观测使用的延迟区间（校正后随档位变化）
  const delayOf = (oi: number): [number, number] => {
    const o = delays?.[oi];
    return o ? [o[0], o[1]] : [endpoints[oi].obs.minDelay, endpoints[oi].obs.maxDelay];
  };
  const makeWitness = (endpoint: 'min' | 'max', x: number[]): EndpointWitness => {
    const offsets: Record<string, number> = {};
    recorders.forEach((r, i) => {
      offsets[r.id] = x[i];
    });
    const observationDelays = endpoints.map(({ obs, index: oi, s, r, ts, tr, senderId, receiverId }) => {
      const [dmin, dmax] = delayOf(oi);
      const sendTrue = ts + x[s];
      const receiveTrue = tr + x[r];
      const actualDelay = receiveTrue - sendTrue;
      return {
        observationId: obs.id,
        sendEvent: obs.sendEvent,
        receiveEvent: obs.receiveEvent,
        sender: senderId,
        receiver: receiverId,
        minDelay: dmin,
        maxDelay: dmax,
        sendLocal: ts,
        receiveLocal: tr,
        sendTrue,
        receiveTrue,
        actualDelay,
        feasible: actualDelay >= dmin && actualDelay <= dmax,
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
    status: unique ? 'unique' : 'multiple',
    ranges,
    allMinWitness,
    allMaxWitness,
  };
}

export function audit(model: NormalizedModel): SolveArtifacts {
  const { recorders } = model;
  const n = recorders.length;
  const ground = n;
  const recorderIds = recorders.map((r) => r.id);
  const endpoints = resolveEndpoints(model);
  const edges = buildEdges(model, endpoints, ground);
  const dist = floyd(edges, n + 1);

  if (hasNegativeCycle(dist)) {
    const chain = extractNegativeCycle(edges, n + 1, ground);
    const verdict: Verdict = { status: 'infeasible', chain };
    // 仅当原裁决不可行、且模型显式声明了候选档位时，才发起校正完整枚举
    if (model.hasCandidates) {
      verdict.correction = findCorrection(model, endpoints, ground, chain);
    }
    return { verdict, nodeOfRecorder: recorderIds, groundNode: ground, edges };
  }

  return {
    verdict: buildFeasibleVerdict(model, endpoints, ground),
    nodeOfRecorder: recorderIds,
    groundNode: ground,
    edges,
  };
}

/* ------------------------------------------------------------------ */
/* 校正求解：候选档位组合的完整精确搜索                                */
/* ------------------------------------------------------------------ */

/** 单条观测的一个档位选项：option 0 为零代价原档，其余为候选档 */
interface TierOption {
  tierId: string;
  candidate: boolean;
  dmin: number;
  dmax: number;
  cost: number;
}

/** 节点评估安全上限（超出视为求解异常；正常规模下分支剪枝远不会触及） */
const NODE_EVAL_CAP = 1_000_000;

interface SearchCounters {
  visitedNodes: number;
  evaluatedLeaves: number;
  feasibleCombinations: number;
  prunedInfeasible: number;
  prunedBound: number;
}

/**
 * 在闭合矩阵 d 上同时加入同一观测的一对边 e1=(u1→v1,w1)、e2=(u2→v2,w2)，
 * 返回新的闭合最短路矩阵。无负环时，新边在任意最短路上至多各出现一次，
 * 故只需枚举新边序列 []、[1]、[2]、[1,2]、[2,1]、[1,1]、[2,2]，段间走 d；
 * 若含新边的环为负环，[1,1]/[2,2] 项必在对角线上显形。
 * 一次 O(N²) 扫描（7 项取小）完成，比逐边两次松弛少一半矩阵分配。
 */
function withTwoEdges(
  d: number[][],
  N: number,
  u1: number, v1: number, w1: number,
  u2: number, v2: number, w2: number,
): number[][] {
  const out = d.map((row) => row.slice());
  const dv1 = d[v1];
  const dv2 = d[v2];
  // 各序列的“前缀列” A[i] 与公共“尾行”行号 tail
  // [1]:  d[i][u1]+w1, tail v1
  // [2]:  d[i][u2]+w2, tail v2
  // [1,2]: d[i][u1]+w1+d[v1][u2]+w2, tail v2
  // [2,1]: d[i][u2]+w2+d[v2][u1]+w1, tail v1
  // [1,1]: d[i][u1]+w1+d[v1][u1]+w1, tail v1
  // [2,2]: d[i][u2]+w2+d[v2][u2]+w2, tail v2
  const link12 = d[v1][u2] === INF ? INF : w1 + d[v1][u2] + w2;
  const link21 = d[v2][u1] === INF ? INF : w2 + d[v2][u1] + w1;
  const loop1 = d[v1][u1] === INF ? INF : w1 + d[v1][u1] + w1;
  const loop2 = d[v2][u2] === INF ? INF : w2 + d[v2][u2] + w2;

  for (let i = 0; i < N; i++) {
    const du1 = d[i][u1];
    const du2 = d[i][u2];
    const p1 = du1 === INF ? INF : du1 + w1;
    const p2 = du2 === INF ? INF : du2 + w2;
    const p12 = du1 === INF || link12 === INF ? INF : du1 + link12;
    const p21 = du2 === INF || link21 === INF ? INF : du2 + link21;
    const p11 = du1 === INF || loop1 === INF ? INF : du1 + loop1;
    const p22 = du2 === INF || loop2 === INF ? INF : du2 + loop2;
    const target = out[i];
    for (let j = 0; j < N; j++) {
      let best = target[j];
      const t1 = dv1[j];
      if (t1 !== INF) {
        if (p1 !== INF && p1 + t1 < best) best = p1 + t1;
        if (p21 !== INF && p21 + t1 < best) best = p21 + t1;
        if (p11 !== INF && p11 + t1 < best) best = p11 + t1;
      }
      const t2 = dv2[j];
      if (t2 !== INF) {
        if (p2 !== INF && p2 + t2 < best) best = p2 + t2;
        if (p12 !== INF && p12 + t2 < best) best = p12 + t2;
        if (p22 !== INF && p22 + t2 < best) best = p22 + t2;
      }
      target[j] = best;
    }
  }
  return out;
}

/** 台账排序键的字典序比较：[观测索引, 档位编号] 列表逐项比较 */
function changeKeyLess(
  a: { observationIndex: number; tierId: string }[],
  b: { observationIndex: number; tierId: string }[],
): boolean {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k++) {
    if (a[k].observationIndex !== b[k].observationIndex) {
      return a[k].observationIndex < b[k].observationIndex;
    }
    if (a[k].tierId !== b[k].tierId) return a[k].tierId < b[k].tierId;
  }
  return a.length < b.length;
}

function findCorrection(
  model: NormalizedModel,
  endpoints: ObsEndpoints[],
  ground: number,
  chain: ConstraintChain,
):
  | { status: 'repaired'; plan: CorrectionPlan }
  | { status: 'no-plan'; stats: CorrectionSearchStats }
  | { status: 'limit'; stats: CorrectionSearchStats } {
  const N = model.recorders.length + 1;

  // 声明了候选档位的观测才参与枚举；其余观测的原区间边恒在
  const eligible: { ep: ObsEndpoints; options: TierOption[] }[] = [];
  endpoints.forEach((ep) => {
    const cands = ep.obs.candidates;
    if (cands && cands.length > 0) {
      const options: TierOption[] = [
        { tierId: '', candidate: false, dmin: ep.obs.minDelay, dmax: ep.obs.maxDelay, cost: 0 },
        ...[...cands]
          .sort((a, b) => (a.cost !== b.cost ? a.cost - b.cost : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((t: DelayTier) => ({
            tierId: t.id,
            candidate: true,
            dmin: t.minDelay,
            dmax: t.maxDelay,
            cost: t.cost,
          })),
      ];
      eligible.push({ ep, options });
    }
  });

  // 出现在原矛盾链上的观测优先展开（不改变最优性，只让部分约束尽早产生矛盾剪枝）
  const chainObsOrder: number[] = [];
  const chainObsSet = new Set<number>();
  for (const e of chain.edges) {
    const m = /^observations\[(\d+)\]/.exec(e.sourcePath ?? '');
    if (m) {
      const idx = Number(m[1]);
      if (!chainObsSet.has(idx)) {
        chainObsSet.add(idx);
        chainObsOrder.push(idx);
      }
    }
  }
  const eligibleByObs = new Map(eligible.map((x) => [x.ep.index, x]));
  const ordered: { ep: ObsEndpoints; options: TierOption[] }[] = [];
  for (const idx of chainObsOrder) {
    const x = eligibleByObs.get(idx);
    if (x) ordered.push(x);
  }
  for (const x of eligible) {
    if (chainObsSet.has(x.ep.index)) continue;
    ordered.push(x);
  }

  const totalCombinations = ordered.reduce((prod, x) => prod * x.options.length, 1);

  // 恒定边：偏移界 + 非候选观测；候选观测的边由 DFS 按所选档位逐条加入
  const fixedDelays: ((readonly [number, number]) | null)[] = [];
  endpoints.forEach((ep) => {
    fixedDelays[ep.index] = eligibleByObs.has(ep.index)
      ? null
      : [ep.obs.minDelay, ep.obs.maxDelay];
  });
  const baseDist = floyd(buildEdges(model, endpoints, ground, fixedDelays), N);

  // choice[orderedPosition] = 选项序号；同时回填到观测索引
  const choice = new Array<number>(ordered.length).fill(0);
  const counters: SearchCounters = {
    visitedNodes: 0,
    evaluatedLeaves: 0,
    feasibleCombinations: 0,
    prunedInfeasible: 0,
    prunedBound: 0,
  };

  interface Incumbent {
    cost: number;
    changed: number;
    /** 按观测索引升序的 (观测索引, 档位编号) 台账键 */
    key: { observationIndex: number; tierId: string }[];
    /** 观测索引 -> 选项序号 */
    optionByObs: Map<number, number>;
  }
  // 用可变持有者让 TS 不因闭包赋值而把 best 窄化为 null
  const bestHolder: { value: Incumbent | null } = { value: null };

  const buildKey = (): { observationIndex: number; tierId: string }[] => {
    const key: { observationIndex: number; tierId: string }[] = [];
    ordered.forEach((x, pos) => {
      const opt = x.options[choice[pos]];
      if (opt.candidate) key.push({ observationIndex: x.ep.index, tierId: opt.tierId });
    });
    key.sort((a, b) => a.observationIndex - b.observationIndex);
    return key;
  };

  /**
   * @param depth 已确定前 depth 个（按 ordered 顺序）观测的档位
   * @param d     含全部恒定边及已选档位边的闭合最短路矩阵
   */
  const dfs = (depth: number, d: number[][], accCost: number, accChanged: number): void => {
    if (++counters.visitedNodes > NODE_EVAL_CAP) {
      throw new Error('校正组合搜索超出节点评估上限（模型约束结构异常复杂）');
    }
    // 目标下界剪枝：代价与改动数只会单调增加，当前已劣于在任最优则整支无望
    const cur = bestHolder.value;
    if (cur && (accCost > cur.cost || (accCost === cur.cost && accChanged > cur.changed))) {
      counters.prunedBound++;
      return;
    }

    if (depth === ordered.length) {
      counters.evaluatedLeaves++;
      counters.feasibleCombinations++;
      const key = buildKey();
      const incumbent = bestHolder.value;
      if (
        !incumbent ||
        accCost < incumbent.cost ||
        (accCost === incumbent.cost &&
          (accChanged < incumbent.changed ||
            (accChanged === incumbent.changed && changeKeyLess(key, incumbent.key))))
      ) {
        const optionByObs = new Map<number, number>();
        ordered.forEach((x, pos) => optionByObs.set(x.ep.index, choice[pos]));
        bestHolder.value = { cost: accCost, changed: accChanged, key, optionByObs };
      }
      return;
    }

    const { ep, options } = ordered[depth];
    for (let oi = 0; oi < options.length; oi++) {
      const opt = options[oi];
      choice[depth] = oi;
      // 同一观测的延迟上/下界边成对加入，一次闭合扫描完成
      const nd = withTwoEdges(
        d, N,
        ep.s, ep.r, ep.ts - ep.tr + opt.dmax,
        ep.r, ep.s, ep.tr - ep.ts - opt.dmin,
      );
      // 部分约束已不可行：任何补全只会增加约束，整棵子树均不可行
      if (hasNegativeCycle(nd)) {
        counters.prunedInfeasible++;
        continue;
      }
      dfs(depth + 1, nd, accCost + opt.cost, accChanged + (opt.candidate ? 1 : 0));
    }
    choice[depth] = 0;
  };

  try {
    dfs(0, baseDist, 0, 0);
  } catch (e) {
    if (!(e instanceof Error && /超出节点评估上限/.test(e.message))) throw e;
    return {
      status: 'limit',
      stats: {
        eligibleObservations: ordered.length,
        totalCombinations,
        feasibleCombinations: counters.feasibleCombinations,
        evaluatedLeaves: counters.evaluatedLeaves,
        prunedInfeasible: counters.prunedInfeasible,
        prunedBound: counters.prunedBound,
        visitedNodes: counters.visitedNodes,
      },
    };
  }

  const stats: CorrectionSearchStats = {
    eligibleObservations: ordered.length,
    totalCombinations,
    feasibleCombinations: counters.feasibleCombinations,
    evaluatedLeaves: counters.evaluatedLeaves,
    prunedInfeasible: counters.prunedInfeasible,
    prunedBound: counters.prunedBound,
    visitedNodes: counters.visitedNodes,
  };

  const best = bestHolder.value;
  if (!best) return { status: 'no-plan', stats };

  // 用最优组合覆盖延迟区间，复算恢复后的完整裁决（紧确范围 + 端点见证）
  const delays: (readonly [number, number])[] = [];
  endpoints.forEach((x) => {
    const optPos = best.optionByObs.get(x.index);
    if (optPos === undefined) {
      delays[x.index] = [x.obs.minDelay, x.obs.maxDelay];
    } else {
      const opt = eligibleByObs.get(x.index)!.options[optPos];
      delays[x.index] = [opt.dmin, opt.dmax];
    }
  });
  const correctedVerdict = buildFeasibleVerdict(model, endpoints, ground, delays);

  const chosenTierOf = (obsIndex: number, optionPos: number): ChosenTier => {
    const holder = eligibleByObs.get(obsIndex)!;
    const ep0 = holder.ep;
    const opt = holder.options[optionPos];
    return {
      observationIndex: obsIndex,
      observationId: ep0.obs.id,
      tierId: opt.tierId,
      candidate: opt.candidate,
      beforeMinDelay: ep0.obs.minDelay,
      beforeMaxDelay: ep0.obs.maxDelay,
      afterMinDelay: opt.dmin,
      afterMaxDelay: opt.dmax,
      cost: opt.cost,
    };
  };

  // 完整选择台账（含保持原档的观测），按观测索引升序
  const selections: ChosenTier[] = [...best.optionByObs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([obsIndex, optionPos]) => chosenTierOf(obsIndex, optionPos));
  const changes = selections.filter((c) => c.candidate);

  const plan: CorrectionPlan = {
    changes,
    selections,
    totalCost: best.cost,
    changedCount: best.changed,
    changeKey: best.key,
    stats,
    correctedVerdict,
  };
  return { status: 'repaired', plan };
}

/**
 * 用 Bellman-Ford 从地面节点提取一个真实的负权闭合约束链。
 * 所有变量节点同时存在出入地面的界边，故地面可到达全部节点。
 */
function extractNegativeCycle(
  edges: ConstraintEdge[],
  N: number,
  ground: number,
): ConstraintChain {
  const dist = new Array<number>(N).fill(INF);
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

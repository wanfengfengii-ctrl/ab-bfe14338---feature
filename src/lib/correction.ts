import type {
  CandidateSelection,
  ConstraintChain,
  CorrectionOutcome,
  ConstraintEdge,
  DelayCandidate,
  NormalizedModel,
} from '../types';
import { auditWithOverrides, buildEdges } from './solver';
import type { DelayOverrides } from './solver';

/**
 * 候选延迟档位校正求解。
 *
 * 仅当原裁决不可行时允许发起。对至多 18 条声明了候选档位的观测做
 * 【完整】组合枚举（分支限界，不是逐条贪心，也不取首个可行组合）：
 *
 *   - 每条可校正观测要么保持原区间（零代价），要么替换为某个候选档位；
 *   - 在“已决定档位、其余观测保持原区间”的部分约束系统上跑 SPFA
 *     （Bellman–Ford 队列优化；地面节点经偏移上界边可达全部节点）：队列清空即
 *     系统可行，此时未决定观测全部取零代价原档即构成一个完整可行组合，记录后剪枝
 *     （继续替换只会增加代价与改动数）；
 *   - 仍不可行时沿最短路前驱提取当前负环：负环只可能被“环上边所属观测替换
 *     档位”打破，故只需对环上尚未决定的可校正观测分支——这是完备的
 *     （环外观测如何替换都不改变环上边权，该负环恒在）；
 *   - 环上已无未决定的可校正观测 ⇒ 该负环无法再被改变，剪枝；
 *   - 可采纳下界剪枝：按各候选档对此环的权值改善量做最小代价背包，得“仅补平
 *     当前负环”所需的最小代价/最少改动数；潜力之和不足缺口立即剪枝；
 *     纯收紧/无放宽的候选被免费原档支配，直接跳过。
 *
 * 搜索顺序：对选中观测先试各候选档位（按代价升序，尽早拿到紧的 incumbent），
 * 最后才“保持原档”。全部可行组合依次比较：
 *   总代价 → 被改观测数 → (观测索引, 档位编号) 列表字典序。
 *
 * 完备性与最优性：任一可行完成 S 必含一个极小可行子集 S'（其任一真子集都不可行）。
 * 沿“当前负环上未决定的可校正观测”逐层分支时，S' 每次替换的观测必在该负环上
 * （不打破此环便不可行），故 S' 一定沿某条分支到达其被全部决定的可行节点并被记录；
 * 部分节点一旦可行即剪去其超集，而候选代价恒 ≥1，被剪掉的超集代价严格更大，
 * 不可能更优。因此记录到的最优可行组合即全局最优。
 */

const OBS_EDGE_RE = /^observations\[(\d+)\]\.(min|max)Delay$/;

interface ObsGeom {
  ts: number;
  tr: number;
}

interface SearchContext {
  model: NormalizedModel;
  N: number;
  ground: number;
  edges: ConstraintEdge[];
  /** 固定拓扑的出边表（边下标），仅建一次，供 SPFA 复用 */
  adj: number[][];
  /** 每条观测的端点几何与在边数组中的两条边下标 */
  geom: ObsGeom[];
  edgeMax: Int32Array;
  edgeMin: Int32Array;
  /** 可校正观测索引（声明了候选，按 (代价最低候选, 索引) 处理顺序） */
  candObsSet: ReadonlySet<number>;
  /** obsIndex -> 候选档位（按代价、编号排序，不改变最优解，仅利于尽早剪枝） */
  candidatesByObs: ReadonlyMap<number, DelayCandidate[]>;
  /** obsIndex -> 0 未决定 / 1 保持原档 / 2 已替换为候选 */
  status: Int8Array;
  curCost: number;
  curCount: number;
  /** 当前已替换选择（按决定先后压入） */
  sel: { obsIndex: number; cand: DelayCandidate }[];
  bestCost: number;
  bestCount: number;
  bestSel: { obsIndex: number; cand: DelayCandidate }[] | null;
  /** 可行性评估次数（每次 Bellman-Ford 计一次） */
  evaluatedCombinations: number;
  /** 找到的完整可行组合数（都参与了全量比较） */
  feasibleCombinations: number;
}

/** 检测到的一个负环：环上边、缺口、环上出现的观测及各观测可提供的最大改善 */
interface CycleInfo {
  edges: ConstraintEdge[];
  /** 缺口 = -(环权总和)，严格为正 */
  deficit: number;
  /** 环上观测索引集合 */
  obsSet: Set<number>;
  /** 环上每个观测出现的边方向：是否用上界边 / 下界边 */
  kindsByObs: Map<number, { up: boolean; lo: boolean }>;
  /**
   * 环上每个观测即使换成其最宽松候选档，相对当前边权能给本环带来的总权增量上界。
   * 某观测可能两条边都在环上（罕见），故按观测累加其在环上各边的改善。
   */
  potentialByObs: Map<number, number>;
}

/** 候选档相对原档对“延迟上界边 / 下界边”的权值改善（恒取非负） */
function edgeImprovement(ctx: SearchContext, oi: number, cand: DelayCandidate): { up: number; lo: number } {
  const o = ctx.model.observations[oi];
  // 上界边权 = ts-tr+dmax：放宽上界（dmax 变大）使权增大，改善 = max(0, dmax'-dmax)
  const up = Math.max(0, cand.maxDelay - o.maxDelay);
  // 下界边权 = tr-ts-dmin：放宽下界（dmin 变小）使权增大，改善 = max(0, dmin-dmin')
  const lo = Math.max(0, o.minDelay - cand.minDelay);
  return { up, lo };
}

/**
 * SPFA（Bellman–Ford 队列优化）。拓扑固定、仅边权随档位变化：
 *  - 队列清空 ⇒ 最短路收敛且无可达负环，当前部分系统可行，返回 null；
 *  - 某节点最短路边数达到 N ⇒ 前驱链含负环，提取并返回该环信息。
 * 相比每节点固定 N 趟全边扫描，近 DAG 的差分约束图上平均快得多。
 */
function detectCycle(ctx: SearchContext): CycleInfo | null {
  const { edges, N, ground, adj } = ctx;
  const INF = Number.POSITIVE_INFINITY;
  const dist = new Array<number>(N).fill(INF);
  const predNode = new Array<number>(N).fill(-1);
  const predEdge = new Array<number>(N).fill(-1);
  const pathLen = new Array<number>(N).fill(0);
  const inQueue = new Uint8Array(N);
  dist[ground] = 0;
  const queue: number[] = [ground];
  inQueue[ground] = 1;

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    inQueue[u] = 0;
    const outs = adj[u];
    for (let a = 0; a < outs.length; a++) {
      const ei = outs[a];
      const e = edges[ei];
      const cand = dist[u] + e.weight;
      if (cand < dist[e.to]) {
        const v = e.to;
        dist[v] = cand;
        predNode[v] = u;
        predEdge[v] = ei;
        pathLen[v] = pathLen[u] + 1;
        if (pathLen[v] >= N) {
          // 前驱链已含 N 条边：尝试抽出真实负环；若抽到的环权非负（陈旧前驱
          // 导致的非简单链），不判可行也不判死，落回入队继续松弛——真有负环则
          // 队列不会排空并会再次确认，无负环则队列自然排空后安全判可行。
          const cyc = extractCycleFromPred(ctx, v, predNode, predEdge);
          if (cyc) return cyc;
        }
        if (!inQueue[v]) {
          inQueue[v] = 1;
          queue.push(v);
        }
      }
    }
  }
  return null;
}

/** 从 SPFA 标记节点沿前驱进入并收集负环 */
function extractCycleFromPred(
  ctx: SearchContext,
  start: number,
  predNode: number[],
  predEdge: number[],
): CycleInfo | null {
  const { edges, N } = ctx;
  let cur = start;
  for (let k = 0; k < N && cur >= 0; k++) cur = predNode[cur];
  if (cur < 0) return null;

  const cycleEdges: ConstraintEdge[] = [];
  const obsSet = new Set<number>();
  const kindsByObs = new Map<number, { up: boolean; lo: boolean }>();
  const seen = new Set<number>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const ei = predEdge[cur];
    if (ei < 0) break;
    cycleEdges.push(edges[ei]);
    const m = edges[ei].sourcePath?.match(OBS_EDGE_RE);
    if (m) {
      const oi = Number(m[1]);
      obsSet.add(oi);
      const k = kindsByObs.get(oi) ?? { up: false, lo: false };
      if (m[2] === 'max') k.up = true;
      else k.lo = true;
      kindsByObs.set(oi, k);
    }
    cur = predNode[cur];
  }
  const total = cycleEdges.reduce((s, e) => s + e.weight, 0);
  if (total >= 0) return null;

  const potentialByObs = new Map<number, number>();
  for (const e of cycleEdges) {
    const m = e.sourcePath?.match(OBS_EDGE_RE);
    if (!m) continue;
    const oi = Number(m[1]);
    const cands = ctx.candidatesByObs.get(oi);
    if (!cands) continue;
    const isMax = m[2] === 'max';
    let best = 0;
    for (const cand of cands) {
      const imp = edgeImprovement(ctx, oi, cand);
      const v = isMax ? imp.up : imp.lo;
      if (v > best) best = v;
    }
    potentialByObs.set(oi, (potentialByObs.get(oi) ?? 0) + best);
  }

  return { edges: cycleEdges, deficit: -total, obsSet, kindsByObs, potentialByObs };
}

type SortKey = { observationIndex: number; candidateId: string }[];

function sortKeyOf(sel: { obsIndex: number; cand: DelayCandidate }[]): SortKey {
  return sel
    .slice()
    .sort((a, b) => a.obsIndex - b.obsIndex)
    .map((s) => ({ observationIndex: s.obsIndex, candidateId: s.cand.id }));
}

function compareKey(a: SortKey, b: SortKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i].observationIndex !== b[i].observationIndex) {
      return a[i].observationIndex - b[i].observationIndex;
    }
    if (a[i].candidateId !== b[i].candidateId) {
      return a[i].candidateId < b[i].candidateId ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** 记录一个完整可行组合并按三级判据全量比较择优 */
function recordFeasible(ctx: SearchContext): void {
  ctx.feasibleCombinations++;
  const { curCost: cost, curCount: count } = ctx;
  if (ctx.bestSel === null) {
    ctx.bestSel = ctx.sel.slice();
    ctx.bestCost = cost;
    ctx.bestCount = count;
    return;
  }
  if (cost < ctx.bestCost ||
      (cost === ctx.bestCost && count < ctx.bestCount) ||
      (cost === ctx.bestCost && count === ctx.bestCount &&
        compareKey(sortKeyOf(ctx.sel), sortKeyOf(ctx.bestSel)) < 0)) {
    ctx.bestSel = ctx.sel.slice();
    ctx.bestCost = cost;
    ctx.bestCount = count;
  }
}

function setEdgeWeights(ctx: SearchContext, oi: number, dmin: number, dmax: number): void {
  const g = ctx.geom[oi];
  ctx.edges[ctx.edgeMax[oi]].weight = g.ts - g.tr + dmax;
  ctx.edges[ctx.edgeMin[oi]].weight = g.tr - g.ts - dmin;
}

/** 某候选档对当前负环上该观测各边的总权增量（只计环上出现的方向） */
function candidateCycleGain(ctx: SearchContext, oi: number, cand: DelayCandidate, cycle: CycleInfo): number {
  const k = cycle.kindsByObs.get(oi);
  if (!k) return 0;
  const imp = edgeImprovement(ctx, oi, cand);
  return (k.up ? imp.up : 0) + (k.lo ? imp.lo : 0);
}

/**
 * 可采纳下界：要把【当前这一个负环】补到非负，环上尚未决定的可校正观测至少要
 * 付出多少候选代价。对每个观测枚举“换成某候选档得到的环改善量 / 代价”，做
 * 0/1 最小代价背包（改善量在缺口处截断）。不可覆盖时返回 Infinity。
 * 修别的负环只会再增加代价，故这是任意可行完成总代价的合法下界。
 */
function minCycleCoverCost(ctx: SearchContext, cycle: CycleInfo): number {
  const undecidedCand: number[] = [];
  for (const oi of cycle.obsSet) {
    if (ctx.candObsSet.has(oi) && ctx.status[oi] === 0) undecidedCand.push(oi);
  }
  if (undecidedCand.length === 0) return Infinity;

  const D = cycle.deficit;
  // gain（截断到 D）-> 达到该累计改善所需的最小代价
  let dp = new Map<number, number>([[0, 0]]);
  for (const oi of undecidedCand) {
    const opts: { gain: number; cost: number }[] = [];
    for (const cand of ctx.candidatesByObs.get(oi)!) {
      const gain = candidateCycleGain(ctx, oi, cand, cycle);
      if (gain > 0) opts.push({ gain: Math.min(gain, D), cost: cand.cost });
    }
    if (opts.length === 0) continue; // 该观测的任何候选都改善不了此环
    const ndp = new Map<number, number>(dp); // 可跳过此观测
    for (const [g, c] of dp) {
      for (const op of opts) {
        const g2 = Math.min(D, g + op.gain);
        const c2 = c + op.cost;
        const prev = ndp.get(g2);
        if (prev === undefined || c2 < prev) ndp.set(g2, c2);
      }
    }
    dp = ndp;
  }
  return dp.get(D) ?? Infinity;
}

/**
 * 可采纳的“最少改动数”下界：环上未决定可校正观测按各自最大改善量降序贪心，
 * 至少需要多少个才能累计补足缺口。每个观测真实改善 ≤ 最大潜力，故贪心数是合法下界。
 */
function minCycleCoverCount(ctx: SearchContext, cycle: CycleInfo): number {
  const pots: number[] = [];
  for (const oi of cycle.obsSet) {
    if (ctx.candObsSet.has(oi) && ctx.status[oi] === 0) {
      const p = cycle.potentialByObs.get(oi) ?? 0;
      if (p > 0) pots.push(p);
    }
  }
  pots.sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < pots.length; i++) {
    acc += pots[i];
    if (acc >= cycle.deficit) return i + 1;
  }
  return Infinity; // 潜力之和仍不足：此环不可破
}

/**
 * DFS。carryCycle 非空表示自父节点后边集未改变（连续“保持原档”），
 * 可直接复用该负环而免做一次 Bellman-Ford。
 */
function dfs(ctx: SearchContext, carryCycle: CycleInfo | null): void {
  let cycle = carryCycle;
  if (cycle === null) {
    ctx.evaluatedCombinations++;
    cycle = detectCycle(ctx);
    if (cycle === null) {
      // 当前（未决定者全取零代价原档）已可行：一个完整可行组合
      recordFeasible(ctx);
      return; // 再替换任何观测都只增代价/改动数
    }
  }

  // 当前负环上尚未决定的可校正观测
  const undecided: number[] = [];
  for (const oi of cycle.obsSet) {
    if (ctx.candObsSet.has(oi) && ctx.status[oi] === 0) undecided.push(oi);
  }
  if (undecided.length === 0) return; // 该负环无法再被改变：此路不可行
  undecided.sort((a, b) => a - b);

  // 可采纳下界：仅补当前负环所需的最小候选代价 / 最少改动数
  const coverCost = minCycleCoverCost(ctx, cycle);
  if (coverCost === Infinity) return; // 即使环上观测全换最宽档也补不平缺口
  const coverCount = minCycleCoverCount(ctx, cycle);
  if (ctx.bestSel !== null) {
    if (ctx.curCost + coverCost > ctx.bestCost) return;
    if (coverCount !== Infinity && ctx.curCost + coverCost === ctx.bestCost &&
        ctx.curCount + coverCount > ctx.bestCount) {
      // 代价持平时改动数下界也已不占优（改动数更多，字典序无从追平）
      return;
    }
  }

  const v = undecided[0];
  const cands = ctx.candidatesByObs.get(v)!;

  // 先试替换为各候选档位（已按代价升序），尽早得到紧的 incumbent
  for (let ci = 0; ci < cands.length; ci++) {
    const cand = cands[ci];
    // 支配剪枝：该候选相对原档两条边都不放宽（区间为原档子集/相同），
    // 则免费原档严格更松且零代价，该候选不可能属于任何最优解，跳过。
    const imp0 = edgeImprovement(ctx, v, cand);
    if (imp0.up === 0 && imp0.lo === 0) continue;
    const newCost = ctx.curCost + cand.cost;
    const newCount = ctx.curCount + 1;
    // 单调下界剪枝（代价/改动数只会继续增加；持平时不剪，字典序或更优）
    if (ctx.bestSel !== null) {
      if (newCost > ctx.bestCost) continue;
      if (newCost === ctx.bestCost && newCount > ctx.bestCount) continue;
    }
    ctx.status[v] = 2;
    ctx.curCost = newCost;
    ctx.curCount = newCount;
    ctx.sel.push({ obsIndex: v, cand });
    setEdgeWeights(ctx, v, cand.minDelay, cand.maxDelay);

    dfs(ctx, null);

    setEdgeWeights(ctx, v, ctx.model.observations[v].minDelay, ctx.model.observations[v].maxDelay);
    ctx.sel.pop();
    ctx.curCost -= cand.cost;
    ctx.curCount -= 1;
    ctx.status[v] = 0;
  }

  // 最后：v 保持原档（零代价，边集与负环均不变，直接复用）
  ctx.status[v] = 1;
  dfs(ctx, cycle);
  ctx.status[v] = 0;
}

/**
 * 发起校正求解。模型未声明任何候选档位时返回 nottriggered，
 * 调用方应保持原裁决与展示。调用方须已确认原裁决不可行。
 */
export function solveCorrection(model: NormalizedModel): CorrectionOutcome {
  const candidatesByObs = new Map<number, DelayCandidate[]>();
  model.observations.forEach((o, oi) => {
    if (o.candidates && o.candidates.length > 0) {
      // 拷贝并按 (代价, 编号) 排序，仅影响搜索顺序，不影响最优解
      const sorted = o.candidates.slice().sort((a, b) =>
        a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      candidatesByObs.set(oi, sorted);
    }
  });
  if (candidatesByObs.size === 0) return { kind: 'nottriggered' };

  // 仅当原裁决不可行时才允许发起校正；原裁决可行则保持原裁决
  if (auditWithOverrides(model, undefined).verdict.status !== 'infeasible') {
    return { kind: 'nottriggered' };
  }

  const n = model.recorders.length;
  const N = n + 1;
  const ground = n;
  const edges = buildEdges(model, undefined);

  // 观测端点时标几何（用于重算两条边权）
  const eventById = new Map(model.events.map((e) => [e.id, e]));
  const geom: ObsGeom[] = model.observations.map((o) => ({
    ts: eventById.get(o.sendEvent)!.localTime,
    tr: eventById.get(o.receiveEvent)!.localTime,
  }));
  const edgeMax = new Int32Array(model.observations.length).fill(-1);
  const edgeMin = new Int32Array(model.observations.length).fill(-1);
  edges.forEach((e, ei) => {
    const m = e.sourcePath?.match(OBS_EDGE_RE);
    if (!m) return;
    const oi = Number(m[1]);
    if (m[2] === 'max') edgeMax[oi] = ei;
    else edgeMin[oi] = ei;
  });

  // 固定拓扑出边表（边权在搜索中会变，下标不变）
  const adj: number[][] = Array.from({ length: N }, () => []);
  edges.forEach((e, ei) => {
    adj[e.from].push(ei);
  });

  const ctx: SearchContext = {
    model,
    N,
    ground,
    edges,
    adj,
    geom,
    edgeMax,
    edgeMin,
    candObsSet: new Set(candidatesByObs.keys()),
    candidatesByObs,
    status: new Int8Array(model.observations.length),
    curCost: 0,
    curCount: 0,
    sel: [],
    bestCost: 0,
    bestCount: 0,
    bestSel: null,
    evaluatedCombinations: 0,
    feasibleCombinations: 0,
  };

  dfs(ctx, null);

  if (ctx.bestSel === null) {
    // 所有候选组合都不可行：重算原裁决，原样保留闭合矛盾链
    const original = auditWithOverrides(model, undefined);
    const chain: ConstraintChain =
      original.verdict.status === 'infeasible'
        ? original.verdict.chain
        : { edges: [], totalWeight: 0, lines: [], contradiction: '0 ≤ 0' };
    return {
      kind: 'noscheme',
      chain,
      evaluatedCombinations: ctx.evaluatedCombinations,
      feasibleCombinations: ctx.feasibleCombinations,
    };
  }

  const chosen = ctx.bestSel.slice().sort((a, b) => a.obsIndex - b.obsIndex);
  const overrides = new Map<number, { minDelay: number; maxDelay: number }>();
  const changes: CandidateSelection[] = chosen.map(({ obsIndex, cand }) => {
    const o = model.observations[obsIndex];
    overrides.set(obsIndex, { minDelay: cand.minDelay, maxDelay: cand.maxDelay });
    return {
      observationIndex: obsIndex,
      observationId: o.id,
      candidateId: cand.id,
      beforeMinDelay: o.minDelay,
      beforeMaxDelay: o.maxDelay,
      afterMinDelay: cand.minDelay,
      afterMaxDelay: cand.maxDelay,
      cost: cand.cost,
    };
  });

  const totalCost = changes.reduce((s, c) => s + c.cost, 0);
  const restoredArtifacts = auditWithOverrides(model, overrides as DelayOverrides);
  if (restoredArtifacts.verdict.status === 'infeasible') {
    return {
      kind: 'noscheme',
      chain: restoredArtifacts.verdict.chain,
      evaluatedCombinations: ctx.evaluatedCombinations,
      feasibleCombinations: ctx.feasibleCombinations,
    };
  }

  return {
    kind: 'found',
    solution: {
      changes,
      totalCost,
      changedCount: changes.length,
      key: changes.map((c) => ({
        observationIndex: c.observationIndex,
        candidateId: c.candidateId,
      })),
      restored: restoredArtifacts.verdict,
      feasibleCombinations: ctx.feasibleCombinations,
      evaluatedCombinations: ctx.evaluatedCombinations,
    },
  };
}

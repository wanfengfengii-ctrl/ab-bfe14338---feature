// 领域模型类型定义

/** 一台脉冲记录器：本地时标 + 偏移 = 真实时刻 */
export interface Recorder {
  /** 唯一编号（字符串即可，展示用） */
  id: string;
  /** 偏移整数闭区间 [minOffset, maxOffset]；参考机两点皆为 0 */
  minOffset: number;
  maxOffset: number;
  /** 是否为参考机（偏移恒为零）。模型中必须恰好有一台 */
  reference?: boolean;
}

/** 全局唯一事件：发生在某台记录器上，带本地时标 */
export interface TimedEvent {
  id: string;
  recorder: string;
  /** 本地时标（整数，绝对值 ≤ 1e9） */
  localTime: number;
}

/**
 * 预录候选延迟档位：现场档位标签抄错时的可选校正。
 * 真实延迟仍须落在非负整数闭区间 [minDelay, maxDelay]；
 * 校正代价为 1..1_000_000 的整数，档位编号在同一条观测内唯一。
 */
export interface DelayTier {
  /** 同一条观测内唯一的档位编号（非空字符串） */
  id: string;
  minDelay: number;
  maxDelay: number;
  /** 采用该档位的整数校正代价（1..1_000_000） */
  cost: number;
}

/**
 * 观测：连接两台不同记录器的发送事件与接收事件。
 * 真实接收时刻 − 真实发送时刻 ∈ [minDelay, maxDelay]（非负整数闭区间）。
 */
export interface Observation {
  id: string;
  sendEvent: string;
  receiveEvent: string;
  minDelay: number;
  maxDelay: number;
  /**
   * 至多 3 个预录候选档位。原区间始终是零代价档位（不在此列表中显式出现，
   * 由 tierId '' / cost 0 的“原档”代表）；此字段缺省即旧模型，保持原裁决。
   */
  candidates?: DelayTier[];
}

export interface AuditModel {
  recorders?: Recorder[];
  events?: TimedEvent[];
  observations?: Observation[];
  // 宽松索引签名，导入任意 JSON 时不使类型断言失败
  [key: string]: unknown;
}

/** 结构化后的模型（校验通过后使用） */
export interface NormalizedModel {
  recorders: Recorder[];
  events: TimedEvent[];
  observations: Observation[];
  /** 模型中是否至少有一条观测显式声明了候选档位 */
  hasCandidates: boolean;
}

export type IssueLevel = 'error' | 'warning';

/** 定位到具体条目/字段的问题反馈 */
export interface Issue {
  level: IssueLevel;
  /** 形如 "recorders[3].maxOffset" 的定位路径 */
  path: string;
  message: string;
}

/** 一条差分约束 edge: x[to] - x[from] <= weight，由具体模型元素见证 */
export interface ConstraintEdge {
  from: number;
  to: number;
  weight: number;
  /** 约束来源描述，用于审计展示 */
  witness: string;
  /** 来源定位（recorders[i] / observations[i] / events[i]） */
  sourcePath?: string;
}

/** 某个偏移端点的完整可行赋值见证 */
export interface EndpointWitness {
  /** 该端点所针对的记录器 id */
  recorderId: string;
  /** 'min' | 'max' */
  endpoint: 'min' | 'max';
  /** 端点值（紧确） */
  value: number;
  /** 完整可行赋值：记录器 id -> 偏移 */
  offsets: Record<string, number>;
  /** 每条观测在该赋值下的实际延迟 */
  observationDelays: {
    observationId: string;
    sendEvent: string;
    receiveEvent: string;
    sender: string;
    receiver: string;
    minDelay: number;
    maxDelay: number;
    sendLocal: number;
    receiveLocal: number;
    sendTrue: number;
    receiveTrue: number;
    actualDelay: number;
    feasible: boolean;
  }[];
}

export interface RecorderRange {
  recorderId: string;
  min: number;
  max: number;
  reference: boolean;
}

export type VerdictStatus = 'unique' | 'multiple' | 'infeasible';

/** 原裁决不可行时，一条观测所采用的档位选择（原档或某候选档） */
export interface ChosenTier {
  /** 观测在 observations 数组中的索引 */
  observationIndex: number;
  observationId: string;
  /** 采用的档位编号；'' 表示零代价原档 */
  tierId: string;
  /** 是否为候选档（原档为 false） */
  candidate: boolean;
  /** 改动前（原档）延迟闭区间 */
  beforeMinDelay: number;
  beforeMaxDelay: number;
  /** 改动后（所选档位）延迟闭区间 */
  afterMinDelay: number;
  afterMaxDelay: number;
  /** 该档位的校正代价（原档为 0） */
  cost: number;
}

/** 校正搜索的完整枚举统计（证明非逐条贪心、非首个可行即止） */
export interface CorrectionSearchStats {
  /** 参与枚举的观测数（声明了候选档位的观测数） */
  eligibleObservations: number;
  /** 完整枚举空间中的组合总数（每观测档位选项数之积，含零代价原档） */
  totalCombinations: number;
  /** 搜索中实际到达叶子、确认可行的组合数（被目标界剪枝排除的组合不可能更优） */
  feasibleCombinations: number;
  /** 到达叶子并完成完整 Floyd 级一致性判定的组合数 */
  evaluatedLeaves: number;
  /** 访问的搜索节点总数（含内部节点） */
  visitedNodes: number;
  /** 因“其余观测即便取最宽档位仍矛盾”而整支剪枝的次数（部分约束不可行传播） */
  prunedInfeasible: number;
  /** 因代价/改动数下界已不优于在任最优而整支剪枝的次数 */
  prunedBound: number;
}

/** 校正后恢复全局一致性的裁决结果 */
export interface CorrectionPlan {
  /** 逐条改动（仅含被改为候选档的观测，按观测索引升序） */
  changes: ChosenTier[];
  /** 最优组合的完整档位选择（含保持原档的观测，按观测索引升序） */
  selections: ChosenTier[];
  totalCost: number;
  /** 被改观测数 */
  changedCount: number;
  /** 复核台账排序键：[观测索引, 档位编号] 按观测索引升序排列 */
  changeKey: { observationIndex: number; tierId: string }[];
  stats: CorrectionSearchStats;
  /** 采用最优组合校正后的完整裁决（紧确偏移范围与端点见证） */
  correctedVerdict: Verdict;
}

/** 闭合约束链（不可行见证） */
export interface ConstraintChain {
  /** 沿链按顺序的边 */
  edges: ConstraintEdge[];
  /** 边权之和（严格小于 0） */
  totalWeight: number;
  /** 链式展开的人类可读说明 */
  lines: string[];
  /** 矛盾形式说明，例如 "0 <= -3" */
  contradiction: string;
}

export type Verdict =
  | {
      status: 'unique' | 'multiple';
      ranges: RecorderRange[];
      /** 全体最小值同时取到的完整赋值见证 */
      allMinWitness: EndpointWitness;
      /** 全体最大值同时取到的完整赋值见证 */
      allMaxWitness: EndpointWitness;
    }
  | {
      status: 'infeasible';
      chain: ConstraintChain;
      /**
       * 仅当模型声明了候选档位时存在：对所有档位组合完整比较后的校正结论。
       * 无方案时 plan 为 null（保留原闭合矛盾链）；未声明候选档位的旧模型为 undefined。
       */
      correction?:
        | { status: 'repaired'; plan: CorrectionPlan }
        | { status: 'no-plan'; stats: CorrectionSearchStats }
        /** 组合空间过大、完整枚举超出节点预算（极端构造；正常规模下不会触发） */
        | { status: 'limit'; stats: CorrectionSearchStats }
        | undefined;
    };

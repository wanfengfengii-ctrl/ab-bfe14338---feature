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
 * 候选延迟档位：原区间被怀疑抄错时，可从预录档位中择一替换。
 * 每档在所属观测内有唯一编号，代价为 1..1_000_000 的整数。
 * 原区间始终作为零代价档位参与枚举，无需在此声明。
 */
export interface DelayCandidate {
  /** 观测内唯一编号（非空字符串） */
  id: string;
  minDelay: number;
  maxDelay: number;
  /** 校正代价：1 到 1_000_000 的整数 */
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
  /** 预录候选档位：至多 3 个；省略表示该观测不参与校正 */
  candidates?: DelayCandidate[];
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
    };

/** 一条观测的档位选择（校正方案中的单条改动） */
export interface CandidateSelection {
  /** 观测在模型 observations 数组中的索引 */
  observationIndex: number;
  observationId: string;
  /** 选中的候选档位编号 */
  candidateId: string;
  /** 改动前（原）区间 */
  beforeMinDelay: number;
  beforeMaxDelay: number;
  /** 改动后（候选）区间 */
  afterMinDelay: number;
  afterMaxDelay: number;
  cost: number;
}

/** 校正后恢复可行时的完整结果 */
export interface CorrectionSolution {
  /** 按观测索引升序的改动列表 */
  changes: CandidateSelection[];
  totalCost: number;
  changedCount: number;
  /** 字典序比较用的 (观测索引, 档位编号) 列表（已按观测索引升序） */
  key: { observationIndex: number; candidateId: string }[];
  /** 校正后模型上重新求解得到的裁决（unique/multiple），含紧确范围与端点见证 */
  restored: Extract<Verdict, { status: 'unique' | 'multiple' }>;
  /** 分支限界中做过可行性评估的组合（搜索节点）数 */
  evaluatedCombinations: number;
  /**
   * 参与三级择优比较的可行组合数。严格劣化的可行超集（代价与改动数同时更大，
   * 恒不可能最优）与不可破负环分支被完备剪枝，不计入；剪枝不影响最优性。
   */
  feasibleCombinations: number;
}

/**
 * 校正求解结果：
 *  - found   ：找到全局最优可行校正方案
 *  - noscheme：所有候选组合均不可行（保留原闭合矛盾链）
 *  - notrigged：原裁决本身可行 / 无候选观测，未发起校正
 */
export type CorrectionOutcome =
  | { kind: 'found'; solution: CorrectionSolution }
  | { kind: 'noscheme'; chain: ConstraintChain; evaluatedCombinations: number; feasibleCombinations: number }
  | { kind: 'nottriggered' };

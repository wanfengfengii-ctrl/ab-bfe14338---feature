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
 * 观测：连接两台不同记录器的发送事件与接收事件。
 * 真实接收时刻 − 真实发送时刻 ∈ [minDelay, maxDelay]（非负整数闭区间）。
 */
export interface Observation {
  id: string;
  sendEvent: string;
  receiveEvent: string;
  minDelay: number;
  maxDelay: number;
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

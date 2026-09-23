import type {
  AuditModel,
  Issue,
  NormalizedModel,
  Observation,
  Recorder,
  TimedEvent,
} from '../types';

const LIMIT = 1_000_000_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isIntInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export interface ValidationResult {
  model?: NormalizedModel;
  issues: Issue[];
}

/**
 * 全量校验：任何非法编号、时标、界值或引用都给出形如
 * "recorders[3].maxOffset" 的精确定位。错误存在时不产出模型。
 */
export function validateModel(raw: unknown): ValidationResult {
  const issues: Issue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ level: 'error', path, message });
  const warning = (path: string, message: string) =>
    issues.push({ level: 'warning', path, message });

  if (!isObject(raw)) {
    error('$', '模型必须是 JSON 对象');
    return { issues };
  }
  const data = raw as AuditModel;

  // ---------- 记录器 ----------
  const recorders: Recorder[] = [];
  const recorderIds = new Map<string, number>();
  const refIndices: number[] = [];

  if (!Array.isArray(data.recorders)) {
    error('recorders', '必须是数组');
  } else {
    const rawRecorders = data.recorders;
    if (rawRecorders.length < 2 || rawRecorders.length > 24) {
      error('recorders', `记录器数量必须在 2 至 24 之间（当前 ${rawRecorders.length}）`);
    }
    rawRecorders.forEach((item, i) => {
      const p = `recorders[${i}]`;
      if (!isObject(item)) {
        error(p, '记录器必须是对象');
        return;
      }
      const r = item as Record<string, unknown>;
      let idOk = false;
      if (!isNonEmptyString(r.id)) {
        error(`${p}.id`, '编号必须是非空字符串');
      } else if (recorderIds.has(r.id)) {
        error(`${p}.id`, `记录器编号重复："${r.id}"（首次出现于 recorders[${recorderIds.get(r.id)}]）`);
      } else {
        recorderIds.set(r.id, i);
        idOk = true;
      }
      if (r.reference !== undefined && typeof r.reference !== 'boolean') {
        error(`${p}.reference`, 'reference 必须是布尔值或省略');
      }
      if (r.reference === true) refIndices.push(i);

      const loOk = isIntInRange(r.minOffset, -LIMIT, LIMIT);
      if (!loOk) {
        error(`${p}.minOffset`, `必须是绝对值不超过 ${LIMIT} 的整数`);
      }
      const hiOk = isIntInRange(r.maxOffset, -LIMIT, LIMIT);
      if (!hiOk) {
        error(`${p}.maxOffset`, `必须是绝对值不超过 ${LIMIT} 的整数`);
      }
      if (loOk && hiOk && (r.minOffset as number) > (r.maxOffset as number)) {
        error(`${p}.minOffset`, '下界不能大于上界');
      }
      if (loOk && hiOk && idOk) {
        recorders.push({
          id: r.id as string,
          minOffset: r.minOffset as number,
          maxOffset: r.maxOffset as number,
          reference: r.reference === true,
        });
      }
    });

    if (refIndices.length === 0) {
      error('recorders', '必须恰好指定一台 reference: true 的参考机');
    } else if (refIndices.length > 1) {
      refIndices.slice(1).forEach((idx) => {
        error(`recorders[${idx}].reference`, `参考机必须恰好一台（recorders[${refIndices[0]}] 已标记）`);
      });
    }
    // 每台标记为参考机的记录器都必须偏移恒零（无论数量是否合法）
    refIndices.forEach((idx) => {
      const item = rawRecorders[idx];
      if (item.minOffset !== 0 || item.maxOffset !== 0) {
        error(`recorders[${idx}].minOffset`, '参考机偏移必须恒为零（minOffset 与 maxOffset 均为 0）');
        if (item.maxOffset !== 0) {
          error(`recorders[${idx}].maxOffset`, '参考机偏移必须恒为零（minOffset 与 maxOffset 均为 0）');
        }
      }
    });
  }

  // 记录器数组可能因类型错误漏建元素，用原始长度对齐索引映射
  const recorderById = new Map(recorders.map((r) => [r.id, r]));

  // ---------- 事件 ----------
  const events: TimedEvent[] = [];
  const eventIds = new Map<string, number>();
  const lastTimeByRecorder = new Map<string, number>();

  if (data.events !== undefined && !Array.isArray(data.events)) {
    error('events', '必须是数组');
  }
  const rawEvents = Array.isArray(data.events) ? data.events : [];
  if (rawEvents.length > 128) {
    error('events', `事件数量至多 128（当前 ${rawEvents.length}）`);
  }
  rawEvents.forEach((item, i) => {
    const p = `events[${i}]`;
    if (!isObject(item)) {
      error(p, '事件必须是对象');
      return;
    }
    const e = item as Record<string, unknown>;
    let id = '';
    let idOk = false;
    if (!isNonEmptyString(e.id)) {
      error(`${p}.id`, '事件编号必须是非空字符串');
    } else if (eventIds.has(e.id)) {
      error(`${p}.id`, `事件编号全局重复："${e.id}"（首次出现于 events[${eventIds.get(e.id)}]）`);
    } else {
      eventIds.set(e.id, i);
      id = e.id;
      idOk = true;
    }
    const recOk = isNonEmptyString(e.recorder) && recorderById.has(e.recorder as string);
    if (!isNonEmptyString(e.recorder) || !recorderById.has(e.recorder as string)) {
      error(`${p}.recorder`, `引用了不存在的记录器：${JSON.stringify(e.recorder)}`);
    }
    let timeOk = false;
    if (!isIntInRange(e.localTime, -LIMIT, LIMIT)) {
      error(`${p}.localTime`, `本地时标必须是绝对值不超过 ${LIMIT} 的整数`);
    } else {
      timeOk = true;
      // 仅当编号合法（该条目确实构成一个事件）时才参与同机严格递增记账
      if (idOk && recOk) {
        const t = e.localTime as number;
        const recId = e.recorder as string;
        const prev = lastTimeByRecorder.get(recId);
        if (prev !== undefined && t <= prev) {
          error(`${p}.localTime`, `记录器 "${recId}" 的事件必须按时标严格递增（上一事件时标 ${prev}，当前 ${t}）`);
          timeOk = false;
        } else {
          lastTimeByRecorder.set(recId, t);
        }
      }
    }
    if (idOk && recOk && timeOk) {
      events.push({ id, recorder: e.recorder as string, localTime: e.localTime as number });
    }
  });

  // ---------- 观测 ----------
  const observations: Observation[] = [];
  const obsIds = new Set<string>();
  if (data.observations !== undefined && !Array.isArray(data.observations)) {
    error('observations', '必须是数组');
  }
  const rawObs = Array.isArray(data.observations) ? data.observations : [];
  if (rawObs.length > 256) {
    error('observations', `观测数量至多 256（当前 ${rawObs.length}）`);
  }
  const eventById = new Map(events.map((e) => [e.id, e]));

  rawObs.forEach((item, i) => {
    const p = `observations[${i}]`;
    if (!isObject(item)) {
      error(p, '观测必须是对象');
      return;
    }
    const o = item as Record<string, unknown>;
    let id = '';
    if (!isNonEmptyString(o.id)) {
      error(`${p}.id`, '观测编号必须是非空字符串');
    } else if (obsIds.has(o.id)) {
      error(`${p}.id`, `观测编号重复："${o.id}"`);
    } else {
      obsIds.add(o.id);
      id = o.id;
    }

    const send = isNonEmptyString(o.sendEvent) ? eventById.get(o.sendEvent) : undefined;
    const recv = isNonEmptyString(o.receiveEvent) ? eventById.get(o.receiveEvent) : undefined;
    if (!isNonEmptyString(o.sendEvent)) {
      error(`${p}.sendEvent`, 'sendEvent 必须是非空字符串');
    } else if (!send) {
      error(`${p}.sendEvent`, `引用了不存在的事件："${o.sendEvent}"`);
    }
    if (!isNonEmptyString(o.receiveEvent)) {
      error(`${p}.receiveEvent`, 'receiveEvent 必须是非空字符串');
    } else if (!recv) {
      error(`${p}.receiveEvent`, `引用了不存在的事件："${o.receiveEvent}"`);
    }
    if (send && recv && send.recorder === recv.recorder) {
      error(`${p}.receiveEvent`, `观测两端必须位于不同记录器（两端都在 "${send.recorder}"）`);
    }

    const dminOk = isIntInRange(o.minDelay, 0, LIMIT);
    if (!dminOk) error(`${p}.minDelay`, `必须是 0 到 ${LIMIT} 之间的整数（延迟非负）`);
    const dmaxOk = isIntInRange(o.maxDelay, 0, LIMIT);
    if (!dmaxOk) error(`${p}.maxDelay`, `必须是 0 到 ${LIMIT} 之间的整数（延迟非负）`);
    if (dminOk && dmaxOk && (o.minDelay as number) > (o.maxDelay as number)) {
      error(`${p}.minDelay`, '延迟下界不能大于上界');
    }

    if (id && send && recv && dminOk && dmaxOk) {
      observations.push({
        id,
        sendEvent: send.id,
        receiveEvent: recv.id,
        minDelay: o.minDelay as number,
        maxDelay: o.maxDelay as number,
      });
    }
  });

  // ---------- 警告（不阻断裁决） ----------
  if (issues.every((x) => x.level !== 'error')) {
    if (observations.length === 0) {
      warning('observations', '模型中没有任何观测，偏移之间不存在相互约束');
    }
    recorders.forEach((r, i) => {
      const hasEvent = events.some((e) => e.recorder === r.id);
      if (!hasEvent) warning(`recorders[${i}]`, `记录器 "${r.id}" 上没有任何事件`);
    });
  }

  if (issues.some((x) => x.level === 'error')) {
    return { issues };
  }
  return {
    issues,
    model: { recorders, events, observations },
  };
}

/** 解析 JSON 文本，语法错误也转换为定位 Issue */
export function parseModelText(text: string): { raw?: unknown; issues: Issue[] } {
  try {
    return { raw: JSON.parse(text) as unknown, issues: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      issues: [{ level: 'error', path: '$', message: `JSON 语法错误：${msg}` }],
    };
  }
}

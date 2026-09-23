import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateModel } from '../src/lib/validation.ts';
import { audit } from '../src/lib/solver.ts';
import { solveCorrection } from '../src/lib/correction.ts';
import type { NormalizedModel } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const examples = join(__dirname, '..', 'public', 'examples');

function mustValidate(raw: unknown): NormalizedModel {
  const r = validateModel(raw);
  const errors = r.issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `模型应合法，但有错误：${JSON.stringify(errors, null, 2)}`);
  assert.ok(r.model);
  return r.model!;
}

function load(name: string): NormalizedModel {
  return mustValidate(JSON.parse(readFileSync(join(examples, name), 'utf8')));
}

test('校正示例：原裁决不可行，最小代价方案恢复一致性', () => {
  const model = load('sample-correction.json');
  assert.equal(audit(model).verdict.status, 'infeasible');
  const out = solveCorrection(model);
  assert.equal(out.kind, 'found');
  if (out.kind !== 'found') return;
  const s = out.solution;

  // o1 的 widen 档代价 2 即解；o3 最便宜的候选代价虽为 1 但解不了
  assert.equal(s.totalCost, 2);
  assert.equal(s.changedCount, 1);
  assert.equal(s.changes[0].observationIndex, 0);
  assert.equal(s.changes[0].observationId, 'o1');
  assert.equal(s.changes[0].candidateId, 'wider');
  assert.deepEqual([s.changes[0].beforeMinDelay, s.changes[0].beforeMaxDelay], [0, 0]);
  assert.deepEqual([s.changes[0].afterMinDelay, s.changes[0].afterMaxDelay], [0, 10]);
  assert.equal(s.changes[0].cost, 2);

  // 恢复后为唯一解：R1=R2=10，端点见证下每条观测延迟均在（校正后）区间内
  assert.equal(s.restored.status, 'unique');
  const byId = new Map(s.restored.ranges.map((r) => [r.recorderId, r]));
  assert.deepEqual([byId.get('R1')!.min, byId.get('R1')!.max], [10, 10]);
  assert.deepEqual([byId.get('R2')!.min, byId.get('R2')!.max], [10, 10]);
  for (const w of [s.restored.allMinWitness, s.restored.allMaxWitness]) {
    for (const d of w.observationDelays) assert.ok(d.feasible, `${d.observationId} 见证延迟应在区间内`);
  }
  // 校正后 o1 的区间已替换为候选区间
  const o1w = s.restored.allMinWitness.observationDelays.find((d) => d.observationId === 'o1')!;
  assert.equal(o1w.minDelay, 0);
  assert.equal(o1w.maxDelay, 10);
});

test('无方案示例：所有候选组合都不可行，保留原负链', () => {
  const model = load('sample-noscheme.json');
  assert.equal(audit(model).verdict.status, 'infeasible');
  const out = solveCorrection(model);
  assert.equal(out.kind, 'noscheme');
  if (out.kind !== 'noscheme') return;
  assert.equal(out.feasibleCombinations, 0);
  assert.ok(out.chain.edges.length >= 2);
  assert.ok(out.chain.totalWeight < 0);
  // 链首尾相接
  const ce = out.chain.edges;
  for (let i = 0; i < ce.length; i++) assert.equal(ce[i].to, ce[(i + 1) % ce.length].from);
});

test('旧模型：不可行但无候选档位 → nottriggered，保持原裁决', () => {
  const model = load('sample-infeasible.json');
  assert.equal(solveCorrection(model).kind, 'nottriggered');
});

test('原裁决可行：即使声明候选档位也不发起校正', () => {
  const model = mustValidate({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'B', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 's', recorder: 'A', localTime: 0 },
      { id: 'r', recorder: 'B', localTime: 7 },
    ],
    observations: [
      { id: 'o', sendEvent: 's', receiveEvent: 'r', minDelay: 3, maxDelay: 3,
        candidates: [{ id: 'c', minDelay: 0, maxDelay: 9, cost: 1 }] },
    ],
  });
  assert.equal(audit(model).verdict.status, 'unique');
  assert.equal(solveCorrection(model).kind, 'nottriggered');
});

test('平局判据：总代价相同取被改观测数更少者', () => {
  // 单改 OE(cost5) 与改 O0(cost2)+O2(cost3) 均可解，总代价都为 5 -> 取单改
  const model = mustValidate({
    recorders: [
      { id: 'R0', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'R1', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 'a', recorder: 'R0', localTime: 0 }, { id: 'b', recorder: 'R1', localTime: 10 },
      { id: 'c', recorder: 'R0', localTime: 20 }, { id: 'er', recorder: 'R1', localTime: 20 },
      { id: 'd', recorder: 'R1', localTime: 30 }, { id: 'f', recorder: 'R0', localTime: 40 },
    ],
    observations: [
      { id: 'O0', sendEvent: 'a', receiveEvent: 'b', minDelay: 10, maxDelay: 10,
        candidates: [{ id: 'p', minDelay: 30, maxDelay: 30, cost: 2 }] },
      { id: 'O2', sendEvent: 'c', receiveEvent: 'd', minDelay: 10, maxDelay: 10,
        candidates: [{ id: 'p', minDelay: 30, maxDelay: 30, cost: 3 }] },
      { id: 'OE', sendEvent: 'er', receiveEvent: 'f', minDelay: 0, maxDelay: 0,
        candidates: [{ id: 'single', minDelay: 20, maxDelay: 20, cost: 5 }] },
    ],
  });
  const out = solveCorrection(model);
  assert.equal(out.kind, 'found');
  if (out.kind !== 'found') return;
  assert.equal(out.solution.totalCost, 5);
  assert.equal(out.solution.changedCount, 1);
  assert.equal(out.solution.changes[0].observationIndex, 2);
});

test('平局判据：代价/改动数相同取观测索引更小者', () => {
  const model = mustValidate({
    recorders: [
      { id: 'R0', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'R1', minOffset: -100, maxOffset: 100 },
      { id: 'R2', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 'a', recorder: 'R0', localTime: 0 }, { id: 'b', recorder: 'R1', localTime: 0 },
      { id: 'c', recorder: 'R2', localTime: 0 }, { id: 'e', recorder: 'R0', localTime: 10 },
    ],
    observations: [
      { id: 'A', sendEvent: 'a', receiveEvent: 'b', minDelay: 0, maxDelay: 0,
        candidates: [{ id: 'looseA', minDelay: 0, maxDelay: 10, cost: 5 }] },
      { id: 'M', sendEvent: 'b', receiveEvent: 'c', minDelay: 0, maxDelay: 0 },
      { id: 'B', sendEvent: 'c', receiveEvent: 'e', minDelay: 0, maxDelay: 0,
        candidates: [{ id: 'looseB', minDelay: 0, maxDelay: 10, cost: 5 }] },
    ],
  });
  const out = solveCorrection(model);
  assert.equal(out.kind, 'found');
  if (out.kind !== 'found') return;
  assert.deepEqual(out.solution.key, [{ observationIndex: 0, candidateId: 'looseA' }]);
  assert.equal(out.solution.feasibleCombinations, 2);
});

test('平局判据：同观测等代价可行档位取编号字典序更小者', () => {
  const model = mustValidate({
    recorders: [
      { id: 'R0', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'R1', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 'a', recorder: 'R0', localTime: 0 }, { id: 'b', recorder: 'R1', localTime: 10 },
      { id: 'c', recorder: 'R0', localTime: 20 }, { id: 'er', recorder: 'R1', localTime: 20 },
      { id: 'd', recorder: 'R1', localTime: 30 }, { id: 'f', recorder: 'R0', localTime: 40 },
    ],
    observations: [
      { id: 'O0', sendEvent: 'a', receiveEvent: 'b', minDelay: 10, maxDelay: 10,
        candidates: [{ id: 'p', minDelay: 30, maxDelay: 30, cost: 2 }] },
      { id: 'O2', sendEvent: 'c', receiveEvent: 'd', minDelay: 10, maxDelay: 10,
        candidates: [{ id: 'p', minDelay: 30, maxDelay: 30, cost: 3 }] },
      { id: 'OE', sendEvent: 'er', receiveEvent: 'f', minDelay: 0, maxDelay: 0,
        candidates: [
          { id: 'zzz', minDelay: 20, maxDelay: 20, cost: 5 },
          { id: 'aaa', minDelay: 20, maxDelay: 20, cost: 5 },
        ] },
    ],
  });
  const out = solveCorrection(model);
  assert.equal(out.kind, 'found');
  if (out.kind !== 'found') return;
  // OE 的两个等代价可行档位之间取编号字典序更小者；整组最优为单改 OE
  assert.equal(out.solution.changedCount, 1);
  assert.equal(out.solution.changes[0].observationIndex, 2);
  assert.equal(out.solution.changes[0].candidateId, 'aaa');
});

test('候选档位校验：数量、编号、区间、代价全部精确定位', () => {
  const r = validateModel({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'B', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 's', recorder: 'A', localTime: 0 },
      { id: 'r', recorder: 'B', localTime: 0 },
    ],
    observations: [
      {
        id: 'o', sendEvent: 's', receiveEvent: 'r', minDelay: 0, maxDelay: 0,
        candidates: [
          { id: 'x', minDelay: -1, maxDelay: 0, cost: 0 },
          { id: 'x', minDelay: 5, maxDelay: 3, cost: 2_000_000 },
          { id: 'z', minDelay: 0, maxDelay: 0, cost: 1 },
        ],
      },
    ],
  });
  const paths = r.issues.filter((i) => i.level === 'error').map((i) => i.path);
  for (const p of [
    'observations[0].candidates[0].minDelay',
    'observations[0].candidates[0].cost',
    'observations[0].candidates[1].id',
    'observations[0].candidates[1].minDelay',
    'observations[0].candidates[1].cost',
  ]) {
    assert.ok(paths.includes(p), `缺少定位 ${p}；实际：${JSON.stringify(paths)}`);
  }
});

test('候选档位：超过 3 个在数组层报错', () => {
  const r = validateModel({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'B', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 's', recorder: 'A', localTime: 0 },
      { id: 'r', recorder: 'B', localTime: 0 },
    ],
    observations: [
      {
        id: 'o', sendEvent: 's', receiveEvent: 'r', minDelay: 0, maxDelay: 0,
        candidates: [
          { id: 'a', minDelay: 0, maxDelay: 0, cost: 1 },
          { id: 'b', minDelay: 0, maxDelay: 0, cost: 1 },
          { id: 'c', minDelay: 0, maxDelay: 0, cost: 1 },
          { id: 'd', minDelay: 0, maxDelay: 0, cost: 1 },
        ],
      },
    ],
  });
  assert.ok(
    r.issues.some((i) => i.level === 'error' && i.path === 'observations[0].candidates'),
    `应在数组层报至多 3 档；实际：${JSON.stringify(r.issues)}`,
  );
});

test('候选档位：空数组 / 非数组 / 非对象均被拒', () => {
  const mk = (candidates: unknown) =>
    validateModel({
      recorders: [
        { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
        { id: 'B', minOffset: -100, maxOffset: 100 },
      ],
      events: [
        { id: 's', recorder: 'A', localTime: 0 },
        { id: 'r', recorder: 'B', localTime: 0 },
      ],
      observations: [
        { id: 'o', sendEvent: 's', receiveEvent: 'r', minDelay: 0, maxDelay: 0, candidates },
      ],
    });
  assert.ok(mk([]).issues.some((i) => i.path === 'observations[0].candidates'));
  assert.ok(mk({}).issues.some((i) => i.path === 'observations[0].candidates'));
  assert.ok(mk([42]).issues.some((i) => i.path === 'observations[0].candidates[0]'));
});

test('声明候选档位的观测至多 18 条', () => {
  const recorders = [
    { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
    { id: 'B', minOffset: -1000, maxOffset: 1000 },
  ];
  const events = [
    { id: 's', recorder: 'A', localTime: 0 },
    ...Array.from({ length: 19 }, (_, i) => ({ id: `r${i}`, recorder: 'B', localTime: 10 + i })),
  ];
  const observations = Array.from({ length: 19 }, (_, i) => ({
    id: `o${i}`,
    sendEvent: 's',
    receiveEvent: `r${i}`,
    minDelay: 0,
    maxDelay: 100,
    candidates: [{ id: 'c', minDelay: 0, maxDelay: 200, cost: 1 }],
  }));
  const r = validateModel({ recorders, events, observations });
  assert.ok(
    r.issues.some((i) => i.level === 'error' && i.path === 'observations' && /18/.test(i.message)),
    `应报 18 条上限；实际：${JSON.stringify(r.issues)}`,
  );
});

test('恰好 18 条候选观测为合法上限', () => {
  const recorders = [
    { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
    { id: 'B', minOffset: -1000, maxOffset: 1000 },
  ];
  const events = [
    { id: 's', recorder: 'A', localTime: 0 },
    ...Array.from({ length: 18 }, (_, i) => ({ id: `r${i}`, recorder: 'B', localTime: 10 + i })),
  ];
  const observations = Array.from({ length: 18 }, (_, i) => ({
    id: `o${i}`,
    sendEvent: 's',
    receiveEvent: `r${i}`,
    minDelay: 0,
    maxDelay: 100,
    candidates: [{ id: 'c', minDelay: 0, maxDelay: 200, cost: 1 }],
  }));
  const r = validateModel({ recorders, events, observations });
  assert.deepEqual(r.issues.filter((i) => i.level === 'error'), []);
});

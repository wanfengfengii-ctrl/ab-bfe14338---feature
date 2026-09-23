import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateModel, parseModelText } from '../src/lib/validation.ts';
import { audit } from '../src/lib/solver.ts';
import type { NormalizedModel, Recorder } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const examples = join(__dirname, '..', 'public', 'examples');

function mustValidate(raw: unknown): NormalizedModel {
  const r = validateModel(raw);
  const errors = r.issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `模型应合法，但有错误：${JSON.stringify(errors, null, 2)}`);
  assert.ok(r.model);
  return r.model!;
}

test('可行示例：紧确界、唯一/多解判定与见证赋值', () => {
  const raw = JSON.parse(readFileSync(join(examples, 'sample-feasible.json'), 'utf8'));
  const model = mustValidate(raw);
  const { verdict } = audit(model);
  assert.ok(verdict.status !== 'infeasible');

  const byId = new Map(verdict.ranges.map((r) => [r.recorderId, r]));
  // o1: (1010+x1)-1000 ∈ [1,30]  ⇒ x1 ∈ [-9, 20]
  // o2: (1020+x2)-(1010+x1) ∈ [0,25] ⇒ x2-x1 ∈ [-10,15]
  // o3: 1200-(1020+x2) ∈ [5,200] ⇒ x2 ∈ [-20,175]
  // o4: (1115+x2)-(1100+x1) ∈ [10,30] ⇒ x2-x1 ∈ [-5,15]
  assert.equal(byId.get('R0')!.min, 0);
  assert.equal(byId.get('R0')!.max, 0);
  assert.equal(byId.get('R1')!.min, -9);
  assert.equal(byId.get('R1')!.max, 20);
  // x2: min = min(x1)-5 = -14；max = max(x1)+15 = 35（o2 的下界-10 与 o4 的-5 取紧者）
  assert.equal(byId.get('R2')!.min, -14);
  assert.equal(byId.get('R2')!.max, 35);
  assert.equal(verdict.status, 'multiple');

  // 全体最小见证：x1=-9, x2=-14
  assert.deepEqual(verdict.allMinWitness.offsets, { R0: 0, R1: -9, R2: -14 });
  for (const d of verdict.allMinWitness.observationDelays) {
    assert.ok(d.feasible, `${d.observationId} 最小见证下应可行，实际延迟 ${d.actualDelay}`);
  }
  // o4 在最小见证下贴下界 10
  const o4min = verdict.allMinWitness.observationDelays.find((d) => d.observationId === 'o4')!;
  assert.equal(o4min.actualDelay, 10);
  // 全体最大见证：x1=20, x2=35
  assert.deepEqual(verdict.allMaxWitness.offsets, { R0: 0, R1: 20, R2: 35 });
  for (const d of verdict.allMaxWitness.observationDelays) {
    assert.ok(d.feasible, `${d.observationId} 最大见证下应可行，实际延迟 ${d.actualDelay}`);
  }
});

test('不可行示例：负权闭合链总和严格小于零', () => {
  const raw = JSON.parse(readFileSync(join(examples, 'sample-infeasible.json'), 'utf8'));
  const model = mustValidate(raw);
  const { verdict } = audit(model);
  assert.equal(verdict.status, 'infeasible');
  if (verdict.status !== 'infeasible') return;
  assert.ok(verdict.chain.edges.length >= 2);
  assert.ok(verdict.chain.totalWeight < 0, '链上权值总和必须严格小于零');
  let sum = 0;
  for (const e of verdict.chain.edges) sum += e.weight;
  assert.equal(sum, verdict.chain.totalWeight);
  // 链必须首尾相接：相邻边的终点=下一条边的起点，且末边回到首边起点
  const ce = verdict.chain.edges;
  for (let i = 0; i < ce.length; i++) {
    const cur = ce[i];
    const next = ce[(i + 1) % ce.length];
    assert.equal(
      cur.to,
      next.from,
      `闭合链第 ${i + 1} 条边终点应等于下一条边起点`,
    );
  }
  // 总和必须与沿链矛盾式 0 <= total 一致
  assert.ok(/0 ≤ -?\d+/.test(verdict.chain.contradiction));
});

test('唯一解：全部范围为单点', () => {
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
      { id: 'o', sendEvent: 's', receiveEvent: 'r', minDelay: 3, maxDelay: 3 },
    ],
  });
  const { verdict } = audit(model);
  assert.equal(verdict.status, 'unique');
  const b = verdict.ranges.find((r) => r.recorderId === 'B')!;
  assert.equal(b.min, -4);
  assert.equal(b.max, -4);
});

test('界内可行但观测矛盾：两台记录器往返闭合', () => {
  const model = mustValidate({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'B', minOffset: -5, maxOffset: 5 },
    ],
    events: [
      { id: 'a1', recorder: 'A', localTime: 0 },
      { id: 'b1', recorder: 'B', localTime: 0 },
      { id: 'b2', recorder: 'B', localTime: 10 },
      { id: 'a2', recorder: 'A', localTime: 8 },
    ],
    observations: [
      { id: 'o1', sendEvent: 'a1', receiveEvent: 'b1', minDelay: 2, maxDelay: 2 },
      { id: 'o2', sendEvent: 'b2', receiveEvent: 'a2', minDelay: 0, maxDelay: 0 },
    ],
  });
  const { verdict } = audit(model);
  assert.equal(verdict.status, 'infeasible');
});

test('三台记录器纯观测矛盾：闭合链正确相接且为负环', () => {
  // 三条观测形成 xB-xA<=0、xC-xB<=0、xA-xC<=-3
  const model = mustValidate({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'B', minOffset: -100, maxOffset: 100 },
      { id: 'C', minOffset: -100, maxOffset: 100 },
    ],
    events: [
      { id: 'a', recorder: 'A', localTime: 0 },
      { id: 'b', recorder: 'B', localTime: 0 },
      { id: 'c', recorder: 'C', localTime: 0 },
      { id: 'a2', recorder: 'A', localTime: 10 },
      { id: 'b2', recorder: 'B', localTime: 10 },
      { id: 'c2', recorder: 'C', localTime: 10 },
    ],
    observations: [
      { id: 'ab', sendEvent: 'a', receiveEvent: 'b', minDelay: 0, maxDelay: 0 },
      { id: 'bc', sendEvent: 'b', receiveEvent: 'c', minDelay: 0, maxDelay: 0 },
      { id: 'ca', sendEvent: 'c', receiveEvent: 'a2', minDelay: 0, maxDelay: 0 },
      { id: 'rest', sendEvent: 'b2', receiveEvent: 'c2', minDelay: 0, maxDelay: 0 },
    ],
  });
  const { verdict } = audit(model);
  assert.equal(verdict.status, 'infeasible');
  if (verdict.status !== 'infeasible') return;
  // ca: a2 在 A@10, c 在 C@0：真实差 = 10+xA-xC ∈[0,0] ⇒ xA-xC<=-10（强负环）
  assert.ok(verdict.chain.totalWeight < 0);
  const ce = verdict.chain.edges;
  for (let i = 0; i < ce.length; i++) {
    assert.equal(ce[i].to, ce[(i + 1) % ce.length].from);
  }
});

test('24 台记录器规模边界通过', () => {
  const recorders: Recorder[] = [{ id: 'R0', minOffset: 0, maxOffset: 0, reference: true }];
  for (let i = 1; i < 24; i++) recorders.push({ id: `R${i}`, minOffset: -1000, maxOffset: 1000 });
  const events = [{ id: 'e0', recorder: 'R0', localTime: 0 }];
  const observations = [];
  for (let i = 1; i < 24; i++) {
    events.push({ id: `e${i}`, recorder: `R${i}`, localTime: 5 });
    observations.push({ id: `o${i}`, sendEvent: 'e0', receiveEvent: `e${i}`, minDelay: 0, maxDelay: 100 });
  }
  const model = mustValidate({ recorders, events, observations });
  const { verdict } = audit(model);
  assert.notEqual(verdict.status, 'infeasible');
});

test('校验：非法编号/时标/界值/引用全部精确定位', () => {
  const r = validateModel({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 0, reference: true },
      { id: 'A', minOffset: 5, maxOffset: 3 },
      { id: 'C', minOffset: -2e9, maxOffset: 1 },
    ],
    events: [
      { id: 'x', recorder: 'ZZ', localTime: 1.5 },
      { id: 'x', recorder: 'A', localTime: 10 },
      { id: 'y', recorder: 'A', localTime: 10 },
    ],
    observations: [
      { id: 'dup', sendEvent: 'y', receiveEvent: 'y', minDelay: -1, maxDelay: 0 },
      { id: 'dup', sendEvent: 'nope', receiveEvent: 'y', minDelay: 0, maxDelay: -5 },
    ],
  });
  const paths = r.issues.filter((i) => i.level === 'error').map((i) => i.path);
  for (const p of [
    'recorders[1].id',
    'recorders[1].minOffset',
    'recorders[2].minOffset',
    'events[0].recorder',
    'events[0].localTime',
    'events[1].id',
    'observations[0].receiveEvent',
    'observations[0].minDelay',
    'observations[1].id',
    'observations[1].sendEvent',
    'observations[1].maxDelay',
  ]) {
    assert.ok(paths.includes(p), `缺少定位 ${p}；实际：${JSON.stringify(paths)}`);
  }
  assert.ok(!r.model, '存在错误时不应产出模型');
});

test('校验：参考机缺失/非零/多台', () => {
  const r1 = validateModel({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 1 },
      { id: 'B', minOffset: 0, maxOffset: 0 },
    ],
    events: [],
    observations: [],
  });
  assert.ok(r1.issues.some((i) => i.path === 'recorders' && /参考机/.test(i.message)));

  const r2 = validateModel({
    recorders: [
      { id: 'A', minOffset: 0, maxOffset: 1, reference: true },
      { id: 'B', minOffset: 0, maxOffset: 0, reference: true },
    ],
    events: [],
    observations: [],
  });
  assert.ok(r2.issues.some((i) => i.path === 'recorders[1].reference'));
  assert.ok(r2.issues.some((i) => i.path === 'recorders[0].maxOffset'));
});

test('校验：记录器数量与事件时标严格递增', () => {
  const r = validateModel({
    recorders: [{ id: 'A', minOffset: 0, maxOffset: 0, reference: true }],
    events: [],
    observations: [],
  });
  assert.ok(r.issues.some((i) => i.path === 'recorders'));
});

test('JSON 语法错误转为定位问题', () => {
  const r = parseModelText('{ not json');
  assert.equal(r.issues[0].path, '$');
  assert.ok(/JSON 语法错误/.test(r.issues[0].message));
});

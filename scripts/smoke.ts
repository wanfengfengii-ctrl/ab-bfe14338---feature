/**
 * HTTP 冒烟检查（verify 一次性服务第 4 步）：
 *  1. /health 返回 ok
 *  2. / 返回首页 HTML 且引用存在的 JS 静态资源（资源再单独 GET 200）
 *  3. 经 HTTP 取得可行/不可行示例模型，用同一套裁决代码复算并核对结论
 * 任一项不满足即抛错，进程以非零码退出。
 */
import { validateModel } from '../src/lib/validation.ts';
import { audit } from '../src/lib/solver.ts';
import { solveCorrection } from '../src/lib/correction.ts';

const BASE = (process.env.BASE_URL ?? 'http://web:80').replace(/\/$/, '');

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${detail}`);
    failures++;
  }
}

async function get(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  return res;
}

async function main() {
  console.log(`BASE_URL = ${BASE}`);

  const health = await get('/health');
  check('GET /health 为 200', health.status === 200, `status=${health.status}`);
  const healthText = (await health.text()).trim();
  check('/health 正文为 ok', healthText === 'ok', `body=${JSON.stringify(healthText)}`);

  const index = await get('/');
  check('GET / 为 200', index.status === 200, `status=${index.status}`);
  const html = await index.text();
  check('首页包含挂载点 #root', html.includes('id="root"'));
  const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
  check('首页引用 /assets 下的 JS 资源', assetMatch !== null);
  if (assetMatch) {
    const asset = await get(assetMatch[1]);
    check(`静态资源 ${assetMatch[1]} 为 200`, asset.status === 200, `status=${asset.status}`);
    const js = await asset.text();
    check('JS 资源非空且像构建产物', js.length > 1000, `length=${js.length}`);
  }

  const cssMatch = html.match(/href="(\/assets\/[^"]+\.css)"/);
  if (cssMatch) {
    const css = await get(cssMatch[1]);
    check(`静态资源 ${cssMatch[1]} 为 200`, css.status === 200, `status=${css.status}`);
  }

  // 经 HTTP 取模型样本并用裁决代码复算
  const feasibleRes = await get('/examples/sample-feasible.json');
  check('可行示例经 HTTP 可取', feasibleRes.status === 200);
  const feasible = validateModel(await feasibleRes.json());
  check('可行示例校验通过', feasible.issues.every((i) => i.level !== 'error'));
  if (feasible.model) {
    const v = audit(feasible.model).verdict;
    check('可行示例裁决为多解', v.status === 'multiple', `status=${v.status}`);
    if (v.status !== 'infeasible') {
      const r1 = v.ranges.find((r) => r.recorderId === 'R1')!;
      check('R1 紧确界为 [-9, 20]', r1.min === -9 && r1.max === 20, `got [${r1.min}, ${r1.max}]`);
      check(
        '全体最小赋值每条观测延迟均在界内',
        v.allMinWitness.observationDelays.every((d) => d.feasible),
      );
      check(
        '全体最大赋值每条观测延迟均在界内',
        v.allMaxWitness.observationDelays.every((d) => d.feasible),
      );
    }
  }

  const infeasibleRes = await get('/examples/sample-infeasible.json');
  check('不可行示例经 HTTP 可取', infeasibleRes.status === 200);
  const infeasible = validateModel(await infeasibleRes.json());
  if (infeasible.model) {
    const v = audit(infeasible.model).verdict;
    check('不可行示例裁决为 infeasible', v.status === 'infeasible', `status=${v.status}`);
    if (v.status === 'infeasible') {
      check(
        '闭合约束链权值总和严格小于零',
        v.chain.totalWeight < 0,
        `sum=${v.chain.totalWeight}`,
      );
      check('链至少含 2 条边', v.chain.edges.length >= 2, `n=${v.chain.edges.length}`);
    }
    // 旧模型（无候选档位）保持原裁决：不发起校正
    check('旧不可行模型不发起校正', solveCorrection(infeasible.model).kind === 'nottriggered');
  }

  // 档位校正示例：经 HTTP 取件并用同一套代码复算全局最优校正
  const correctionRes = await get('/examples/sample-correction.json');
  check('校正示例经 HTTP 可取', correctionRes.status === 200);
  const correction = validateModel(await correctionRes.json());
  check('校正示例校验通过', correction.issues.every((i) => i.level !== 'error'));
  if (correction.model) {
    check('校正示例原裁决为 infeasible', audit(correction.model).verdict.status === 'infeasible');
    const c = solveCorrection(correction.model);
    check('校正结果为 found', c.kind === 'found', `kind=${c.kind}`);
    if (c.kind === 'found') {
      check('最优总代价为 2（取 o1 的 widen 档）', c.solution.totalCost === 2, `cost=${c.solution.totalCost}`);
      check('被改观测数为 1', c.solution.changedCount === 1, `count=${c.solution.changedCount}`);
      check('恢复后裁决可行（唯一解或多解）', c.solution.restored.status === 'unique' || c.solution.restored.status === 'multiple');
      check(
        '恢复后端点见证每条观测延迟均在界内',
        c.solution.restored.allMinWitness.observationDelays.every((d) => d.feasible) &&
          c.solution.restored.allMaxWitness.observationDelays.every((d) => d.feasible),
      );
    }
  }

  // 无方案示例：所有候选组合都不可行，保留原负链
  const noschemeRes = await get('/examples/sample-noscheme.json');
  check('无方案示例经 HTTP 可取', noschemeRes.status === 200);
  const noscheme = validateModel(await noschemeRes.json());
  if (noscheme.model) {
    const c = solveCorrection(noscheme.model);
    check('无方案示例结果为 noscheme', c.kind === 'noscheme', `kind=${c.kind}`);
    if (c.kind === 'noscheme') {
      check('可行组合数为 0', c.feasibleCombinations === 0, `feasible=${c.feasibleCombinations}`);
      check('保留的负链总和严格小于零', c.chain.totalWeight < 0, `sum=${c.chain.totalWeight}`);
    }
  }

  if (failures > 0) {
    console.error(`\n冒烟检查失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n冒烟检查全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

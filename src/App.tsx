import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { parseModelText, validateModel } from './lib/validation';
import { audit } from './lib/solver';
import type {
  ConstraintChain,
  CorrectionPlan,
  CorrectionSearchStats,
  EndpointWitness,
  Issue,
  NormalizedModel,
  RecorderRange,
  Verdict,
} from './types';
import { WitnessPanel } from './components/WitnessPanel';
import type { SolveArtifacts } from './lib/solver';

type Analysis =
  | { stage: 'empty' }
  | { stage: 'syntax'; issues: Issue[] }
  | { stage: 'invalid'; issues: Issue[] }
  | { stage: 'audited'; issues: Issue[]; model: NormalizedModel; artifacts: SolveArtifacts };

interface EndpointSelection {
  witness: EndpointWitness;
  ranges: RecorderRange[];
  recorderId: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function App() {
  const [text, setText] = useState<string>('');
  const [loadedName, setLoadedName] = useState<string>('（手动编辑）');
  const [selection, setSelection] = useState<EndpointSelection | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 每次文本变更都重新解析/校验/裁决，不保留任何旧裁决 → 旧裁决立即清除
  const analysis: Analysis = useMemo(() => {
    if (text.trim() === '') return { stage: 'empty' };
    const parsed = parseModelText(text);
    if (parsed.issues.length > 0) return { stage: 'syntax', issues: parsed.issues };
    const result = validateModel(parsed.raw);
    if (result.issues.some((i) => i.level === 'error')) {
      return { stage: 'invalid', issues: result.issues };
    }
    const model = result.model!;
    return { stage: 'audited', issues: result.issues, model, artifacts: audit(model) };
  }, [text]);

  const openEndpoint = (
    witness: EndpointWitness,
    ranges: RecorderRange[],
    recorderId: string,
  ) => setSelection({ witness, ranges, recorderId });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setLoadedName(file.name);
    setSelection(null);
  };

  const loadExample = async (name: string) => {
    const res = await fetch(`examples/${name}`);
    setText(await res.text());
    setLoadedName(name);
    setSelection(null);
  };

  const clearAll = () => {
    setText('');
    setLoadedName('（手动编辑）');
    setSelection(null);
  };

  const errors =
    analysis.stage === 'syntax' || analysis.stage === 'invalid'
      ? analysis.issues.filter((i) => i.level === 'error')
      : [];
  const warnings =
    analysis.stage === 'audited' || analysis.stage === 'invalid'
      ? analysis.issues.filter((i) => i.level === 'warning')
      : [];

  return (
    <div className="app">
      <header className="topbar">
        <h1>脉冲时标一致性复核台</h1>
        <span className="muted">
          纯前端 · 本地时标 + 偏移 = 真实时刻 · 观测延迟闭区间 · 差分约束精确裁决
        </span>
      </header>

      <div className="layout">
        <section className="pane editor-pane">
          <div className="pane-head">
            <h2>模型（JSON）</h2>
            <div className="actions">
              <button className="btn" onClick={() => fileRef.current?.click()}>导入文件…</button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <button className="btn" onClick={() => void loadExample('sample-feasible.json')}>
                示例：可行
              </button>
              <button className="btn" onClick={() => void loadExample('sample-infeasible.json')}>
                示例：不可行
              </button>
              <button className="btn" onClick={() => void loadExample('sample-correction.json')}>
                示例：档位校正
              </button>
              <button className="btn ghost" onClick={clearAll}>清空</button>
            </div>
          </div>
          <p className="muted small">
            当前来源：{loadedName}　·　编辑任意字符即重新校验并清除旧裁决
          </p>
          <textarea
            className="editor"
            spellCheck={false}
            value={text}
            placeholder={'{\n  "recorders": [ ... ],\n  "events": [ ... ],\n  "observations": [ ... ]\n}'}
            onChange={(e) => {
              // 输入变更立即清除旧裁决与旧见证
              setSelection(null);
              setText(e.target.value);
            }}
          />

          {warnings.length > 0 && (
            <div className="issues">
              <h3>警告（{warnings.length}，不阻断裁决）</h3>
              <ul>
                {warnings.map((iss, i) => (
                  <li key={i} className="issue warning">
                    <code>{iss.path}</code> {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {errors.length > 0 && (
            <div className="issues">
              <h3>错误（{errors.length}）—— 裁决被阻断</h3>
              <ul>
                {errors.map((iss, i) => (
                  <li key={i} className="issue error">
                    <code>{iss.path}</code> {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="pane verdict-pane">
          <div className="pane-head"><h2>审计裁决</h2></div>
          {analysis.stage === 'empty' && (
            <div className="placeholder">
              <p>导入或在左侧粘贴模型 JSON 开始复核。</p>
              <p className="muted small">
                约束规模：记录器 2–24 台、事件 ≤128、观测 ≤256；本地时标与界值为绝对值 ≤ 10⁹ 的整数。
              </p>
            </div>
          )}
          {analysis.stage === 'syntax' && (
            <Banner kind="bad" title="无法解析">
              JSON 文本存在语法错误，修正后才会继续。
            </Banner>
          )}
          {analysis.stage === 'invalid' && (
            <Banner kind="bad" title="模型非法">
              左侧列出的编号 / 时标 / 界值 / 引用问题全部修复后才进行裁决。
            </Banner>
          )}
          {analysis.stage === 'audited' && (
            <VerdictBody
              model={analysis.model}
              verdict={analysis.artifacts.verdict}
              onOpen={openEndpoint}
            />
          )}
        </section>
      </div>

      {selection && (
        <WitnessPanel
          witness={selection.witness}
          ranges={selection.ranges}
          focusRecorderId={selection.recorderId}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

function Banner({ kind, title, children }: { kind: 'good' | 'mid' | 'bad'; title: string; children?: ReactNode }) {
  return (
    <div className={`banner ${kind}`}>
      <strong>{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

function VerdictBody({
  model,
  verdict,
  onOpen,
}: {
  model: NormalizedModel;
  verdict: Verdict;
  onOpen: (w: EndpointWitness, r: RecorderRange[], id: string) => void;
}) {
  return (
    <div className="verdict-body">
      <div className="meta small muted">
        记录器 {model.recorders.length} 台 · 事件 {model.events.length} 个 · 观测 {model.observations.length} 条
      </div>

      {verdict.status === 'unique' && (
        <Banner kind="good" title="裁决：唯一解">
          所有记录器的偏移可行域均为单点，存在唯一一致的真实时间解释。
        </Banner>
      )}
      {verdict.status === 'multiple' && (
        <Banner kind="mid" title="裁决：多解">
          至少一台记录器的偏移可行域宽度大于零，逐对校时拼不出唯一解释；下列区间均为紧确界。
        </Banner>
      )}
      {verdict.status === 'infeasible' && (
        <Banner kind="bad" title="裁决：不可行">
          不存在任何一致的真实时间解释。下方是一条上界总和严格小于零的闭合约束链。
        </Banner>
      )}

      {verdict.status !== 'infeasible' && (
        <>
          <div className="pane-head compact">
            <h3>紧确偏移区间（点选端点查看完整见证）</h3>
            <div className="actions">
              <button
                className="btn small"
                onClick={() => onOpen(verdict.allMinWitness, verdict.ranges, verdict.ranges[0].recorderId)}
              >
                全体最小赋值
              </button>
              <button
                className="btn small"
                onClick={() => onOpen(verdict.allMaxWitness, verdict.ranges, verdict.ranges[0].recorderId)}
              >
                全体最大赋值
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>记录器</th>
                  <th>最小偏移</th>
                  <th>最大偏移</th>
                  <th>宽度</th>
                </tr>
              </thead>
              <tbody>
                {verdict.ranges.map((r) => (
                  <tr key={r.recorderId}>
                    <td>
                      {r.recorderId}
                      {r.reference && <span className="tag ref">参考机</span>}
                      {r.min === r.max && <span className="tag point">单点</span>}
                    </td>
                    <td>
                      <button
                        className="endpoint min-ep"
                        title="点选查看：全体最小值完整可行赋值"
                        onClick={() => onOpen(verdict.allMinWitness, verdict.ranges, r.recorderId)}
                      >
                        {fmt(r.min)} ◂
                      </button>
                    </td>
                    <td>
                      <button
                        className="endpoint max-ep"
                        title="点选查看：全体最大值完整可行赋值"
                        onClick={() => onOpen(verdict.allMaxWitness, verdict.ranges, r.recorderId)}
                      >
                        {fmt(r.max)} ▸
                      </button>
                    </td>
                    <td className="mono">{fmt(r.max - r.min)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            紧确性：每个最小值都在“全体最小赋值”中同时达到，每个最大值都在“全体最大赋值”中同时达到；
            端点详情列出全部偏移与每条观测的实际延迟。
          </p>
        </>
      )}

      {verdict.status === 'infeasible' && (
        <>
          {verdict.correction !== undefined && (
            <CorrectionPanel
              correction={verdict.correction}
              onOpen={onOpen}
            />
          )}
          <ChainView chain={verdict.chain} />
        </>
      )}
    </div>
  );
}

function SearchStatsView({ stats }: { stats: CorrectionSearchStats }) {
  return (
    <p className="muted small">
      全局精确枚举（非逐条贪心、非首个可行即止）：参与观测 {stats.eligibleObservations} 条 ·
      组合空间 {fmt(stats.totalCombinations)} 个 · 访问节点 {fmt(stats.visitedNodes)} ·
      到达叶子 {fmt(stats.evaluatedLeaves)}（其中可行 {fmt(stats.feasibleCombinations)}）·
      部分矛盾剪枝 {fmt(stats.prunedInfeasible)} · 目标界剪枝 {fmt(stats.prunedBound)}。
      所有未到达叶子的组合均经证明不可能更优，故最优组合完整可比。
    </p>
  );
}

function CorrectionPanel({
  correction,
  onOpen,
}: {
  correction: NonNullable<Extract<Verdict, { status: 'infeasible' }>['correction']>;
  onOpen: (w: EndpointWitness, r: RecorderRange[], id: string) => void;
}) {
  if (correction.status === 'no-plan') {
    return (
      <div className="correction">
        <Banner kind="bad" title="校正复核：无方案">
          已在 {fmt(correction.stats.totalCombinations)} 个候选档位组合上完整比较，
          没有任何组合能恢复全局一致性；原裁决保持不可行，下方闭合矛盾链原样保留。
        </Banner>
        <SearchStatsView stats={correction.stats} />
      </div>
    );
  }

  if (correction.status === 'limit') {
    return (
      <div className="correction">
        <Banner kind="mid" title="校正复核：枚举超限">
          候选档位组合空间为 {fmt(correction.stats.totalCombinations)}，
          完整精确枚举超出节点预算（{fmt(correction.stats.visitedNodes)}），
          本次不给出方案以避免以部分搜索冒称全局最优；原闭合矛盾链保留于下方。
        </Banner>
        <SearchStatsView stats={correction.stats} />
      </div>
    );
  }

  const plan: CorrectionPlan = correction.plan;
  const cv = plan.correctedVerdict;
  if (cv.status === 'infeasible') return null; // 理论不可达：校正方案必可行

  return (
    <div className="correction">
      <Banner kind="good" title="校正复核：已恢复全局一致性">
        原裁决不可行；对候选档位的全部组合完整比较后，取得字典序最优校正方案：
        总代价 <strong>{fmt(plan.totalCost)}</strong>，改动观测 <strong>{plan.changedCount}</strong> 条
        （优先级：总代价 → 被改观测数 → 改动项 [观测索引, 档位编号] 台账）。
      </Banner>
      <SearchStatsView stats={plan.stats} />

      <div className="pane-head compact">
        <h3>改动明细（{plan.changes.length} 条，按观测索引升序）</h3>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>观测索引</th>
              <th>观测</th>
              <th>改动前区间</th>
              <th>档位编号</th>
              <th>改动后区间</th>
              <th>代价</th>
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((c) => (
              <tr key={c.observationIndex}>
                <td className="mono">{c.observationIndex}</td>
                <td>{c.observationId}</td>
                <td className="mono">[{fmt(c.beforeMinDelay)}, {fmt(c.beforeMaxDelay)}]</td>
                <td className="mono strong">{c.tierId}</td>
                <td className="mono">[{fmt(c.afterMinDelay)}, {fmt(c.afterMaxDelay)}]</td>
                <td className="mono">{fmt(c.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="good-row">
              <td colSpan={5}>总代价（改动台账：{plan.changeKey
                .map((k) => `[${k.observationIndex}, ${k.tierId}]`)
                .join('，') || '无'}）</td>
              <td className="mono strong">{fmt(plan.totalCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <details className="selections">
        <summary className="muted small">
          完整档位选择台账（{plan.selections.length} 条候选观测，含保持原档者）
        </summary>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>观测索引</th><th>观测</th><th>采用档位</th><th>区间</th><th>代价</th></tr>
            </thead>
            <tbody>
              {plan.selections.map((s) => (
                <tr key={s.observationIndex} className={s.candidate ? 'good-row' : ''}>
                  <td className="mono">{s.observationIndex}</td>
                  <td>{s.observationId}</td>
                  <td className="mono">{s.candidate ? s.tierId : '（原档 · 零代价）'}</td>
                  <td className="mono">[{fmt(s.afterMinDelay)}, {fmt(s.afterMaxDelay)}]</td>
                  <td className="mono">{fmt(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="pane-head compact">
        <h3>恢复后的紧确偏移区间（点选端点查看完整见证）</h3>
        <div className="actions">
          <button
            className="btn small"
            onClick={() => onOpen(cv.allMinWitness, cv.ranges, cv.ranges[0].recorderId)}
          >
            全体最小赋值
          </button>
          <button
            className="btn small"
            onClick={() => onOpen(cv.allMaxWitness, cv.ranges, cv.ranges[0].recorderId)}
          >
            全体最大赋值
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>记录器</th>
              <th>最小偏移</th>
              <th>最大偏移</th>
              <th>宽度</th>
            </tr>
          </thead>
          <tbody>
            {cv.ranges.map((r) => (
              <tr key={r.recorderId}>
                <td>
                  {r.recorderId}
                  {r.reference && <span className="tag ref">参考机</span>}
                  {r.min === r.max && <span className="tag point">单点</span>}
                </td>
                <td>
                  <button
                    className="endpoint min-ep"
                    title="点选查看：全体最小值完整可行赋值（校正后）"
                    onClick={() => onOpen(cv.allMinWitness, cv.ranges, r.recorderId)}
                  >
                    {fmt(r.min)} ◂
                  </button>
                </td>
                <td>
                  <button
                    className="endpoint max-ep"
                    title="点选查看：全体最大值完整可行赋值（校正后）"
                    onClick={() => onOpen(cv.allMaxWitness, cv.ranges, r.recorderId)}
                  >
                    {fmt(r.max)} ▸
                  </button>
                </td>
                <td className="mono">{fmt(r.max - r.min)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        端点见证使用校正后的档位区间逐项核对每条观测的实际延迟；校正后裁决状态：
        {cv.status === 'unique' ? '唯一解。' : '多解（区间均为紧确界）。'}
      </p>
    </div>
  );
}

function ChainView({ chain }: { chain: ConstraintChain }) {
  return (
    <div className="chain">
      <h3>闭合约束链（{chain.edges.length} 条边）</h3>
      <p className="muted small">
        下列约束首尾相连，左右分别相加后所有偏移项抵消，即得右侧权值总和——严格小于零便是矛盾。
      </p>
      <ol className="chain-lines edge-only">
        {chain.edges.map((e, i) => (
          <li key={i} className="chain-edge">
            {e.witness}
            <span className="muted">　权值 {fmt(e.weight)}</span>
          </li>
        ))}
      </ol>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th>#</th><th>约束</th><th>权值</th><th>来源</th></tr>
          </thead>
          <tbody>
            {chain.edges.map((e, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="mono">{e.witness}</td>
                <td className="mono">{fmt(e.weight)}</td>
                <td><code>{e.sourcePath}</code></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bad-row">
              <td colSpan={2}>权值总和（严格小于零才矛盾）</td>
              <td className="mono strong">{fmt(chain.totalWeight)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="contradiction">{chain.contradiction}</p>
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { parseModelText, validateModel } from './lib/validation';
import { audit } from './lib/solver';
import { solveCorrection } from './lib/correction';
import type {
  CandidateSelection,
  ConstraintChain,
  CorrectionOutcome,
  EndpointWitness,
  Issue,
  NormalizedModel,
  RecorderRange,
  Verdict,
} from './types';
import { WitnessPanel } from './components/WitnessPanel';
import type { SolveArtifacts } from './lib/solver';

interface Audited {
  issues: Issue[];
  model: NormalizedModel;
  artifacts: SolveArtifacts;
  /** 仅在原裁决不可行时求解候选档位校正；否则为 null */
  correction: CorrectionOutcome | null;
}

type Analysis =
  | { stage: 'empty' }
  | { stage: 'syntax'; issues: Issue[] }
  | { stage: 'invalid'; issues: Issue[] }
  | { stage: 'audited'; audited: Audited };

interface EndpointSelection {
  witness: EndpointWitness;
  ranges: RecorderRange[];
  recorderId: string;
  /** 见证来源标签 */
  sourceLabel: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function App() {
  const [text, setText] = useState<string>('');
  const [loadedName, setLoadedName] = useState<string>('（手动编辑）');
  const [selection, setSelection] = useState<EndpointSelection | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 每次文本变更都重新解析/校验/裁决，不保留任何旧裁决 → 旧裁决/校正方案立即清除
  const analysis: Analysis = useMemo(() => {
    if (text.trim() === '') return { stage: 'empty' };
    const parsed = parseModelText(text);
    if (parsed.issues.length > 0) return { stage: 'syntax', issues: parsed.issues };
    const result = validateModel(parsed.raw);
    if (result.issues.some((i) => i.level === 'error')) {
      return { stage: 'invalid', issues: result.issues };
    }
    const model = result.model!;
    const artifacts = audit(model);
    // 校正仅在原裁决不可行时发起；旧模型（无候选档位）返回 nottriggered，展示与原来一致
    const correction =
      artifacts.verdict.status === 'infeasible' ? solveCorrection(model) : null;
    return { stage: 'audited', audited: { issues: result.issues, model, artifacts, correction } };
  }, [text]);

  const openEndpoint = (
    witness: EndpointWitness,
    ranges: RecorderRange[],
    recorderId: string,
    sourceLabel: string,
  ) => setSelection({ witness, ranges, recorderId, sourceLabel });

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
      ? analysis.issues.filter((i: Issue) => i.level === 'error')
      : [];
  const warnings =
    analysis.stage === 'invalid'
      ? analysis.issues.filter((i: Issue) => i.level === 'warning')
      : analysis.stage === 'audited'
        ? analysis.audited.issues.filter((i: Issue) => i.level === 'warning')
        : [];

  return (
    <div className="app">
      <header className="topbar">
        <h1>脉冲时标一致性复核台</h1>
        <span className="muted">
          纯前端 · 本地时标 + 偏移 = 真实时刻 · 观测延迟闭区间 · 差分约束精确裁决 · 不可行时候选档位全局最优校正
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
            当前来源：{loadedName}　·　编辑任意字符即重新校验并清除旧裁决与旧校正方案
          </p>
          <textarea
            className="editor"
            spellCheck={false}
            value={text}
            placeholder={'{\n  "recorders": [ ... ],\n  "events": [ ... ],\n  "observations": [ ... ]\n}'}
            onChange={(e) => {
              // 输入变更立即清除旧裁决、旧见证与旧校正方案
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
                至多 18 条观测可声明 1–3 个候选延迟档位（id / 非负整数闭区间 / 代价 1–10⁶），原区间恒为零代价档。
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
              model={analysis.audited.model}
              verdict={analysis.audited.artifacts.verdict}
              correction={analysis.audited.correction}
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
          sourceLabel={selection.sourceLabel}
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
  correction,
  onOpen,
}: {
  model: NormalizedModel;
  verdict: Verdict;
  correction: CorrectionOutcome | null;
  onOpen: (w: EndpointWitness, r: RecorderRange[], id: string, sourceLabel: string) => void;
}) {
  return (
    <div className="verdict-body">
      <div className="meta small muted">
        记录器 {model.recorders.length} 台 · 事件 {model.events.length} 个 · 观测 {model.observations.length} 条
        {model.observations.some((o) => o.candidates && o.candidates.length > 0) && (
          <> · 候选档位观测 {model.observations.filter((o) => o.candidates && o.candidates.length > 0).length} 条</>
        )}
      </div>

      {verdict.status === 'unique' && (
        <Banner kind="good" title="裁决：唯一解">
          所有记录器的偏移可行域均为单点，存在唯一一致的真实时间解释。原裁决可行，不发起档位校正。
        </Banner>
      )}
      {verdict.status === 'multiple' && (
        <Banner kind="mid" title="裁决：多解">
          至少一台记录器的偏移可行域宽度大于零，逐对校时拼不出唯一解释；下列区间均为紧确界。原裁决可行，不发起档位校正。
        </Banner>
      )}
      {verdict.status === 'infeasible' && (
        <Banner kind="bad" title="裁决：不可行（原区间）">
          按原延迟区间不存在任何一致的真实时间解释。下方保留一条权值总和严格小于零的闭合约束链；
          {correction?.kind === 'found'
            ? '已在候选档位中找到全局最优校正方案（见下）。'
            : '候选档位校正结果见下。'}
        </Banner>
      )}

      {verdict.status !== 'infeasible' && (
        <RangesTable verdict={verdict} onOpen={onOpen} sourceLabel="原裁决" />
      )}

      {verdict.status === 'infeasible' && (
        <>
          {correction?.kind === 'found' && (
            <CorrectionView correction={correction} onOpen={onOpen} />
          )}
          <ChainView chain={verdict.chain} retained={correction?.kind !== 'found'} />
          {correction?.kind === 'noscheme' && <NoSchemeNote correction={correction} />}
          {correction?.kind === 'nottriggered' && (
            <p className="muted small">
              本模型未声明任何候选延迟档位，按旧规则保持原裁决与展示；如需校正，请在相关观测上补充
              <code> candidates</code>（每条 1–3 档，含 id / 非负整数闭区间 / 代价 1–1000000）。
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** 紧确偏移区间表 + 全体最小/最大端点见证入口（原裁决与恢复后裁决共用） */
function RangesTable({
  verdict,
  onOpen,
  sourceLabel,
}: {
  verdict: Extract<Verdict, { status: 'unique' | 'multiple' }>;
  onOpen: (w: EndpointWitness, r: RecorderRange[], id: string, sourceLabel: string) => void;
  sourceLabel: string;
}) {
  return (
    <>
      <div className="pane-head compact">
        <h3>紧确偏移区间（点选端点查看完整见证）</h3>
        <div className="actions">
          <button
            className="btn small"
            onClick={() => onOpen(verdict.allMinWitness, verdict.ranges, verdict.ranges[0].recorderId, sourceLabel)}
          >
            全体最小赋值
          </button>
          <button
            className="btn small"
            onClick={() => onOpen(verdict.allMaxWitness, verdict.ranges, verdict.ranges[0].recorderId, sourceLabel)}
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
                    onClick={() => onOpen(verdict.allMinWitness, verdict.ranges, r.recorderId, sourceLabel)}
                  >
                    {fmt(r.min)} ◂
                  </button>
                </td>
                <td>
                  <button
                    className="endpoint max-ep"
                    title="点选查看：全体最大赋值完整可行赋值"
                    onClick={() => onOpen(verdict.allMaxWitness, verdict.ranges, r.recorderId, sourceLabel)}
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
  );
}

/** 校正方案：改动明细 + 恢复后的紧确区间与完整端点见证 */
function CorrectionView({
  correction,
  onOpen,
}: {
  correction: Extract<CorrectionOutcome, { kind: 'found' }>;
  onOpen: (w: EndpointWitness, r: RecorderRange[], id: string, sourceLabel: string) => void;
}) {
  const { solution } = correction;
  const restored = solution.restored;
  return (
    <div className="correction">
      <Banner kind="good" title={`校正方案：已恢复全局一致性（总代价 ${fmt(solution.totalCost)}）`}>
        分支限界完整比较后按“总代价 → 被改观测数 → (观测索引, 档位编号) 列表字典序”择优；
        共评估 {fmt(solution.evaluatedCombinations)} 个搜索节点，{fmt(solution.feasibleCombinations)} 个可行组合参与三级择优。
        被剪枝的分支要么含无法打破的负环、要么是某个已可行组合代价严格更大的超集（候选代价恒 ≥1），均不可能最优，故结论为全局最优。
        本方案改动 {solution.changedCount} 条观测。
      </Banner>

      <h3>改动明细（{solution.changes.length} 条）</h3>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>观测索引</th>
              <th>观测 id</th>
              <th>档位编号</th>
              <th>改动前区间</th>
              <th>改动后区间</th>
              <th>代价</th>
            </tr>
          </thead>
          <tbody>
            {solution.changes.map((c: CandidateSelection) => (
              <tr key={c.observationIndex}>
                <td className="mono">{c.observationIndex}</td>
                <td>{c.observationId}</td>
                <td className="mono">{c.candidateId}</td>
                <td className="mono">[{fmt(c.beforeMinDelay)}, {fmt(c.beforeMaxDelay)}]</td>
                <td className="mono strong">[{fmt(c.afterMinDelay)}, {fmt(c.afterMaxDelay)}]</td>
                <td className="mono">{fmt(c.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>总代价 / 被改观测数</td>
              <td className="mono strong">{fmt(solution.totalCost)} / {solution.changedCount}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small mono">
        字典序键：[{solution.key.map((k) => `(${k.observationIndex}, "${k.candidateId}")`).join(', ')}]
      </p>

      <h3>恢复后的紧确偏移范围与完整端点见证</h3>
      <RangesTable verdict={restored} onOpen={onOpen} sourceLabel="校正后" />
    </div>
  );
}

function NoSchemeNote({ correction }: { correction: Extract<CorrectionOutcome, { kind: 'noscheme' }> }) {
  return (
    <Banner kind="bad" title="无方案：所有候选组合均不可行">
      已完整搜索候选档位组合空间（评估 {fmt(correction.evaluatedCombinations)} 个搜索节点，可行 {fmt(correction.feasibleCombinations)} 个；
      被剪枝分支均含无法被任何剩余替换打破的负环），没有任何候选档位替换能恢复全局一致性。
      上方原闭合矛盾链原样保留，未作任何改动。
    </Banner>
  );
}

function ChainView({ chain, retained }: { chain: ConstraintChain; retained: boolean }) {
  return (
    <div className="chain">
      <h3>
        闭合约束链（{chain.edges.length} 条边）{retained ? '' : '（原始矛盾，校正前）'}
      </h3>
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

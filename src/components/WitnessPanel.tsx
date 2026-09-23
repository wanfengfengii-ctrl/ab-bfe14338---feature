import type { EndpointWitness, RecorderRange } from '../types';

interface Props {
  witness: EndpointWitness;
  ranges: RecorderRange[];
  /** 点选端点对应的记录器（用于高亮） */
  focusRecorderId?: string;
  onClose: () => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * 端点详情：列出该完整可行赋值下的全部偏移，以及每条观测的
 * 发送/接收真实时刻与实际延迟，供逐项核对是否落在给定闭区间内。
 */
export function WitnessPanel({ witness, ranges, focusRecorderId, onClose }: Props) {
  const title =
    witness.endpoint === 'min' ? '全体最小端点完整可行赋值' : '全体最大端点完整可行赋值';
  const subtitle =
    witness.endpoint === 'min'
      ? '该赋值同时使每台记录器达到各自紧确最小值，故点选任意记录器的最小端点都由它见证。'
      : '该赋值同时使每台记录器达到各自紧确最大值，故点选任意记录器的最大端点都由它见证。';

  return (
    <div className="witness-overlay" onClick={onClose}>
      <div className="witness-modal" onClick={(e) => e.stopPropagation()}>
        <div className="witness-head">
          <div>
            <h3>{title}</h3>
            <p className="muted">{subtitle}</p>
          </div>
          <button className="btn" onClick={onClose}>关闭 ✕</button>
        </div>

        {focusRecorderId && (
          <p className="focus-line">
            当前点选：记录器 <code>{focusRecorderId}</code> 的{witness.endpoint === 'min' ? '最小' : '最大'}偏移 ={' '}
            <strong>{fmt(witness.offsets[focusRecorderId])}</strong>
          </p>
        )}

        <h4>全部偏移（{ranges.length} 台记录器）</h4>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>记录器</th>
                <th>可行域</th>
                <th>本赋值偏移</th>
                <th>核对</th>
              </tr>
            </thead>
            <tbody>
              {ranges.map((r) => {
                const v = witness.offsets[r.recorderId];
                const hit = r.recorderId === focusRecorderId;
                return (
                  <tr key={r.recorderId} className={hit ? 'focus-row' : ''}>
                    <td>
                      {r.recorderId}
                      {r.reference && <span className="tag ref">参考机</span>}
                    </td>
                    <td className="mono">[{fmt(r.min)}, {fmt(r.max)}]</td>
                    <td className="mono strong">{fmt(v)}</td>
                    <td>{v >= r.min && v <= r.max ? '✓ 在界内' : '✗ 越界'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h4>各观测实际延迟逐项核对（{witness.observationDelays.length} 条）</h4>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>观测</th>
                <th>发送（事件@本地时标）</th>
                <th>接收（事件@本地时标）</th>
                <th>允许延迟</th>
                <th>实际延迟</th>
                <th>核对</th>
              </tr>
            </thead>
            <tbody>
              {witness.observationDelays.map((d) => {
                return (
                  <tr key={d.observationId} className={d.feasible ? '' : 'bad-row'}>
                    <td>{d.observationId}</td>
                    <td className="mono">
                      {d.sender} · {d.sendEvent}
                      <br />
                      <span className="muted">
                        本地 {fmt(d.sendLocal)} + 偏移 {fmt(witness.offsets[d.sender])} = 真实 {fmt(d.sendTrue)}
                      </span>
                    </td>
                    <td className="mono">
                      {d.receiver} · {d.receiveEvent}
                      <br />
                      <span className="muted">
                        本地 {fmt(d.receiveLocal)} + 偏移 {fmt(witness.offsets[d.receiver])} = 真实 {fmt(d.receiveTrue)}
                      </span>
                    </td>
                    <td className="mono">[{fmt(d.minDelay)}, {fmt(d.maxDelay)}]</td>
                    <td className="mono strong">{fmt(d.actualDelay)}</td>
                    <td>{d.feasible ? '✓ 在区间内' : '✗ 越界'}</td>
                  </tr>
                );
              })}
              {witness.observationDelays.length === 0 && (
                <tr><td colSpan={6} className="muted">模型无观测</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

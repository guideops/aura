import { useState } from "react";
import { api } from "../lib/api";
import { agentColor, useShell } from "../lib/store";

/**
 * Security-gate approval overlay (reference S2): the oldest pending request is
 * shown front and center; the agent stays blocked until the operator acts.
 */
export function ActionRequestModal() {
  const approvals = useShell((s) => s.approvals);
  const [busy, setBusy] = useState(false);
  const req = approvals[0];
  if (!req) return null;

  const resolve = async (approved: boolean) => {
    setBusy(true);
    await api.resolveApproval(req.id, approved).catch(() => {});
    setBusy(false);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal action-request">
        <div className="ar-head">
          <span className="ar-badge">⛨ Action Request</span>
          <span className="ar-gate">● Security Gate</span>
        </div>
        <p className="ar-lede">
          <b style={{ color: agentColor(req.agentId) }}>{req.agentId}</b> is requesting permission to
          perform the following action:
        </p>
        <div className="ar-action">
          <div className="ar-tool">{req.tool}</div>
          <pre className="ar-preview">{req.inputPreview}</pre>
        </div>
        <dl className="props">
          <dt>Requested by</dt><dd>{req.agentId}</dd>
          <dt>Session</dt><dd className="mono-dim">{req.sessionId}</dd>
          <dt>Reason</dt><dd>{req.reason || "—"}</dd>
          <dt>Impact</dt>
          <dd><span className={`impact impact-${req.impact}`}>{req.impact}</span></dd>
          <dt>Requested</dt><dd>{new Date(req.ts).toLocaleTimeString()}</dd>
        </dl>
        <div className="ar-steps">
          <span className="ar-step done">1 Review</span>
          <span className="ar-step active">2 Approve</span>
          <span className="ar-step">3 Execute</span>
        </div>
        <div className="modal-actions">
          <button disabled={busy} onClick={() => void resolve(false)}>Deny</button>
          <button className="btn-primary" disabled={busy} onClick={() => void resolve(true)}>
            Approve &amp; Execute
          </button>
        </div>
        {approvals.length > 1 && (
          <div className="muted small-line">+{approvals.length - 1} more pending</div>
        )}
      </div>
    </div>
  );
}

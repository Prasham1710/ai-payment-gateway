'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, Sliders, XCircle, Zap } from 'lucide-react';
import PreviewBadge from '@/components/ui/PreviewBadge';

interface FraudDecision {
  riskScore: number; // 0.0 to 1.0
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK';
  reasons: string[];
  rulesTriggered: { name: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; scoreDelta: number }[];
}

interface RiskInputs {
  amount: string;
  ipAddress: string;
  velocityCount: number;
  isNewDevice: boolean;
  allowThreshold: number;
  blockThreshold: number;
}

/** Illustrative rules, evaluated in the browser. No fraud service exists yet. */
function evaluateRisk({ amount, ipAddress, velocityCount, isNewDevice, allowThreshold, blockThreshold }: RiskInputs): FraudDecision {
  let score = 0.05;
  const rules: FraudDecision['rulesTriggered'] = [];
  const reasons: string[] = [];
  const parsedAmount = parseFloat(amount) || 0;

  // Rule 1: Velocity
  if (velocityCount >= 5) {
    score += 0.35;
    rules.push({ name: 'High Velocity (≥5 charges / 60s)', severity: 'HIGH', scoreDelta: 0.35 });
    reasons.push(`Rapid transaction frequency: ${velocityCount} charges in the last minute.`);
  } else if (velocityCount >= 3) {
    score += 0.15;
    rules.push({ name: 'Moderate Velocity (3-4 charges / 60s)', severity: 'MEDIUM', scoreDelta: 0.15 });
  }

  // Rule 2: High Amount Ticket
  if (parsedAmount > 15000) {
    score += 0.25;
    rules.push({ name: 'High-Ticket Outlier (>₹15,000)', severity: 'MEDIUM', scoreDelta: 0.25 });
    reasons.push(`Amount ₹${parsedAmount.toFixed(2)} is above the ₹15,000 high-ticket threshold.`);
  }

  // Rule 3: Tor / Datacenter IP detection (example ranges)
  if (ipAddress.startsWith('185.220') || ipAddress.startsWith('198.51')) {
    score += 0.3;
    rules.push({ name: 'Suspicious IP Range (Datacenter / Tor Node)', severity: 'HIGH', scoreDelta: 0.3 });
    reasons.push(`IP ${ipAddress} is in an example proxy/anonymizer range.`);
  }

  // Rule 4: Device Fingerprint
  if (isNewDevice) {
    score += 0.1;
    rules.push({ name: 'Unrecognized Device Fingerprint', severity: 'LOW', scoreDelta: 0.1 });
  }

  score = Math.min(0.99, Math.max(0.02, score));
  const decision: FraudDecision['decision'] = score >= blockThreshold ? 'BLOCK' : score >= allowThreshold ? 'REVIEW' : 'ALLOW';
  if (rules.length === 0) {
    reasons.push('Standard transaction profile. No velocity or behavioural anomalies.');
  }
  return { riskScore: score, decision, reasons, rulesTriggered: rules };
}

export default function Port8002FraudDetector() {
  // Inputs
  const [vpa, setVpa] = useState('user.suspicious@upi');
  const [amount, setAmount] = useState('18500.00');
  const [ipAddress, setIpAddress] = useState('185.220.101.5');
  const [velocityCount, setVelocityCount] = useState(6);
  const [isNewDevice, setIsNewDevice] = useState(true);

  // Policy Thresholds
  const [allowThreshold, setAllowThreshold] = useState(0.30);
  const [blockThreshold, setBlockThreshold] = useState(0.70);

  // The initial inputs are scored right away; later changes are scored on demand.
  const [result, setResult] = useState<FraudDecision>(() =>
    evaluateRisk({ amount, ipAddress, velocityCount, isNewDevice, allowThreshold, blockThreshold }),
  );

  const handleEvaluate = () => {
    setResult(evaluateRisk({ amount, ipAddress, velocityCount, isNewDevice, allowThreshold, blockThreshold }));
  };

  return (
    <div className="space-y-6">
      <PreviewBadge note="Planned service, not built yet: nothing in the payment flow calls a fraud check today. Scores below come from example rules running in this page." />

      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-rose-500 to-red-600 flex items-center justify-center text-white shadow-lg shadow-rose-500/20 font-mono font-bold text-xl">
            8002
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Fraud Detector</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-rose-700/60 bg-rose-950/80 text-rose-300 font-semibold">
                Planned
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Design preview of a rule-based risk scorer (velocity, amount, IP and device signals). Port 8002 is reserved for it; no
              service listens there yet.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-bold bg-slate-800 border-slate-700 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            NOT RUNNING · PLANNED
          </div>
        </div>
      </div>

      {/* TWO COLUMN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN: RISK INPUTS */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Eye className="w-4 h-4 text-rose-400" /> Transaction Risk Analyzer
            </h3>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">
              rules run in this page
            </span>
          </div>

          <div className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-300 mb-1">Customer VPA / Account</label>
              <input
                type="text"
                value={vpa}
                onChange={(e) => setVpa(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-rose-500 outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Amount (INR ₹)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono font-bold focus:ring-2 focus:ring-rose-500 outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-300 mb-1">Client IP Address</label>
                <input
                  type="text"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-rose-500 outline-none"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-slate-300 font-semibold mb-1">
                <span>Velocity (charges in the last 60s)</span>
                <span className="text-rose-400 font-mono font-bold">{velocityCount} charges / min</span>
              </div>
              <input
                type="range"
                min="1"
                max="12"
                value={velocityCount}
                onChange={(e) => setVelocityCount(parseInt(e.target.value))}
                className="w-full accent-rose-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="newDevice"
                checked={isNewDevice}
                onChange={(e) => setIsNewDevice(e.target.checked)}
                className="w-4 h-4 accent-rose-500 rounded cursor-pointer"
              />
              <label htmlFor="newDevice" className="text-slate-300 font-medium cursor-pointer">
                Flag as Unrecognized Device Fingerprint
              </label>
            </div>

            <button
              type="button"
              onClick={handleEvaluate}
              className="w-full py-3 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-rose-600/30 transition text-sm"
            >
              <Zap className="w-4 h-4" /> Evaluate Transaction Risk (simulated)
            </button>
          </div>

          {/* POLICY THRESHOLDS SLIDERS */}
          <div className="pt-3 border-t border-slate-800 space-y-3">
            <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" /> Decision Policy Thresholds
            </h4>
            
            <div className="space-y-2 text-[11px] font-mono">
              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Allow Threshold (&lt;):</span>
                  <span className="text-emerald-400 font-bold">{allowThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="0.5"
                  step="0.05"
                  value={allowThreshold}
                  onChange={(e) => setAllowThreshold(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500 h-1 bg-slate-800 rounded cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Block Threshold (≥):</span>
                  <span className="text-rose-400 font-bold">{blockThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="0.9"
                  step="0.05"
                  value={blockThreshold}
                  onChange={(e) => setBlockThreshold(parseFloat(e.target.value))}
                  className="w-full accent-rose-500 h-1 bg-slate-800 rounded cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: DECISION & ANOMALY RULES BREAKDOWN */}
        <div className="lg:col-span-7 space-y-6">
          {result && (
            <div className={`border-2 rounded-2xl p-6 shadow-2xl space-y-5 transition-all ${
              result.decision === 'ALLOW'
                ? 'bg-emerald-950/20 border-emerald-700/80'
                : result.decision === 'REVIEW'
                ? 'bg-amber-950/20 border-amber-700/80'
                : 'bg-rose-950/30 border-rose-700/80'
            }`}>
              {/* Header Badge */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {result.decision === 'ALLOW' && <CheckCircle2 className="w-8 h-8 text-emerald-400" />}
                  {result.decision === 'REVIEW' && <AlertTriangle className="w-8 h-8 text-amber-400" />}
                  {result.decision === 'BLOCK' && <XCircle className="w-8 h-8 text-rose-500" />}
                  <div>
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest block">POLICY DECISION</span>
                    <h3 className={`text-2xl font-black font-mono ${
                      result.decision === 'ALLOW'
                        ? 'text-emerald-400'
                        : result.decision === 'REVIEW'
                        ? 'text-amber-400'
                        : 'text-rose-400'
                    }`}>
                      {result.decision === 'ALLOW' && 'ALLOW TRANSACTION'}
                      {result.decision === 'REVIEW' && 'FLAG FOR MANUAL REVIEW / 2FA'}
                      {result.decision === 'BLOCK' && 'BLOCK PAYMENT (DECLINED)'}
                    </h3>
                  </div>
                </div>

                <div className="text-right font-mono">
                  <span className="text-[10px] text-slate-500 block">EVALUATED</span>
                  <span className="text-xs text-white font-bold">in browser</span>
                </div>
              </div>

              {/* Risk Meter Gauge */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-slate-400">Risk Anomaly Score:</span>
                  <span className={`font-black text-base ${
                    result.riskScore < allowThreshold 
                      ? 'text-emerald-400' 
                      : result.riskScore < blockThreshold 
                      ? 'text-amber-400' 
                      : 'text-rose-400'
                  }`}>
                    {(result.riskScore * 100).toFixed(1)} / 100
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 flex">
                  <div 
                    className={`h-full transition-all duration-500 ${
                      result.riskScore < allowThreshold 
                        ? 'bg-emerald-500' 
                        : result.riskScore < blockThreshold 
                        ? 'bg-amber-500' 
                        : 'bg-rose-500'
                    }`}
                    style={{ width: `${result.riskScore * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                  <span>0.0 (Safe)</span>
                  <span>{allowThreshold.toFixed(2)} (Review)</span>
                  <span>{blockThreshold.toFixed(2)} (Block)</span>
                  <span>1.0 (Critical)</span>
                </div>
              </div>

              {/* Triggered Rules List */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Behavioral Anomalies & Rule Triggers ({result.rulesTriggered.length})
                </h4>
                {result.rulesTriggered.length > 0 ? (
                  <div className="space-y-2">
                    {result.rulesTriggered.map((rule, i) => (
                      <div
                        key={i}
                        className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-xl flex items-center justify-between text-xs"
                      >
                        <span className="text-slate-300 font-medium">{rule.name}</span>
                        <div className="flex items-center gap-2 font-mono">
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                            rule.severity === 'HIGH' ? 'bg-rose-950 text-rose-300 border border-rose-800' : 'bg-amber-950 text-amber-300 border border-amber-800'
                          }`}>
                            {rule.severity}
                          </span>
                          <span className="text-rose-400 font-bold">+{rule.scoreDelta.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-xl text-xs text-emerald-400 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> All behavioral & velocity rule checks passed cleanly.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}


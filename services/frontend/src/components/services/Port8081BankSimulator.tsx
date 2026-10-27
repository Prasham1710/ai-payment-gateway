'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, Clock, Flame, Radio, RefreshCw, Search, Send, X, Zap } from 'lucide-react';
import { GatewayError, PROVIDERS, PROVIDER_NAMES, type ProviderStatus, bankSimulator, config } from '@/lib/gateway';

const REFRESH_MS = 3000;
/** Slider changes are sent once the user stops moving the thumb for this long. */
const SLIDER_COMMIT_MS = 400;

interface ErrorInfo {
  message: string;
  network: boolean;
}

interface ChargeOutcome {
  httpStatus: number | null;
  roundtripMs: number;
  body: Record<string, unknown> | null;
  error?: ErrorInfo;
}

type Draft = { latency?: number; rate?: number };

function describeError(e: unknown): ErrorInfo {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

const selectClass =
  'w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-cyan-500 outline-none';

export default function Port8081BankSimulator() {
  const [providers, setProviders] = useState<Record<string, ProviderStatus> | null>(null);
  const [statusError, setStatusError] = useState<ErrorInfo | null>(null);
  const [chaosMessage, setChaosMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Direct charge tester state
  const [selectedProvider, setSelectedProvider] = useState<string>(PROVIDERS[0]);
  const [testAmount, setTestAmount] = useState('500.00');
  const [paymentMethod, setPaymentMethod] = useState('UPI');
  const [customerVpa, setCustomerVpa] = useState('alice@upi');
  const [chargeLoading, setChargeLoading] = useState(false);
  const [chargeResult, setChargeResult] = useState<ChargeOutcome | null>(null);

  // Status enquiry state
  const [enquiryTxId, setEnquiryTxId] = useState('');
  const [enquiryLoading, setEnquiryLoading] = useState(false);
  const [enquiryResult, setEnquiryResult] = useState<{ body?: Record<string, unknown>; error?: ErrorInfo } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setProviders(await bankSimulator.status());
      setStatusError(null);
    } catch (e) {
      setStatusError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus();
    }, REFRESH_MS);
    const pending = timers.current;
    return () => {
      clearInterval(interval);
      Object.values(pending).forEach(clearTimeout);
    };
  }, [fetchStatus]);

  const runChaos = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      setChaosMessage({ tone: 'ok', text: success });
    } catch (e) {
      const info = describeError(e);
      setChaosMessage({
        tone: 'error',
        text: info.network ? `${info.message} Start the bank simulator (${config.bankSimulatorUrl}).` : info.message,
      });
    } finally {
      await fetchStatus();
    }
  };

  const handleKill = (providerId: string) =>
    runChaos(() => bankSimulator.kill(providerId), `Killed ${providerId}: its charges now fail with HTTP 503 until restored.`);

  const handleRestore = (providerId?: string) =>
    runChaos(
      () => bankSimulator.restore(providerId),
      providerId ? `Restored ${providerId}.` : 'All rails restored (kill switches off; latency and success rates unchanged).',
    );

  const setDraft = (providerId: string, patch: Draft) =>
    setDrafts((prev) => ({ ...prev, [providerId]: { ...prev[providerId], ...patch } }));

  const clearDraft = (providerId: string, field: keyof Draft) =>
    setDrafts((prev) => {
      const next = { ...prev[providerId] };
      delete next[field];
      return { ...prev, [providerId]: next };
    });

  /** Shows the slider value at once and sends it when the user stops dragging. */
  const scheduleCommit = (providerId: string, field: keyof Draft, value: number) => {
    setDraft(providerId, { [field]: value });
    const key = `${providerId}:${field}`;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      delete timers.current[key];
      const done =
        field === 'latency'
          ? runChaos(() => bankSimulator.setLatency(providerId, value), `Latency for ${providerId} set to ${value} ms.`)
          : runChaos(
              () => bankSimulator.setSuccessRate(providerId, value),
              `Success rate for ${providerId} set to ${(value * 100).toFixed(0)}%.`,
            );
      void done.then(() => clearDraft(providerId, field));
    }, SLIDER_COMMIT_MS);
  };

  const handleDirectCharge = async (e: React.FormEvent) => {
    e.preventDefault();
    const rupees = Number(testAmount);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setChargeResult({ httpStatus: null, roundtripMs: 0, body: null, error: { message: 'Enter a positive amount.', network: false } });
      return;
    }
    const txId = `tx_dash_${Date.now()}`;
    setChargeLoading(true);
    setChargeResult(null);
    const started = performance.now();
    try {
      const body = await bankSimulator.charge({
        transaction_id: txId,
        provider_id: selectedProvider,
        amount: rupees,
        payment_method: paymentMethod,
        ...(paymentMethod === 'UPI' && customerVpa.trim() ? { customer_vpa: customerVpa.trim() } : {}),
      });
      setChargeResult({ httpStatus: 200, roundtripMs: Math.round(performance.now() - started), body });
    } catch (err) {
      const roundtripMs = Math.round(performance.now() - started);
      if (err instanceof GatewayError && !err.isNetworkError) {
        // Declines (400) and killed rails (503) come back as non-2xx; the simulator records them in its ledger,
        // so read the full response back through the status enquiry.
        let body: Record<string, unknown> | null = null;
        try {
          body = await bankSimulator.enquire(txId);
        } catch {
          // not recorded (e.g. unknown provider or invalid request): show the error itself
        }
        setChargeResult({ httpStatus: err.status, roundtripMs, body, error: body ? undefined : describeError(err) });
      } else {
        setChargeResult({ httpStatus: null, roundtripMs, body: null, error: describeError(err) });
      }
    } finally {
      setEnquiryTxId(txId);
      setChargeLoading(false);
    }
  };

  const handleEnquiry = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = enquiryTxId.trim();
    if (!id) return;
    setEnquiryLoading(true);
    try {
      setEnquiryResult({ body: await bankSimulator.enquire(id) });
    } catch (err) {
      setEnquiryResult({ error: describeError(err) });
    } finally {
      setEnquiryLoading(false);
    }
  };

  const isOnline = statusError ? false : providers ? true : null;
  const chargeStatus = typeof chargeResult?.body?.status === 'string' ? chargeResult.body.status : null;

  return (
    <div className="space-y-6">
      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20 font-mono font-bold text-xl">
            8081
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Bank & Provider Simulator</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-cyan-700/60 bg-cyan-950/80 text-cyan-300 font-semibold">
                Go
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Simulated bank rails ({PROVIDERS.map((id) => PROVIDER_NAMES[id]).join(', ')}) that the orchestrator charges, refunds and
              reconciles against, with chaos controls for failover testing.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRestore()}
            disabled={!isOnline}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-950/80 hover:bg-emerald-900 disabled:opacity-50 border border-emerald-800 text-emerald-300 rounded-lg transition font-bold"
          >
            <Check className="w-3.5 h-3.5" /> Restore All Rails
          </button>
          <div
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-bold ${
              isOnline === true
                ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                : isOnline === false
                  ? 'bg-rose-950/80 border-rose-800 text-rose-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : isOnline === false ? 'bg-rose-500' : 'bg-slate-500'}`} />
            {isOnline === true ? 'PORT 8081 ONLINE' : isOnline === false ? 'PORT 8081 OFFLINE' : 'CHECKING...'}
          </div>
        </div>
      </div>

      {statusError && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-xl px-4 py-3 space-y-0.5">
          <p>{statusError.message}</p>
          {statusError.network && (
            <p className="text-rose-200/70">Start the bank simulator ({config.bankSimulatorUrl}); this view retries every few seconds.</p>
          )}
        </div>
      )}

      {chaosMessage && (
        <div
          className={`bg-slate-900/90 border p-3.5 rounded-xl text-xs font-mono flex items-center justify-between gap-3 ${
            chaosMessage.tone === 'ok' ? 'border-indigo-800/60 text-indigo-200' : 'border-rose-800/60 text-rose-300'
          }`}
        >
          <span>{chaosMessage.text}</span>
          <button type="button" onClick={() => setChaosMessage(null)} className="text-slate-400 hover:text-white" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* PROVIDER CARDS MATRIX */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PROVIDERS.map((id) => {
          const p = providers?.[id];
          const draft = drafts[id] ?? {};
          const latency = draft.latency ?? p?.latency_ms ?? 0;
          const rate = draft.rate ?? p?.success_rate ?? 0;

          return (
            <div
              key={id}
              className={`bg-slate-900 border rounded-2xl p-5 shadow-xl transition-all space-y-4 ${
                p?.is_killed ? 'border-rose-700/80 bg-rose-950/20' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-extrabold text-sm text-white">{p?.name ?? PROVIDER_NAMES[id] ?? id}</h4>
                  <span className="text-[11px] font-mono text-slate-400">{id}</span>
                </div>
                {p && (
                  <span
                    className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${
                      p.is_killed ? 'bg-rose-950 text-rose-300 border-rose-800' : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${p.is_killed ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                    {p.is_killed ? 'KILLED (503)' : 'OPERATIONAL'}
                  </span>
                )}
              </div>

              {/* Stats Bar */}
              <div className="grid grid-cols-3 gap-2 bg-slate-950 p-2.5 rounded-xl border border-slate-800/80 text-center font-mono text-[11px]">
                <div>
                  <span className="text-slate-500 block text-[9px]">SUCCESS</span>
                  <span className="text-emerald-400 font-bold">{p ? `${(p.success_rate * 100).toFixed(0)}%` : '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[9px]">LATENCY</span>
                  <span className="text-amber-400 font-bold">{p ? `${p.latency_ms}ms` : '—'}</span>
                </div>
                <div title="The simulator's nominal per-transaction cost; the router ranks rails by success, not cost">
                  <span className="text-slate-500 block text-[9px]">RAIL COST</span>
                  <span className="text-indigo-400 font-bold">{p ? `₹${p.cost_inr.toFixed(2)}` : '—'}</span>
                </div>
              </div>

              {/* Chaos Sliders & Buttons */}
              <fieldset disabled={!p} className="space-y-3 pt-1 text-xs disabled:opacity-50">
                <div>
                  <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                    <label htmlFor={`latency-${id}`}>Latency Injection:</label>
                    <span className="font-mono text-white font-bold">{latency}ms</span>
                  </div>
                  <input
                    id={`latency-${id}`}
                    type="range"
                    min="0"
                    max="3000"
                    step="50"
                    value={latency}
                    onChange={(e) => scheduleCommit(id, 'latency', parseInt(e.target.value, 10))}
                    className="w-full accent-cyan-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                    <label htmlFor={`rate-${id}`}>Success Rate:</label>
                    <span className="font-mono text-white font-bold">{(rate * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    id={`rate-${id}`}
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={rate}
                    onChange={(e) => scheduleCommit(id, 'rate', parseFloat(e.target.value))}
                    className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  {p?.is_killed ? (
                    <button
                      type="button"
                      onClick={() => void handleRestore(id)}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" /> Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleKill(id)}
                      className="w-full py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 shadow-lg shadow-rose-600/20"
                    >
                      <Flame className="w-3.5 h-3.5" /> Kill Rail
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void runChaos(() => bankSimulator.setLatency(id, 2000), `Latency for ${id} set to 2000 ms.`)}
                    className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 border border-slate-700"
                  >
                    <Clock className="w-3.5 h-3.5" /> Spike 2s
                  </button>
                </div>
              </fieldset>
            </div>
          );
        })}
      </div>

      {/* DIRECT CHARGE TESTER */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan-400" /> Direct Bank Charge (Bypasses Orchestrator)
            </h3>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800 whitespace-nowrap">
              POST /api/v1/bank/charge
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Charges one rail directly, to see how it answers under the current chaos settings. Nothing is recorded in the gateway: no
            payment, no webhook, no routing feedback.
          </p>

          <form onSubmit={handleDirectCharge} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="charge-provider" className="block font-semibold text-slate-300 mb-1">
                  Target Bank Rail
                </label>
                <select
                  id="charge-provider"
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  className={selectClass}
                >
                  {PROVIDERS.map((id) => (
                    <option key={id} value={id}>
                      {id} ({PROVIDER_NAMES[id]})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="charge-amount" className="block font-semibold text-slate-300 mb-1">
                  Amount (INR ₹)
                </label>
                <input
                  id="charge-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={testAmount}
                  onChange={(e) => setTestAmount(e.target.value)}
                  className={`${selectClass} font-bold`}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="charge-method" className="block font-semibold text-slate-300 mb-1">
                  Payment Method
                </label>
                <select id="charge-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>
                  <option value="UPI">UPI</option>
                  <option value="CARD">CARD</option>
                  <option value="NETBANKING">NETBANKING</option>
                </select>
              </div>
              <div>
                <label htmlFor="charge-vpa" className="block font-semibold text-slate-300 mb-1">
                  Customer VPA (UPI)
                </label>
                <input
                  id="charge-vpa"
                  type="text"
                  disabled={paymentMethod !== 'UPI'}
                  value={customerVpa}
                  onChange={(e) => setCustomerVpa(e.target.value)}
                  className={`${selectClass} disabled:opacity-40`}
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Test VPAs <span className="font-mono text-slate-400">success@gateway</span> and{' '}
              <span className="font-mono text-slate-400">failure@gateway</span> always succeed or decline; any other VPA succeeds with the
              rail&apos;s success rate. A killed rail fails either way.
            </p>

            <button
              type="submit"
              disabled={chargeLoading}
              className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/30 transition text-sm"
            >
              {chargeLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Calling Bank Rail...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" /> Send Direct Charge to Port 8081
                </>
              )}
            </button>
          </form>
        </div>

        {/* CHARGE RESPONSE & STATUS ENQUIRY */}
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" /> Simulator Response
            </h3>
            {chargeResult && (
              <span
                className={`text-[11px] font-mono px-2 py-0.5 rounded font-bold border ${
                  chargeResult.httpStatus === 200
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                    : 'bg-rose-950 text-rose-400 border-rose-800'
                }`}
              >
                {chargeResult.httpStatus === null ? 'NO RESPONSE' : `HTTP ${chargeResult.httpStatus}`}
                {chargeStatus ? ` · ${chargeStatus}` : ''} ({chargeResult.roundtripMs}ms)
              </span>
            )}
          </div>

          {chargeResult ? (
            <div className="space-y-2">
              {chargeResult.error && (
                <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2 space-y-0.5">
                  <p>{chargeResult.error.message}</p>
                  {chargeResult.error.network && (
                    <p className="text-rose-200/70">Start the bank simulator ({config.bankSimulatorUrl}) and try again.</p>
                  )}
                </div>
              )}
              {chargeResult.body && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-[11px] text-cyan-300 max-h-60 overflow-y-auto">
                  <pre>{JSON.stringify(chargeResult.body, null, 2)}</pre>
                </div>
              )}
              {chargeResult.body && chargeResult.httpStatus !== 200 && (
                <p className="text-[11px] text-slate-500">Body read back from the simulator ledger (status enquiry).</p>
              )}
            </div>
          ) : (
            <div className="h-44 border-2 border-dashed border-slate-800 rounded-xl flex flex-col items-center justify-center text-center p-4 text-slate-500 text-xs">
              <Radio className="w-8 h-8 text-slate-700 mb-1" />
              <p>Send a charge to see the rail&apos;s response</p>
            </div>
          )}

          {/* STATUS ENQUIRY FORM */}
          <div className="pt-2 border-t border-slate-800 space-y-2">
            <label htmlFor="enquiry-tx" className="block text-xs font-semibold text-slate-400">
              Transaction status enquiry (<span className="font-mono">GET /api/v1/bank/status?transaction_id=</span>)
            </label>
            <form onSubmit={handleEnquiry} className="flex gap-2">
              <input
                id="enquiry-tx"
                type="text"
                value={enquiryTxId}
                onChange={(e) => setEnquiryTxId(e.target.value)}
                placeholder="Transaction ID (e.g. tx_dash_...)"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <button
                type="submit"
                disabled={enquiryLoading || !enquiryTxId.trim()}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl border border-slate-700 transition flex items-center gap-1.5"
              >
                <Search className={`w-3.5 h-3.5 ${enquiryLoading ? 'animate-pulse' : ''}`} /> Query
              </button>
            </form>
            <p className="text-[11px] text-slate-500">
              The orchestrator uses this enquiry to reconcile payments whose bank outcome was unknown. The ledger lives in memory and is
              cleared when the simulator restarts.
            </p>
            {enquiryResult?.error && (
              <p className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">
                {enquiryResult.error.message}
                {enquiryResult.error.network ? ` Start the bank simulator (${config.bankSimulatorUrl}).` : ''}
              </p>
            )}
            {enquiryResult?.body && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-[10px] text-emerald-300 max-h-32 overflow-y-auto">
                <pre>{JSON.stringify(enquiryResult.body, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

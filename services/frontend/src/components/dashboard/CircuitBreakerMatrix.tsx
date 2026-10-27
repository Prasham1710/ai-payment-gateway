'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  TriangleAlert,
  Zap,
  RefreshCw,
  Activity,
  CircleCheck,
  CircleX,
  Database,
  Cpu,
  Flame,
  Power,
  Send,
  Ban,
} from 'lucide-react';
import {
  GatewayError,
  PROVIDER_NAMES,
  bankSimulator,
  formatInr,
  newIdempotencyKey,
  orchestrator,
  type CircuitBreakerStatus,
  type Instrument,
  type PaymentAttempt,
  type ProviderStatus,
} from '@/lib/gateway';

const POLL_INTERVAL_MS = 2000;
/** resilience4j slidingWindowSize from the orchestrator's application.yml; GET /ops/circuit-breakers does not report it. */
const SLIDING_WINDOW_SIZE = 10;
const STRESS_DEFAULT = 20;
const STRESS_MIN = 2;
const STRESS_MAX = 50;
const STRESS_PRESETS = [10, 20, 50];
/** Test payments are ₹1.00 against the sandbox merchant. */
const TEST_AMOUNT_PAISE = 100;
const TEST_INSTRUMENT: Instrument = { method: 'upi', vpa: 'success@gateway' };
const TRAFFIC_BATCH = 10;
/** Payments inspected after a stress run; normally exactly one. */
const MAX_INSPECTED_PAYMENTS = 5;

interface LoadError {
  message: string;
  network: boolean;
}

function toLoadError(e: unknown): LoadError {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

const railName = (id: string): string => PROVIDER_NAMES[id] ?? id;

function unique(values: (string | null)[]): string[] {
  const out: string[] = [];
  values.forEach((v) => {
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

interface StressOutcome {
  index: number;
  kind: 'success' | 'conflict' | 'error';
  paymentId: string | null;
  httpStatus: number; // 0 = no answer
  message: string;
  ms: number;
}

interface InspectedPayment {
  paymentId: string;
  attempts: PaymentAttempt[] | null;
  error: string | null;
}

interface StressResult {
  requests: number;
  orderId: string;
  idempotencyKey: string;
  outcomes: StressOutcome[];
  succeeded: number;
  successPaymentIds: string[];
  conflicts: number;
  otherErrors: number;
  errorSummary: { message: string; count: number }[];
  wallMs: number;
  inspected: InspectedPayment[];
  sentToBank: number;
  approvedCharges: number;
  skippedByBreaker: number;
  doubleCharges: number;
  replay: { paymentId: string | null; message: string } | null;
}

interface TrafficRun {
  total: number;
  sent: number;
  authorized: number;
  failed: number;
  running: boolean;
  lastError: string | null;
}

export default function CircuitBreakerMatrix() {
  const [breakers, setBreakers] = useState<CircuitBreakerStatus[] | null>(null);
  const [breakerError, setBreakerError] = useState<LoadError | null>(null);
  const [rails, setRails] = useState<Record<string, ProviderStatus> | null>(null);
  const [railError, setRailError] = useState<LoadError | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [manualRefresh, setManualRefresh] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<TrafficRun | null>(null);

  // Stress test state
  const [concurrency, setConcurrency] = useState<number>(STRESS_DEFAULT);
  const [isStressTesting, setIsStressTesting] = useState<boolean>(false);
  const [stressPhase, setStressPhase] = useState<string>('');
  const [stressResult, setStressResult] = useState<StressResult | null>(null);
  const [stressError, setStressError] = useState<LoadError | null>(null);

  const mounted = useRef(true);
  const inFlight = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const [cb, sim] = await Promise.allSettled([orchestrator.circuitBreakers(), bankSimulator.status()]);
    inFlight.current = false;
    if (!mounted.current) return;
    if (cb.status === 'fulfilled') {
      setBreakers(cb.value.items);
      setBreakerError(null);
      setLastUpdated(new Date());
    } else {
      setBreakerError(toLoadError(cb.reason));
    }
    if (sim.status === 'fulfilled') {
      setRails(sim.value);
      setRailError(null);
    } else {
      setRailError(toLoadError(sim.reason));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [refresh]);

  const flash = (text: string, tone: 'ok' | 'error') => {
    if (!mounted.current) return;
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };

  const handleManualRefresh = async () => {
    setManualRefresh(true);
    await refresh();
    if (mounted.current) setManualRefresh(false);
  };

  const runAction = async (key: string, action: () => Promise<string>) => {
    setBusyAction(key);
    try {
      flash(await action(), 'ok');
    } catch (e) {
      flash(toLoadError(e).message, 'error');
    } finally {
      if (mounted.current) setBusyAction(null);
      void refresh();
    }
  };

  const handleReset = (providerId: string) =>
    runAction(`reset:${providerId}`, async () => {
      const status = await orchestrator.resetCircuitBreaker(providerId);
      setBreakers((prev) => (prev ? prev.map((b) => (b.provider_id === providerId ? status : b)) : prev));
      return `${railName(providerId)} breaker reset to ${status.state}; its call statistics were cleared.`;
    });

  const handleKill = (providerId: string) =>
    runAction(`kill:${providerId}`, async () => {
      await bankSimulator.kill(providerId);
      return `${railName(providerId)} is down at the bank simulator. Send test payments to watch its breaker react.`;
    });

  const handleRestore = (providerId?: string) =>
    runAction(`restore:${providerId ?? 'all'}`, async () => {
      await bankSimulator.restore(providerId);
      return providerId
        ? `${railName(providerId)} restored at the bank simulator. An open breaker lets a trial call through after its wait, or reset it now.`
        : 'All rails restored at the bank simulator. Open breakers let trial calls through after their wait, or reset them now.';
    });

  /** Sends small payments one after another so breaker state can change between them. */
  const sendTestTraffic = async () => {
    const run: TrafficRun = { total: TRAFFIC_BATCH, sent: 0, authorized: 0, failed: 0, running: true, lastError: null };
    setTraffic({ ...run });
    for (let i = 0; i < TRAFFIC_BATCH; i++) {
      if (!mounted.current) return;
      try {
        await orchestrator.createAndPay(TEST_AMOUNT_PAISE, TEST_INSTRUMENT);
        run.authorized++;
      } catch (e) {
        const err = toLoadError(e);
        run.lastError = err.message;
        if (err.network) {
          run.running = false;
          if (mounted.current) setTraffic({ ...run });
          return;
        }
        run.failed++;
      }
      run.sent++;
      if (mounted.current) setTraffic({ ...run });
      void refresh();
    }
    run.running = false;
    if (mounted.current) setTraffic({ ...run });
  };

  const runStressTest = async () => {
    const n = Math.min(STRESS_MAX, Math.max(STRESS_MIN, Math.round(concurrency) || STRESS_DEFAULT));
    setConcurrency(n);
    setIsStressTesting(true);
    setStressResult(null);
    setStressError(null);
    try {
      setStressPhase('Creating order');
      const order = await orchestrator.createOrder(TEST_AMOUNT_PAISE, {
        receipt: `stress_${Date.now()}`,
        notes: { purpose: 'idempotency stress test' },
      });
      const idempotencyKey = newIdempotencyKey('stress');

      setStressPhase(`Firing ${n} concurrent checkouts`);
      const started = performance.now();
      const outcomes = await Promise.all(
        Array.from({ length: n }, (_, index) => {
          const sentAt = performance.now();
          return orchestrator.pay(order.id, TEST_INSTRUMENT, {}, idempotencyKey).then(
            (r): StressOutcome => ({
              index,
              kind: 'success',
              paymentId: r.payment_id,
              httpStatus: 200,
              message: r.status,
              ms: performance.now() - sentAt,
            }),
            (e: unknown): StressOutcome => {
              const g = e instanceof GatewayError ? e : null;
              return {
                index,
                kind: g?.status === 409 ? 'conflict' : 'error',
                paymentId: g?.metadata?.payment_id ?? null,
                httpStatus: g?.status ?? 0,
                message: g?.message ?? (e instanceof Error ? e.message : String(e)),
                ms: performance.now() - sentAt,
              };
            },
          );
        }),
      );
      const wallMs = performance.now() - started;

      const successes = outcomes.filter((o) => o.kind === 'success');
      const successPaymentIds = unique(successes.map((o) => o.paymentId));
      const errors = outcomes.filter((o) => o.kind === 'error');
      const errorCounts: Record<string, number> = {};
      errors.forEach((o) => {
        const label = o.httpStatus ? `HTTP ${o.httpStatus}: ${o.message}` : o.message;
        errorCounts[label] = (errorCounts[label] ?? 0) + 1;
      });

      // One request after the burst: it must replay the stored result with the same payment id.
      setStressPhase('Replaying the key once more');
      let replay: StressResult['replay'] = null;
      try {
        const r = await orchestrator.pay(order.id, TEST_INSTRUMENT, {}, idempotencyKey);
        replay = { paymentId: r.payment_id, message: `HTTP 200, status ${r.status}` };
      } catch (e) {
        const g = e instanceof GatewayError ? e : null;
        replay = { paymentId: g?.metadata?.payment_id ?? null, message: g ? `HTTP ${g.status}: ${g.message}` : String(e) };
      }

      setStressPhase('Reading bank attempts');
      const toInspect = unique(outcomes.map((o) => o.paymentId).concat(replay?.paymentId ?? null)).slice(0, MAX_INSPECTED_PAYMENTS);
      const inspected: InspectedPayment[] = await Promise.all(
        toInspect.map((paymentId) =>
          orchestrator.getAttempts(paymentId).then(
            (c): InspectedPayment => ({ paymentId, attempts: c.items, error: null }),
            (e: unknown): InspectedPayment => ({ paymentId, attempts: null, error: toLoadError(e).message }),
          ),
        ),
      );

      let sentToBank = 0;
      let approvedCharges = 0;
      let skippedByBreaker = 0;
      let extraApprovedAttempts = 0;
      inspected.forEach((p) => {
        const attempts = p.attempts ?? [];
        const approved = attempts.filter((a) => a.status === 'success').length;
        sentToBank += attempts.filter((a) => a.response_code !== 'CB_OPEN').length;
        skippedByBreaker += attempts.filter((a) => a.response_code === 'CB_OPEN').length;
        approvedCharges += approved;
        extraApprovedAttempts += Math.max(0, approved - 1);
      });

      if (!mounted.current) return;
      setStressResult({
        requests: n,
        orderId: order.id,
        idempotencyKey,
        outcomes,
        succeeded: successes.length,
        successPaymentIds,
        conflicts: outcomes.filter((o) => o.kind === 'conflict').length,
        otherErrors: errors.length,
        errorSummary: Object.keys(errorCounts).map((message) => ({ message, count: errorCounts[message] })),
        wallMs,
        inspected,
        sentToBank,
        approvedCharges,
        skippedByBreaker,
        doubleCharges: Math.max(0, successPaymentIds.length - 1) + extraApprovedAttempts,
        replay,
      });
    } catch (e) {
      if (mounted.current) setStressError(toLoadError(e));
    } finally {
      if (mounted.current) {
        setIsStressTesting(false);
        setStressPhase('');
      }
      void refresh();
    }
  };

  // Shown in the notes; taken from the live breakers once loaded (the orchestrator's defaults until then).
  const breakerConfig = {
    minCalls: breakers?.[0]?.minimum_number_of_calls ?? 5,
    threshold: breakers?.[0]?.failure_rate_threshold ?? 50,
    waitSeconds: (breakers?.[0]?.wait_duration_in_open_state_ms ?? 5000) / 1000,
  };

  const verdictOk = stressResult !== null && stressResult.doubleCharges === 0 && stressResult.successPaymentIds.length <= 1;
  const replayMatches =
    stressResult?.replay?.paymentId != null &&
    stressResult.successPaymentIds.length === 1 &&
    stressResult.replay.paymentId === stressResult.successPaymentIds[0];

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
              <ShieldCheck className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">Resilience4j Circuit Breakers & Checkout Idempotency</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Live per-rail breakers from <span className="font-mono text-slate-300">GET /ops/circuit-breakers</span> (every{' '}
                {POLL_INTERVAL_MS / 1000}s), bank-simulator outage controls, and a real duplicate-checkout stress test.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {notice && (
            <span
              className={`text-xs px-3 py-1.5 rounded-lg border max-w-md ${
                notice.tone === 'ok'
                  ? 'bg-emerald-950/80 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-950/80 border-rose-500/30 text-rose-300'
              }`}
            >
              {notice.text}
            </span>
          )}
          <span className="text-[11px] text-slate-500 font-mono">{lastUpdated ? lastUpdated.toLocaleTimeString() : '--:--:--'}</span>
          <button
            onClick={() => void handleManualRefresh()}
            disabled={manualRefresh}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs px-3 py-1.5 rounded-xl border border-slate-700 transition flex items-center gap-1.5 font-semibold"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${manualRefresh ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Breaker load errors */}
      {breakerError && (
        <div className="bg-rose-950/40 border border-rose-800/60 p-4 rounded-2xl flex items-start gap-3 text-xs">
          <TriangleAlert className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-rose-200 font-semibold">
              {breakers ? 'Breaker refresh failed; showing the last known state.' : 'Could not load circuit breakers.'} {breakerError.message}
            </p>
            {breakerError.network && (
              <p className="text-rose-300/80">Start the payment orchestrator (port 8080). This panel retries every {POLL_INTERVAL_MS / 1000}s.</p>
            )}
          </div>
        </div>
      )}

      {/* Circuit Breakers Telemetry Matrix */}
      {!breakers && !breakerError && (
        <div className="bg-slate-900 border border-slate-800 p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" /> Loading circuit breakers...
        </div>
      )}
      {breakers && breakers.length === 0 && (
        <div className="bg-slate-900 border border-dashed border-slate-700 p-8 rounded-2xl text-center text-xs text-slate-500">
          The orchestrator reports no provider rails (gateway.routing.providers is empty).
        </div>
      )}
      {breakers && breakers.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {breakers.map((cb) => {
            const isClosed = cb.state === 'CLOSED';
            const isOpen = cb.state === 'OPEN' || cb.state === 'FORCED_OPEN';
            const isHalfOpen = cb.state === 'HALF_OPEN';
            const rail = rails?.[cb.provider_id];
            const hasRate = cb.failure_rate >= 0;
            const waitSeconds = cb.wait_duration_in_open_state_ms / 1000;

            return (
              <div
                key={cb.provider_id}
                className={`rounded-2xl border p-5 transition-all flex flex-col justify-between ${
                  isOpen
                    ? 'bg-rose-950/20 border-rose-500/40 shadow-lg shadow-rose-950/30'
                    : isHalfOpen
                      ? 'bg-amber-950/20 border-amber-500/40'
                      : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div>
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{cb.provider_id}</span>
                      <h3 className="text-base font-bold text-white">{railName(cb.provider_id)}</h3>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 border ${
                        isOpen
                          ? 'bg-rose-500/20 text-rose-400 border-rose-500/30 animate-pulse'
                          : isHalfOpen
                            ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                            : isClosed
                              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                              : 'bg-slate-700/40 text-slate-300 border-slate-600'
                      }`}
                    >
                      {isOpen && <TriangleAlert className="w-3.5 h-3.5" />}
                      {isHalfOpen && <Activity className="w-3.5 h-3.5" />}
                      {isClosed && <CircleCheck className="w-3.5 h-3.5" />}
                      {cb.state.replace('_', '-')}
                    </span>
                  </div>

                  {/* State description */}
                  <div className="mb-4 text-xs">
                    {isOpen ? (
                      <p className="text-rose-300/90 bg-rose-950/40 p-2.5 rounded-xl border border-rose-500/20">
                        <strong>TRIPPED:</strong> payments skip this rail without sending the charge (attempt recorded as{' '}
                        <code className="font-mono">CB_OPEN</code>) and fail over. After {waitSeconds}s the next payment is let through as a
                        trial call.
                      </p>
                    ) : isHalfOpen ? (
                      <p className="text-amber-300/90 bg-amber-950/40 p-2.5 rounded-xl border border-amber-500/20">
                        <strong>HALF-OPEN:</strong> a few trial calls are let through. Healthy answers close the breaker; failures open it again.
                      </p>
                    ) : isClosed ? (
                      <p className="text-slate-400 bg-slate-800/40 p-2.5 rounded-xl border border-slate-800">
                        <strong>NORMAL:</strong> all calls permitted. Bank declines count as healthy answers; only unavailable or unanswered
                        calls count as failures.
                      </p>
                    ) : (
                      <p className="text-slate-400 bg-slate-800/40 p-2.5 rounded-xl border border-slate-800">
                        <strong>{cb.state}:</strong> set manually on the orchestrator. Reset to return the breaker to CLOSED.
                      </p>
                    )}
                  </div>

                  {/* Metric Telemetry */}
                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60 space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400">Failure rate:</span>
                        <span
                          className={`font-bold ${
                            !hasRate ? 'text-slate-500' : cb.failure_rate >= cb.failure_rate_threshold ? 'text-rose-400' : 'text-slate-200'
                          }`}
                        >
                          {hasRate ? `${cb.failure_rate.toFixed(1)}%` : `not enough calls (${cb.buffered_calls}/${cb.minimum_number_of_calls})`}
                        </span>
                      </div>
                      <div className="relative w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${cb.failure_rate >= cb.failure_rate_threshold ? 'bg-rose-500' : 'bg-indigo-500'}`}
                          style={{ width: `${hasRate ? Math.min(100, cb.failure_rate) : 0}%` }}
                        />
                        <div
                          className="absolute top-0 h-full w-0.5 bg-amber-400"
                          style={{ left: `${Math.min(100, cb.failure_rate_threshold)}%` }}
                          title={`Opens at ${cb.failure_rate_threshold}%`}
                        />
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Opens at {cb.failure_rate_threshold}% after at least {cb.minimum_number_of_calls} calls · waits {waitSeconds}s
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[11px] text-slate-500 block">Successful</span>
                        <span className="font-bold text-emerald-400 text-sm">{cb.successful_calls}</span>
                      </div>
                      <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[11px] text-slate-500 block">Failed</span>
                        <span className="font-bold text-rose-400 text-sm">{cb.failed_calls}</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-slate-400">Not permitted (skipped):</span>
                      <span className={`font-bold ${cb.not_permitted_calls > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
                        {cb.not_permitted_calls} calls
                      </span>
                    </div>

                    <div className="flex justify-between items-center bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-slate-400">Sliding window:</span>
                      <span className="text-indigo-300 font-bold">
                        {cb.buffered_calls} / {SLIDING_WINDOW_SIZE} calls
                      </span>
                    </div>

                    <div className="flex justify-between items-center bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-slate-400">Bank rail:</span>
                      {rail ? (
                        <span className={`font-bold ${rail.is_killed ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {rail.is_killed ? 'DOWN (killed)' : 'up'}
                          <span className="text-slate-500 font-normal">
                            {' '}
                            · {Math.round(rail.success_rate * 100)}% · {rail.latency_ms}ms
                          </span>
                        </span>
                      ) : (
                        <span className="text-slate-500">{railError ? 'simulator unreachable' : 'loading...'}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-5 pt-4 border-t border-slate-800/80 flex items-center gap-2">
                  <button
                    onClick={() => void handleReset(cb.provider_id)}
                    disabled={busyAction !== null}
                    className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium rounded-lg border border-slate-700 transition flex items-center justify-center gap-1"
                  >
                    <RefreshCw className={`w-3 h-3 ${busyAction === `reset:${cb.provider_id}` ? 'animate-spin' : ''}`} /> Reset breaker
                  </button>
                  {rail?.is_killed ? (
                    <button
                      onClick={() => void handleRestore(cb.provider_id)}
                      disabled={busyAction !== null}
                      title="Bring this rail back up at the bank simulator"
                      className="py-1.5 px-2.5 bg-emerald-950/40 hover:bg-emerald-900/60 disabled:opacity-50 text-emerald-300 text-xs font-medium rounded-lg border border-emerald-800/40 transition flex items-center justify-center gap-1"
                    >
                      <Power className="w-3 h-3 text-emerald-400" /> Restore rail
                    </button>
                  ) : (
                    <button
                      onClick={() => void handleKill(cb.provider_id)}
                      disabled={busyAction !== null || railError !== null}
                      title="Take this rail down at the bank simulator (it answers 503)"
                      className="py-1.5 px-2.5 bg-rose-950/40 hover:bg-rose-900/60 disabled:opacity-50 text-rose-300 text-xs font-medium rounded-lg border border-rose-800/40 transition flex items-center justify-center gap-1"
                    >
                      <Flame className="w-3 h-3 text-rose-400" /> Kill rail
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Chaos + test traffic bar */}
      <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-xl space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-2 text-xs text-slate-300">
            <Flame className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <span>
              Breakers only move when payments are routed. Kill a rail, then send test traffic ({TRAFFIC_BATCH} sequential{' '}
              {formatInr(TEST_AMOUNT_PAISE)} UPI payments on the sandbox merchant). The AI router learns to rank a failing rail last, so with
              one rail down it may stop getting traffic before its breaker trips; kill all three to see every breaker open.
              {railError && <span className="text-rose-300"> Bank simulator: {railError.message}</span>}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void sendTestTraffic()}
              disabled={traffic?.running === true}
              className="px-3.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 disabled:opacity-50 text-indigo-200 border border-indigo-500/30 rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
            >
              <Send className={`w-3.5 h-3.5 ${traffic?.running ? 'animate-pulse' : ''}`} />
              {traffic?.running ? `Sending ${traffic.sent}/${traffic.total}...` : `Send ${TRAFFIC_BATCH} test payments`}
            </button>
            <button
              onClick={() => void handleRestore()}
              disabled={busyAction !== null || railError !== null}
              className="px-3.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-50 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
            >
              <CircleCheck className="w-3.5 h-3.5" /> Restore all rails
            </button>
          </div>
        </div>
        {traffic && (
          <div className="text-[11px] font-mono text-slate-400 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
            Test traffic: {traffic.sent}/{traffic.total} sent · <span className="text-emerald-400">{traffic.authorized} paid</span> ·{' '}
            <span className="text-rose-400">{traffic.failed} failed</span>
            {traffic.lastError && <span className="text-slate-500"> · last error: {traffic.lastError}</span>}
          </div>
        )}
      </div>

      {/* Idempotency stress test */}
      <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/20 border border-indigo-500/40 rounded-xl text-indigo-400">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Idempotency stress test
                <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-2 py-0.5 rounded-full font-mono">
                  UNIQUE (merchant_id, idempotency_key)
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Creates one {formatInr(TEST_AMOUNT_PAISE)} order, then fires concurrent{' '}
                <span className="font-mono">POST /v1/checkout/payments</span> requests that all share one Idempotency-Key.
              </p>
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-xl text-xs font-mono">
              <span className="text-slate-400">Requests:</span>
              {STRESS_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setConcurrency(preset)}
                  disabled={isStressTesting}
                  className={`px-2 py-0.5 rounded transition ${
                    concurrency === preset ? 'bg-indigo-600 text-white font-bold' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {preset}
                </button>
              ))}
              <input
                type="number"
                min={STRESS_MIN}
                max={STRESS_MAX}
                value={concurrency}
                disabled={isStressTesting}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-14 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-white outline-none focus:ring-1 focus:ring-indigo-500"
                aria-label="Number of concurrent requests"
              />
            </div>

            <button
              onClick={() => void runStressTest()}
              disabled={isStressTesting}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-lg shadow-indigo-600/30 transition flex items-center gap-2"
            >
              <Zap className={`w-4 h-4 ${isStressTesting ? 'animate-bounce text-amber-300' : ''}`} />
              {isStressTesting ? `${stressPhase}...` : `Fire ${Math.min(STRESS_MAX, Math.max(STRESS_MIN, concurrency || STRESS_DEFAULT))} duplicate checkouts`}
            </button>
          </div>
        </div>

        {stressError && (
          <div className="relative mb-4 bg-rose-950/40 border border-rose-800/60 p-3 rounded-xl text-xs text-rose-200">
            Stress test could not run: {stressError.message}
            {stressError.network && <span className="text-rose-300/80"> Start the payment orchestrator (port 8080) and try again.</span>}
          </div>
        )}

        {/* Results */}
        {stressResult ? (
          <div className="relative bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <span className={`text-xs font-bold flex items-center gap-1.5 ${verdictOk ? 'text-slate-200' : 'text-rose-300'}`}>
                {verdictOk ? <CircleCheck className="w-4 h-4 text-emerald-400" /> : <CircleX className="w-4 h-4 text-rose-400" />}
                {verdictOk
                  ? stressResult.successPaymentIds.length === 1
                    ? `No double charge: ${stressResult.requests} requests resolved to one payment with ${stressResult.approvedCharges} approved bank charge${stressResult.approvedCharges === 1 ? '' : 's'}`
                    : 'No payment succeeded, so nothing was charged; see the errors below'
                  : `Double charge detected: ${stressResult.doubleCharges}`}
              </span>
              <span className="text-xs font-mono text-slate-400">
                Wall time: <strong className="text-white">{Math.round(stressResult.wallMs)}ms</strong>
              </span>
            </div>

            {/* Metric cards */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-center">
                <span className="text-[10px] text-slate-400 uppercase font-mono block">Requests</span>
                <span className="text-xl font-extrabold text-white">{stressResult.requests}</span>
                <span className="text-[10px] text-slate-500 block">same key</span>
              </div>
              <div className="bg-emerald-950/40 border border-emerald-500/30 p-3 rounded-xl text-center">
                <span className="text-[10px] text-emerald-300 uppercase font-mono block">Succeeded</span>
                <span className="text-xl font-extrabold text-emerald-400">{stressResult.succeeded}</span>
                <span className="text-[10px] text-emerald-300/70 block">
                  {stressResult.successPaymentIds.length} distinct payment id{stressResult.successPaymentIds.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="bg-amber-950/40 border border-amber-500/30 p-3 rounded-xl text-center">
                <span className="text-[10px] text-amber-300 uppercase font-mono block">409 Conflicts</span>
                <span className="text-xl font-extrabold text-amber-400">{stressResult.conflicts}</span>
                <span className="text-[10px] text-amber-300/70 block">still processing, retry</span>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 p-3 rounded-xl text-center">
                <span className="text-[10px] text-slate-400 uppercase font-mono block">Other errors</span>
                <span className={`text-xl font-extrabold ${stressResult.otherErrors > 0 ? 'text-rose-400' : 'text-slate-300'}`}>
                  {stressResult.otherErrors}
                </span>
                <span className="text-[10px] text-slate-500 block">non-409</span>
              </div>
              <div className="bg-indigo-950/40 border border-indigo-500/30 p-3 rounded-xl text-center">
                <span className="text-[10px] text-indigo-300 uppercase font-mono block">Reached bank</span>
                <span className="text-xl font-extrabold text-indigo-400">{stressResult.sentToBank}</span>
                <span className="text-[10px] text-indigo-300/70 block">
                  {stressResult.approvedCharges} approved
                  {stressResult.skippedByBreaker > 0 ? ` · ${stressResult.skippedByBreaker} CB_OPEN` : ''}
                </span>
              </div>
              <div
                className={`p-3 rounded-xl text-center border ${
                  stressResult.doubleCharges === 0 ? 'bg-emerald-950/40 border-emerald-500/40' : 'bg-rose-950/40 border-rose-500/40'
                }`}
              >
                <span className={`text-[10px] uppercase font-mono block ${stressResult.doubleCharges === 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  Double charges
                </span>
                <span
                  className={`text-xl font-extrabold flex items-center justify-center gap-1 ${
                    stressResult.doubleCharges === 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {stressResult.doubleCharges === 0 ? <CircleCheck className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                  {stressResult.doubleCharges}
                </span>
              </div>
            </div>

            {/* Per-request outcomes */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-slate-500">
                <span>Outcome per request (send order):</span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> 200 same payment
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" /> 409 retry
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block" /> other error
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {stressResult.outcomes.map((o) => (
                  <span
                    key={o.index}
                    title={`#${o.index + 1}: ${o.httpStatus ? `HTTP ${o.httpStatus}` : 'no answer'} after ${Math.round(o.ms)}ms. ${o.message}`}
                    className={`w-4 h-4 rounded-sm ${o.kind === 'success' ? 'bg-emerald-500' : o.kind === 'conflict' ? 'bg-amber-500' : 'bg-rose-500'}`}
                  />
                ))}
              </div>
            </div>

            {stressResult.errorSummary.length > 0 && (
              <div className="bg-rose-950/30 border border-rose-900/50 rounded-xl p-3 text-[11px] font-mono text-rose-300 space-y-0.5">
                {stressResult.errorSummary.map((e) => (
                  <div key={e.message}>
                    {e.count}× {e.message}
                  </div>
                ))}
              </div>
            )}

            {/* Execution trace */}
            <div className="bg-slate-900 p-3 rounded-xl border border-slate-800/80 font-mono text-xs space-y-2 text-slate-400">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div>
                  Order: <span className="text-slate-200">{stressResult.orderId}</span>
                </div>
                <div>
                  Payment:{' '}
                  <span className="text-indigo-300 font-bold">
                    {stressResult.successPaymentIds.length > 0 ? stressResult.successPaymentIds.join(', ') : 'none'}
                  </span>
                </div>
                <div>
                  Idempotency-Key: <span className="text-slate-200">{stressResult.idempotencyKey}</span>
                </div>
              </div>
              {stressResult.replay && (
                <div className={replayMatches ? 'text-emerald-400' : 'text-slate-400'}>
                  Follow-up replay with the same key: {stressResult.replay.message}
                  {stressResult.replay.paymentId ? ` → ${stressResult.replay.paymentId}` : ''}
                  {replayMatches ? ' (same payment id)' : ''}
                </div>
              )}
              {stressResult.inspected.map((p) => (
                <div key={p.paymentId} className="border-t border-slate-800 pt-2">
                  <div className="text-slate-500 mb-1">GET /v1/payments/{p.paymentId}/attempts</div>
                  {p.error ? (
                    <div className="text-rose-300">{p.error}</div>
                  ) : p.attempts && p.attempts.length > 0 ? (
                    <div className="space-y-0.5">
                      {p.attempts.map((a) => (
                        <div key={a.id} className="flex flex-wrap gap-x-3 text-[11px]">
                          <span className="text-slate-300">{railName(a.provider)}</span>
                          <span className={a.status === 'success' ? 'text-emerald-400' : 'text-rose-300'}>{a.status}</span>
                          <span>code {a.response_code ?? '-'}</span>
                          <span>{a.latency_ms ?? '-'}ms</span>
                          {a.bank_reference && <span className="text-slate-500">{a.bank_reference}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-500">No rail attempts recorded.</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="relative bg-slate-950/60 border border-slate-800/80 rounded-xl p-5 text-center">
            <div className="max-w-xl mx-auto space-y-2">
              <Cpu className="w-8 h-8 text-indigo-400 mx-auto opacity-70" />
              <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                {isStressTesting ? `${stressPhase}...` : 'Ready'}
              </h4>
              <p className="text-xs text-slate-500">
                Fires {Math.min(STRESS_MAX, Math.max(STRESS_MIN, concurrency || STRESS_DEFAULT))} checkouts for the same order with one shared
                Idempotency-Key, counts what came back, then reads the payment&apos;s rail attempts to count how many charges reached the
                bank. Expect one payment id, a mix of 200 replays and 409s, and exactly one approved charge. Browsers open about six
                connections per host, so beyond that the requests queue in the browser; the duplicates still overlap on the server.
              </p>
            </div>
          </div>
        )}

        {/* Architecture notes */}
        <div className="relative mt-5 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-400">
          <div className="bg-slate-950/40 border border-slate-800/60 p-3.5 rounded-xl">
            <h5 className="font-bold text-slate-200 mb-1 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-400" /> Why one charge: database constraint + checkout state machine
            </h5>
            <p className="text-[11px] leading-relaxed">
              The first request inserts the payment in <code className="text-indigo-300 font-mono">created</code> state, protected by the
              unique index <code className="text-indigo-300 font-mono">(merchant_id, idempotency_key)</code> on{' '}
              <code className="text-indigo-300 font-mono">payments</code> in PostgreSQL, and only that request calls the bank. Duplicates find
              the existing row: while it is still <code className="text-indigo-300 font-mono">created</code> they get{' '}
              <code className="text-amber-300 font-mono">409</code> (retry later); once it is authorized, captured or failed they replay the
              stored result with the same payment id. There is no Redis lock in this path.
            </p>
          </div>

          <div className="bg-slate-950/40 border border-slate-800/60 p-3.5 rounded-xl">
            <h5 className="font-bold text-slate-200 mb-1 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-amber-400" /> Resilience4j circuit breakers
            </h5>
            <p className="text-[11px] leading-relaxed">
              One breaker per rail over the last {SLIDING_WINDOW_SIZE} calls. Once at least {breakerConfig.minCalls} calls are recorded and{' '}
              {breakerConfig.threshold}% or more failed (rail unavailable or no usable answer), it opens: the rail is skipped without sending
              the charge and its attempt is recorded as <code className="text-rose-400 font-mono">CB_OPEN</code>. After{' '}
              {breakerConfig.waitSeconds}s it goes half-open and lets trial calls through. Bank declines are healthy answers and never count
              as failures.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

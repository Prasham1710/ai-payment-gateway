'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Award, Brain, Cpu, Info, RefreshCw, Sliders, Sparkles } from 'lucide-react';
import {
  GatewayError,
  PROVIDERS,
  PROVIDER_NAMES,
  type PaymentMethod,
  type RouteAdvice,
  type RouterStats,
  aiRouter,
  config,
  formatInr,
  toPaise,
} from '@/lib/gateway';

const REFRESH_MS = 5000;

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'netbanking', label: 'NetBanking' },
];

const inputClass =
  'w-full bg-slate-950 border border-slate-800 text-white rounded-xl px-3 py-2 text-xs font-mono focus:border-indigo-500 outline-none';

interface ErrorInfo {
  message: string;
  network: boolean;
}

type Health = Awaited<ReturnType<typeof aiRouter.health>>;
type Arm = RouterStats['arms'][number];

function describeError(e: unknown): ErrorInfo {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

const pct = (value: number | undefined) => (value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

export default function Port8000AiRouter() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<ErrorInfo | null>(null);
  const [stats, setStats] = useState<RouterStats | null>(null);
  const [statsError, setStatsError] = useState<ErrorInfo | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const [reloading, setReloading] = useState(false);
  const [reloadMsg, setReloadMsg] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);

  // Routing playground inputs
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [amount, setAmount] = useState('1499.00');
  const [hour, setHour] = useState('');
  const [routing, setRouting] = useState(false);
  const [advice, setAdvice] = useState<RouteAdvice | null>(null);
  const [askedWith, setAskedWith] = useState<{ payment_method: string; amount: number; hour?: number } | null>(null);
  const [routeError, setRouteError] = useState<ErrorInfo | null>(null);
  const autoRouted = useRef(false);

  const refresh = useCallback(async () => {
    const [h, s] = await Promise.allSettled([aiRouter.health(), aiRouter.stats()]);
    if (h.status === 'fulfilled') {
      setHealth(h.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(describeError(h.reason));
    }
    if (s.status === 'fulfilled') {
      setStats(s.value);
      setStatsError(null);
    } else {
      setStatsError(describeError(s.reason));
    }
    setUpdatedAt(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleRoute = useCallback(async () => {
    const rupees = Number(amount);
    const paise = toPaise(amount);
    if (!Number.isFinite(rupees) || paise < 1) {
      setRouteError({ message: 'Enter an amount of at least ₹0.01.', network: false });
      return;
    }
    let hourValue: number | undefined;
    if (hour.trim() !== '') {
      hourValue = Number(hour);
      if (!Number.isInteger(hourValue) || hourValue < 0 || hourValue > 23) {
        setRouteError({ message: 'Hour must be a whole number from 0 to 23, or empty for the current hour (IST).', network: false });
        return;
      }
    }
    const body = { payment_method: method, amount: paise, ...(hourValue === undefined ? {} : { hour: hourValue }) };
    setRouting(true);
    setRouteError(null);
    try {
      setAdvice(await aiRouter.route(body));
      setAskedWith(body);
    } catch (e) {
      setRouteError(describeError(e));
    } finally {
      setRouting(false);
    }
  }, [amount, hour, method]);

  // Show one ranking as soon as the router is known to be up.
  useEffect(() => {
    if (health && !autoRouted.current) {
      autoRouted.current = true;
      void handleRoute();
    }
  }, [health, handleRoute]);

  const handleReload = async () => {
    setReloading(true);
    setReloadMsg(null);
    try {
      const res = await aiRouter.reloadModel();
      setReloadMsg(
        res.loaded
          ? { tone: 'ok', text: `Loaded model ${res.model_version ?? ''}`.trim() }
          : { tone: 'info', text: 'No model file found: routing uses the bandit alone.' },
      );
      await refresh();
    } catch (e) {
      const info = describeError(e);
      setReloadMsg({
        tone: 'error',
        text: info.network
          ? `${info.message} Start the AI router (${config.aiRouterUrl}).`
          : `${info.message}: the model file exists but could not be loaded (see the AI router log).`,
      });
    } finally {
      setReloading(false);
    }
  };

  const online = health !== null;
  const arms = [...(stats?.arms ?? [])].sort(
    (a, b) => a.payment_method.localeCompare(b.payment_method) || b.expected_success - a.expected_success,
  );
  const totalObservations = arms.reduce((sum, a) => sum + a.observations, 0);
  const modelVersion = health?.model_version ?? stats?.model_version ?? null;
  const modelMetrics = stats?.model_metrics ?? null;

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
            <Cpu className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-bold text-white tracking-tight">AI Smart Router (Port 8000)</h2>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-bold font-mono border ${
                  online
                    ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/40'
                    : healthError
                      ? 'bg-rose-950/80 text-rose-400 border-rose-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                {online ? 'ONLINE' : healthError ? 'OFFLINE' : 'CHECKING'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Bandit over (rail, payment method) success rates: greedy on the expected success rate, with occasional Thompson-sampling
              exploration, optionally blended with a scikit-learn logistic-regression model. FastAPI at{' '}
              <span className="font-mono">{config.aiRouterUrl}</span>.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {reloadMsg && (
            <span
              className={`text-xs border px-3 py-1.5 rounded-lg ${
                reloadMsg.tone === 'ok'
                  ? 'bg-emerald-950/80 border-emerald-500/30 text-emerald-400'
                  : reloadMsg.tone === 'info'
                    ? 'bg-slate-800 border-slate-700 text-slate-300'
                    : 'bg-rose-950/80 border-rose-500/30 text-rose-300'
              }`}
            >
              {reloadMsg.text}
            </span>
          )}
          <button
            type="button"
            onClick={handleReload}
            disabled={reloading || !online}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs px-4 py-2 rounded-xl transition flex items-center gap-2 shadow-lg shadow-indigo-600/30"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reloading ? 'animate-spin' : ''}`} />
            {reloading ? 'Reloading…' : 'Reload model'}
          </button>
        </div>
      </div>

      {healthError && (
        <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-xl px-4 py-3 space-y-0.5">
          <p>{healthError.message}</p>
          {healthError.network && (
            <p className="text-rose-200/70">
              Start the AI router ({config.aiRouterUrl}). Meanwhile the orchestrator routes in its configured order (
              {PROVIDERS.join(', ')}).
            </p>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Strategy"
          value={!online ? '—' : modelVersion ? 'bandit + model' : 'bandit only'}
          hint={`greedy, ~3% Thompson-sampling exploration${modelVersion ? ', +model' : ''}`}
          tone="text-indigo-300"
        />
        <MetricCard label="Model version" value={modelVersion ?? 'none'} hint="Offline logistic regression" tone="text-white" small />
        <MetricCard label="Arms tracked" value={stats ? String(arms.length) : '—'} hint="(rail, method) pairs seen" tone="text-emerald-400" />
        <MetricCard
          label="Outcomes reported"
          value={stats ? totalObservations.toLocaleString() : '—'}
          hint="Counted attempts since router start"
          tone="text-amber-300"
        />
      </div>

      {/* Arms table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 bg-slate-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Brain className="w-4 h-4 text-indigo-400" /> What the router believes right now
          </h3>
          <span className="text-[11px] font-mono text-slate-500 flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> GET /v1/stats every {REFRESH_MS / 1000}s
            {updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString()}` : ''}
          </span>
        </div>

        {statsError && !healthError && (
          <p className="m-4 text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2">{statsError.message}</p>
        )}

        {!stats ? (
          <p className="p-6 text-xs text-slate-500">{healthError ? 'Router unreachable.' : 'Loading router state…'}</p>
        ) : arms.length === 0 ? (
          <div className="p-6 text-xs text-slate-400 space-y-1">
            <p className="text-slate-300 font-semibold">No outcomes reported yet.</p>
            <p>
              The orchestrator reports every rail attempt to <span className="font-mono">POST /v1/feedback</span>. Make a few payments and
              the arms appear here. Until then every rail starts at Beta(1, 1), a 50% guess. Arms live in memory and reset when the
              router restarts.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="text-left font-semibold px-4 py-2">Rail</th>
                  <th className="text-left font-semibold px-4 py-2">Method</th>
                  <th className="text-right font-semibold px-4 py-2">α (successes)</th>
                  <th className="text-right font-semibold px-4 py-2">β (failures)</th>
                  <th className="text-left font-semibold px-4 py-2 w-1/4">Expected success</th>
                  <th className="text-right font-semibold px-4 py-2" title="Outcomes counted for this arm since the router started (not decayed; unknown outcomes are not counted)">
                    Observations
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {arms.map((arm) => (
                  <ArmRow key={`${arm.provider}:${arm.payment_method}`} arm={arm} />
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-800/60">
              α and β include the Beta(1, 1) prior and are decayed over time, so they can be far below the observation count: that is the
              forgetting at work.
            </p>
          </div>
        )}
      </div>

      {/* Playground + model / explanation */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: routing playground */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-indigo-400" /> Routing playground
            </h3>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">
              POST /v1/route
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="ai-method" className="text-xs font-semibold text-slate-300 block mb-1.5">
                Payment method
              </label>
              <select id="ai-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ai-amount" className="text-xs font-semibold text-slate-300 block mb-1.5">
                Amount (₹)
              </label>
              <input
                id="ai-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="ai-hour" className="text-xs font-semibold text-slate-300 block mb-1.5">
                Hour (IST, optional)
              </label>
              <input
                id="ai-hour"
                type="number"
                min="0"
                max="23"
                step="1"
                placeholder="now"
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleRoute()}
            disabled={routing}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30"
          >
            <Sparkles className={`w-4 h-4 ${routing ? 'animate-spin' : ''}`} />
            {routing ? 'Asking the router…' : 'Rank the rails'}
          </button>

          {routeError && (
            <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2 space-y-0.5">
              <p>{routeError.message}</p>
              {routeError.network && <p className="text-rose-200/70">Start the AI router ({config.aiRouterUrl}) and try again.</p>}
            </div>
          )}

          {advice && askedWith && (
            <div className="bg-slate-950 border border-indigo-500/40 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                  <Award className="w-4 h-4 text-emerald-400" /> First rail: {providerName(advice.providers[0])}
                </span>
                <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1.5">
                  strategy: <strong className="text-indigo-300">{advice.strategy}</strong>
                  {advice.model_version ? <span className="text-slate-500">({advice.model_version})</span> : null}
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      advice.strategy.startsWith('thompson_sampling')
                        ? 'bg-amber-950/60 text-amber-300 border-amber-800/70'
                        : 'bg-slate-800 text-slate-300 border-slate-700'
                    }`}
                  >
                    {advice.strategy.startsWith('thompson_sampling') ? 'exploration call' : 'exploit'}
                  </span>
                </span>
              </div>

              <p className="text-[11px] font-mono text-slate-500">
                {askedWith.payment_method.toUpperCase()} · {formatInr(askedWith.amount)} ({askedWith.amount} paise) · hour{' '}
                {askedWith.hour ?? 'now (IST)'}
              </p>

              <div className="space-y-2">
                {advice.providers.map((id, idx) => {
                  const score = advice.scores[id];
                  const expected = advice.expected_success[id];
                  return (
                    <div
                      key={id}
                      className={`p-2.5 rounded-lg border text-xs font-mono space-y-1.5 ${
                        idx === 0 ? 'bg-indigo-950/40 border-indigo-500/40 text-white' : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-indigo-400">#{idx + 1}</span>
                          <span className="font-semibold text-slate-200">{providerName(id)}</span>
                          <span className="text-[10px] text-slate-500">({id})</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-indigo-300 font-bold">score {score === undefined ? '—' : score.toFixed(3)}</span>
                          <span className="text-emerald-400">{pct(expected)} expected</span>
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800/80">
                        <div
                          className="bg-indigo-500 h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(Math.max((score ?? 0) * 100, 0), 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Rails are ordered by <strong className="text-slate-400">score</strong>.{' '}
                {advice.strategy.startsWith('thompson_sampling')
                  ? 'This was an exploration call: score is a random draw from each rail’s Beta belief, so an avoided rail can come first.'
                  : 'On this greedy call score is the expected success rate, so the most reliable rail comes first.'}{' '}
                {advice.strategy.includes('model') ? 'Both are blended with the model’s prediction. ' : ''}
                About 3% of calls (by default) explore; press Rank the rails a few times to see one.{' '}
                <strong className="text-slate-400">expected</strong> is the belief&apos;s mean. Asking here does not teach the router
                anything; only outcomes the orchestrator reports do.
              </p>
            </div>
          )}
        </div>

        {/* Right: model + how it works */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Brain className="w-4 h-4 text-indigo-400" /> Offline model
              </h3>
              <span className="text-xs text-slate-400 font-mono">{modelVersion ?? 'not loaded'}</span>
            </div>

            {modelVersion ? (
              modelMetrics && Object.keys(modelMetrics).length > 0 ? (
                <dl className="space-y-1.5 font-mono text-[11px]">
                  {Object.entries(modelMetrics).map(([key, value]) => (
                    <MetricEntry key={key} name={key} value={value} />
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-slate-500">The loaded model has no metrics recorded.</p>
              )
            ) : (
              <p className="text-xs text-slate-400 leading-relaxed">
                No model is loaded, so the router ranks rails with the bandit alone. To blend in a prior, train one with{' '}
                <span className="font-mono text-slate-300">services/ai-router/train.py</span> (it writes{' '}
                <span className="font-mono text-slate-300">models/routing-model.joblib</span>), then press Reload model.
              </p>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-3 text-[11px] text-slate-400 leading-relaxed">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Info className="w-4 h-4 text-indigo-400" /> How it works
            </h3>
            <p>
              Each (rail, payment method) pair is an arm with a Beta(α, β) belief about its success rate. Every attempt outcome the
              orchestrator reports adds to α (success) or β (declined or unavailable). Unknown outcomes (no usable bank answer yet) are not
              counted, since the charge may still succeed.
            </p>
            <p>
              Ranking is greedy: most payments try the rail with the highest expected success first. On a small share (3% by default,{' '}
              <span className="font-mono">AI_ROUTER_EXPLORE_RATE</span>) the router explores instead, ranking by one Thompson sample per
              rail, so a rail that was avoided gets tried again. With a trained model loaded, its prediction is blended in (30% by default)
              and the strategy gets a <span className="font-mono">+model</span> suffix.
            </p>
            <p>
              The bandit forgets: older evidence is discounted on each update (×0.995 by default) and halves every hour (3600 s), so a rail
              that had a bad spell drifts back towards &quot;unknown&quot;, gets explored and wins its traffic back once it recovers.
            </p>
            <p>
              The orchestrator asks for the rail order on every payment with a 150 ms deadline. If the router is down, slow or disabled it
              uses the configured order ({PROVIDERS.join(', ')}), and the router can only reorder rails, never add or drop one. Rails
              with an open circuit breaker are skipped either way.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArmRow({ arm }: { arm: Arm }) {
  return (
    <tr className="hover:bg-slate-800/30">
      <td className="px-4 py-2">
        <span className="text-slate-200 font-semibold">{providerName(arm.provider)}</span>
        <span className="text-[10px] text-slate-500 ml-1.5">{arm.provider}</span>
      </td>
      <td className="px-4 py-2 text-slate-300">{arm.payment_method.toUpperCase()}</td>
      <td className="px-4 py-2 text-right text-emerald-400">{arm.alpha.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-rose-300">{arm.beta.toFixed(2)}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800/80">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                arm.expected_success >= 0.8 ? 'bg-emerald-500' : arm.expected_success >= 0.5 ? 'bg-amber-500' : 'bg-rose-500'
              }`}
              style={{ width: `${Math.min(Math.max(arm.expected_success * 100, 0), 100)}%` }}
            />
          </div>
          <span className="text-white font-bold w-14 text-right">{pct(arm.expected_success)}</span>
        </div>
      </td>
      <td className="px-4 py-2 text-right text-slate-300">{arm.observations.toLocaleString()}</td>
    </tr>
  );
}

function MetricEntry({ name, value }: { name: string; value: unknown }) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return (
      <div className="space-y-1">
        <dt className="text-slate-400">{name}</dt>
        <dd className="pl-3 space-y-1 border-l border-slate-800">
          {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <span className="text-slate-500">{providerName(k)}</span>
              <span className="text-slate-200">{formatMetric(v)}</span>
            </div>
          ))}
        </dd>
      </div>
    );
  }
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-400">{name}</dt>
      <dd className="text-white font-bold">{formatMetric(value)}</dd>
    </div>
  );
}

function formatMetric(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function MetricCard({ label, value, hint, tone, small }: { label: string; value: string; hint: string; tone: string; small?: boolean }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl min-w-0">
      <span className="text-[10px] text-slate-400 uppercase font-mono block">{label}</span>
      <span className={`${small ? 'text-sm font-mono break-all' : 'text-2xl'} font-extrabold ${tone} block`}>{value}</span>
      <span className="text-[10px] text-slate-500 block mt-1">{hint}</span>
    </div>
  );
}

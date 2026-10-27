'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TrendingUp,
  CircleCheck,
  RotateCcw,
  CreditCard,
  RefreshCw,
  Activity,
  Layers,
  ArrowUpRight,
  Receipt,
  Wallet,
  TriangleAlert,
  Inbox,
} from 'lucide-react';
import {
  GatewayError,
  PROVIDERS,
  PROVIDER_NAMES,
  formatInr,
  loadKeys,
  onKeysChanged,
  orchestrator,
  type MerchantAnalytics,
} from '@/lib/gateway';

const POLL_INTERVAL_MS = 10000;

const STATUS_ORDER = ['created', 'authorized', 'captured', 'refunded', 'failed'] as const;
const STATUS_COLORS: Record<string, string> = {
  created: 'bg-slate-500',
  authorized: 'bg-blue-500',
  captured: 'bg-emerald-500',
  refunded: 'bg-rose-500',
  failed: 'bg-red-600',
};
const STATUS_HINTS: Record<string, string> = {
  created: 'in progress',
  authorized: 'approved, awaiting capture',
  captured: 'settled to merchant',
  refunded: 'fully refunded',
  failed: 'declined or no rail available',
};

const METHOD_ORDER = ['upi', 'card', 'netbanking'] as const;
const METHOD_LABELS: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking' };

interface LoadError {
  message: string;
  network: boolean;
}

function toLoadError(e: unknown): LoadError {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

/** Preferred keys first (shown even when zero), then any other keys the API returned, alphabetically. */
function orderedEntries(record: Record<string, number>, preferred: readonly string[]): [string, number][] {
  const extra = Object.keys(record)
    .filter((k) => preferred.indexOf(k) < 0)
    .sort();
  return preferred.concat(extra).map((k): [string, number] => [k, record[k] ?? 0]);
}

const pct = (part: number, total: number): number => (total > 0 ? (part / total) * 100 : 0);

interface BreakdownRow {
  key: string;
  label: string;
  hint?: string;
  count: number;
  color: string;
}

function Breakdown({ title, caption, rows, total }: { title: string; caption: string; rows: BreakdownRow[]; total: number }) {
  return (
    <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl space-y-4">
      <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{title}</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">{caption}</p>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const share = pct(row.count, total);
          return (
            <div key={row.key} className="space-y-1.5">
              <div className="flex justify-between gap-2 text-xs font-medium">
                <span className="text-slate-300 font-semibold truncate">
                  {row.label}
                  {row.hint && <span className="ml-1.5 text-[10px] font-mono font-normal text-slate-500">{row.hint}</span>}
                </span>
                <span className="text-slate-400 font-mono whitespace-nowrap">
                  {row.count} ({Math.round(share)}%)
                </span>
              </div>
              <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden">
                <div className={`h-full ${row.color} rounded-full transition-all`} style={{ width: `${share}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface AnalyticsDashboardProps {
  /** Ignored. Analytics always cover the sandbox merchant whose API keys the dashboard holds. */
  merchantId?: string;
}

export default function AnalyticsDashboard(_props: AnalyticsDashboardProps) {
  const [data, setData] = useState<MerchantAnalytics | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);

  const mounted = useRef(true);
  const inFlight = useRef(false);

  const fetchAnalytics = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsLoading(true);
    try {
      const result = await orchestrator.analytics();
      if (!mounted.current) return;
      setData(result);
      setError(null);
      setLastRefreshed(new Date());
      setMerchantId(loadKeys()?.merchantId ?? null);
    } catch (e) {
      if (mounted.current) setError(toLoadError(e));
    } finally {
      inFlight.current = false;
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchAnalytics();
    const interval = setInterval(() => void fetchAnalytics(), POLL_INTERVAL_MS);
    const unsubscribe = onKeysChanged(() => {
      setMerchantId(loadKeys()?.merchantId ?? null);
      void fetchAnalytics();
    });
    return () => {
      mounted.current = false;
      clearInterval(interval);
      unsubscribe();
    };
  }, [fetchAnalytics]);

  const successRate = data?.success_rate ?? 0;
  const inProgress = data?.count_by_status?.created ?? 0;

  const methodRows: BreakdownRow[] = data
    ? orderedEntries(data.count_by_method ?? {}, METHOD_ORDER).map(([method, count]) => ({
        key: method,
        label: METHOD_LABELS[method] ?? method,
        count,
        color: 'bg-indigo-500',
      }))
    : [];

  const statusRows: BreakdownRow[] = data
    ? orderedEntries(data.count_by_status ?? {}, STATUS_ORDER).map(([status, count]) => ({
        key: status,
        label: status,
        hint: STATUS_HINTS[status],
        count,
        color: STATUS_COLORS[status] ?? 'bg-slate-500',
      }))
    : [];

  const providerRows: BreakdownRow[] = data
    ? orderedEntries(data.successful_by_provider ?? {}, PROVIDERS).map(([provider, count]) => ({
        key: provider,
        label: PROVIDER_NAMES[provider] ?? provider,
        hint: provider,
        count,
        color: 'bg-blue-500',
      }))
    : [];

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-indigo-400" /> Merchant Business Analytics & Insights
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Live totals from <span className="font-mono text-slate-300">GET /v1/analytics</span> for the sandbox merchant
            {merchantId ? (
              <>
                {' '}
                <span className="font-mono text-indigo-300 font-bold">{merchantId}</span>
              </>
            ) : null}
            . Amounts are in rupees; refreshes every {POLL_INTERVAL_MS / 1000}s.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[11px] text-slate-500 font-mono">
            {lastRefreshed ? `Updated: ${lastRefreshed.toLocaleTimeString()}` : 'Not loaded yet'}
          </span>
          <button
            onClick={() => void fetchAnalytics()}
            disabled={isLoading}
            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs px-3.5 py-2 rounded-xl border border-slate-700 transition flex items-center gap-1.5 font-semibold"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-rose-950/40 border border-rose-800/60 p-4 rounded-2xl flex items-start gap-3 text-xs">
          <TriangleAlert className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-rose-200 font-semibold">
              {data ? 'Refresh failed; showing the last loaded numbers.' : 'Could not load analytics.'} {error.message}
            </p>
            {error.network && (
              <p className="text-rose-300/80">
                Start the payment orchestrator (services/payment-orchestrator, port 8080). This panel retries every {POLL_INTERVAL_MS / 1000}s.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Initial loading */}
      {!data && !error && (
        <div className="bg-slate-900 border border-slate-800 p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-slate-400">
          <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" /> Loading merchant analytics...
        </div>
      )}

      {/* Empty state */}
      {data && data.payments === 0 && (
        <div className="bg-slate-900 border border-dashed border-slate-700 p-10 rounded-2xl text-center space-y-2">
          <Inbox className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-bold text-slate-300">No payments yet</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            This sandbox merchant has not taken any payments. Run a checkout from the dashboard or the Port 8080 console and the
            numbers appear here on the next refresh.
          </p>
        </div>
      )}

      {data && data.payments > 0 && (
        <>
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Gross volume */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Gross Volume</span>
                <div className="w-8 h-8 rounded-xl bg-indigo-950 border border-indigo-800 text-indigo-400 flex items-center justify-center">
                  <span className="font-bold text-xs">₹</span>
                </div>
              </div>
              <div className="mt-4">
                <h3 className="text-2xl font-extrabold text-white tracking-tight">{formatInr(data.gross_volume)}</h3>
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                  <span>{data.successful_payments} bank-approved payments</span>
                </p>
              </div>
            </div>

            {/* Captured volume */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Captured Volume</span>
                <div className="w-8 h-8 rounded-xl bg-emerald-950 border border-emerald-800 text-emerald-400 flex items-center justify-center">
                  <CircleCheck className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-4">
                <h3 className="text-2xl font-extrabold text-emerald-400 tracking-tight">{formatInr(data.captured_volume)}</h3>
                <p className="text-[11px] text-slate-400 mt-1">
                  {Math.round(pct(data.captured_volume, data.gross_volume))}% of gross volume captured
                </p>
              </div>
            </div>

            {/* Success rate */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Payment Success Rate</span>
                <div className="w-8 h-8 rounded-xl bg-blue-950 border border-blue-800 text-blue-400 flex items-center justify-center">
                  <Activity className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-4">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-2xl font-extrabold text-white tracking-tight">{successRate.toFixed(1)}%</h3>
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                      successRate >= 90
                        ? 'bg-emerald-950 text-emerald-400'
                        : successRate >= 70
                          ? 'bg-amber-950 text-amber-400'
                          : 'bg-rose-950 text-rose-400'
                    }`}
                  >
                    {successRate >= 90 ? 'Healthy' : successRate >= 70 ? 'Degraded' : 'Investigate'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {data.successful_payments} approved / {data.failed_payments} failed (in-progress excluded)
                </p>
              </div>
            </div>

            {/* Net settlement */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">Net Settlement</span>
                <div className="w-8 h-8 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400 flex items-center justify-center">
                  <Wallet className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-4">
                <h3 className="text-2xl font-extrabold text-cyan-300 tracking-tight">{formatInr(data.net_settlement)}</h3>
                <p className="text-[11px] text-slate-400 mt-1">Captured − refunded − fees</p>
              </div>
            </div>
          </div>

          {/* Secondary Metrics Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5 text-rose-400" />
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-400">Refunded Volume</span>
                <h4 className="text-lg font-bold text-rose-400">{formatInr(data.refunded_volume)}</h4>
                <span className="text-[11px] font-mono text-slate-500">{data.count_by_status?.refunded ?? 0} fully refunded</span>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0">
                <Receipt className="w-5 h-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-400">Fees (incl. GST)</span>
                <h4 className="text-lg font-bold text-white">{formatInr(data.fees)}</h4>
                <span className="text-[11px] font-mono text-slate-500">of which GST {formatInr(data.taxes)}</span>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0">
                <CreditCard className="w-5 h-5 text-indigo-400" />
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-400">Average Payment</span>
                <h4 className="text-lg font-bold text-white">{formatInr(data.average_payment_value)}</h4>
                <span className="text-[11px] font-mono text-slate-500">per approved payment</span>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0">
                <Layers className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="min-w-0">
                <span className="text-xs text-slate-400">Payments</span>
                <h4 className="text-lg font-bold text-white">{data.payments.toLocaleString('en-IN')} total</h4>
                <span className="text-[11px] font-mono text-slate-500">{inProgress} in progress</span>
              </div>
            </div>
          </div>

          {/* Breakdown Grids */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Breakdown title="Payments by Method" caption={`Share of all ${data.payments} payments`} rows={methodRows} total={data.payments} />
            <Breakdown title="Payments by Status" caption={`Share of all ${data.payments} payments`} rows={statusRows} total={data.payments} />
            <Breakdown
              title="Successful Payments by Rail"
              caption={`Share of ${data.successful_payments} approved payments, by the provider rail that processed them`}
              rows={providerRows}
              total={data.successful_payments}
            />
          </div>
        </>
      )}
    </div>
  );
}

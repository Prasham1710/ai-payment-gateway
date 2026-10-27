'use client';

import { useState } from 'react';
import { ExternalLink, Info, Play, Server, Terminal } from 'lucide-react';
import PreviewBadge from '@/components/ui/PreviewBadge';

/** External tool from a separate compose project; linked only, never called by the dashboard. */
const PROMETHEUS_URL = 'http://localhost:9090';

interface PlannedTarget {
  endpoint: string;
  service: string;
  port: number;
  note: string;
}

interface SampleOutput {
  metric: string;
  data: Record<string, string | number>[];
}

// None of these endpoints exist yet; they are what a metrics phase would add.
const PLANNED_TARGETS: PlannedTarget[] = [
  { endpoint: '/actuator/prometheus', service: 'Payment Orchestrator', port: 8080, note: 'needs Micrometer Prometheus registry' },
  { endpoint: '/metrics', service: 'Bank Simulator', port: 8081, note: 'no metrics handler yet' },
  { endpoint: '/metrics', service: 'AI Router', port: 8000, note: 'no metrics endpoint yet' },
  { endpoint: 'postgres-exporter', service: 'PostgreSQL', port: 5432, note: 'exporter not deployed' },
];

function sampleOutputFor(query: string): SampleOutput {
  if (query.includes('latency')) {
    return {
      metric: 'p95_latency_ms (sample)',
      data: [
        { t: '-2m30s', value: 124 },
        { t: '-2m', value: 135 },
        { t: '-1m30s', value: 128 },
        { t: '-1m', value: 142 },
        { t: '-30s', value: 130 },
        { t: 'now', value: 126 },
      ],
    };
  }
  if (query.includes('circuit')) {
    return {
      metric: 'circuit_breaker_state (sample)',
      data: [
        { provider: 'provider-a', state: '0 (CLOSED)' },
        { provider: 'provider-b', state: '0 (CLOSED)' },
        { provider: 'provider-c', state: '0 (CLOSED)' },
      ],
    };
  }
  return {
    metric: 'payment_requests_rate_tps (sample)',
    data: [
      { t: '-2m30s', value: 48.2 },
      { t: '-2m', value: 54.1 },
      { t: '-1m30s', value: 62.5 },
      { t: '-1m', value: 58.0 },
      { t: '-30s', value: 71.3 },
      { t: 'now', value: 65.4 },
    ],
  };
}

const DEFAULT_QUERY = 'rate(payment_requests_total[1m])';

export default function Port9090Prometheus() {
  const [promQuery, setPromQuery] = useState(DEFAULT_QUERY);
  const [queryOutput, setQueryOutput] = useState<SampleOutput>(() => sampleOutputFor(DEFAULT_QUERY));

  const handleRunQuery = (presetQuery?: string) => {
    const q = presetQuery || promQuery;
    if (presetQuery) setPromQuery(presetQuery);
    setQueryOutput(sampleOutputFor(q));
  };

  return (
    <div className="space-y-6">
      <PreviewBadge note="Prometheus is not scraping the gateway yet: no gateway service exposes a metrics endpoint. Gauges, query results and targets below are sample data." />

      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-600 to-rose-600 flex items-center justify-center text-white shadow-lg shadow-amber-600/20 font-mono font-bold text-xl">
            9090
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Prometheus Metrics</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-amber-700/60 bg-amber-950/80 text-amber-300 font-semibold">
                PromQL · not scraping yet
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Design preview of gateway metrics and PromQL queries. A Prometheus on :9090, if one is running on this machine, belongs to a
              separate compose project.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={PROMETHEUS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition border border-slate-700"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Prometheus :9090 (external tool)
          </a>
          <a
            href={`${PROMETHEUS_URL}/targets`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-xl text-xs font-bold transition border border-slate-700"
          >
            <ExternalLink className="w-3.5 h-3.5" /> /targets (external tool)
          </a>
          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs font-mono text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <span>NOT SCRAPING GATEWAY</span>
          </div>
        </div>
      </div>

      {/* WHERE LIVE NUMBERS ARE TODAY */}
      <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-start gap-3 text-xs text-slate-400">
        <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-px" />
        <p>
          Live numbers today come from the gateway APIs: merchant analytics (<span className="font-mono text-slate-300">GET /v1/analytics</span>),
          rail circuit breakers (<span className="font-mono text-slate-300">GET /ops/circuit-breakers</span>) and the AI router&apos;s beliefs (
          <span className="font-mono text-slate-300">GET /v1/stats</span> on :8000). See the main dashboard and the :8000 console.
        </p>
      </div>

      {/* TOP TELEMETRY GAUGES (SAMPLE) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-[10px] text-slate-500 block uppercase">SYSTEM THROUGHPUT (SAMPLE)</span>
          <span className="text-2xl font-black text-white">
            65.4 <span className="text-xs font-normal text-slate-400">TPS</span>
          </span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-[10px] text-slate-500 block uppercase">P95 LATENCY (SAMPLE)</span>
          <span className="text-2xl font-black text-amber-400">
            126 <span className="text-xs font-normal text-slate-400">ms</span>
          </span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-[10px] text-slate-500 block uppercase">CIRCUIT BREAKERS (SAMPLE)</span>
          <span className="text-2xl font-black text-emerald-400">
            3 / 3 <span className="text-xs font-normal text-slate-400">CLOSED</span>
          </span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-[10px] text-slate-500 block uppercase">ERROR RATE (SAMPLE)</span>
          <span className="text-2xl font-black text-emerald-400">0.04%</span>
        </div>
      </div>

      {/* TWO COLUMN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: PROMQL CONSOLE */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-400" /> PromQL Console (sample output)
            </h3>
            <span className="text-[11px] font-mono text-slate-400">not sent to Prometheus</span>
          </div>

          {/* Preset Chips */}
          <div className="flex flex-wrap gap-2 text-[11px] font-mono">
            <button
              type="button"
              onClick={() => handleRunQuery('rate(payment_requests_total[1m])')}
              className="px-2.5 py-1 bg-slate-950 hover:bg-slate-800 text-amber-300 rounded-lg border border-slate-800 transition"
            >
              rate(payment_requests_total)
            </button>
            <button
              type="button"
              onClick={() => handleRunQuery('histogram_quantile(0.95, payment_latency_ms)')}
              className="px-2.5 py-1 bg-slate-950 hover:bg-slate-800 text-purple-300 rounded-lg border border-slate-800 transition"
            >
              p95_latency_ms
            </button>
            <button
              type="button"
              onClick={() => handleRunQuery('circuit_breaker_state')}
              className="px-2.5 py-1 bg-slate-950 hover:bg-slate-800 text-emerald-300 rounded-lg border border-slate-800 transition"
            >
              circuit_breaker_state
            </button>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              aria-label="PromQL query"
              value={promQuery}
              onChange={(e) => setPromQuery(e.target.value)}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-amber-300 outline-none focus:ring-2 focus:ring-amber-500"
            />
            <button
              type="button"
              onClick={() => handleRunQuery()}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 transition shadow"
            >
              <Play className="w-3.5 h-3.5" />
              Query
            </button>
          </div>

          {/* Query Output */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs space-y-2">
            <div className="flex justify-between text-[11px] text-slate-500 border-b border-slate-800 pb-1">
              <span>METRIC: {queryOutput.metric}</span>
              <span className="text-amber-400">SAMPLE DATA</span>
            </div>
            <pre className="text-amber-300 text-[11px] max-h-48 overflow-y-auto">{JSON.stringify(queryOutput.data, null, 2)}</pre>
          </div>
        </div>

        {/* RIGHT COLUMN: PLANNED SCRAPE TARGETS */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-rose-400" /> Planned Scrape Targets
            </h3>
            <span className="text-[11px] font-mono text-slate-400">none configured</span>
          </div>

          <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden text-xs font-mono">
            {PLANNED_TARGETS.map((t) => (
              <div key={t.port} className="p-3 bg-slate-950/60 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white">{t.service}</span>
                    <span className="text-[10px] text-slate-500">:{t.port}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 block truncate">
                    {t.endpoint} · {t.note}
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-400 border border-slate-700 shrink-0">
                  PLANNED
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

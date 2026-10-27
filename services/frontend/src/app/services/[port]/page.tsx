'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Server, Radio, Cpu, ShieldAlert, Database, Zap, Layers, BarChart3 } from 'lucide-react';

import Port8080Orchestrator from '@/components/services/Port8080Orchestrator';
import Port8081BankSimulator from '@/components/services/Port8081BankSimulator';
import Port8000AiRouter from '@/components/services/Port8000AiRouter';
import Port8002FraudDetector from '@/components/services/Port8002FraudDetector';
import Port5432Postgres from '@/components/services/Port5432Postgres';
import Port6380Redis from '@/components/services/Port6380Redis';
import Port9092Kafka from '@/components/services/Port9092Kafka';
import Port9090Prometheus from '@/components/services/Port9090Prometheus';

/**
 * live: a real service the dashboard calls. preview / planned: the console is a simulated preview
 * (the component says so with a PreviewBadge).
 */
type ServiceStatus = 'live' | 'preview' | 'planned';

const servicePorts: { port: string; name: string; tag: string; status: ServiceStatus; icon: typeof Server; color: string }[] = [
  { port: '8080', name: 'Orchestrator', tag: 'Java 17 / Spring Boot', status: 'live', icon: Server, color: 'text-indigo-400' },
  { port: '8081', name: 'Bank Simulator', tag: 'Go', status: 'live', icon: Radio, color: 'text-cyan-400' },
  { port: '8000', name: 'AI Router', tag: 'FastAPI', status: 'live', icon: Cpu, color: 'text-purple-400' },
  { port: '5432', name: 'PostgreSQL', tag: 'Postgres 16', status: 'live', icon: Database, color: 'text-blue-400' },
  { port: '8002', name: 'Fraud Detector', tag: 'planned', status: 'planned', icon: ShieldAlert, color: 'text-rose-400' },
  { port: '6380', name: 'Redis', tag: 'not used yet', status: 'preview', icon: Zap, color: 'text-red-400' },
  { port: '9092', name: 'Kafka', tag: 'roadmap', status: 'planned', icon: Layers, color: 'text-amber-400' },
  { port: '9090', name: 'Prometheus', tag: 'not scraping yet', status: 'preview', icon: BarChart3, color: 'text-orange-400' },
];

export default function ServicePortPage() {
  const params = useParams();
  const port = Array.isArray(params?.port) ? params.port[0] : params?.port || '8080';
  const current = servicePorts.find((sp) => sp.port === port);

  const renderComponent = () => {
    switch (port) {
      case '8080':
        return <Port8080Orchestrator />;
      case '8081':
        return <Port8081BankSimulator />;
      case '8000':
        return <Port8000AiRouter />;
      case '8002':
        return <Port8002FraudDetector />;
      case '5432':
        return <Port5432Postgres />;
      case '6380':
      case '5540': // RedisInsight is an external tool; old links land on the Redis console, which links to it
        return <Port6380Redis />;
      case '9092':
        return <Port9092Kafka />;
      case '9090':
        return <Port9090Prometheus />;
      default:
        return (
          <div className="p-12 text-center text-slate-400">
            <h2 className="text-xl font-bold text-white mb-2">Unknown Service Port: {port}</h2>
            <p className="text-sm">Please select a registered service port from the directory above.</p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* TOP HEADER */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl border border-slate-700 transition font-bold"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Gateway
          </Link>
          <div className="h-6 w-px bg-slate-800" />
          <h1 className="font-extrabold text-base tracking-tight text-white flex items-center gap-2">
            {current ? current.name : 'Service Console'}{' '}
            <span className="text-[11px] bg-indigo-950 text-indigo-400 border border-indigo-800 px-2 py-0.5 rounded-full font-mono">Port {port}</span>
            {current && (
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-mono border ${
                  current.status === 'live'
                    ? 'bg-slate-800 text-slate-300 border-slate-700'
                    : 'bg-amber-950/60 text-amber-300 border-amber-800/70'
                }`}
              >
                {current.tag}
              </span>
            )}
          </h1>
        </div>

        <div className="text-xs font-mono text-slate-400">
          AI Payment Gateway Infrastructure
        </div>
      </header>

      {/* HORIZONTAL PORT SWITCHER BAR */}
      <div className="bg-slate-900/60 border-b border-slate-800 px-6 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mr-2 whitespace-nowrap">
          ALL PORTS:
        </span>
        {servicePorts.map((sp) => {
          const Icon = sp.icon;
          const isActive = sp.port === port;
          return (
            <Link
              key={sp.port}
              href={`/services/${sp.port}`}
              title={`${sp.name} · ${sp.tag}${sp.status === 'live' ? '' : ' (simulated preview)'}`}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-mono transition whitespace-nowrap border ${
                isActive
                  ? 'bg-slate-800 border-indigo-500 text-white font-bold shadow'
                  : 'bg-slate-950/80 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${sp.color}`} />
              <span>:{sp.port}</span>
              <span className="text-[10px] text-slate-500">({sp.name})</span>
              {sp.status !== 'live' && <span className="text-[9px] uppercase tracking-wider text-amber-400/80">{sp.tag}</span>}
            </Link>
          );
        })}
      </div>

      {/* MAIN CONTAINER */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {renderComponent()}
      </main>
    </div>
  );
}

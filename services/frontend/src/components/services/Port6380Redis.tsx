'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, Copy, Database, ExternalLink, Key, Lock, Unlock } from 'lucide-react';
import PreviewBadge from '@/components/ui/PreviewBadge';

/** External tool from a separate compose project; linked only, never called by the dashboard. */
const REDIS_INSIGHT_URL = 'http://localhost:5540';
const REDIS_URI = 'redis://localhost:6380';

interface RedisKeyItem {
  key: string;
  type: 'string' | 'hash' | 'set';
  ttl: number; // seconds (-1 = infinite)
  value: string;
  category: 'lock' | 'idempotency' | 'velocity' | 'circuit';
}

// Example keys showing how a future phase could use Redis. Nothing writes these today.
const EXAMPLE_KEYS: RedisKeyItem[] = [
  {
    key: 'idemp:merch_demo:dash_lx2k9a_4f1c2d',
    type: 'string',
    ttl: 86320,
    value: JSON.stringify({ payment_id: 'pay_XXXXXXXXXXXXXX', status: 'captured', amount: 149900, provider: 'provider-a' }, null, 2),
    category: 'idempotency',
  },
  {
    key: 'fraud:velocity:vpa:alice@upi',
    type: 'string',
    ttl: 42,
    value: '2',
    category: 'velocity',
  },
  {
    key: 'circuit:state:provider-a',
    type: 'string',
    ttl: -1,
    value: 'CLOSED',
    category: 'circuit',
  },
  {
    key: 'circuit:state:provider-b',
    type: 'string',
    ttl: -1,
    value: 'CLOSED',
    category: 'circuit',
  },
];

export default function Port6380Redis() {
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'lock' | 'idempotency' | 'velocity' | 'circuit'>('all');
  const [copiedUri, setCopiedUri] = useState(false);

  // Distributed Lock Simulator State
  const [lockKey, setLockKey] = useState('lock:payment:idemp_demo_9921');
  const [lockOwner, setLockOwner] = useState('node-pod-alpha');
  const [lockTtl, setLockTtl] = useState(10);
  const [isLocked, setIsLocked] = useState(false);
  const [currentLockHolder, setCurrentLockHolder] = useState<string | null>(null);
  const [lockRemainingTtl, setLockRemainingTtl] = useState<number>(0);
  const [collisionAttemptMessage, setCollisionAttemptMessage] = useState<string | null>(null);

  const [keys, setKeys] = useState<RedisKeyItem[]>(EXAMPLE_KEYS);
  const [activeKeyInspection, setActiveKeyInspection] = useState<RedisKeyItem | null>(EXAMPLE_KEYS[0]);

  // Lock TTL countdown timer
  useEffect(() => {
    if (!isLocked || lockRemainingTtl <= 0) return;
    const timer = setInterval(() => {
      setLockRemainingTtl((prev) => {
        if (prev <= 1) {
          setIsLocked(false);
          setCurrentLockHolder(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isLocked, lockRemainingTtl]);

  const handleAcquireLock = () => {
    if (isLocked) {
      setCollisionAttemptMessage(`LOCK REJECTED: "${lockKey}" is already held by [${currentLockHolder}].`);
      return;
    }
    setIsLocked(true);
    setCurrentLockHolder(lockOwner);
    setLockRemainingTtl(lockTtl);
    setCollisionAttemptMessage(null);

    const newLockItem: RedisKeyItem = {
      key: lockKey,
      type: 'string',
      ttl: lockTtl,
      value: `LOCK_TOKEN_${Date.now()}_${lockOwner}`,
      category: 'lock',
    };
    setKeys((prev) => [newLockItem, ...prev.filter((k) => k.key !== lockKey)]);
    setActiveKeyInspection(newLockItem);
  };

  const handleReleaseLock = () => {
    setIsLocked(false);
    setCurrentLockHolder(null);
    setLockRemainingTtl(0);
    setCollisionAttemptMessage('Lock released (simulated compare-and-delete Lua script).');
    setKeys((prev) => prev.filter((k) => k.key !== lockKey));
  };

  const handleSimulateCollision = () => {
    if (isLocked) {
      setCollisionAttemptMessage(
        `CONCURRENT COLLISION: [node-pod-beta] tried SET NX on "${lockKey}" and was rejected; only [${currentLockHolder}] holds the lock.`,
      );
    } else {
      setCollisionAttemptMessage('The lock is free. Acquire it first, then test a collision.');
    }
  };

  const copyUri = async () => {
    try {
      await navigator.clipboard.writeText(REDIS_URI);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 2000);
    } catch {
      setCopiedUri(false);
    }
  };

  const filteredKeys = selectedFilter === 'all' ? keys : keys.filter((k) => k.category === selectedFilter);

  return (
    <div className="space-y-6">
      <PreviewBadge note="Redis runs at :6380 but the gateway does not use it yet (reserved for a future phase); idempotency is enforced in PostgreSQL. The lock console and keys below are simulated in this page." />

      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-red-500 to-amber-600 flex items-center justify-center text-white shadow-lg shadow-red-500/20 font-mono font-bold text-xl">
            6380
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Redis Cache & Lock Engine</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-red-700/60 bg-red-950/80 text-red-300 font-semibold">
                Redis 7 · reserved
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Design preview of distributed locks (SET NX), an idempotency cache and velocity counters in Redis. Not part of the payment
              flow today.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={REDIS_INSIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition border border-slate-700"
          >
            <ExternalLink className="w-3.5 h-3.5" /> RedisInsight :5540 (external tool)
          </a>
          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs font-mono text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <span>NOT USED BY GATEWAY YET</span>
          </div>
        </div>
      </div>

      {/* HOW IT WORKS TODAY + CONNECTION INFO */}
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-slate-900 border border-slate-800 p-4 rounded-2xl gap-3 text-xs">
        <div className="flex items-start gap-2 text-slate-400">
          <Database className="w-4 h-4 text-blue-400 shrink-0 mt-px" />
          <p>
            Today: the <span className="font-mono text-slate-300">Idempotency-Key</span> header is stored on the payment or refund row,
            with a unique (merchant_id, idempotency_key) index in PostgreSQL. Circuit-breaker state lives in the orchestrator&apos;s memory.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 shrink-0">
          <span>
            Redis: <strong className="text-white">localhost:6380</strong>
          </span>
          <button
            type="button"
            onClick={() => void copyUri()}
            className="flex items-center gap-1 text-[10px] bg-slate-950 px-2 py-1 rounded border border-slate-800 hover:text-white transition"
          >
            <Copy className="w-3 h-3" /> {copiedUri ? 'Copied!' : 'Copy URI'}
          </button>
        </div>
      </div>

      {/* DISTRIBUTED LOCK & IDEMPOTENCY CONSOLE (SIMULATED) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: DISTRIBUTED LOCK SIMULATOR */}
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-amber-400" /> Distributed Lock Simulator (SET NX + Lua Release)
            </h3>
            <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800 whitespace-nowrap">
              SET key val NX EX ttl
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Simulates how pods could take a lock before charging, so concurrent retries of one payment never charge twice. Runs only in
            this page.
          </p>

          <div className="space-y-4 text-xs">
            <div>
              <label htmlFor="lock-key" className="block font-semibold text-slate-300 mb-1">
                Lock Key (Idempotency Target)
              </label>
              <input
                id="lock-key"
                type="text"
                value={lockKey}
                onChange={(e) => setLockKey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="lock-owner" className="block font-semibold text-slate-300 mb-1">
                  Lock Owner (Cluster Node)
                </label>
                <input
                  id="lock-owner"
                  type="text"
                  value={lockOwner}
                  onChange={(e) => setLockOwner(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-amber-500 outline-none"
                />
              </div>
              <div>
                <label htmlFor="lock-ttl" className="block font-semibold text-slate-300 mb-1">
                  Lock Lease TTL (Seconds)
                </label>
                <input
                  id="lock-ttl"
                  type="number"
                  min="1"
                  value={lockTtl}
                  onChange={(e) => setLockTtl(parseInt(e.target.value, 10) || 5)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono font-bold focus:ring-2 focus:ring-amber-500 outline-none"
                />
              </div>
            </div>

            {/* Lock Status Card */}
            <div
              className={`p-4 rounded-xl border transition ${
                isLocked ? 'bg-amber-950/30 border-amber-800/80 text-amber-200' : 'bg-slate-950 border-slate-800 text-slate-400'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono font-bold">
                  {isLocked ? <Lock className="w-4 h-4 text-amber-400" /> : <Unlock className="w-4 h-4 text-slate-500" />}
                  <span>{isLocked ? `LOCKED BY [${currentLockHolder}]` : 'UNLOCKED (KEY FREE)'}</span>
                </div>
                {isLocked && (
                  <span className="text-xs font-mono font-bold bg-amber-900/60 px-2 py-0.5 rounded border border-amber-700 text-amber-300">
                    TTL: {lockRemainingTtl}s
                  </span>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={handleAcquireLock}
                disabled={isLocked}
                className="py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-1.5 shadow"
              >
                <Lock className="w-3.5 h-3.5" /> Acquire Lock
              </button>
              <button
                type="button"
                onClick={handleSimulateCollision}
                className="py-2.5 bg-rose-900/80 hover:bg-rose-800 border border-rose-700 text-rose-200 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1.5 shadow"
              >
                <AlertTriangle className="w-3.5 h-3.5" /> Test Collision
              </button>
              <button
                type="button"
                onClick={handleReleaseLock}
                disabled={!isLocked}
                className="py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1.5 border border-slate-700 shadow"
              >
                <Unlock className="w-3.5 h-3.5" /> Release Lock
              </button>
            </div>

            {collisionAttemptMessage && (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-amber-300">
                {collisionAttemptMessage}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: KEY BROWSER & VALUE VIEWER */}
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-red-400" /> Example Key Layout
            </h3>
            <span className="text-[11px] font-mono text-slate-400">illustrative, not read from Redis</span>
          </div>

          {/* Filter Tabs */}
          <div className="flex flex-wrap gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-[11px] font-mono">
            {(['all', 'lock', 'idempotency', 'velocity', 'circuit'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setSelectedFilter(filter)}
                className={`px-2.5 py-1 rounded-lg capitalize transition ${
                  selectedFilter === filter ? 'bg-red-600 text-white font-bold' : 'text-slate-400 hover:text-white'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>

          {/* Key List */}
          <div className="border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800 max-h-48 overflow-y-auto">
            {filteredKeys.length === 0 ? (
              <p className="p-4 text-center text-xs text-slate-500">No example keys in this category.</p>
            ) : (
              filteredKeys.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveKeyInspection(item)}
                  className={`w-full text-left p-3 flex items-center justify-between cursor-pointer transition text-xs font-mono ${
                    activeKeyInspection?.key === item.key ? 'bg-red-950/30' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div>
                    <span className="font-bold text-slate-200 block">{item.key}</span>
                    <span className="text-[10px] text-slate-500 uppercase">
                      {item.type} | {item.category}
                    </span>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                      item.ttl > 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.ttl > 0 ? `TTL: ${item.ttl}s` : 'PERSISTENT'}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Key Inspector */}
          {activeKeyInspection && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-slate-400 font-semibold">Value: {activeKeyInspection.key}</span>
                <span className="text-[10px] text-slate-500">TYPE: {activeKeyInspection.type.toUpperCase()}</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-amber-300 max-h-40 overflow-y-auto">
                <pre>{activeKeyInspection.value}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import { Database, ExternalLink, Layers, Plus, Radio, Repeat } from 'lucide-react';
import PreviewBadge from '@/components/ui/PreviewBadge';
import { WEBHOOK_EVENTS } from '@/lib/gateway';

/** External tool from a separate compose project; linked only, never called by the dashboard. */
const REDPANDA_CONSOLE_URL = 'http://localhost:8085';

type Topic = 'payment-events' | 'routing-metrics' | 'reconciliation-dlq';

interface KafkaMessage {
  id: string;
  topic: Topic;
  partition: number;
  offset: number;
  key: string;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const TOPICS: { name: Topic; partitions: number; retention: string; description: string }[] = [
  { name: 'payment-events', partitions: 3, retention: '7 Days', description: 'Planned: payment lifecycle events (initiated, routed, charged, settled)' },
  { name: 'routing-metrics', partitions: 3, retention: '3 Days', description: 'Planned: per-attempt rail telemetry for routing and dashboards' },
  { name: 'reconciliation-dlq', partitions: 1, retention: '30 Days', description: 'Planned: dead-letter queue for bank status mismatches' },
];

// Example records only: nothing in the gateway produces to Kafka today.
const EXAMPLE_MESSAGES: KafkaMessage[] = [
  {
    id: 'msg_001',
    topic: 'payment-events',
    partition: 1,
    offset: 1042,
    key: 'pay_XXXXXXXXXXXXXX',
    eventType: 'PaymentInitiatedEvent',
    timestamp: '2026-01-01T10:00:00.000Z',
    payload: { payment_id: 'pay_XXXXXXXXXXXXXX', amount: 149900, method: 'upi', merchant_id: 'merch_XXXXXXXXXXXXXX' },
  },
  {
    id: 'msg_002',
    topic: 'payment-events',
    partition: 1,
    offset: 1043,
    key: 'pay_XXXXXXXXXXXXXX',
    eventType: 'ProviderRoutingEvent',
    timestamp: '2026-01-01T10:00:00.150Z',
    payload: { payment_id: 'pay_XXXXXXXXXXXXXX', providers: ['provider-a', 'provider-b', 'provider-c'], strategy: 'thompson_sampling' },
  },
  {
    id: 'msg_003',
    topic: 'payment-events',
    partition: 1,
    offset: 1044,
    key: 'pay_XXXXXXXXXXXXXX',
    eventType: 'PaymentCompletedEvent',
    timestamp: '2026-01-01T10:00:00.400Z',
    payload: { payment_id: 'pay_XXXXXXXXXXXXXX', status: 'captured', bank_reference: 'BANKREF_XXXXXXXXXX', latency_ms: 120 },
  },
  {
    id: 'msg_004',
    topic: 'routing-metrics',
    partition: 0,
    offset: 521,
    key: 'provider-a',
    eventType: 'ProviderHealthSample',
    timestamp: '2026-01-01T10:00:05.000Z',
    payload: { provider: 'provider-a', success_rate: 0.96, p95_latency_ms: 120 },
  },
  {
    id: 'msg_005',
    topic: 'reconciliation-dlq',
    partition: 0,
    offset: 12,
    key: 'pay_YYYYYYYYYYYYYY',
    eventType: 'BankTimeoutMismatch',
    timestamp: '2026-01-01T09:59:00.000Z',
    payload: { payment_id: 'pay_YYYYYYYYYYYYYY', error: 'Bank simulator socket timeout', retry_count: 3 },
  },
];

export default function Port9092Kafka() {
  const [selectedTopic, setSelectedTopic] = useState<Topic>('payment-events');

  // Example producer state (local only)
  const [produceTopic, setProduceTopic] = useState<Topic>('payment-events');
  const [produceEventType, setProduceEventType] = useState('PaymentInitiatedEvent');
  const [produceKey, setProduceKey] = useState('pay_example_0001');
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  const [messages, setMessages] = useState<KafkaMessage[]>(EXAMPLE_MESSAGES);
  const [activeMessage, setActiveMessage] = useState<KafkaMessage | null>(EXAMPLE_MESSAGES[0]);

  const handlePublish = (e: React.FormEvent) => {
    e.preventDefault();
    const sameTopic = messages.filter((m) => m.topic === produceTopic);
    const newMsg: KafkaMessage = {
      id: `msg_${Date.now()}`,
      topic: produceTopic,
      partition: 0,
      offset: sameTopic.reduce((max, m) => Math.max(max, m.offset), -1) + 1,
      key: produceKey,
      eventType: produceEventType,
      timestamp: new Date().toISOString(),
      payload: { key: produceKey, event_type: produceEventType, source: 'dashboard-preview' },
    };
    setMessages((prev) => [newMsg, ...prev]);
    setSelectedTopic(produceTopic);
    setActiveMessage(newMsg);
    setPublishMsg(`Added example "${produceEventType}" to ${produceTopic} in this page only; nothing was sent to a broker.`);
  };

  const handleRedriveDlq = () => {
    const dlqCount = messages.filter((m) => m.topic === 'reconciliation-dlq').length;
    setPublishMsg(`Simulated: a re-drive would move ${dlqCount} message(s) from reconciliation-dlq back to payment-events.`);
  };

  const filteredMessages = messages.filter((m) => m.topic === selectedTopic);

  return (
    <div className="space-y-6">
      <PreviewBadge note="Roadmap: the gateway does not use Kafka. Webhook events go through a database outbox (PostgreSQL) today. Topics and messages below are examples in this page." />

      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-lg shadow-amber-500/20 font-mono font-bold text-xl">
            9092
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Kafka Event Stream</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-amber-700/60 bg-amber-950/80 text-amber-300 font-semibold">
                Kafka / Redpanda · roadmap
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Design preview of a future streaming backbone: <span className="font-mono">payment-events</span>,{' '}
              <span className="font-mono">routing-metrics</span> and <span className="font-mono">reconciliation-dlq</span>.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={REDPANDA_CONSOLE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition border border-slate-700"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Redpanda Console :8085 (external tool)
          </a>
          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs font-mono text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <span>NOT INTEGRATED</span>
          </div>
        </div>
      </div>

      {/* WHAT EXISTS TODAY */}
      <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-start gap-3 text-xs text-slate-400">
        <Database className="w-4 h-4 text-blue-400 shrink-0 mt-px" />
        <div className="space-y-2">
          <p>
            Today, events reach merchants as signed webhooks. Each event is written to a PostgreSQL outbox in the same transaction as the
            payment or refund change, and a dispatcher delivers it with retries (see the Webhooks tab on the main dashboard). A broker on
            :9092, if one is running on this machine, belongs to a separate compose project and is not wired to the gateway.
          </p>
          <div className="flex flex-wrap gap-1">
            {WEBHOOK_EVENTS.map((event) => (
              <span key={event} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                {event}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* TOPIC SUMMARY CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {TOPICS.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setSelectedTopic(t.name)}
            className={`text-left p-5 rounded-2xl border cursor-pointer transition shadow-xl space-y-3 ${
              selectedTopic === t.name
                ? 'bg-amber-950/20 border-amber-600/80 ring-1 ring-amber-500/40'
                : 'bg-slate-900 border-slate-800 hover:bg-slate-800/40'
            }`}
          >
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 block">EXAMPLE TOPIC</span>
                <h4 className="font-extrabold text-sm text-white font-mono">{t.name}</h4>
              </div>
              <span className="text-[10px] font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-amber-400 font-bold">
                {t.partitions} Partitions
              </span>
            </div>
            <p className="text-xs text-slate-400">{t.description}</p>
            <div className="flex justify-between text-[11px] font-mono text-slate-500 pt-1 border-t border-slate-800">
              <span>Retention: {t.retention}</span>
              <span className="text-slate-500">not created</span>
            </div>
          </button>
        ))}
      </div>

      {/* TWO COLUMN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: EXAMPLE EVENT STREAM */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-400" /> Example Event Stream [{selectedTopic}]
            </h3>
            {selectedTopic === 'reconciliation-dlq' && (
              <button
                type="button"
                onClick={handleRedriveDlq}
                className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-lg transition flex items-center gap-1 shadow"
              >
                <Repeat className="w-3 h-3" /> Re-drive DLQ (simulated)
              </button>
            )}
          </div>

          <div className="border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800 max-h-72 overflow-y-auto">
            {filteredMessages.length > 0 ? (
              filteredMessages.map((msg) => (
                <button
                  key={msg.id}
                  type="button"
                  onClick={() => setActiveMessage(msg)}
                  className={`w-full text-left p-3 cursor-pointer transition text-xs font-mono flex items-center justify-between ${
                    activeMessage?.id === msg.id ? 'bg-amber-950/40' : 'hover:bg-slate-800/40'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{msg.eventType}</span>
                      <span className="text-[10px] text-slate-500">
                        P:{msg.partition} O:{msg.offset}
                      </span>
                    </div>
                    <span className="text-[11px] text-indigo-400">Key: {msg.key}</span>
                  </div>
                  <span className="text-[10px] text-slate-500">{msg.timestamp.slice(11, 19)} UTC</span>
                </button>
              ))
            ) : (
              <div className="p-8 text-center text-slate-500 text-xs">No example events in this topic.</div>
            )}
          </div>

          {/* ACTIVE EVENT PAYLOAD INSPECTOR */}
          {activeMessage && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex justify-between items-center text-xs font-mono">
                <span className="text-slate-400 font-semibold">Event Payload: {activeMessage.eventType}</span>
                <span className="text-[10px] text-amber-400">OFFSET #{activeMessage.offset}</span>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-amber-300 max-h-40 overflow-y-auto">
                <pre>{JSON.stringify(activeMessage.payload, null, 2)}</pre>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: EXAMPLE PRODUCER */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-orange-400" /> Example Event Producer
            </h3>
            <span className="text-[11px] font-mono text-slate-400">local only</span>
          </div>

          <form onSubmit={handlePublish} className="space-y-4 text-xs">
            <div>
              <label htmlFor="kafka-topic" className="block font-semibold text-slate-300 mb-1">
                Target Topic
              </label>
              <select
                id="kafka-topic"
                value={produceTopic}
                onChange={(e) => setProduceTopic(e.target.value as Topic)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-orange-500 outline-none"
              >
                {TOPICS.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="kafka-event" className="block font-semibold text-slate-300 mb-1">
                Event Type Header
              </label>
              <select
                id="kafka-event"
                value={produceEventType}
                onChange={(e) => setProduceEventType(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-orange-500 outline-none"
              >
                <option value="PaymentInitiatedEvent">PaymentInitiatedEvent</option>
                <option value="ProviderRoutingEvent">ProviderRoutingEvent</option>
                <option value="PaymentCompletedEvent">PaymentCompletedEvent</option>
                <option value="CircuitBreakerTrippedEvent">CircuitBreakerTrippedEvent</option>
                <option value="BankTimeoutMismatch">BankTimeoutMismatch</option>
              </select>
            </div>

            <div>
              <label htmlFor="kafka-key" className="block font-semibold text-slate-300 mb-1">
                Message Key (Partition Key)
              </label>
              <input
                id="kafka-key"
                type="text"
                value={produceKey}
                onChange={(e) => setProduceKey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-orange-600/30 transition text-sm"
            >
              <Plus className="w-4 h-4" /> Add Example Event (not sent)
            </button>

            {publishMsg && (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-amber-300">{publishMsg}</div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

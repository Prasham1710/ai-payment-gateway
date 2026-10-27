'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Server,
  Send,
  RefreshCw,
  CircleCheck,
  CircleX,
  Clock,
  Search,
  Copy,
  ArrowRight,
  ShieldCheck,
  Zap,
  Code,
  ListOrdered,
  Repeat,
  BookOpen,
} from 'lucide-react';
import {
  GatewayError,
  PROVIDER_NAMES,
  config,
  formatInr,
  fromUnix,
  loadKeys,
  newIdempotencyKey,
  onKeysChanged,
  orchestrator,
  paymentLabel,
  toPaise,
  type GatewayPayment,
  type Instrument,
  type PaymentAttempt,
  type PaymentMethod,
  type SandboxKeys,
} from '@/lib/gateway';

/** Net banking codes the orchestrator accepts (PaymentInstrument.NETBANKING_BANKS); gateway.ts does not export them. */
const NETBANKING_BANKS: { code: string; name: string }[] = [
  { code: 'HDFC', name: 'HDFC Bank' },
  { code: 'ICIC', name: 'ICICI Bank' },
  { code: 'SBIN', name: 'State Bank of India' },
  { code: 'UTIB', name: 'Axis Bank' },
  { code: 'KKBK', name: 'Kotak Mahindra Bank' },
];

/**
 * Liveness probe. orchestrator.health() requests "/", which the orchestrator serves without CORS headers, so a
 * browser always reports it as a network failure; /ops/circuit-breakers is CORS-enabled, unauthenticated and cheap.
 */
const pingOrchestrator = (): Promise<boolean> => orchestrator.circuitBreakers().then(() => true);

const RECENT_COUNT = 15;
const HEALTH_INTERVAL_MS = 5000;

const API_SURFACE: { method: string; path: string; auth: string; summary: string }[] = [
  { method: 'POST', path: '/v1/merchants', auth: 'none', summary: 'Sign up a sandbox merchant; returns key_id and key_secret once' },
  { method: 'POST', path: '/v1/orders', auth: 'Basic', summary: 'Create an order (amount in paise, minimum 100)' },
  { method: 'POST', path: '/v1/checkout/payments', auth: 'key_id', summary: 'Pay an order, as checkout.js does; honours Idempotency-Key' },
  { method: 'GET', path: '/v1/payments', auth: 'Basic', summary: 'List payments (count up to 100, skip)' },
  { method: 'GET', path: '/v1/payments/{id}', auth: 'Basic', summary: 'Fetch one payment' },
  { method: 'GET', path: '/v1/payments/{id}/attempts', auth: 'Basic', summary: 'Rail attempts for a payment (transactions rows)' },
  { method: 'POST', path: '/v1/payments/{id}/capture', auth: 'Basic', summary: 'Capture an authorized payment' },
  { method: 'POST', path: '/v1/payments/{id}/refund', auth: 'Basic', summary: 'Full or partial refund; honours Idempotency-Key' },
  { method: 'GET', path: '/v1/analytics', auth: 'Basic', summary: 'Volumes, fees, success rate and breakdowns' },
  { method: 'GET POST DELETE', path: '/v1/webhooks', auth: 'Basic', summary: 'Webhook endpoints and /{id}/deliveries' },
  { method: 'GET', path: '/ops/circuit-breakers', auth: 'operator', summary: 'Per-rail breaker state; POST /{provider}/reset closes one' },
];

interface ConsoleEntry {
  label: string;
  ok: boolean;
  httpStatus: number | null; // null: the request never got an answer
  latencyMs: number;
  body: unknown;
  summary: { title: string; fields: [string, string][]; note?: string } | null;
  at: Date;
}

interface Inspected {
  payment: GatewayPayment;
  attempts: PaymentAttempt[] | null;
}

interface LastCheckout {
  orderId: string;
  instrument: Instrument;
  idempotencyKey: string | undefined;
}

/** The error envelope as gateway.ts parsed it (source, step and field are not kept by GatewayError). */
function errorBody(e: unknown): unknown {
  if (e instanceof GatewayError) {
    return { error: { code: e.code ?? null, description: e.message, reason: e.reason ?? null, metadata: e.metadata ?? {} } };
  }
  return { error: { description: e instanceof Error ? e.message : String(e) } };
}

const errorStatus = (e: unknown): number | null => (e instanceof GatewayError && !e.isNetworkError ? e.status : null);

function paymentFields(p: GatewayPayment): [string, string][] {
  const instrument = p.vpa ?? (p.card ? `${p.card.network} •••• ${p.card.last4}` : p.bank ?? '-');
  return [
    ['PAYMENT ID', p.id],
    ['ORDER ID', p.order_id],
    ['METHOD', `${p.method} · ${instrument}`],
    ['PROVIDER RAIL', p.provider ? `${PROVIDER_NAMES[p.provider] ?? p.provider} (${p.provider})` : 'none'],
    ['BANK REFERENCE', p.acquirer_data?.bank_reference ?? '-'],
    ['RAILS TRIED', String(p.attempts)],
    ['FEE (INCL. GST)', p.fee != null ? `${formatInr(p.fee)} (GST ${formatInr(p.tax)})` : '-'],
    ['REFUNDED', p.amount_refunded ? formatInr(p.amount_refunded) : '-'],
  ];
}

const STATUS_BADGE: Record<string, string> = {
  created: 'bg-slate-800 text-slate-300 border-slate-700',
  authorized: 'bg-blue-950 text-blue-300 border-blue-800',
  captured: 'bg-emerald-950 text-emerald-400 border-emerald-800',
  refunded: 'bg-rose-950 text-rose-300 border-rose-800',
  'partially refunded': 'bg-amber-950 text-amber-300 border-amber-800',
  failed: 'bg-red-950 text-red-400 border-red-800',
};

function StatusBadge({ payment }: { payment: Pick<GatewayPayment, 'status' | 'refund_status'> }) {
  const label = paymentLabel(payment);
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase ${STATUS_BADGE[label] ?? STATUS_BADGE.created}`}>{label}</span>
  );
}

const inputClass =
  'w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:ring-2 focus:ring-indigo-500 outline-none';

export default function Port8080Orchestrator() {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<SandboxKeys | null>(null);

  // Payment initiator
  const [amount, setAmount] = useState('499.00');
  const [method, setMethod] = useState<PaymentMethod>('upi');
  const [vpa, setVpa] = useState('success@gateway');
  const [cardNumber, setCardNumber] = useState('4111 1111 1111 1111');
  const [cardName, setCardName] = useState('Test Customer');
  const [expiryMonth, setExpiryMonth] = useState('12');
  const [expiryYear, setExpiryYear] = useState(String(new Date().getFullYear() + 3));
  const [cvv, setCvv] = useState('123');
  const [bank, setBank] = useState('HDFC');
  const [autoCapture, setAutoCapture] = useState(true);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastCheckout, setLastCheckout] = useState<LastCheckout | null>(null);

  // Console
  const [entry, setEntry] = useState<ConsoleEntry | null>(null);
  const [copied, setCopied] = useState(false);

  // Lookup
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // Recent payments
  const [recent, setRecent] = useState<GatewayPayment[] | null>(null);
  const [recentError, setRecentError] = useState<{ message: string; network: boolean } | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  const mounted = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      await pingOrchestrator();
      if (mounted.current) setIsOnline(true);
    } catch (e) {
      // Any HTTP answer means the process is up; only a network failure means it is down.
      if (mounted.current) setIsOnline(!(e instanceof GatewayError && e.isNetworkError));
    }
  }, []);

  /** Loads recent payments; when `toConsole` is set the response is also shown in the console. */
  const loadRecent = useCallback(async (toConsole = false) => {
    setRecentLoading(true);
    const started = performance.now();
    try {
      const page = await orchestrator.listPayments(RECENT_COUNT);
      if (!mounted.current) return;
      setRecent(page.items);
      setRecentError(null);
      if (toConsole) {
        setEntry({
          label: `GET /v1/payments?count=${RECENT_COUNT}`,
          ok: true,
          httpStatus: 200,
          latencyMs: Math.round(performance.now() - started),
          body: page,
          summary: null,
          at: new Date(),
        });
      }
    } catch (e) {
      if (!mounted.current) return;
      setRecentError({ message: e instanceof Error ? e.message : String(e), network: e instanceof GatewayError && e.isNetworkError });
      if (toConsole) {
        setEntry({
          label: `GET /v1/payments?count=${RECENT_COUNT}`,
          ok: false,
          httpStatus: errorStatus(e),
          latencyMs: Math.round(performance.now() - started),
          body: errorBody(e),
          summary: null,
          at: new Date(),
        });
      }
    } finally {
      if (mounted.current) setRecentLoading(false);
    }
  }, []);

  /** Fetches a payment and its rail attempts into the inspector without touching the console. */
  const inspectQuietly = useCallback(async (paymentId: string) => {
    try {
      const [payment, attempts] = await Promise.all([orchestrator.getPayment(paymentId), orchestrator.getAttempts(paymentId)]);
      if (!mounted.current) return;
      setInspected({ payment, attempts: attempts.items });
      setInspectError(null);
      setSearchQuery(paymentId);
    } catch (e) {
      if (mounted.current) setInspectError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setKeys(loadKeys());
    void checkHealth();
    void loadRecent();
    const interval = setInterval(() => void checkHealth(), HEALTH_INTERVAL_MS);
    const unsubscribe = onKeysChanged(() => {
      setKeys(loadKeys());
      void loadRecent();
    });
    return () => {
      mounted.current = false;
      clearInterval(interval);
      unsubscribe();
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [checkHealth, loadRecent]);

  const buildInstrument = (): Instrument => {
    switch (method) {
      case 'card':
        return {
          method: 'card',
          card: {
            number: cardNumber.replace(/[\s-]/g, ''),
            name: cardName.trim(),
            expiry_month: Number(expiryMonth),
            expiry_year: Number(expiryYear),
            cvv: cvv.trim(),
          },
        };
      case 'netbanking':
        return { method: 'netbanking', bank };
      default:
        return { method: 'upi', vpa: vpa.trim() };
    }
  };

  const afterCheckout = (paymentId: string | null | undefined) => {
    if (paymentId) void inspectQuietly(paymentId);
    void loadRecent();
  };

  const handleExecutePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountPaise = toPaise(amount);
    const instrument = buildInstrument();
    const key = idempotencyKey.trim() || undefined;
    const label = 'POST /v1/orders → POST /v1/checkout/payments';
    if (!Number.isFinite(amountPaise)) {
      setEntry({ label, ok: false, httpStatus: null, latencyMs: 0, body: { error: { description: 'Enter an amount in rupees, e.g. 499.00' } }, summary: null, at: new Date() });
      return;
    }

    setIsExecuting(true);
    const started = performance.now();
    try {
      const { order, result } = await orchestrator.createAndPay(amountPaise, instrument, { idempotencyKey: key, capture: autoCapture });
      if (!mounted.current) return;
      setLastCheckout({ orderId: order.id, instrument, idempotencyKey: key });
      setEntry({
        label,
        ok: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - started),
        body: { order, checkout: result },
        summary: {
          title: result.status,
          fields: [
            ['PAYMENT ID', result.payment_id],
            ['ORDER ID', result.order_id],
            ['AMOUNT', formatInr(order.amount)],
            ['IDEMPOTENCY-KEY', key ?? 'not sent'],
          ],
          note: 'Signature = HMAC-SHA256(order_id|payment_id, key_secret); verify it on your server.',
        },
        at: new Date(),
      });
      afterCheckout(result.payment_id);
    } catch (err) {
      if (!mounted.current) return;
      const paymentId = err instanceof GatewayError ? err.metadata?.payment_id : undefined;
      setEntry({
        label,
        ok: false,
        httpStatus: errorStatus(err),
        latencyMs: Math.round(performance.now() - started),
        body: errorBody(err),
        summary: null,
        at: new Date(),
      });
      afterCheckout(paymentId);
    } finally {
      if (mounted.current) setIsExecuting(false);
    }
  };

  /** Sends the last checkout again: same order, same instrument, same Idempotency-Key. */
  const handleReplay = async () => {
    if (!lastCheckout) return;
    setIsExecuting(true);
    const started = performance.now();
    const label = `POST /v1/checkout/payments (replay${lastCheckout.idempotencyKey ? ', same key' : ', no key'})`;
    try {
      const result = await orchestrator.pay(lastCheckout.orderId, lastCheckout.instrument, {}, lastCheckout.idempotencyKey);
      if (!mounted.current) return;
      setEntry({
        label,
        ok: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - started),
        body: result,
        summary: {
          title: result.status,
          fields: [
            ['PAYMENT ID', result.payment_id],
            ['ORDER ID', result.order_id],
          ],
          note: 'Same Idempotency-Key and order: the stored result is replayed and no new charge is sent.',
        },
        at: new Date(),
      });
      afterCheckout(result.payment_id);
    } catch (err) {
      if (!mounted.current) return;
      setEntry({
        label,
        ok: false,
        httpStatus: errorStatus(err),
        latencyMs: Math.round(performance.now() - started),
        body: errorBody(err),
        summary: null,
        at: new Date(),
      });
    } finally {
      if (mounted.current) setIsExecuting(false);
    }
  };

  const lookup = async (paymentId: string) => {
    const id = paymentId.trim();
    if (!id) return;
    setSearchQuery(id);
    setSearchLoading(true);
    const started = performance.now();
    try {
      const [payment, attempts] = await Promise.all([orchestrator.getPayment(id), orchestrator.getAttempts(id)]);
      if (!mounted.current) return;
      setInspected({ payment, attempts: attempts.items });
      setInspectError(null);
      setEntry({
        label: `GET /v1/payments/${id} + /attempts`,
        ok: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - started),
        body: { payment, attempts },
        summary: { title: paymentLabel(payment), fields: paymentFields(payment) },
        at: new Date(),
      });
    } catch (e) {
      if (!mounted.current) return;
      setInspected(null);
      setInspectError(e instanceof Error ? e.message : String(e));
      setEntry({
        label: `GET /v1/payments/${id} + /attempts`,
        ok: false,
        httpStatus: errorStatus(e),
        latencyMs: Math.round(performance.now() - started),
        body: errorBody(e),
        summary: null,
        at: new Date(),
      });
    } finally {
      if (mounted.current) setSearchLoading(false);
    }
  };

  const handleCapture = async () => {
    if (!inspected) return;
    const p = inspected.payment;
    setIsCapturing(true);
    const started = performance.now();
    try {
      const captured = await orchestrator.capture(p.id, p.amount);
      if (!mounted.current) return;
      setInspected({ payment: captured, attempts: inspected.attempts });
      setEntry({
        label: `POST /v1/payments/${p.id}/capture`,
        ok: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - started),
        body: captured,
        summary: { title: paymentLabel(captured), fields: paymentFields(captured) },
        at: new Date(),
      });
      void loadRecent();
    } catch (e) {
      if (!mounted.current) return;
      setEntry({
        label: `POST /v1/payments/${p.id}/capture`,
        ok: false,
        httpStatus: errorStatus(e),
        latencyMs: Math.round(performance.now() - started),
        body: errorBody(e),
        summary: null,
        at: new Date(),
      });
    } finally {
      if (mounted.current) setIsCapturing(false);
    }
  };

  const rawJson = entry ? JSON.stringify(entry.body, null, 2) : '';

  const handleCopyJson = async () => {
    if (!rawJson) return;
    try {
      await navigator.clipboard.writeText(rawJson);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (insecure context or permission): nothing to do
    }
  };

  const currentLabel = inspected ? paymentLabel(inspected.payment) : null;
  const stateClass = (state: string, base: string) =>
    `px-2 py-1 rounded border font-bold ${base} ${currentLabel === state || (state === 'captured' && currentLabel === 'partially refunded') ? 'ring-2 ring-white/70' : 'opacity-80'}`;

  return (
    <div className="space-y-6">
      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20 font-mono font-bold text-xl">
            8080
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">Payment Orchestrator UI</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-indigo-700/60 bg-indigo-950/80 text-indigo-300 font-semibold">
                Java 17 / Spring Boot 3.2
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Razorpay-style merchant API: orders, checkout, payment state machine, idempotent retries and multi-rail failover.
            </p>
            <p className="text-[11px] text-slate-500 mt-1 font-mono">
              {config.orchestratorUrl} · sandbox merchant{' '}
              {keys ? (
                <>
                  <span className="text-indigo-300">{keys.merchantId}</span> ({keys.keyId})
                </>
              ) : (
                'created on first request'
              )}
            </p>
          </div>
        </div>

        {/* Live Service Status */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => void checkHealth()}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Re-check
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
            {isOnline === true ? 'PORT 8080 ONLINE' : isOnline === false ? 'PORT 8080 OFFLINE' : 'CHECKING...'}
          </div>
        </div>
      </div>

      {isOnline === false && (
        <div className="bg-rose-950/40 border border-rose-800/60 p-4 rounded-2xl text-xs text-rose-200">
          Cannot reach the payment orchestrator at <span className="font-mono">{config.orchestratorUrl}</span>. Start the service
          (services/payment-orchestrator) and this page reconnects within {HEALTH_INTERVAL_MS / 1000}s.
        </div>
      )}

      {/* TWO COLUMN GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN */}
        <div className="lg:col-span-6 space-y-6">
          {/* PAYMENT INITIATOR */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-indigo-400" /> Payment Initiator
              </h3>
              <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800 text-right">
                POST /v1/orders → POST /v1/checkout/payments
              </span>
            </div>

            <form onSubmit={handleExecutePayment} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Amount (INR ₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={`${inputClass} font-bold`}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Sent as {Number.isFinite(toPaise(amount)) ? toPaise(amount).toLocaleString('en-IN') : '?'} paise (min 100)
                  </p>
                </div>
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Payment Method</label>
                  <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={inputClass}>
                    <option value="upi">upi (Unified Payments)</option>
                    <option value="card">card (Credit / Debit)</option>
                    <option value="netbanking">netbanking</option>
                  </select>
                </div>
              </div>

              {method === 'upi' && (
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Customer VPA</label>
                  <input type="text" value={vpa} onChange={(e) => setVpa(e.target.value)} className={inputClass} />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Test VPAs: <code className="text-emerald-300">success@gateway</code> always approves,{' '}
                    <code className="text-rose-300">failure@gateway</code> is declined; others follow the rail&apos;s success rate.
                  </p>
                </div>
              )}

              {method === 'card' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Card Number</label>
                      <input type="text" value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Name on Card</label>
                      <input type="text" value={cardName} onChange={(e) => setCardName(e.target.value)} className={inputClass} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Exp. Month</label>
                      <input type="number" min="1" max="12" value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Exp. Year</label>
                      <input type="number" value={expiryYear} onChange={(e) => setExpiryYear(e.target.value)} className={inputClass} />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">CVV</label>
                      <input type="password" value={cvv} onChange={(e) => setCvv(e.target.value)} className={inputClass} autoComplete="off" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Test cards: <code className="text-emerald-300">4111 1111 1111 1111</code> approves,{' '}
                    <code className="text-rose-300">4000 0000 0000 0002</code> is declined. Only the last four digits and network are stored.
                  </p>
                </div>
              )}

              {method === 'netbanking' && (
                <div>
                  <label className="block font-semibold text-slate-300 mb-1">Bank</label>
                  <select value={bank} onChange={(e) => setBank(e.target.value)} className={inputClass}>
                    {NETBANKING_BANKS.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.code} · {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <label className="flex items-start gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={autoCapture}
                  onChange={(e) => setAutoCapture(e.target.checked)}
                  className="accent-indigo-500 mt-0.5"
                />
                <span>
                  <span className="font-semibold">Auto-capture (order payment_capture)</span>
                  <span className="block text-[11px] text-slate-500">
                    Off leaves the payment authorized until you capture it from the lookup panel below.
                  </span>
                </span>
              </label>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-semibold text-slate-300">Idempotency-Key (optional)</label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setIdempotencyKey(newIdempotencyKey('orch'))}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 underline"
                    >
                      Generate key
                    </button>
                    {idempotencyKey && (
                      <button type="button" onClick={() => setIdempotencyKey('')} className="text-[11px] text-slate-400 hover:text-slate-300 underline">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  placeholder="not sent when empty"
                  maxLength={64}
                  className={`${inputClass} text-amber-300`}
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Each submit creates a new order, so re-using a key here is rejected (key already used for a different order). Use{' '}
                  <strong>Replay</strong> below to resend the same order with the same key and get the stored result back.
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isExecuting}
                  className="flex-1 py-3 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 disabled:opacity-50 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30 transition text-sm"
                >
                  {isExecuting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Processing...
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" /> Create order &amp; pay
                    </>
                  )}
                </button>
                {lastCheckout && (
                  <button
                    type="button"
                    onClick={() => void handleReplay()}
                    disabled={isExecuting}
                    title={`Resend order ${lastCheckout.orderId}${lastCheckout.idempotencyKey ? ` with key ${lastCheckout.idempotencyKey}` : ' without a key'}`}
                    className="px-4 py-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-bold rounded-xl border border-slate-700 flex items-center gap-2 transition text-xs"
                  >
                    <Repeat className="w-4 h-4" /> Replay
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* PAYMENT LOOKUP */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Search className="w-4 h-4 text-emerald-400" /> Payment Lookup
              </h3>
              <span className="text-[11px] font-mono text-slate-400">GET /v1/payments/{'{id}'} + /attempts</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void lookup(searchQuery);
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Payment ID (pay_xxx)"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white font-mono focus:ring-2 focus:ring-emerald-500 outline-none"
              />
              <button
                type="submit"
                disabled={searchLoading || !searchQuery.trim()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition flex items-center gap-1.5"
              >
                {searchLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Query
              </button>
            </form>

            {inspectError && <div className="bg-rose-950/40 border border-rose-800/60 rounded-xl p-3 text-xs text-rose-300">{inspectError}</div>}

            {inspected && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-3 text-xs font-mono">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge payment={inspected.payment} />
                    <span className="text-indigo-300 font-bold">{inspected.payment.id}</span>
                  </div>
                  <span className="text-white font-bold">{formatInr(inspected.payment.amount)}</span>
                </div>
                {inspected.payment.error_description && (
                  <div className="text-[11px] text-rose-300">
                    {inspected.payment.error_code}: {inspected.payment.error_description}
                    {inspected.payment.error_reason ? ` (${inspected.payment.error_reason})` : ''}
                  </div>
                )}
                <div>
                  <div className="text-[10px] text-slate-500 mb-1">RAIL ATTEMPTS</div>
                  {inspected.attempts && inspected.attempts.length > 0 ? (
                    <table className="w-full text-left text-[11px]">
                      <tbody className="divide-y divide-slate-800/60">
                        {inspected.attempts.map((a) => (
                          <tr key={a.id}>
                            <td className="py-1 pr-2 text-slate-300">{PROVIDER_NAMES[a.provider] ?? a.provider}</td>
                            <td className={`py-1 pr-2 ${a.status === 'success' ? 'text-emerald-400' : 'text-rose-300'}`}>{a.status}</td>
                            <td className="py-1 pr-2 text-slate-400">{a.response_code ?? '-'}</td>
                            <td className="py-1 pr-2 text-slate-500">{a.latency_ms != null ? `${a.latency_ms}ms` : '-'}</td>
                            <td className="py-1 text-slate-500 truncate max-w-[10rem]">{a.message ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-slate-500">No rail attempts recorded.</div>
                  )}
                </div>
                {inspected.payment.status === 'authorized' && (
                  <button
                    onClick={() => void handleCapture()}
                    disabled={isCapturing}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-lg flex items-center justify-center gap-1.5 transition"
                  >
                    {isCapturing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CircleCheck className="w-3.5 h-3.5" />}
                    Capture {formatInr(inspected.payment.amount)}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* RECENT PAYMENTS */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <ListOrdered className="w-4 h-4 text-amber-400" /> Recent Payments
              </h3>
              <button
                onClick={() => void loadRecent(true)}
                disabled={recentLoading}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-300 rounded-lg border border-slate-700 transition font-mono"
              >
                <RefreshCw className={`w-3 h-3 ${recentLoading ? 'animate-spin' : ''}`} /> GET /v1/payments
              </button>
            </div>

            {recentError && (
              <div className="bg-rose-950/40 border border-rose-800/60 rounded-xl p-3 text-xs text-rose-300">
                {recentError.message}
                {recentError.network && <span className="block text-rose-300/80 mt-1">Start the payment orchestrator (port 8080).</span>}
              </div>
            )}

            {!recent && !recentError && <div className="text-xs text-slate-500">Loading payments...</div>}

            {recent && recent.length === 0 && (
              <div className="text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl p-4 text-center">
                No payments yet for this sandbox merchant. Use the initiator above to create one.
              </div>
            )}

            {recent && recent.length > 0 && (
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-72">
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 text-[10px] uppercase">
                      <tr>
                        <th className="px-3 py-2">Payment</th>
                        <th className="px-3 py-2">Amount</th>
                        <th className="px-3 py-2">Method</th>
                        <th className="px-3 py-2">Rail</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Created</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-300">
                      {recent.map((p) => (
                        <tr key={p.id} onClick={() => void lookup(p.id)} className="hover:bg-slate-800/40 cursor-pointer" title="Inspect this payment">
                          <td className="px-3 py-1.5 text-indigo-300 font-bold">{p.id}</td>
                          <td className="px-3 py-1.5 text-white">{formatInr(p.amount)}</td>
                          <td className="px-3 py-1.5">{p.method}</td>
                          <td className="px-3 py-1.5 text-amber-300">{p.provider ?? '-'}</td>
                          <td className="px-3 py-1.5">
                            <StatusBadge payment={p} />
                          </td>
                          <td className="px-3 py-1.5 text-slate-500">{fromUnix(p.created_at)?.toLocaleTimeString() ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="lg:col-span-6 space-y-6">
          {/* RESPONSE CONSOLE */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Code className="w-4 h-4 text-amber-400" /> Orchestrator Response Console
              </h3>
              {entry && (
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] font-mono px-2 py-0.5 rounded font-bold border ${
                      entry.ok ? 'bg-emerald-950 text-emerald-400 border-emerald-800' : 'bg-rose-950 text-rose-400 border-rose-800'
                    }`}
                  >
                    {entry.httpStatus === null ? 'NO RESPONSE' : `HTTP ${entry.httpStatus}`}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {entry.latencyMs}ms
                  </span>
                </div>
              )}
            </div>

            {entry ? (
              <div className="space-y-4">
                <div className="text-[11px] font-mono text-slate-500">
                  {entry.label} · {entry.at.toLocaleTimeString()}
                </div>

                {entry.summary ? (
                  <div
                    className={`p-4 rounded-xl border ${
                      entry.summary.title === 'failed' ? 'bg-rose-950/40 border-rose-800/80' : 'bg-emerald-950/40 border-emerald-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      {entry.summary.title === 'failed' ? (
                        <CircleX className="w-5 h-5 text-rose-400" />
                      ) : (
                        <CircleCheck className="w-5 h-5 text-emerald-400" />
                      )}
                      <span className="text-base font-black text-white font-mono uppercase">{entry.summary.title}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-300">
                      {entry.summary.fields.map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <span className="text-slate-500 block text-[10px]">{k}</span>
                          <span className="text-slate-200 break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                    {entry.summary.note && <div className="mt-2 pt-2 border-t border-slate-800 text-[11px] text-slate-400">{entry.summary.note}</div>}
                  </div>
                ) : !entry.ok ? (
                  <div className="p-4 rounded-xl border bg-rose-950/40 border-rose-800/80 text-xs space-y-1">
                    <div className="flex items-center gap-2 text-rose-300 font-bold">
                      <CircleX className="w-4 h-4" /> Request failed
                    </div>
                    <p className="text-rose-200 font-mono text-[11px]">
                      {(entry.body as { error?: { description?: string } })?.error?.description ?? 'Unknown error'}
                    </p>
                    {entry.httpStatus === null && <p className="text-rose-300/80">Is the payment orchestrator running on port 8080?</p>}
                    {entry.httpStatus === 409 && <p className="text-amber-300">409: the same Idempotency-Key is still being processed. Retry shortly.</p>}
                  </div>
                ) : null}

                {/* Raw JSON viewer */}
                <div>
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="font-semibold text-slate-400 font-mono">Raw JSON {entry.ok ? 'response' : 'error envelope'}</span>
                    <button onClick={() => void handleCopyJson()} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition">
                      <Copy className="w-3 h-3" /> {copied ? 'Copied!' : 'Copy JSON'}
                    </button>
                  </div>
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-[11px] text-emerald-400 max-h-80 overflow-auto">
                    <pre>{rawJson}</pre>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-64 border-2 border-dashed border-slate-800 rounded-xl flex flex-col items-center justify-center text-center p-6 text-slate-500 text-xs">
                <Server className="w-10 h-10 text-slate-700 mb-2" />
                <p className="font-semibold text-slate-400">No request sent yet</p>
                <p className="text-slate-600 mt-1 max-w-xs">
                  Create a payment, look one up, or refresh the payment list; the last response appears here as raw JSON.
                </p>
              </div>
            )}
          </div>

          {/* STATE MACHINE */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-400" /> Payment State Machine
              {inspected && <span className="normal-case font-mono text-slate-500">· highlighting {inspected.payment.id}</span>}
            </h3>
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2 text-[11px] font-mono text-slate-400">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={stateClass('created', 'bg-slate-800 text-slate-300 border-slate-700')}>created</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                <span className={stateClass('authorized', 'bg-blue-950 text-blue-300 border-blue-800')}>authorized</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                <span className={stateClass('captured', 'bg-emerald-950 text-emerald-300 border-emerald-800')}>captured</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                <span className={stateClass('refunded', 'bg-rose-950 text-rose-300 border-rose-800')}>refunded</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={stateClass('created', 'bg-slate-800 text-slate-300 border-slate-700')}>created</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                <span className={stateClass('failed', 'bg-red-950 text-red-300 border-red-800')}>failed</span>
                <span className="text-slate-500">declined by the bank, or every rail unavailable</span>
              </div>
            </div>
            <ul className="text-[11px] text-slate-500 space-y-1 list-disc pl-4">
              <li>
                Checkout inserts the payment as <code>created</code> (unique per merchant + Idempotency-Key), then tries rails in the AI
                router&apos;s order; an open circuit breaker skips a rail without charging (<code>CB_OPEN</code>), unavailable rails fail
                over, and a bank decline stops immediately.
              </li>
              <li>
                Bank approval makes it <code>authorized</code>. Orders with payment_capture go straight to <code>captured</code>; otherwise
                capture with POST /v1/payments/{'{id}'}/capture, or it is refunded automatically after the capture window.
              </li>
              <li>
                Refunds keep a captured payment <code>captured</code> with refund_status <code>partial</code> until fully refunded, then it
                becomes <code>refunded</code>.
              </li>
            </ul>
          </div>

          {/* API SURFACE */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-indigo-400" /> API Endpoints
            </h3>
            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left font-mono text-[11px]">
                <tbody className="divide-y divide-slate-800/60">
                  {API_SURFACE.map((ep) => (
                    <tr key={`${ep.method} ${ep.path}`} className="hover:bg-slate-800/30">
                      <td className="px-3 py-1.5 text-amber-300 font-bold whitespace-nowrap align-top">{ep.method}</td>
                      <td className="px-3 py-1.5 text-indigo-300 whitespace-nowrap align-top">{ep.path}</td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap align-top">{ep.auth}</td>
                      <td className="px-3 py-1.5 text-slate-400 font-sans">{ep.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              Basic = HTTP Basic with key_id:key_secret. key_id = public checkout call identified by the key id in the body. operator =
              unauthenticated /ops endpoints for trusted networks only. Amounts are integer paise.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

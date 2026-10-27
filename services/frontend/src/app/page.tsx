'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  CreditCard,
  Zap,
  ShieldAlert,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Database,
  Server,
  Radio,
  Cpu,
  Layers,
  BarChart3,
  Key,
  TrendingUp,
  RotateCcw,
  Sparkles,
  ShieldCheck,
  Ban,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Loader2,
  Repeat,
} from 'lucide-react';

import Port8080Orchestrator from '@/components/services/Port8080Orchestrator';
import Port8081BankSimulator from '@/components/services/Port8081BankSimulator';
import Port8000AiRouter from '@/components/services/Port8000AiRouter';
import Port8002FraudDetector from '@/components/services/Port8002FraudDetector';
import Port5432Postgres from '@/components/services/Port5432Postgres';
import Port6380Redis from '@/components/services/Port6380Redis';
import Port9092Kafka from '@/components/services/Port9092Kafka';
import Port9090Prometheus from '@/components/services/Port9090Prometheus';

import StandardCheckoutModal from '@/components/checkout/StandardCheckoutModal';
import RefundModal from '@/components/modals/RefundModal';
import AnalyticsDashboard from '@/components/dashboard/AnalyticsDashboard';
import WebhookInspector from '@/components/dashboard/WebhookInspector';
import ApiKeysPortal from '@/components/dashboard/ApiKeysPortal';
import CircuitBreakerMatrix from '@/components/dashboard/CircuitBreakerMatrix';

import {
  GatewayError,
  PROVIDERS,
  PROVIDER_NAMES,
  bankSimulator,
  config,
  ensureKeys,
  formatInr,
  fromUnix,
  isRefundable,
  loadKeys,
  newIdempotencyKey,
  onKeysChanged,
  orchestrator,
  paymentLabel,
  toPaise,
  type CheckoutResult,
  type GatewayPayment,
  type GatewayRefund,
  type Instrument,
  type PaymentAttempt,
  type PaymentMethod,
  type ProviderStatus,
  type SandboxKeys,
} from '@/lib/gateway';

type TabId =
  | 'checkout' | 'analytics' | 'circuits' | 'webhooks' | 'apikeys' | 'chaos' | 'ledger'
  | 'port-8080' | 'port-8081' | 'port-8000' | 'port-8002' | 'port-5432' | 'port-6380' | 'port-9092' | 'port-9090';

/** Netbanking bank codes the gateway accepts. */
const NETBANKING_BANKS = [
  { code: 'HDFC', name: 'HDFC Bank' },
  { code: 'ICIC', name: 'ICICI Bank' },
  { code: 'SBIN', name: 'State Bank of India' },
  { code: 'UTIB', name: 'Axis Bank' },
  { code: 'KKBK', name: 'Kotak Mahindra Bank' },
];

/** The quick form pays cards with a fixed future expiry and CVV; only the number varies the outcome. */
const QUICK_CARD = { name: 'Ops Dashboard', expiry_month: 12, expiry_year: 2030, cvv: '123' };

/** Bank simulator start-up latencies, used by "Reset Delay" (restore does not reset latency). */
const DEFAULT_LATENCY_MS: Record<string, number> = { 'provider-a': 120, 'provider-b': 180, 'provider-c': 250 };

const LEDGER_PAGE = 100;
const LEDGER_POLL_MS = 5000;
const HEALTH_POLL_MS = 4000;

// ---------------------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------------------

function errorText(err: unknown, service: string): string {
  if (err instanceof GatewayError) {
    return err.isNetworkError ? `${err.message} Start the ${service} and try again.` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const providerName = (id: string | null | undefined): string => (id ? PROVIDER_NAMES[id] ?? id : '—');

function methodDetail(p: GatewayPayment): string | null {
  if (p.method === 'upi') return p.vpa;
  if (p.method === 'card') return p.card ? `${p.card.network} •••• ${p.card.last4}` : null;
  return p.bank;
}

function statusBadgeClass(p: Pick<GatewayPayment, 'status' | 'refund_status'>): string {
  switch (paymentLabel(p)) {
    case 'captured':
      return 'bg-emerald-950 text-emerald-400 border border-emerald-800';
    case 'authorized':
      return 'bg-sky-950 text-sky-400 border border-sky-800';
    case 'partially refunded':
      return 'bg-amber-950 text-amber-400 border border-amber-800';
    case 'refunded':
      return 'bg-fuchsia-950 text-fuchsia-300 border border-fuchsia-800';
    case 'failed':
      return 'bg-rose-950 text-rose-400 border border-rose-800';
    default:
      return 'bg-slate-900 text-slate-400 border border-slate-700';
  }
}

function attemptView(a: PaymentAttempt): { label: string; cls: string; skipped: boolean } {
  if (a.response_code === 'CB_OPEN') {
    return { label: 'skipped · circuit open', cls: 'bg-amber-950 text-amber-300 border border-amber-800', skipped: true };
  }
  switch (a.status) {
    case 'success':
      return { label: 'success', cls: 'bg-emerald-950 text-emerald-400 border border-emerald-800', skipped: false };
    case 'declined':
      return { label: 'declined', cls: 'bg-rose-950 text-rose-400 border border-rose-800', skipped: false };
    case 'unavailable':
      return { label: 'unavailable', cls: 'bg-orange-950 text-orange-300 border border-orange-800', skipped: false };
    default:
      return { label: 'unknown', cls: 'bg-slate-900 text-slate-400 border border-slate-700', skipped: false };
  }
}

/** Per-rail routing trail of one payment; CB_OPEN rows were skipped without sending a charge. */
function AttemptTrail({ attempts }: { attempts: PaymentAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="text-[11px] text-slate-500 font-sans">No rail was attempted for this payment.</p>;
  }
  return (
    <ol className="space-y-1.5">
      {attempts.map((a, i) => {
        const view = attemptView(a);
        return (
          <li
            key={a.id}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-xl border text-[11px] ${
              view.skipped ? 'bg-amber-950/20 border-amber-800/50 border-dashed' : 'bg-slate-950/80 border-slate-800/60'
            }`}
          >
            <span className="font-mono text-slate-500">#{i + 1}</span>
            <span className="font-sans font-semibold text-slate-200 flex items-center gap-1.5">
              {view.skipped && <Ban className="w-3.5 h-3.5 text-amber-400" />}
              {providerName(a.provider)}
              <span className="font-mono text-[10px] text-slate-500">{a.provider}</span>
            </span>
            <span className={`px-2 py-0.5 rounded font-sans text-[10px] font-bold uppercase ${view.cls}`}>{view.label}</span>
            <span className="font-mono text-slate-400">code {a.response_code ?? '—'}</span>
            <span className="font-mono text-slate-400">{a.latency_ms != null ? `${a.latency_ms} ms` : '— ms'}</span>
            {view.skipped ? (
              <span className="font-sans text-amber-300/90 basis-full">
                Circuit breaker open: rail skipped, no charge was sent to the bank.
              </span>
            ) : (
              a.message && <span className="font-sans text-slate-500 basis-full sm:basis-auto">{a.message}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// Idempotency demo: a key is tied to the order it first paid, so replaying the key pays that same order again
// and the gateway answers with the original payment (reusing a key on a new order is rejected by the API).
interface IdempotentOrder {
  orderId: string;
  keyId: string;
  amountPaise: number;
}
const IDEMPOTENCY_STORE = 'dashboard.idempotencyOrders';

function readIdempotentOrders(): Record<string, IdempotentOrder> {
  try {
    const raw = window.sessionStorage.getItem(IDEMPOTENCY_STORE);
    return raw ? (JSON.parse(raw) as Record<string, IdempotentOrder>) : {};
  } catch {
    return {};
  }
}

function writeIdempotentOrder(key: string, entry: IdempotentOrder): void {
  try {
    const all = readIdempotentOrders();
    all[key] = entry;
    window.sessionStorage.setItem(IDEMPOTENCY_STORE, JSON.stringify(all));
  } catch {
    // storage unavailable: the in-memory copy still covers this page session
  }
}

interface RunError {
  message: string;
  status: number;
  code?: string;
  reason?: string;
  hint?: string;
}

interface CheckoutRun {
  phase: 'created' | 'routing' | 'done' | 'error';
  idempotencyKey: string;
  replay: boolean;
  orderId: string | null;
  result: CheckoutResult | null;
  payment: GatewayPayment | null;
  attempts: PaymentAttempt[] | null;
  detailsError: string | null;
  error: RunError | null;
  /** Step that rejected the request when no payment was created (1 = order, 2 = checkout). */
  failedStep: 1 | 2 | null;
}

interface PaymentDetails {
  payment: GatewayPayment | null;
  attempts: PaymentAttempt[] | null;
  detailsError: string | null;
}

async function loadPaymentDetails(paymentId: string): Promise<PaymentDetails> {
  const [p, a] = await Promise.allSettled([orchestrator.getPayment(paymentId), orchestrator.getAttempts(paymentId)]);
  const failed = [p, a].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  return {
    payment: p.status === 'fulfilled' ? p.value : null,
    attempts: a.status === 'fulfilled' ? a.value.items : null,
    detailsError: failed ? errorText(failed.reason, 'payment orchestrator') : null,
  };
}

interface RowDetails {
  loading: boolean;
  attempts: PaymentAttempt[] | null;
  refunds: GatewayRefund[] | null;
  error: string | null;
}

type StepState = 'pending' | 'active' | 'done' | 'failed';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('checkout');

  // Sandbox merchant
  const [keys, setKeys] = useState<SandboxKeys | null>(null);
  const [keysError, setKeysError] = useState<string>('');

  // Service health
  const [orchestratorOnline, setOrchestratorOnline] = useState<boolean | null>(null);
  const [bankOnline, setBankOnline] = useState<boolean | null>(null);

  // Checkout Form State
  const [amount, setAmount] = useState('1499.00');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('upi');
  const [customerVpa, setCustomerVpa] = useState('success@gateway');
  const [cardNumber, setCardNumber] = useState('4111111111111111');
  const [bankCode, setBankCode] = useState('HDFC');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [formError, setFormError] = useState('');
  const [run, setRun] = useState<CheckoutRun | null>(null);
  const idempotentOrders = useRef<Record<string, IdempotentOrder>>({});

  // Prototype Modal States
  const [isCheckoutModalOpen, setIsCheckoutModalOpen] = useState(false);
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [selectedRefundPayment, setSelectedRefundPayment] = useState<GatewayPayment | null>(null);

  // Chaos & Providers State
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [chaosMessage, setChaosMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [chaosBusy, setChaosBusy] = useState<string | null>(null);

  // Ledger State
  const [payments, setPayments] = useState<GatewayPayment[]>([]);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const [ledgerUpdatedAt, setLedgerUpdatedAt] = useState<Date | null>(null);
  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);
  const [rowDetails, setRowDetails] = useState<Record<string, RowDetails>>({});
  const ledgerInFlight = useRef(false);
  const ledgerRerun = useRef(false);

  // ------------------------------------------------------------------ data loading

  const refreshProviders = useCallback(async () => {
    try {
      const status = await bankSimulator.status();
      setProviders(status);
      setBankOnline(true);
    } catch {
      setBankOnline(false);
    }
  }, []);

  const checkOrchestrator = useCallback(async () => {
    try {
      await orchestrator.health();
      setOrchestratorOnline(true);
    } catch {
      setOrchestratorOnline(false);
    }
  }, []);

  const fetchLedger = useCallback(async () => {
    // One request at a time; a call made meanwhile (new payment, merchant switch) runs once the current one ends.
    if (ledgerInFlight.current) {
      ledgerRerun.current = true;
      return;
    }
    ledgerInFlight.current = true;
    setLedgerLoading(true);
    try {
      do {
        ledgerRerun.current = false;
        try {
          const page = await orchestrator.listPayments(LEDGER_PAGE);
          setPayments(page.items);
          setLedgerError('');
          setLedgerUpdatedAt(new Date());
        } catch (err) {
          setLedgerError(errorText(err, 'payment orchestrator'));
        }
      } while (ledgerRerun.current);
    } finally {
      ledgerInFlight.current = false;
      setLedgerLoaded(true);
      setLedgerLoading(false);
    }
  }, []);

  const loadRowDetails = useCallback(async (paymentId: string) => {
    setRowDetails((prev) => ({
      ...prev,
      [paymentId]: { loading: true, attempts: prev[paymentId]?.attempts ?? null, refunds: prev[paymentId]?.refunds ?? null, error: null },
    }));
    const [a, r] = await Promise.allSettled([orchestrator.getAttempts(paymentId), orchestrator.listRefunds(paymentId)]);
    const failed = [a, r].find((x): x is PromiseRejectedResult => x.status === 'rejected');
    setRowDetails((prev) => ({
      ...prev,
      [paymentId]: {
        loading: false,
        attempts: a.status === 'fulfilled' ? a.value.items : null,
        refunds: r.status === 'fulfilled' ? r.value.items : null,
        error: failed ? errorText(failed.reason, 'payment orchestrator') : null,
      },
    }));
  }, []);

  // Active sandbox merchant: created on first use, kept in sync with key changes made anywhere in the app.
  useEffect(() => {
    let cancelled = false;
    setKeys(loadKeys());
    ensureKeys()
      .then((k) => {
        if (!cancelled) {
          setKeys(k);
          setKeysError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setKeysError(errorText(err, 'payment orchestrator'));
      });
    const unsubscribe = onKeysChanged(() => {
      if (!cancelled) setKeys(loadKeys());
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // A fresh idempotency key per page load (generated after mount so server and client HTML match).
  useEffect(() => {
    setIdempotencyKey(newIdempotencyKey());
  }, []);

  // Header pills and chaos cards.
  useEffect(() => {
    checkOrchestrator();
    refreshProviders();
    const interval = setInterval(() => {
      checkOrchestrator();
      refreshProviders();
    }, HEALTH_POLL_MS);
    return () => clearInterval(interval);
  }, [checkOrchestrator, refreshProviders]);

  // Ledger count for the tab label; reloaded when the active merchant changes.
  useEffect(() => {
    fetchLedger();
  }, [fetchLedger, keys?.keyId]);

  // Live ledger while its tab is open.
  useEffect(() => {
    if (activeTab !== 'ledger') return;
    fetchLedger();
    const interval = setInterval(fetchLedger, LEDGER_POLL_MS);
    return () => clearInterval(interval);
  }, [activeTab, fetchLedger]);

  // ------------------------------------------------------------------ direct API checkout

  const handleInitiatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountPaise = toPaise(amount);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      setFormError('Enter an amount of at least ₹1.00.');
      return;
    }
    let instrument: Instrument;
    if (paymentMethod === 'upi') {
      if (!customerVpa.trim()) {
        setFormError('Enter the customer VPA, e.g. success@gateway.');
        return;
      }
      instrument = { method: 'upi', vpa: customerVpa.trim() };
    } else if (paymentMethod === 'card') {
      instrument = { method: 'card', card: { ...QUICK_CARD, number: cardNumber.replace(/[\s-]/g, '') } };
    } else {
      instrument = { method: 'netbanking', bank: bankCode };
    }

    const key = idempotencyKey.trim();
    setFormError('');
    setIsProcessing(true);
    const base: CheckoutRun = {
      phase: 'created', idempotencyKey: key, replay: false, orderId: null, result: null,
      payment: null, attempts: null, detailsError: null, error: null, failedStep: null,
    };
    setRun(base);

    let orderId: string | null = null;
    let replay = false;
    try {
      const active = await ensureKeys();
      const prior = key ? idempotentOrders.current[key] ?? readIdempotentOrders()[key] : undefined;
      if (prior && prior.keyId === active.keyId) {
        // Same key again: pay the order it was first used for, so the gateway can return the original payment.
        orderId = prior.orderId;
        replay = true;
      } else {
        const order = await orchestrator.createOrder(amountPaise, { receipt: `dash_${Date.now()}` });
        orderId = order.id;
        if (key) {
          const entry = { orderId: order.id, keyId: active.keyId, amountPaise };
          idempotentOrders.current[key] = entry;
          writeIdempotentOrder(key, entry);
        }
      }
      setRun({ ...base, phase: 'routing', orderId, replay });

      const result = await orchestrator.pay(orderId, instrument, {}, key || undefined);
      const details = await loadPaymentDetails(result.payment_id);
      setRun({ ...base, phase: 'done', orderId: result.order_id, replay, result, ...details });
    } catch (err) {
      const gatewayError = err instanceof GatewayError ? err : null;
      const error: RunError = {
        message: errorText(err, 'payment orchestrator'),
        status: gatewayError?.status ?? 0,
        code: gatewayError?.code,
        reason: gatewayError?.reason,
        hint: gatewayError && /Idempotency-Key/.test(gatewayError.message)
          ? 'This key belongs to an order this page no longer remembers. Click Gen New for a fresh key.'
          : undefined,
      };
      const failedPaymentId = gatewayError?.metadata?.payment_id;
      if (failedPaymentId) {
        const details = await loadPaymentDetails(failedPaymentId);
        setRun({ ...base, phase: 'done', orderId: gatewayError?.metadata?.order_id ?? orderId, replay, error, ...details });
      } else {
        setRun({ ...base, phase: 'error', orderId, replay, error, failedStep: orderId ? 2 : 1 });
      }
    } finally {
      setIsProcessing(false);
      fetchLedger();
    }
  };

  // ------------------------------------------------------------------ chaos controls

  const runChaos = async (busyKey: string, action: () => Promise<unknown>, successText: string) => {
    setChaosBusy(busyKey);
    try {
      await action();
      setChaosMessage({ tone: 'ok', text: successText });
    } catch (err) {
      setChaosMessage({ tone: 'error', text: errorText(err, 'bank simulator') });
    } finally {
      setChaosBusy(null);
      refreshProviders();
    }
  };

  const handleChaosKill = (pId: string) =>
    runChaos(`kill:${pId}`, () => bankSimulator.kill(pId),
      `Killed ${providerName(pId)}. Payments fail over to the next rail; after repeated failures its circuit breaker opens and attempts show CB_OPEN.`);

  const handleChaosRestore = (pId: string) =>
    runChaos(`restore:${pId}`, () => bankSimulator.restore(pId), `Restored ${providerName(pId)} to a healthy state.`);

  const handleChaosRestoreAll = () =>
    runChaos('restore:all', () => bankSimulator.restore(), 'Restored every rail.');

  const handleChaosLatency = (pId: string, ms: number, text: string) =>
    runChaos(`latency:${pId}`, () => bankSimulator.setLatency(pId, ms), text);

  // ------------------------------------------------------------------ refunds

  const openRefund = (p: GatewayPayment) => {
    setSelectedRefundPayment(p);
    setIsRefundModalOpen(true);
  };

  const handleRefundCreated = async (refund: GatewayRefund) => {
    fetchLedger();
    if (expandedPaymentId === refund.payment_id) loadRowDetails(refund.payment_id);
    if (run?.payment?.id === refund.payment_id) {
      try {
        const payment = await orchestrator.getPayment(refund.payment_id);
        setRun((prev) => (prev && prev.payment?.id === payment.id ? { ...prev, payment } : prev));
      } catch {
        // the ledger shows the new state anyway
      }
    }
  };

  const toggleRow = (paymentId: string) => {
    if (expandedPaymentId === paymentId) {
      setExpandedPaymentId(null);
      return;
    }
    setExpandedPaymentId(paymentId);
    loadRowDetails(paymentId);
  };

  // ------------------------------------------------------------------ derived view state

  const runStatus = run?.payment?.status ?? run?.result?.status ?? (run?.phase === 'done' && run.error ? 'failed' : null);
  const runCaptured = run?.payment?.captured ?? (run?.result?.status === 'captured');
  const runFailed = runStatus === 'failed';
  const runSucceeded = runStatus === 'authorized' || runStatus === 'captured' || runStatus === 'refunded';

  const stepStates: [StepState, StepState, StepState, StepState] = (() => {
    if (!run) return ['pending', 'pending', 'pending', 'pending'];
    if (run.phase === 'created') return ['active', 'pending', 'pending', 'pending'];
    if (run.phase === 'routing') return ['done', 'active', 'pending', 'pending'];
    if (run.phase === 'error') {
      return run.failedStep === 1 ? ['failed', 'pending', 'pending', 'pending'] : ['done', 'failed', 'pending', 'pending'];
    }
    if (runFailed) return ['done', 'done', 'failed', 'pending'];
    if (runSucceeded) return ['done', 'done', 'done', runCaptured ? 'done' : 'pending'];
    return ['done', 'done', 'pending', 'pending'];
  })();

  const skippedRails = run?.attempts?.filter((a) => a.response_code === 'CB_OPEN').length ?? 0;
  const steps = [
    { label: 'CREATED', sub: run?.orderId ? run.orderId : 'order + payment' },
    { label: 'ROUTING', sub: run?.attempts ? `${run.attempts.length} attempt${run.attempts.length === 1 ? '' : 's'}${skippedRails ? ` · ${skippedRails} CB_OPEN` : ''}` : 'bank rails' },
    { label: runFailed ? 'FAILED' : 'AUTHORIZED', sub: runFailed ? (run?.error?.status === 502 ? 'all rails down' : 'declined') : 'bank approved' },
    { label: 'CAPTURED', sub: runSucceeded && !runCaptured ? 'awaiting capture' : 'funds captured' },
  ];

  const ledgerCountLabel = !ledgerLoaded ? '…' : payments.length >= LEDGER_PAGE ? `${LEDGER_PAGE}+` : String(payments.length);
  const providerList = PROVIDERS.filter((id) => providers[id]).map((id) => providers[id])
    .concat(Object.values(providers).filter((p) => !(PROVIDERS as readonly string[]).includes(p.id)));
  const formAmountPaise = toPaise(amount);
  const tabClass = (tab: TabId, tone: 'indigo' | 'rose' | 'emerald' = 'indigo') =>
    `flex items-center gap-2 px-4 py-3 text-xs font-bold transition border-b-2 whitespace-nowrap ${
      activeTab === tab
        ? tone === 'rose'
          ? 'border-rose-500 text-rose-400 bg-rose-950/30'
          : tone === 'emerald'
            ? 'border-emerald-500 text-emerald-400 bg-emerald-950/30'
            : 'border-indigo-500 text-indigo-400 bg-indigo-950/30'
        : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  const servicePorts: { id: TabId; port: string; name: string; icon: typeof Server; color: string }[] = [
    { id: 'port-8080', port: '8080', name: 'Spring Boot Orchestrator', icon: Server, color: 'text-emerald-400' },
    { id: 'port-8081', port: '8081', name: 'Bank Simulator', icon: ShieldAlert, color: 'text-indigo-400' },
    { id: 'port-8000', port: '8000', name: 'AI Router', icon: Cpu, color: 'text-purple-400' },
    { id: 'port-8002', port: '8002', name: 'Fraud', icon: ShieldAlert, color: 'text-rose-400' },
    { id: 'port-5432', port: '5432', name: 'Postgres (pgAdmin 5050)', icon: Database, color: 'text-blue-400' },
    { id: 'port-6380', port: '6380', name: 'Redis (RedisInsight 5540)', icon: Zap, color: 'text-red-400' },
    { id: 'port-9092', port: '9092', name: 'Kafka (Redpanda 8085)', icon: Layers, color: 'text-amber-400' },
    { id: 'port-9090', port: '9090', name: 'Prometheus (Native 9090)', icon: BarChart3, color: 'text-orange-400' },
  ];

  const healthPill = (label: string, online: boolean | null, onlineTone: string) => (
    <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
      <span className={`w-2 h-2 rounded-full ${
        online === null ? 'bg-slate-500' : online ? `${onlineTone === 'emerald' ? 'bg-emerald-400' : 'bg-indigo-400'} animate-pulse` : 'bg-rose-500'
      }`}></span>
      <span className="text-slate-300">{label}:</span>
      <span className={`font-bold ${
        online === null ? 'text-slate-500' : online ? (onlineTone === 'emerald' ? 'text-emerald-400' : 'text-indigo-400') : 'text-rose-400'
      }`}>
        {online === null ? 'CHECKING' : online ? 'ONLINE' : 'OFFLINE'}
      </span>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">

      {/* MODALS */}
      <StandardCheckoutModal
        isOpen={isCheckoutModalOpen}
        onClose={() => {
          setIsCheckoutModalOpen(false);
          fetchLedger();
        }}
        onPaymentSuccess={() => {
          fetchLedger();
        }}
        initialAmount={Number.isFinite(formAmountPaise) && formAmountPaise >= 100 ? formAmountPaise / 100 : 1499.00}
      />

      <RefundModal
        isOpen={isRefundModalOpen}
        onClose={() => {
          setIsRefundModalOpen(false);
          setSelectedRefundPayment(null);
          fetchLedger();
        }}
        payment={selectedRefundPayment}
        onRefundSuccess={handleRefundCreated}
      />

      {/* HEADER BAR */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-lg text-white shadow-lg shadow-indigo-600/30">
            ⚡
          </div>
          <div>
            <h1 className="font-extrabold text-base tracking-tight text-white flex items-center gap-2">
              AI Payment Gateway <span className="text-[10px] bg-indigo-950 text-indigo-400 border border-indigo-800/80 px-2 py-0.5 rounded-full font-mono">v2.0 Working Prototype</span>
            </h1>
            <p className="text-xs text-slate-400">Enterprise End-to-End Orchestration & Chaos Platform</p>
          </div>
        </div>

        {/* Action Button & Badges */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsCheckoutModalOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3.5 py-2 rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Open Checkout Modal</span>
          </button>

          <div className="hidden sm:flex items-center gap-3 text-xs font-medium">
            {healthPill('Port 8080', orchestratorOnline, 'emerald')}
            {healthPill('Port 8081', bankOnline, 'indigo')}
          </div>
        </div>
      </header>

      {/* NAVIGATION TABS */}
      <div className="bg-slate-900/80 border-b border-slate-800 px-6 flex items-center justify-between overflow-x-auto gap-4">
        <div className="flex items-center gap-1">
          <button onClick={() => setActiveTab('checkout')} className={tabClass('checkout')}>
            <CreditCard className="w-4 h-4" /> 🛒 Checkout
          </button>

          <button onClick={() => setActiveTab('analytics')} className={tabClass('analytics')}>
            <TrendingUp className="w-4 h-4" /> 📊 Analytics & GMV
          </button>

          <button onClick={() => setActiveTab('circuits')} className={tabClass('circuits')}>
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> 🛡️ Circuits & Idempotency
          </button>

          <button onClick={() => setActiveTab('webhooks')} className={tabClass('webhooks')}>
            <Radio className="w-4 h-4" /> 🔔 Webhook Inspector
          </button>

          <button onClick={() => setActiveTab('apikeys')} className={tabClass('apikeys')}>
            <Key className="w-4 h-4" /> 🔑 Developer API Keys
          </button>

          <button onClick={() => setActiveTab('chaos')} className={tabClass('chaos', 'rose')}>
            <ShieldAlert className="w-4 h-4" /> 🔴 Chaos Matrix
          </button>

          <button onClick={() => setActiveTab('ledger')} className={tabClass('ledger', 'emerald')}>
            <Database className="w-4 h-4" /> 📋 Transaction Ledger ({ledgerCountLabel})
          </button>
        </div>

        <span className="text-[11px] font-mono text-slate-500 hidden lg:inline">
          Port Microservices UIs Available Below ↓
        </span>
      </div>

      {/* SERVICE PORTS SUB-BAR (Direct UI for All Service Ports) */}
      <div className="bg-slate-950 border-b border-slate-800/80 px-6 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mr-2 whitespace-nowrap flex items-center gap-1">
          <Server className="w-3 h-3 text-indigo-400" /> SERVICE PORTS:
        </span>
        {servicePorts.map((sp) => {
          const Icon = sp.icon;
          const isActive = activeTab === sp.id;
          return (
            <button
              key={sp.id}
              onClick={() => setActiveTab(sp.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono transition whitespace-nowrap border ${
                isActive
                  ? 'bg-indigo-950/80 border-indigo-500 text-white font-bold shadow'
                  : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-3 h-3 ${sp.color}`} />
              <span className="font-bold">:{sp.port}</span>
              <span className="text-[10px] text-slate-400">{sp.name}</span>
            </button>
          );
        })}
      </div>

      {/* MAIN CONTAINER */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">

        {/* TAB 1: CHECKOUT VISUALIZER */}
        {activeTab === 'checkout' && (
          <div className="space-y-6">

            {/* HERO LAUNCH BANNER */}
            <div className="bg-gradient-to-r from-indigo-950 via-slate-900 to-blue-950 border border-indigo-500/30 p-6 rounded-3xl flex flex-col md:flex-row items-center justify-between gap-5 shadow-2xl">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-bold text-2xl shadow-xl shadow-indigo-600/40 shrink-0">
                  ⚡
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-extrabold text-base text-white">
                      Standard Drop-in Checkout Modal
                    </h3>
                    <span className="bg-indigo-900 text-indigo-300 border border-indigo-700 text-[10px] font-mono px-2.5 py-0.5 rounded-full font-bold">
                      Live Sandbox
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                    Walk the customer payment journey with real sandbox payments: UPI QR scan, UPI collect with a 60s approval timer, cards with a simulated 3-D Secure OTP (<code className="text-emerald-400">123456</code>), and netbanking. Every option creates an order and pays it through the gateway.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsCheckoutModalOpen(true)}
                className="w-full md:w-auto bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-6 py-3.5 rounded-2xl transition shadow-xl shadow-indigo-600/40 flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <Sparkles className="w-4 h-4" /> Launch Checkout Modal
              </button>
            </div>

            {/* RAW REST ORCHESTRATION TESTER */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Form Column */}
              <div className="lg:col-span-5 bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-5">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-indigo-400" /> Direct API Checkout Form
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Creates an order (<code className="text-slate-300">POST /v1/orders</code>) and pays it through the public checkout API (<code className="text-slate-300">POST /v1/checkout/payments</code>).
                  </p>
                </div>

                <form onSubmit={handleInitiatePayment} className="space-y-4 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-300 mb-1">Sandbox Merchant Key ID</label>
                    <input
                      type="text"
                      readOnly
                      value={keys?.keyId ?? (keysError ? 'unavailable' : 'creating sandbox merchant…')}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 font-mono focus:outline-none cursor-default"
                    />
                    <p className={`text-[10px] mt-1 ${keys || !keysError ? 'text-slate-500' : 'text-rose-400'}`}>
                      {keys
                        ? `${keys.name} · ${keys.merchantId} · change it in Developer API Keys`
                        : keysError || 'A test-mode merchant is created on first use.'}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Amount (INR ₹)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <p className="text-[10px] text-slate-500 mt-1 font-mono">
                        = {Number.isFinite(formAmountPaise) ? formAmountPaise : 0} paise
                      </p>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Payment Rail</label>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="upi">UPI Rail</option>
                        <option value="card">Credit/Debit Card</option>
                        <option value="netbanking">NetBanking</option>
                      </select>
                    </div>
                  </div>

                  {paymentMethod === 'upi' && (
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Customer VPA</label>
                      <input
                        type="text"
                        value={customerVpa}
                        onChange={(e) => setCustomerVpa(e.target.value)}
                        placeholder="success@gateway"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <p className="text-[10px] text-slate-500 mt-1">
                        <code className="text-emerald-400">success@gateway</code> succeeds, <code className="text-rose-400">failure@gateway</code> is declined; other VPAs follow the rail&apos;s success rate.
                      </p>
                    </div>
                  )}

                  {paymentMethod === 'card' && (
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Card Number</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={cardNumber}
                        onChange={(e) => setCardNumber(e.target.value)}
                        placeholder="4111111111111111"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <p className="text-[10px] text-slate-500 mt-1">
                        Expiry {String(QUICK_CARD.expiry_month).padStart(2, '0')}/{QUICK_CARD.expiry_year}, CVV {QUICK_CARD.cvv}. <code className="text-emerald-400">4111111111111111</code> succeeds, <code className="text-rose-400">4000000000000002</code> is declined.
                      </p>
                    </div>
                  )}

                  {paymentMethod === 'netbanking' && (
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Bank</label>
                      <select
                        value={bankCode}
                        onChange={(e) => setBankCode(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {NETBANKING_BANKS.map((b) => (
                          <option key={b.code} value={b.code}>{b.name} ({b.code})</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="font-semibold text-slate-300">Idempotency Key</label>
                      <button
                        type="button"
                        onClick={() => setIdempotencyKey(newIdempotencyKey())}
                        className="text-[10px] text-indigo-400 hover:underline flex items-center gap-1"
                      >
                        <RefreshCw className="w-3 h-3" /> Gen New
                      </button>
                    </div>
                    <input
                      type="text"
                      value={idempotencyKey}
                      onChange={(e) => setIdempotencyKey(e.target.value)}
                      maxLength={64}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-400 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Sent as the <code className="text-slate-300">Idempotency-Key</code> header. Submit again with the same key to replay: the gateway returns the original payment instead of charging twice.
                    </p>
                  </div>

                  {formError && (
                    <div className="bg-rose-950/40 border border-rose-800/80 text-rose-300 px-3 py-2 rounded-xl text-[11px] flex items-center gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {formError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isProcessing}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-xl transition shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" /> Orchestrating Transaction...
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" /> Execute Payment Request
                      </>
                    )}
                  </button>
                </form>
              </div>

              {/* State Machine & Result Column */}
              <div className="lg:col-span-7 space-y-6">

                {/* State Machine Flow Indicator */}
                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Payment State Machine Lifecycle</h3>

                  <div className="flex items-start justify-between text-xs gap-1">
                    {steps.map((step, i) => {
                      const state = stepStates[i];
                      const outcomeStep = i >= 2;
                      const circle =
                        state === 'failed'
                          ? 'border-rose-500 bg-rose-950/80 text-white'
                          : state === 'done'
                            ? outcomeStep
                              ? 'border-emerald-500 bg-emerald-950/80 text-white'
                              : 'border-indigo-500 bg-indigo-950/80 text-white'
                            : state === 'active'
                              ? 'border-indigo-400 bg-indigo-950/40 text-indigo-200'
                              : 'border-slate-800 bg-slate-950';
                      const text =
                        state === 'failed'
                          ? 'text-rose-400 font-bold'
                          : state === 'done'
                            ? outcomeStep ? 'text-emerald-400 font-bold' : 'text-indigo-400 font-bold'
                            : state === 'active'
                              ? 'text-indigo-300 font-bold'
                              : 'text-slate-600';
                      return (
                        <React.Fragment key={i}>
                          {i > 0 && (
                            <ArrowRight className={`w-4 h-4 mt-3 shrink-0 ${state === 'pending' ? 'text-slate-800' : state === 'failed' ? 'text-rose-500' : 'text-indigo-500'}`} />
                          )}
                          <div className={`flex flex-col items-center gap-1.5 min-w-0 flex-1 text-center ${text}`}>
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${circle}`}>
                              {state === 'active' ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : state === 'done' ? (
                                '✓'
                              ) : state === 'failed' ? (
                                '✕'
                              ) : (
                                i + 1
                              )}
                            </div>
                            <span>{step.label}</span>
                            <span className="text-[9px] font-mono font-normal text-slate-500 truncate max-w-full">{step.sub}</span>
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>

                {/* Response Card */}
                {!run && (
                  <div className="bg-slate-900/50 border border-dashed border-slate-800 p-6 rounded-2xl text-center text-xs text-slate-500">
                    Submit the form to create an order, route the payment across the bank rails and see every attempt here.
                  </div>
                )}

                {run && (run.phase === 'created' || run.phase === 'routing') && (
                  <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl flex items-center gap-3 text-xs text-slate-300">
                    <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
                    {run.phase === 'created'
                      ? 'Creating the order…'
                      : run.replay
                        ? `Replaying key ${run.idempotencyKey} against ${run.orderId}…`
                        : `Routing ${run.orderId} across the bank rails…`}
                  </div>
                )}

                {run && run.phase === 'error' && run.error && (
                  <div className="border p-6 rounded-2xl shadow-2xl space-y-3 bg-rose-950/30 border-rose-800/80">
                    <div className="flex items-center gap-3">
                      <XCircle className="w-7 h-7 text-rose-400" />
                      <div>
                        <h3 className="font-bold text-base text-white">
                          {run.error.status === 0 ? 'Gateway unreachable' : 'Request rejected'}
                        </h3>
                        <p className="text-xs text-slate-400">
                          {run.failedStep === 1 ? 'The order could not be created; no payment was made.' : `Order ${run.orderId} was created, but no payment was made.`}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-rose-200 bg-slate-950/60 border border-rose-900/60 rounded-xl p-3">
                      {run.error.message}
                      {run.error.status > 0 && (
                        <span className="block text-[10px] font-mono text-rose-400/80 mt-1">
                          HTTP {run.error.status}{run.error.code ? ` · ${run.error.code}` : ''}{run.error.reason ? ` · ${run.error.reason}` : ''}
                        </span>
                      )}
                    </p>
                    {run.error.hint && <p className="text-[11px] text-amber-300">{run.error.hint}</p>}
                  </div>
                )}

                {run && run.phase === 'done' && (
                  <div className={`border p-6 rounded-2xl shadow-2xl space-y-4 ${
                    runSucceeded
                      ? 'bg-emerald-950/30 border-emerald-800/80'
                      : 'bg-rose-950/30 border-rose-800/80'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {runSucceeded ? (
                          <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                        ) : (
                          <XCircle className="w-7 h-7 text-rose-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <h3 className="font-bold text-base text-white">
                            Payment {run.payment ? paymentLabel(run.payment) : runStatus}
                          </h3>
                          <p className="text-xs text-slate-400 font-mono truncate">
                            ID: {run.payment?.id ?? run.result?.payment_id ?? '—'}
                          </p>
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase shrink-0 ${
                        run.payment ? statusBadgeClass(run.payment) : runSucceeded ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
                      }`}>
                        {run.payment ? paymentLabel(run.payment) : runStatus}
                      </span>
                    </div>

                    {run.replay && (
                      <div className="bg-indigo-950/50 border border-indigo-800/70 rounded-xl p-3 text-[11px] text-indigo-200 flex items-start gap-2">
                        <Repeat className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                        <span>
                          Idempotent replay: key <code className="font-mono text-indigo-300">{run.idempotencyKey}</code> was already used for order{' '}
                          <code className="font-mono text-indigo-300">{run.orderId}</code>, so the gateway returned the original payment instead of charging again
                          {run.payment && run.payment.amount !== formAmountPaise ? ' (the amount field was ignored)' : ''}.
                        </span>
                      </div>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs pt-1">
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Order ID</span>
                        <span className="font-mono text-slate-200 break-all">{run.orderId ?? '—'}</span>
                      </div>
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Provider</span>
                        <span className="font-bold text-indigo-400 text-sm">{providerName(run.payment?.provider)}</span>
                      </div>
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Amount</span>
                        <span className="font-bold text-white">{run.payment ? formatInr(run.payment.amount) : '—'}</span>
                      </div>
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Method</span>
                        <span className="font-mono text-slate-200 break-all">
                          {run.payment ? `${run.payment.method}${methodDetail(run.payment) ? ` · ${methodDetail(run.payment)}` : ''}` : '—'}
                        </span>
                      </div>
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Bank Reference</span>
                        <span className="font-mono text-slate-200 break-all">{run.payment?.acquirer_data?.bank_reference ?? '—'}</span>
                      </div>
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 min-w-0">
                        <span className="text-slate-400 block text-[10px]">Fee (incl. GST)</span>
                        <span className="font-mono text-slate-200">{run.payment?.fee != null ? formatInr(run.payment.fee) : '—'}</span>
                      </div>
                    </div>

                    {run.result && (
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/60 text-xs">
                        <span className="text-slate-400 block text-[10px]">Signature · HMAC-SHA256(order_id|payment_id, key_secret)</span>
                        <span className="font-mono text-[11px] text-slate-300 break-all">{run.result.signature}</span>
                      </div>
                    )}

                    {run.error && (
                      <div className="bg-slate-950/80 p-3 rounded-xl border border-rose-900/70 text-xs space-y-1">
                        <span className="text-rose-300 block text-[10px] font-bold uppercase">
                          {run.error.status === 502 ? 'All bank rails unavailable (HTTP 502)' : `Declined (HTTP ${run.error.status})`}
                        </span>
                        <span className="text-rose-200 block">{run.payment?.error_description ?? run.error.message}</span>
                        <span className="text-[10px] font-mono text-rose-400/80 block">
                          {[run.payment?.error_code ?? run.error.code, run.payment?.error_reason ?? run.error.reason, run.payment?.error_source, run.payment?.error_step]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                    )}

                    {/* Routing trail */}
                    <div className="space-y-2">
                      <span className="text-slate-400 block text-[10px] font-semibold uppercase tracking-wider">Routing Attempts</span>
                      {run.attempts ? (
                        <AttemptTrail attempts={run.attempts} />
                      ) : (
                        <p className="text-[11px] text-slate-500">Attempts unavailable{run.detailsError ? `: ${run.detailsError}` : '.'}</p>
                      )}
                    </div>

                    {run.payment && isRefundable(run.payment) && (
                      <button
                        type="button"
                        onClick={() => run.payment && openRefund(run.payment)}
                        className="bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/80 px-3 py-1.5 rounded-lg text-[11px] font-bold transition flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Refund this payment
                      </button>
                    )}

                    {/* Raw JSON Inspector */}
                    <div className="bg-slate-950 rounded-xl p-3 text-[11px] font-mono text-slate-300 border border-slate-800/80 overflow-x-auto">
                      <span className="text-slate-500 block mb-1 font-sans text-[10px] font-semibold">REST JSON Payload:</span>
                      <pre>{JSON.stringify(run.payment ?? run.result, null, 2)}</pre>
                    </div>
                  </div>
                )}

              </div>

            </div>
          </div>
        )}

        {/* TAB: ANALYTICS DASHBOARD */}
        {activeTab === 'analytics' && (
          <AnalyticsDashboard />
        )}

        {/* TAB: CIRCUITS & IDEMPOTENCY */}
        {activeTab === 'circuits' && (
          <CircuitBreakerMatrix />
        )}

        {/* TAB: WEBHOOK INSPECTOR */}
        {activeTab === 'webhooks' && (
          <WebhookInspector />
        )}

        {/* TAB: API KEYS */}
        {activeTab === 'apikeys' && (
          <ApiKeysPortal />
        )}

        {/* TAB: CHAOS CONTROL MATRIX */}
        {activeTab === 'chaos' && (
          <div className="space-y-6">
            <div className="bg-rose-950/30 border border-rose-800/60 p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-rose-300 flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-rose-400" /> Chaos Engineering Controls
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">Kill provider rails or inject latency to test Resilience4j circuit breakers & automated failover.</p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {chaosMessage && (
                  <span className={`text-xs px-3 py-1.5 rounded-lg border font-medium ${
                    chaosMessage.tone === 'ok'
                      ? 'bg-rose-950 text-rose-300 border-rose-800/80'
                      : 'bg-slate-950 text-amber-300 border-amber-800/80'
                  }`}>
                    {chaosMessage.text}
                  </span>
                )}
                <button
                  onClick={handleChaosRestoreAll}
                  disabled={chaosBusy !== null || bankOnline === false}
                  className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition whitespace-nowrap flex items-center gap-1.5"
                >
                  {chaosBusy === 'restore:all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '🟢'} Restore all
                </button>
              </div>
            </div>

            {bankOnline === false && (
              <div className="bg-slate-900 border border-rose-800/60 p-6 rounded-2xl text-center text-xs text-slate-300 space-y-1">
                <p className="font-bold text-rose-300">Bank simulator unreachable</p>
                <p className="text-slate-400">
                  Cannot reach {config.bankSimulatorUrl}. Start the bank simulator; this view refreshes every few seconds.
                </p>
              </div>
            )}

            {bankOnline === null && providerList.length === 0 && (
              <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading rail status…
              </div>
            )}

            {bankOnline !== false && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {providerList.map((p) => {
                  const defaultLatency = DEFAULT_LATENCY_MS[p.id] ?? 120;
                  const busy = chaosBusy !== null && chaosBusy.endsWith(`:${p.id}`);
                  return (
                    <div key={p.id} className={`bg-slate-900 border p-5 rounded-2xl shadow-xl flex flex-col justify-between space-y-4 ${
                      p.is_killed ? 'border-rose-800/80 bg-rose-950/10' : 'border-slate-800'
                    }`}>
                      <div>
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="font-bold text-sm text-white">{p.name}</h3>
                            <p className="text-xs text-slate-500 font-mono">{p.id}</p>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                            p.is_killed ? 'bg-rose-950 text-rose-400 border border-rose-800' : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          }`}>
                            {p.is_killed ? 'OFFLINE' : 'ONLINE'}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
                          <div className="bg-slate-950 p-2 rounded-xl border border-slate-800/60">
                            <span className="text-slate-500 text-[10px] block">Success Rate</span>
                            <span className="font-bold text-emerald-400 font-mono text-xs">{(p.success_rate * 100).toFixed(0)}%</span>
                          </div>
                          <div className="bg-slate-950 p-2 rounded-xl border border-slate-800/60">
                            <span className="text-slate-500 text-[10px] block">Mock Latency</span>
                            <span className={`font-bold font-mono text-xs ${p.latency_ms > defaultLatency ? 'text-amber-400' : 'text-slate-300'}`}>{p.latency_ms}ms</span>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 pt-2 border-t border-slate-800/80 text-xs">
                        {p.is_killed ? (
                          <button
                            onClick={() => handleChaosRestore(p.id)}
                            disabled={busy}
                            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-2 rounded-xl transition"
                          >
                            🟢 Restore Provider Rail
                          </button>
                        ) : (
                          <button
                            onClick={() => handleChaosKill(p.id)}
                            disabled={busy}
                            className="w-full bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold py-2 rounded-xl transition shadow-lg shadow-rose-600/30"
                          >
                            🔴 Inject Kill Switch (Failover Demo)
                          </button>
                        )}

                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <button
                            onClick={() => handleChaosLatency(p.id, 3000, `Injected 3000ms delay into ${p.name}.`)}
                            disabled={busy}
                            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[11px] py-1.5 rounded-lg border border-slate-700 transition"
                          >
                            ⏱️ Add 3s Delay
                          </button>
                          <button
                            onClick={() => handleChaosLatency(p.id, defaultLatency, `Reset ${p.name} latency to ${defaultLatency}ms.`)}
                            disabled={busy}
                            className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[11px] py-1.5 rounded-lg border border-slate-700 transition"
                          >
                            🔄 Reset Delay
                          </button>
                        </div>
                      </div>

                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB: TRANSACTION LEDGER WITH 1-CLICK REFUND */}
        {activeTab === 'ledger' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center gap-3 bg-slate-950">
              <div>
                <h2 className="font-bold text-sm text-white flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" /> PostgreSQL Payment Ledger
                </h2>
                <p className="text-xs text-slate-400">
                  Payments of the sandbox merchant{keys ? ` ${keys.keyId}` : ''}, newest first. Refreshes every {LEDGER_POLL_MS / 1000}s
                  {ledgerUpdatedAt ? ` · updated ${ledgerUpdatedAt.toLocaleTimeString()}` : ''}.
                </p>
              </div>
              <button
                onClick={fetchLedger}
                disabled={ledgerLoading}
                className="bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1.5 font-semibold"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${ledgerLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>

            {ledgerError && (
              <div className="px-4 py-2.5 bg-rose-950/40 border-b border-rose-900/60 text-xs text-rose-300 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {ledgerError}
                {payments.length > 0 && <span className="text-rose-400/70">(showing the last loaded rows)</span>}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="p-3.5">Payment ID</th>
                    <th className="p-3.5">Order ID</th>
                    <th className="p-3.5">Amount (INR)</th>
                    <th className="p-3.5">Method</th>
                    <th className="p-3.5">Provider</th>
                    <th className="p-3.5">Status</th>
                    <th className="p-3.5">Refunded</th>
                    <th className="p-3.5">Time</th>
                    <th className="p-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {!ledgerLoaded ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-500 font-sans">
                        <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading payments…</span>
                      </td>
                    </tr>
                  ) : payments.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-500 font-sans">
                        {ledgerError
                          ? 'The ledger could not be loaded.'
                          : 'No payments yet. Submit a test payment from the Checkout tab or launch the Checkout modal!'}
                      </td>
                    </tr>
                  ) : (
                    payments.map((p) => {
                      const expanded = expandedPaymentId === p.id;
                      const details = rowDetails[p.id];
                      const created = fromUnix(p.created_at);
                      const detail = methodDetail(p);
                      return (
                        <React.Fragment key={p.id}>
                          <tr className={`hover:bg-slate-800/40 transition ${expanded ? 'bg-slate-800/30' : ''}`}>
                            <td className="p-3.5 font-bold text-white whitespace-nowrap">{p.id}</td>
                            <td className="p-3.5 text-slate-400 whitespace-nowrap">{p.order_id}</td>
                            <td className="p-3.5 font-bold text-slate-200 whitespace-nowrap">{formatInr(p.amount)}</td>
                            <td className="p-3.5">
                              <div className="text-indigo-400 font-semibold uppercase">{p.method}</div>
                              {detail && <div className="text-[10px] text-slate-500 font-sans">{detail}</div>}
                            </td>
                            <td className="p-3.5">
                              <span className="px-2 py-0.5 bg-indigo-950 text-indigo-300 border border-indigo-800/60 rounded font-sans text-[10px] font-bold whitespace-nowrap">
                                {providerName(p.provider)}
                              </span>
                              {p.attempts > 1 && (
                                <div className="text-[10px] text-slate-500 font-sans mt-0.5">{p.attempts} attempts</div>
                              )}
                            </td>
                            <td className="p-3.5 font-sans">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase whitespace-nowrap ${statusBadgeClass(p)}`}>
                                {paymentLabel(p)}
                              </span>
                            </td>
                            <td className={`p-3.5 whitespace-nowrap ${p.amount_refunded > 0 ? 'text-rose-400' : 'text-slate-600'}`}>
                              {p.amount_refunded > 0 ? formatInr(p.amount_refunded) : '—'}
                            </td>
                            <td className="p-3.5 text-slate-500 text-[10px] whitespace-nowrap">{created ? created.toLocaleString() : '—'}</td>
                            <td className="p-3.5 text-right font-sans">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => toggleRow(p.id)}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded-lg text-[10px] font-bold transition flex items-center gap-1"
                                >
                                  {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Details
                                </button>
                                {isRefundable(p) && (
                                  <button
                                    onClick={() => openRefund(p)}
                                    className="bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/80 px-2.5 py-1 rounded-lg text-[10px] font-bold transition flex items-center gap-1"
                                  >
                                    <RotateCcw className="w-3 h-3" /> Refund
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="bg-slate-950/60">
                              <td colSpan={9} className="p-4">
                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                  <div className="lg:col-span-2 space-y-2">
                                    <span className="text-slate-400 block text-[10px] font-sans font-semibold uppercase tracking-wider">Routing Attempts</span>
                                    {details?.attempts ? (
                                      <AttemptTrail attempts={details.attempts} />
                                    ) : details?.loading ? (
                                      <p className="text-[11px] text-slate-500 font-sans flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading attempts…</p>
                                    ) : (
                                      <p className="text-[11px] text-rose-300 font-sans">{details?.error ?? 'Attempts unavailable.'}</p>
                                    )}
                                  </div>
                                  <div className="space-y-2 font-sans text-[11px]">
                                    <span className="text-slate-400 block text-[10px] font-semibold uppercase tracking-wider">Payment</span>
                                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-1">
                                      <div className="flex justify-between gap-2"><span className="text-slate-500">Bank ref</span><span className="font-mono text-slate-300 break-all text-right">{p.acquirer_data?.bank_reference ?? '—'}</span></div>
                                      <div className="flex justify-between gap-2"><span className="text-slate-500">Captured</span><span className="text-slate-300">{p.captured ? 'yes' : 'no'}</span></div>
                                      <div className="flex justify-between gap-2"><span className="text-slate-500">Fee / GST</span><span className="font-mono text-slate-300">{p.fee != null ? `${formatInr(p.fee)} / ${formatInr(p.tax)}` : '—'}</span></div>
                                      {p.error_description && (
                                        <div className="pt-1 border-t border-slate-800 text-rose-300">
                                          {p.error_description}
                                          <span className="block font-mono text-[10px] text-rose-400/70">{[p.error_code, p.error_reason].filter(Boolean).join(' · ')}</span>
                                        </div>
                                      )}
                                    </div>
                                    {details?.refunds && details.refunds.length > 0 && (
                                      <>
                                        <span className="text-slate-400 block text-[10px] font-semibold uppercase tracking-wider pt-1">Refunds</span>
                                        <ul className="space-y-1">
                                          {details.refunds.map((r) => (
                                            <li key={r.id} className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                                              <span className="font-mono text-slate-300">{r.id}</span>
                                              <span className="font-mono text-rose-400">{formatInr(r.amount)}</span>
                                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                                                r.status === 'processed'
                                                  ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                                                  : r.status === 'pending'
                                                    ? 'bg-amber-950 text-amber-400 border-amber-800'
                                                    : 'bg-rose-950 text-rose-400 border-rose-800'
                                              }`}>{r.status}</span>
                                              {r.acquirer_data?.arn && <span className="basis-full font-mono text-[10px] text-slate-500">ARN {r.acquirer_data.arn}</span>}
                                              {r.status === 'pending' && <span className="basis-full text-[10px] text-amber-300/80">Rail unavailable; the gateway retries automatically.</span>}
                                            </li>
                                          ))}
                                        </ul>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SERVICE PORT UI TABS */}
        {activeTab === 'port-8080' && <Port8080Orchestrator />}
        {activeTab === 'port-8081' && <Port8081BankSimulator />}
        {activeTab === 'port-8000' && <Port8000AiRouter />}
        {activeTab === 'port-8002' && <Port8002FraudDetector />}
        {activeTab === 'port-5432' && <Port5432Postgres />}
        {activeTab === 'port-6380' && <Port6380Redis />}
        {activeTab === 'port-9092' && <Port9092Kafka />}
        {activeTab === 'port-9090' && <Port9090Prometheus />}
      </main>
    </div>
  );
}

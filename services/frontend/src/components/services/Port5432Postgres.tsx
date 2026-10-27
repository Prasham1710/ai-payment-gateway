'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Terminal, RefreshCw, Layers, Table, Copy, ExternalLink, Key, TriangleAlert, Eye } from 'lucide-react';
import {
  GatewayError,
  PROVIDER_NAMES,
  formatInr,
  fromUnix,
  loadKeys,
  onKeysChanged,
  orchestrator,
  paymentLabel,
  type GatewayPayment,
  type PaymentStatus,
} from '@/lib/gateway';

/** Database the running orchestrator uses (container payment_postgres, port 5432). */
const DB_NAME = 'payment_gateway';
/** pgAdmin is not part of this repo; it is an optional external tool. Plain link only. */
const PGADMIN_URL = 'http://localhost:5050';
const RECORD_POLL_MS = 10000;
const ROW_COUNTS = [10, 25, 50, 100];

interface SchemaColumn {
  name: string;
  type: string;
  constraint: string;
  description: string;
}

interface SchemaTable {
  name: string;
  summary: string;
  columns: SchemaColumn[];
  indexes: string[];
}

// Mirrors the live payment_gateway schema (information_schema + pg_indexes + check constraints).
// Amount columns are bigint paise; enum columns store the uppercase Java enum name and the API lowercases them.
const SCHEMA: SchemaTable[] = [
  {
    name: 'payments',
    summary: 'One row per checkout attempt on an order; the Razorpay-style payment entity.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Payment id (pay_…)' },
      { name: 'merchant_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Owning merchant (acc_…)' },
      { name: 'order_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Order being paid (order_…)' },
      { name: 'amount', type: 'bigint', constraint: 'NOT NULL', description: 'Amount in paise' },
      { name: 'currency', type: 'varchar(3)', constraint: 'NOT NULL', description: 'ISO currency, INR' },
      { name: 'status', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'CREATED | AUTHORIZED | CAPTURED | REFUNDED | FAILED' },
      { name: 'method', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'UPI | CARD | NETBANKING' },
      { name: 'captured', type: 'boolean', constraint: 'NOT NULL', description: 'True once captured (stays true after refunds)' },
      { name: 'captured_at', type: 'timestamptz', constraint: 'NULL', description: 'When the payment was captured' },
      { name: 'amount_refunded', type: 'bigint', constraint: 'NOT NULL', description: 'Refunded so far, in paise' },
      { name: 'refund_status', type: 'varchar(10)', constraint: 'NULL, CHECK', description: 'PARTIAL | FULL' },
      { name: 'vpa', type: 'varchar(100)', constraint: 'NULL', description: 'UPI id for upi payments' },
      { name: 'bank', type: 'varchar(10)', constraint: 'NULL', description: 'Net banking bank code (HDFC, ICIC, SBIN, UTIB, KKBK)' },
      { name: 'card_last4', type: 'varchar(4)', constraint: 'NULL', description: 'Last four digits; full PAN and CVV are never stored' },
      { name: 'card_network', type: 'varchar(20)', constraint: 'NULL', description: 'Visa, MasterCard, RuPay, …' },
      { name: 'email', type: 'varchar(254)', constraint: 'NULL', description: 'Customer email' },
      { name: 'contact', type: 'varchar(20)', constraint: 'NULL', description: 'Customer phone' },
      { name: 'fee', type: 'bigint', constraint: 'NULL', description: 'Platform fee incl. GST, paise; set on capture' },
      { name: 'tax', type: 'bigint', constraint: 'NULL', description: 'GST part of fee, paise' },
      { name: 'provider', type: 'varchar(30)', constraint: 'NULL', description: 'Rail that processed it (provider-a/b/c)' },
      { name: 'provider_transaction_id', type: 'varchar(64)', constraint: 'NULL', description: 'Our tx id on that rail, used for refunds' },
      { name: 'bank_reference', type: 'varchar(64)', constraint: 'NULL', description: 'Bank authorization reference' },
      { name: 'attempts', type: 'integer', constraint: 'NOT NULL', description: 'Rails tried while routing' },
      { name: 'error_code', type: 'varchar(40)', constraint: 'NULL', description: 'BAD_REQUEST_ERROR, GATEWAY_ERROR, SERVER_ERROR' },
      { name: 'error_description', type: 'varchar(255)', constraint: 'NULL', description: 'Human-readable failure' },
      { name: 'error_source', type: 'varchar(40)', constraint: 'NULL', description: 'bank, gateway or business' },
      { name: 'error_step', type: 'varchar(60)', constraint: 'NULL', description: 'Step that failed, e.g. payment_authorization' },
      { name: 'error_reason', type: 'varchar(60)', constraint: 'NULL', description: 'Machine-readable reason' },
      { name: 'idempotency_key', type: 'varchar(64)', constraint: 'UNIQUE w/ merchant_id', description: 'Checkout Idempotency-Key header' },
      { name: 'reconcile_until', type: 'timestamptz', constraint: 'NULL', description: 'Keep asking the bank until then (unknown outcome)' },
      { name: 'reconcile_after', type: 'timestamptz', constraint: 'NULL', description: 'Next reconciliation check' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Creation time' },
    ],
    indexes: [
      'payments_pkey (id)',
      'idx_payment_idempotency UNIQUE (merchant_id, idempotency_key)',
      'idx_payment_merchant_created (merchant_id, created_at)',
      'idx_payment_order (order_id)',
      'idx_payment_status_created (status, created_at)',
      'idx_payment_reconcile (reconcile_after)',
    ],
  },
  {
    name: 'transactions',
    summary: 'One row per rail attempt while routing a payment; GET /v1/payments/{id}/attempts reads these.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Attempt id (tx_…), also the transaction id sent to the bank' },
      { name: 'payment_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'References payments.id' },
      { name: 'provider_id', type: 'varchar(30)', constraint: 'NOT NULL', description: 'Rail tried (provider-a/b/c)' },
      { name: 'amount', type: 'bigint', constraint: 'NOT NULL', description: 'Amount in paise' },
      { name: 'status', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'SUCCESS | DECLINED | UNAVAILABLE | UNKNOWN' },
      { name: 'response_code', type: 'varchar(10)', constraint: 'NULL', description: 'Bank code, or CB_OPEN when skipped by the breaker' },
      { name: 'message', type: 'varchar(255)', constraint: 'NULL', description: 'Bank or gateway message' },
      { name: 'bank_reference', type: 'varchar(64)', constraint: 'NULL', description: 'Set on SUCCESS' },
      { name: 'latency_ms', type: 'integer', constraint: 'NULL', description: 'Bank round trip; 0 for CB_OPEN skips' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Written before the charge is sent' },
    ],
    indexes: ['transactions_pkey (id)', 'idx_tx_payment (payment_id)', 'idx_tx_provider (provider_id)'],
  },
  {
    name: 'orders',
    summary: 'Created by the merchant server before checkout; fixes the amount the customer pays.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Order id (order_…)' },
      { name: 'merchant_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Owning merchant' },
      { name: 'amount', type: 'bigint', constraint: 'NOT NULL', description: 'Amount in paise' },
      { name: 'amount_paid', type: 'bigint', constraint: 'NOT NULL', description: 'Paid so far, in paise' },
      { name: 'currency', type: 'varchar(3)', constraint: 'NOT NULL', description: 'INR' },
      { name: 'receipt', type: 'varchar(40)', constraint: 'NULL', description: 'Merchant receipt number' },
      { name: 'status', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'CREATED | ATTEMPTED | PAID' },
      { name: 'attempts', type: 'integer', constraint: 'NOT NULL', description: 'Payments attempted on the order' },
      { name: 'payment_capture', type: 'boolean', constraint: 'NOT NULL', description: 'Auto-capture on authorization' },
      { name: 'notes', type: 'varchar(8000)', constraint: 'NULL', description: 'Key/value notes as JSON' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Creation time' },
    ],
    indexes: ['orders_pkey (id)', 'idx_order_merchant_created (merchant_id, created_at)'],
  },
  {
    name: 'refunds',
    summary: 'Refunds against captured (or reversed authorized) payments, retried until the bank answers.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Refund id (rfnd_…)' },
      { name: 'merchant_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Owning merchant' },
      { name: 'payment_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Refunded payment' },
      { name: 'amount', type: 'bigint', constraint: 'NOT NULL', description: 'Amount in paise' },
      { name: 'currency', type: 'varchar(3)', constraint: 'NOT NULL', description: 'INR' },
      { name: 'status', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'PENDING | PROCESSED | FAILED' },
      { name: 'receipt', type: 'varchar(40)', constraint: 'NULL', description: 'Merchant receipt number' },
      { name: 'notes', type: 'varchar(8000)', constraint: 'NULL', description: 'Key/value notes as JSON' },
      { name: 'provider', type: 'varchar(30)', constraint: 'NULL', description: 'Rail the refund goes through' },
      { name: 'arn', type: 'varchar(64)', constraint: 'NULL', description: 'Acquirer reference number once processed' },
      { name: 'attempts', type: 'integer', constraint: 'NOT NULL', description: 'Bank calls made' },
      { name: 'outcome_unknown', type: 'boolean', constraint: 'NOT NULL DEFAULT false', description: 'An attempt got no usable answer; never failed on a guess' },
      { name: 'next_attempt_at', type: 'timestamptz', constraint: 'NULL', description: 'Next retry' },
      { name: 'failure_reason', type: 'varchar(255)', constraint: 'NULL', description: 'Why it failed' },
      { name: 'idempotency_key', type: 'varchar(64)', constraint: 'UNIQUE w/ merchant_id', description: 'Refund Idempotency-Key header' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Creation time' },
      { name: 'processed_at', type: 'timestamptz', constraint: 'NULL', description: 'When the bank confirmed it' },
    ],
    indexes: [
      'refunds_pkey (id)',
      'idx_refund_idempotency UNIQUE (merchant_id, idempotency_key)',
      'idx_refund_payment (payment_id)',
      'idx_refund_merchant_created (merchant_id, created_at)',
      'idx_refund_due (status, next_attempt_at)',
    ],
  },
  {
    name: 'merchants',
    summary: 'Merchant accounts and their API keys.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Merchant id (acc_…)' },
      { name: 'name', type: 'varchar(120)', constraint: 'NOT NULL', description: 'Business name' },
      { name: 'email', type: 'varchar(254)', constraint: 'NOT NULL, UNIQUE', description: 'Account email' },
      { name: 'key_id', type: 'varchar(64)', constraint: 'NOT NULL, UNIQUE', description: 'Public API key id (key_test_…)' },
      { name: 'key_secret_encrypted', type: 'varchar(255)', constraint: 'NOT NULL', description: 'API key secret, AES-256 encrypted at rest' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Sign-up time' },
    ],
    indexes: ['merchants_pkey (id)', 'idx_merchant_key_id UNIQUE (key_id)', 'idx_merchant_email UNIQUE (email)'],
  },
  {
    name: 'webhook_endpoints',
    summary: 'Merchant webhook receivers.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Webhook id (wh_…)' },
      { name: 'merchant_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Owning merchant' },
      { name: 'url', type: 'varchar(2048)', constraint: 'NOT NULL', description: 'Receiver URL' },
      { name: 'secret_encrypted', type: 'varchar(255)', constraint: 'NOT NULL', description: 'Signing secret, encrypted at rest' },
      { name: 'events', type: 'varchar(1000)', constraint: 'NOT NULL', description: 'Comma-separated event names, or *' },
      { name: 'active', type: 'boolean', constraint: 'NOT NULL', description: 'Receives deliveries' },
      { name: 'consecutive_failures', type: 'integer', constraint: 'NOT NULL DEFAULT 0', description: 'Failures in a row; any success resets it' },
      { name: 'paused_until', type: 'timestamptz', constraint: 'NULL', description: 'No deliveries until then (failing endpoint)' },
      { name: 'last_claimed_at', type: 'timestamptz', constraint: 'NULL', description: 'Round-robin fairness between endpoints' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Creation time' },
    ],
    indexes: ['webhook_endpoints_pkey (id)', 'idx_webhook_merchant (merchant_id)'],
  },
  {
    name: 'webhook_deliveries',
    summary: 'Transactional outbox: written with the state change, then delivered and retried.',
    columns: [
      { name: 'id', type: 'varchar(64)', constraint: 'PRIMARY KEY', description: 'Delivery id (whd_…)' },
      { name: 'event_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Shared by every endpoint getting the same event (evt_…)' },
      { name: 'endpoint_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Target webhook endpoint' },
      { name: 'merchant_id', type: 'varchar(64)', constraint: 'NOT NULL', description: 'Owning merchant' },
      { name: 'event', type: 'varchar(60)', constraint: 'NOT NULL', description: 'payment.captured, refund.processed, …' },
      { name: 'payload', type: 'varchar(16000)', constraint: 'NOT NULL', description: 'JSON body sent to the receiver' },
      { name: 'status', type: 'varchar(20)', constraint: 'NOT NULL, CHECK', description: 'PENDING | DELIVERED | FAILED' },
      { name: 'attempts', type: 'integer', constraint: 'NOT NULL', description: 'Delivery attempts so far' },
      { name: 'next_attempt_at', type: 'timestamptz', constraint: 'NULL', description: 'Next retry (exponential backoff)' },
      { name: 'last_response_code', type: 'integer', constraint: 'NULL', description: 'Receiver HTTP status' },
      { name: 'last_error', type: 'varchar(255)', constraint: 'NULL', description: 'Last failure' },
      { name: 'created_at', type: 'timestamptz', constraint: 'NOT NULL', description: 'Enqueued at' },
      { name: 'delivered_at', type: 'timestamptz', constraint: 'NULL', description: 'Acknowledged at' },
    ],
    indexes: [
      'webhook_deliveries_pkey (id)',
      'idx_delivery_due (status, next_attempt_at)',
      'idx_delivery_endpoint (endpoint_id, created_at)',
      'idx_delivery_endpoint_due (endpoint_id, status, next_attempt_at)',
    ],
  },
];

interface SqlExample {
  label: string;
  sql: string;
  columns: string[];
}

const SQL_EXAMPLES: SqlExample[] = [
  {
    label: 'Recent payments',
    sql: `SELECT id, order_id, ROUND(amount / 100.0, 2) AS amount_inr, method, provider, status, created_at
FROM payments
ORDER BY created_at DESC
LIMIT 10;`,
    columns: ['id', 'order_id', 'amount_inr', 'method', 'provider', 'status', 'created_at'],
  },
  {
    label: 'Success rate by rail',
    sql: `-- Rail attempts from transactions; CB_OPEN rows were skipped by the breaker and never reached the bank.
SELECT provider_id,
       COUNT(*) FILTER (WHERE response_code IS DISTINCT FROM 'CB_OPEN') AS sent_to_bank,
       COUNT(*) FILTER (WHERE status = 'SUCCESS') AS approved,
       COUNT(*) FILTER (WHERE status = 'DECLINED') AS declined,
       COUNT(*) FILTER (WHERE response_code = 'CB_OPEN') AS skipped_by_breaker,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'SUCCESS')
             / NULLIF(COUNT(*) FILTER (WHERE response_code IS DISTINCT FROM 'CB_OPEN'), 0), 1) AS success_rate_pct,
       ROUND(AVG(latency_ms) FILTER (WHERE response_code IS DISTINCT FROM 'CB_OPEN')) AS avg_latency_ms
FROM transactions
GROUP BY provider_id
ORDER BY provider_id;`,
    columns: ['provider_id', 'sent_to_bank', 'approved', 'declined', 'skipped_by_breaker', 'success_rate_pct', 'avg_latency_ms'],
  },
  {
    label: 'Captured volume by day',
    sql: `SELECT (captured_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
       COUNT(*) AS captured_payments,
       ROUND(SUM(amount) / 100.0, 2) AS captured_inr,
       ROUND(SUM(fee) / 100.0, 2) AS fees_inr,
       ROUND(SUM(tax) / 100.0, 2) AS gst_inr
FROM payments
WHERE captured
GROUP BY 1
ORDER BY 1 DESC;`,
    columns: ['day', 'captured_payments', 'captured_inr', 'fees_inr', 'gst_inr'],
  },
  {
    label: 'Status × method',
    sql: `SELECT status, method, COUNT(*) AS payments, ROUND(SUM(amount) / 100.0, 2) AS volume_inr
FROM payments
GROUP BY status, method
ORDER BY payments DESC;`,
    columns: ['status', 'method', 'payments', 'volume_inr'],
  },
  {
    label: 'Idempotency audit',
    sql: `-- Always empty: idx_payment_idempotency is UNIQUE (merchant_id, idempotency_key).
SELECT merchant_id, idempotency_key, COUNT(*) AS payments
FROM payments
WHERE idempotency_key IS NOT NULL
GROUP BY merchant_id, idempotency_key
HAVING COUNT(*) > 1;`,
    columns: ['merchant_id', 'idempotency_key', 'payments'],
  },
  {
    label: 'Refunds not yet processed',
    sql: `SELECT id, payment_id, ROUND(amount / 100.0, 2) AS amount_inr, status, attempts, outcome_unknown, next_attempt_at, failure_reason
FROM refunds
WHERE status <> 'PROCESSED'
ORDER BY created_at DESC;`,
    columns: ['id', 'payment_id', 'amount_inr', 'status', 'attempts', 'outcome_unknown', 'next_attempt_at', 'failure_reason'],
  },
  {
    label: 'Webhook backlog',
    sql: `SELECT e.url, d.status, COUNT(*) AS deliveries, MAX(d.attempts) AS max_attempts, MIN(d.next_attempt_at) AS next_retry
FROM webhook_deliveries d
JOIN webhook_endpoints e ON e.id = d.endpoint_id
GROUP BY e.url, d.status
ORDER BY e.url, d.status;`,
    columns: ['url', 'status', 'deliveries', 'max_attempts', 'next_retry'],
  },
];

const STATUS_FILTERS: ('all' | PaymentStatus)[] = ['all', 'created', 'authorized', 'captured', 'refunded', 'failed'];

const STATUS_BADGE: Record<string, string> = {
  created: 'bg-slate-800 text-slate-300 border-slate-700',
  authorized: 'bg-blue-950 text-blue-300 border-blue-800',
  captured: 'bg-emerald-950 text-emerald-400 border-emerald-800',
  refunded: 'bg-rose-950 text-rose-300 border-rose-800',
  'partially refunded': 'bg-amber-950 text-amber-300 border-amber-800',
  failed: 'bg-red-950 text-red-400 border-red-800',
};

export default function Port5432Postgres() {
  const [viewMode, setViewMode] = useState<'records' | 'workbench'>('records');
  const [activeTable, setActiveTable] = useState<string>('payments');

  // Live record viewer
  const [rows, setRows] = useState<GatewayPayment[] | null>(null);
  const [rowCount, setRowCount] = useState<number>(25);
  const [statusFilter, setStatusFilter] = useState<'all' | PaymentStatus>('all');
  const [recordsError, setRecordsError] = useState<{ message: string; network: boolean } | null>(null);
  const [recordsLoading, setRecordsLoading] = useState<boolean>(false);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);

  // SQL workbench (preview only)
  const [queryInput, setQueryInput] = useState<string>(SQL_EXAMPLES[0].sql);
  const [copied, setCopied] = useState<boolean>(false);

  const mounted = useRef(true);
  const inFlight = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecords = useCallback(async (count: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRecordsLoading(true);
    try {
      const page = await orchestrator.listPayments(count);
      if (!mounted.current) return;
      setRows(page.items);
      setRecordsError(null);
      setLastLoaded(new Date());
      setMerchantId(loadKeys()?.merchantId ?? null);
    } catch (e) {
      if (mounted.current) {
        setRecordsError({ message: e instanceof Error ? e.message : String(e), network: e instanceof GatewayError && e.isNetworkError });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadRecords(rowCount);
    const interval = setInterval(() => void loadRecords(rowCount), RECORD_POLL_MS);
    const unsubscribe = onKeysChanged(() => void loadRecords(rowCount));
    return () => {
      mounted.current = false;
      clearInterval(interval);
      unsubscribe();
    };
  }, [loadRecords, rowCount]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(queryInput);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (insecure context or permission): the query stays selectable in the editor
    }
  };

  const visibleRows = rows ? rows.filter((r) => statusFilter === 'all' || r.status === statusFilter) : [];
  const schemaTable = SCHEMA.find((t) => t.name === activeTable) ?? SCHEMA[0];
  const matchedExample = SQL_EXAMPLES.find((ex) => ex.sql === queryInput) ?? null;
  const ledgerReadable = rows !== null && recordsError === null;

  return (
    <div className="space-y-6">
      {/* HEADER BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20 font-mono font-bold text-xl">
            5432
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black text-white tracking-tight">PostgreSQL Database UI</h2>
              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full border border-blue-700/60 bg-blue-950/80 text-blue-300 font-semibold">
                PostgreSQL 16 Alpine
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Ledger database <code className="text-blue-300">{DB_NAME}</code>: merchants, orders, payments, transactions (one row per rail
              attempt), refunds, webhook_endpoints and webhook_deliveries. Schema is managed by the orchestrator (Hibernate).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <a
            href={PGADMIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Optional external tool, not part of this repo"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-600/20 whitespace-nowrap"
          >
            <ExternalLink className="w-3.5 h-3.5" /> pgAdmin :5050 (optional)
          </a>
          <div
            className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs font-mono text-slate-300 whitespace-nowrap"
            title="The browser cannot reach PostgreSQL directly; this reflects whether the orchestrator could read the payments table."
          >
            <span
              className={`w-2 h-2 rounded-full ${ledgerReadable ? 'bg-emerald-400 animate-pulse' : recordsError ? 'bg-rose-500' : 'bg-slate-500'}`}
            />
            <span>{ledgerReadable ? 'LEDGER READABLE VIA :8080' : recordsError ? 'LEDGER UNREACHABLE' : 'CHECKING...'}</span>
          </div>
        </div>
      </div>

      {/* VIEW SWITCHER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-slate-900 border border-slate-800 p-2 rounded-2xl gap-3">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('records')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold font-mono transition ${
              viewMode === 'records' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white bg-slate-950/60'
            }`}
          >
            <Eye className="w-3.5 h-3.5 text-blue-300" /> Live Records & Schema
          </button>
          <button
            onClick={() => setViewMode('workbench')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold font-mono transition ${
              viewMode === 'workbench' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white bg-slate-950/60'
            }`}
          >
            <Terminal className="w-3.5 h-3.5 text-cyan-300" /> SQL Workbench & pgAdmin
          </button>
        </div>

        <div className="text-[11px] font-mono text-slate-400 pr-2">
          Container: <strong className="text-white">payment_postgres</strong> · db <strong className="text-white">{DB_NAME}</strong> on port
          5432
        </div>
      </div>

      {/* VIEW 1: LIVE RECORDS + SCHEMA */}
      {viewMode === 'records' && (
        <div className="space-y-6">
          {/* LIVE RECORD VIEWER */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                  <Table className="w-4 h-4 text-blue-400" /> Live Record Viewer: payments
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Rows of the sandbox merchant{merchantId ? <span className="font-mono text-slate-400"> {merchantId}</span> : null}, read
                  through <span className="font-mono">GET /v1/payments</span> (the browser has no direct database connection). Refreshes every{' '}
                  {RECORD_POLL_MS / 1000}s.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | PaymentStatus)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-slate-300 outline-none focus:ring-1 focus:ring-blue-500"
                  aria-label="Filter by status"
                >
                  {STATUS_FILTERS.map((s) => (
                    <option key={s} value={s}>
                      status: {s}
                    </option>
                  ))}
                </select>
                <select
                  value={rowCount}
                  onChange={(e) => setRowCount(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-slate-300 outline-none focus:ring-1 focus:ring-blue-500"
                  aria-label="Rows to load"
                >
                  {ROW_COUNTS.map((n) => (
                    <option key={n} value={n}>
                      LIMIT {n}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void loadRecords(rowCount)}
                  disabled={recordsLoading}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 rounded-lg border border-slate-700 transition"
                >
                  <RefreshCw className={`w-3 h-3 ${recordsLoading ? 'animate-spin' : ''}`} /> Refresh
                </button>
              </div>
            </div>

            {recordsError && (
              <div className="bg-rose-950/40 border border-rose-800/60 rounded-xl p-3 text-xs text-rose-200 flex items-start gap-2">
                <TriangleAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  {rows ? 'Refresh failed; showing the last loaded rows. ' : ''}
                  {recordsError.message}
                  {recordsError.network && (
                    <span className="block text-rose-300/80 mt-0.5">Start the payment orchestrator (port 8080); it reads this database.</span>
                  )}
                </div>
              </div>
            )}

            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <div className="bg-slate-950 px-4 py-2 border-b border-slate-800 flex justify-between items-center text-xs font-mono text-slate-400">
                <span>
                  {rows ? `${visibleRows.length} of ${rows.length} rows` : 'No rows loaded yet'}
                  {statusFilter !== 'all' ? ` (status = ${statusFilter})` : ''}
                </span>
                <span className="text-slate-500">{lastLoaded ? `loaded ${lastLoaded.toLocaleTimeString()}` : ''}</span>
              </div>

              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 text-[10px] uppercase">
                    <tr>
                      <th className="px-4 py-2.5">id</th>
                      <th className="px-4 py-2.5">order_id</th>
                      <th className="px-4 py-2.5">amount</th>
                      <th className="px-4 py-2.5">method</th>
                      <th className="px-4 py-2.5">provider</th>
                      <th className="px-4 py-2.5">status</th>
                      <th className="px-4 py-2.5">attempts</th>
                      <th className="px-4 py-2.5">fee</th>
                      <th className="px-4 py-2.5">created_at</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300 text-[11px]">
                    {!rows && !recordsError && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                          <RefreshCw className="w-4 h-4 animate-spin inline mr-2 text-blue-400" /> Loading payments...
                        </td>
                      </tr>
                    )}
                    {rows && visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                          {rows.length === 0
                            ? 'No payments yet for this sandbox merchant. Create one on the Port 8080 console or from the dashboard checkout.'
                            : `No ${statusFilter} payments among the last ${rows.length}.`}
                        </td>
                      </tr>
                    )}
                    {visibleRows.map((r) => {
                      const label = paymentLabel(r);
                      return (
                        <tr key={r.id} className="hover:bg-slate-800/40">
                          <td className="px-4 py-2 font-bold text-indigo-400 whitespace-nowrap">{r.id}</td>
                          <td className="px-4 py-2 text-slate-400 whitespace-nowrap">{r.order_id}</td>
                          <td className="px-4 py-2 font-bold text-white whitespace-nowrap" title={`${r.amount} paise`}>
                            {formatInr(r.amount)}
                          </td>
                          <td className="px-4 py-2">{r.method}</td>
                          <td className="px-4 py-2 text-amber-400 whitespace-nowrap" title={r.provider ? PROVIDER_NAMES[r.provider] : undefined}>
                            {r.provider ?? 'NULL'}
                          </td>
                          <td className="px-4 py-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${STATUS_BADGE[label] ?? STATUS_BADGE.created}`}>
                              {label}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-center">{r.attempts}</td>
                          <td className="px-4 py-2 text-slate-400 whitespace-nowrap">{r.fee != null ? formatInr(r.fee) : 'NULL'}</td>
                          <td className="px-4 py-2 text-slate-500 text-[10px] whitespace-nowrap">{fromUnix(r.created_at)?.toLocaleString() ?? '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Amounts are stored as bigint paise and shown in rupees here; status and method are stored uppercase (CAPTURED, UPI) and the API
              returns them lowercase.
            </p>
          </div>

          {/* SCHEMA INSPECTOR */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-400" /> Relational Schema & Index Inspector
              </h3>
              <div className="flex flex-wrap gap-2">
                {SCHEMA.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => setActiveTable(t.name)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition ${
                      activeTable === t.name ? 'bg-blue-600 text-white' : 'bg-slate-950 text-slate-400 hover:text-white'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-slate-400">{schemaTable.summary}</p>

            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 text-[10px] uppercase">
                    <tr>
                      <th className="px-4 py-2.5">COLUMN</th>
                      <th className="px-4 py-2.5">DATA TYPE</th>
                      <th className="px-4 py-2.5">CONSTRAINTS</th>
                      <th className="px-4 py-2.5">DESCRIPTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-300 text-[11px]">
                    {schemaTable.columns.map((c) => (
                      <tr key={c.name} className="hover:bg-slate-800/30">
                        <td className="px-4 py-2 font-bold text-white whitespace-nowrap">{c.name}</td>
                        <td className="px-4 py-2 text-blue-400 whitespace-nowrap">{c.type}</td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className="text-[10px] bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-amber-300 font-semibold">
                            {c.constraint}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-slate-400 text-xs font-sans">{c.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px] font-mono">
              <span className="text-slate-500 flex items-center gap-1">
                <Key className="w-3 h-3" /> Indexes:
              </span>
              {schemaTable.indexes.map((ix) => (
                <span
                  key={ix}
                  className={`px-2 py-0.5 rounded border ${
                    ix.indexOf('UNIQUE') >= 0 ? 'border-amber-800/60 bg-amber-950/30 text-amber-300' : 'border-slate-800 bg-slate-950 text-slate-400'
                  }`}
                >
                  {ix}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: SQL WORKBENCH (PREVIEW) + PGADMIN */}
      {viewMode === 'workbench' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-white flex items-center gap-2">
                <Terminal className="w-4 h-4 text-blue-400" /> SQL Query Workbench
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border border-amber-600/50 bg-amber-950/60 text-amber-300">
                  Simulated preview
                </span>
              </h3>
              <span className="text-[11px] font-mono text-slate-400">Database: {DB_NAME} | User: postgres</span>
            </div>

            <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl p-3 text-[11px] text-amber-200/90 space-y-1">
              <p>
                Queries are <strong>not executed</strong> here: the dashboard has no SQL endpoint and the browser cannot connect to PostgreSQL.
                The examples below are written against the real schema; copy one and run it with psql or pgAdmin.
              </p>
              <p className="font-mono text-amber-300/80">docker exec -it payment_postgres psql -U postgres -d {DB_NAME}</p>
            </div>

            {/* Example query chips */}
            <div className="flex flex-wrap gap-2 text-[11px] font-mono">
              {SQL_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => setQueryInput(ex.sql)}
                  className={`px-2.5 py-1 rounded-lg border transition ${
                    queryInput === ex.sql
                      ? 'bg-blue-600/30 text-white border-blue-600/60'
                      : 'bg-slate-950 hover:bg-slate-800 text-blue-300 border-slate-800'
                  }`}
                >
                  {ex.label}
                </button>
              ))}
            </div>

            {/* Query editor */}
            <div className="relative">
              <textarea
                rows={Math.min(14, Math.max(4, queryInput.split('\n').length + 1))}
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                spellCheck={false}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 pr-28 text-xs font-mono text-blue-300 outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => void handleCopySql()}
                className="absolute right-3 top-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shadow transition"
              >
                <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied!' : 'Copy SQL'}
              </button>
            </div>

            {/* Result shape */}
            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <div className="bg-slate-950 px-4 py-2 border-b border-slate-800 flex justify-between items-center text-xs font-mono text-slate-400">
                <span>Result columns (no rows: preview only)</span>
                <span className="text-amber-300/80">not executed</span>
              </div>
              <div className="px-4 py-3 flex flex-wrap gap-2 text-[11px] font-mono">
                {matchedExample ? (
                  matchedExample.columns.map((col) => (
                    <span key={col} className="px-2 py-0.5 rounded border border-slate-800 bg-slate-950 text-slate-300">
                      {col}
                    </span>
                  ))
                ) : (
                  <span className="text-slate-500">Edited query: run it in psql or pgAdmin to see its columns and rows.</span>
                )}
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              Enum columns hold uppercase values (status = &apos;CAPTURED&apos;, transactions.status = &apos;SUCCESS&apos;); amounts are bigint
              paise, so divide by 100.0 for rupees; timestamps are timestamptz.
            </p>
          </div>

          {/* PGADMIN (OPTIONAL EXTERNAL TOOL) */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs font-mono text-slate-300 shadow-xl">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-400" />
                <span className="font-bold text-white">pgAdmin: optional external tool for running queries</span>
              </div>
              <p className="text-slate-400 text-[11px] font-sans">
                pgAdmin is not part of this project. If you run one at {PGADMIN_URL}, open it in its own tab (it refuses to be embedded in
                other pages) and register this server:
              </p>
              <p className="text-slate-400 text-[11px]">
                Host: <code className="text-blue-300">localhost</code> (or <code className="text-blue-300">payment_postgres</code> from a
                container on the same Docker network) · Port: <code className="text-blue-300">5432</code> · DB:{' '}
                <code className="text-blue-300">{DB_NAME}</code> · User: <code className="text-blue-300">postgres</code> · Password: as set in
                docker/docker-compose.yml
              </p>
            </div>
            <a
              href={PGADMIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap shadow"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open pgAdmin
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Typed client for every backend the operations dashboard talks to.
 *
 * - Payment orchestrator (Spring Boot): Razorpay-style merchant API under /v1 (HTTP Basic auth with the
 *   sandbox merchant's key id and secret), public checkout under /v1/checkout, operator endpoints under /ops.
 *   Amounts on the wire are integer paise; helpers below convert to and from rupees for display.
 * - Bank simulator (Go): rails and chaos controls under /api/v1.
 * - AI router (FastAPI): /health, /v1/stats, /v1/route.
 *
 * The dashboard acts as one sandbox merchant. Its keys are created on first use and kept in localStorage,
 * which is acceptable for a local test-mode console only; a real merchant never puts key secrets in a browser.
 */

export const config = {
  orchestratorUrl: process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? 'http://localhost:8080',
  bankSimulatorUrl: process.env.NEXT_PUBLIC_BANK_SIMULATOR_URL ?? 'http://localhost:8081',
  aiRouterUrl: process.env.NEXT_PUBLIC_AI_ROUTER_URL ?? 'http://localhost:8000',
};

export const PROVIDERS = ['provider-a', 'provider-b', 'provider-c'] as const;

export const PROVIDER_NAMES: Record<string, string> = {
  'provider-a': 'HDFC Direct Rail',
  'provider-b': 'ICICI Payment Rail',
  'provider-c': 'SBI Gateway Rail',
};

// ---------------------------------------------------------------------------------------------------------
// Types (snake_case, exactly as the APIs return them)
// ---------------------------------------------------------------------------------------------------------

export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
export type PaymentMethod = 'upi' | 'card' | 'netbanking';

export interface GatewayPayment {
  id: string;
  entity: 'payment';
  amount: number; // paise
  currency: string;
  status: PaymentStatus;
  order_id: string;
  method: PaymentMethod;
  amount_refunded: number; // paise
  refund_status: 'partial' | 'full' | null;
  captured: boolean;
  card: { last4: string; network: string } | null;
  bank: string | null;
  vpa: string | null;
  email: string | null;
  contact: string | null;
  fee: number | null; // paise, includes GST
  tax: number | null; // paise, the GST part of fee
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  acquirer_data: Record<string, string> | null;
  provider: string | null;
  attempts: number;
  created_at: number; // unix seconds
}

export interface GatewayOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface PaymentAttempt {
  id: string;
  entity: 'payment_attempt';
  provider: string;
  status: 'success' | 'declined' | 'unavailable' | 'unknown';
  response_code: string | null; // "CB_OPEN" when the rail was skipped by its circuit breaker
  message: string | null;
  bank_reference: string | null;
  latency_ms: number | null;
  created_at: number;
}

export interface GatewayRefund {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  notes: Record<string, string>;
  receipt: string | null;
  acquirer_data: Record<string, string> | null;
  status: 'pending' | 'processed' | 'failed';
  failure_reason: string | null;
  created_at: number;
}

export interface CheckoutResult {
  payment_id: string;
  order_id: string;
  signature: string;
  status: PaymentStatus;
}

export interface MerchantAnalytics {
  entity: 'analytics';
  currency: string;
  payments: number;
  successful_payments: number;
  failed_payments: number;
  success_rate: number; // percent
  gross_volume: number; // paise
  captured_volume: number;
  refunded_volume: number;
  fees: number; // includes GST
  taxes: number;
  net_settlement: number;
  average_payment_value: number;
  count_by_status: Record<string, number>;
  count_by_method: Record<string, number>;
  successful_by_provider: Record<string, number>;
}

export interface CircuitBreakerStatus {
  entity: 'circuit_breaker';
  provider_id: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'DISABLED' | 'FORCED_OPEN' | 'METRICS_ONLY';
  failure_rate: number; // percent, -1 until enough calls
  buffered_calls: number;
  failed_calls: number;
  successful_calls: number;
  not_permitted_calls: number;
  failure_rate_threshold: number;
  minimum_number_of_calls: number;
  wait_duration_in_open_state_ms: number;
}

export interface Webhook {
  id: string;
  entity: 'webhook';
  url: string;
  events: string[];
  active: boolean;
  created_at: number;
}

export interface WebhookDelivery {
  id: string;
  entity: 'webhook_delivery';
  event_id: string;
  event: string;
  status: string; // pending | delivered | failed
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  next_attempt_at: number | null;
  delivered_at: number | null;
  created_at: number;
}

export const WEBHOOK_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
  'refund.processed',
  'refund.failed',
] as const;

export interface Collection<T> {
  entity: 'collection';
  count: number;
  items: T[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  success_rate: number; // 0..1
  latency_ms: number;
  is_killed: boolean;
  cost_inr: number;
}

export interface RouterStats {
  model_version: string | null;
  model_metrics: Record<string, unknown> | null;
  arms: { provider: string; payment_method: string; alpha: number; beta: number; expected_success: number; observations: number }[];
}

export interface RouteAdvice {
  providers: string[];
  scores: Record<string, number>;
  expected_success: Record<string, number>;
  strategy: string;
  model_version: string | null;
}

/** An error the gateway described with its {"error": {...}} envelope (or a network failure). */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reason?: string,
    readonly metadata?: Record<string, string>,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** True when the request never got an answer (service down or blocked by the browser). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------------------

export const toPaise = (rupees: number | string): number => Math.round(Number(rupees) * 100);
export const toRupees = (paise: number | null | undefined): number => (paise ?? 0) / 100;
export const formatInr = (paise: number | null | undefined): string =>
  `₹${toRupees(paise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fromUnix = (seconds: number | null | undefined): Date | null => (seconds ? new Date(seconds * 1000) : null);

/** Human label for a payment, folding in partial/full refunds. */
export function paymentLabel(p: Pick<GatewayPayment, 'status' | 'refund_status'>): string {
  if (p.status === 'refunded' || p.refund_status === 'full') return 'refunded';
  if (p.refund_status === 'partial') return 'partially refunded';
  return p.status;
}

/** Captured payments with something left to refund, or authorized ones (refunded as a full reversal). */
export function isRefundable(p: GatewayPayment): boolean {
  return (p.status === 'captured' && p.amount_refunded < p.amount) || p.status === 'authorized';
}

export const newIdempotencyKey = (prefix = 'dash'): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------------------------------------
// Sandbox merchant keys
// ---------------------------------------------------------------------------------------------------------

export interface SandboxKeys {
  merchantId: string;
  name: string;
  email: string;
  keyId: string;
  keySecret: string;
  createdAt: number;
}

const KEYS_STORAGE = 'gateway.sandboxMerchant';
const KEYS_EVENT = 'gateway-keys-changed';

export function loadKeys(): SandboxKeys | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEYS_STORAGE);
    return raw ? (JSON.parse(raw) as SandboxKeys) : null;
  } catch {
    return null;
  }
}

export function saveKeys(keys: SandboxKeys | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (keys) window.localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
    else window.localStorage.removeItem(KEYS_STORAGE);
  } catch {
    // storage unavailable (private mode): keys live for this page only
  }
  memoryKeys = keys;
  window.dispatchEvent(new Event(KEYS_EVENT));
}

/** Subscribe to key changes (signup, paste, reset) from any component. Returns an unsubscribe function. */
export function onKeysChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(KEYS_EVENT, listener);
  return () => window.removeEventListener(KEYS_EVENT, listener);
}

let memoryKeys: SandboxKeys | null = null;
let pendingSignup: Promise<SandboxKeys> | null = null;

/** Creates a new sandbox merchant account and makes it the dashboard's active merchant. */
export async function createSandboxMerchant(name = 'Ops Dashboard Sandbox'): Promise<SandboxKeys> {
  const email = `ops+${Date.now().toString(36)}@gateway.test`;
  const m = await request<{ id: string; name: string; email: string; key_id: string; key_secret: string; created_at: number }>(
    config.orchestratorUrl,
    '/v1/merchants',
    { method: 'POST', body: { name, email } },
  );
  const keys: SandboxKeys = { merchantId: m.id, name: m.name, email: m.email, keyId: m.key_id, keySecret: m.key_secret, createdAt: m.created_at };
  saveKeys(keys);
  return keys;
}

/**
 * The active sandbox merchant's keys, creating a merchant on first use. Concurrent callers share one signup.
 * If stored keys stop working (for example the database was reset) a fresh merchant is created.
 */
export async function ensureKeys(): Promise<SandboxKeys> {
  const existing = memoryKeys ?? loadKeys();
  if (existing) {
    memoryKeys = existing;
    return existing;
  }
  if (!pendingSignup) {
    pendingSignup = createSandboxMerchant().finally(() => {
      pendingSignup = null;
    });
  }
  return pendingSignup;
}

/** Uses keys the user pasted (from POST /v1/merchants); verifies them first. */
export async function useExistingKeys(keyId: string, keySecret: string): Promise<SandboxKeys> {
  const me = await request<{ id: string; name: string; email: string; created_at: number }>(config.orchestratorUrl, '/v1/merchants/me', {
    auth: { keyId, keySecret },
  });
  const keys: SandboxKeys = { merchantId: me.id, name: me.name, email: me.email, keyId, keySecret, createdAt: me.created_at };
  saveKeys(keys);
  return keys;
}

// ---------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  auth?: { keyId: string; keySecret: string };
  idempotencyKey?: string;
  timeoutMs?: number;
}

async function request<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth) headers.Authorization = `Basic ${btoa(`${options.auth.keyId}:${options.auth.keySecret}`)}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch {
    throw new GatewayError(`Cannot reach ${baseUrl}. Is the service running?`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw toGatewayError(res.status, data);
  }
  return data as T;
}

/**
 * Reads the error shape of whichever service answered: the orchestrator's {"error": {...}} envelope,
 * FastAPI's {"detail": "..." | [{msg}]} (AI router), a bank simulator body with "message", or plain text.
 */
function toGatewayError(status: number, data: unknown): GatewayError {
  const body = (data ?? {}) as {
    error?: { code?: string; description?: string; reason?: string; metadata?: Record<string, string> };
    detail?: string | { msg?: string; loc?: (string | number)[] }[];
    message?: string;
  };
  if (body.error?.description) {
    return new GatewayError(body.error.description, status, body.error.code, body.error.reason, body.error.metadata);
  }
  if (typeof body.detail === 'string') {
    return new GatewayError(body.detail, status);
  }
  if (Array.isArray(body.detail) && body.detail.length > 0) {
    const first = body.detail[0];
    const field = first.loc?.filter((part) => part !== 'body').join('.');
    return new GatewayError(field ? `${field}: ${first.msg}` : (first.msg ?? `HTTP ${status}`), status);
  }
  if (typeof body.message === 'string' && body.message) {
    return new GatewayError(body.message, status);
  }
  return new GatewayError(typeof data === 'string' && data.trim() ? data.trim() : `HTTP ${status}`, status);
}

/** Merchant API call with the sandbox keys; recreates the merchant once if the stored keys are rejected. */
async function merchantRequest<T>(path: string, options: Omit<RequestOptions, 'auth'> = {}): Promise<T> {
  const keys = await ensureKeys();
  try {
    return await request<T>(config.orchestratorUrl, path, { ...options, auth: keys });
  } catch (e) {
    if (e instanceof GatewayError && e.status === 401) {
      saveKeys(null);
      const fresh = await ensureKeys();
      return request<T>(config.orchestratorUrl, path, { ...options, auth: fresh });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Payment orchestrator
// ---------------------------------------------------------------------------------------------------------

export type Instrument =
  | { method: 'upi'; vpa: string }
  | { method: 'card'; card: { number: string; name: string; expiry_month: number; expiry_year: number; cvv: string } }
  | { method: 'netbanking'; bank: string };

export const orchestrator = {
  health: () => request<{ status: string }>(config.orchestratorUrl, '/ops/health', { timeoutMs: 3000 }).then(() => true),

  me: () => merchantRequest<{ id: string; name: string; email: string; key_id: string; created_at: number }>('/v1/merchants/me'),

  createOrder: (amountPaise: number, opts: { receipt?: string; notes?: Record<string, string>; paymentCapture?: boolean } = {}) =>
    merchantRequest<GatewayOrder>('/v1/orders', {
      method: 'POST',
      body: {
        amount: amountPaise,
        currency: 'INR',
        ...(opts.receipt ? { receipt: opts.receipt } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
        ...(opts.paymentCapture === false ? { payment_capture: false } : {}),
      },
    }),

  getOrder: (orderId: string) => merchantRequest<GatewayOrder>(`/v1/orders/${encodeURIComponent(orderId)}`),

  /**
   * Customer-side payment through the public checkout API (what checkout.js does), identified by key id only.
   * Throws GatewayError on decline (400) or when every rail is unavailable (502); error.metadata.payment_id
   * then names the failed payment.
   */
  pay: async (orderId: string, instrument: Instrument, customer: { email?: string; contact?: string } = {}, idempotencyKey?: string) => {
    const keys = await ensureKeys();
    return request<CheckoutResult>(config.orchestratorUrl, '/v1/checkout/payments', {
      method: 'POST',
      body: { key_id: keys.keyId, order_id: orderId, ...instrument, ...customer },
      idempotencyKey,
      timeoutMs: 30000,
    });
  },

  /** Creates an order and pays it in one go, as the dashboard's quick checkout does. */
  createAndPay: async (amountPaise: number, instrument: Instrument, opts: { idempotencyKey?: string; capture?: boolean; email?: string; contact?: string } = {}) => {
    const order = await orchestrator.createOrder(amountPaise, { receipt: `dash_${Date.now()}`, paymentCapture: opts.capture });
    const result = await orchestrator.pay(order.id, instrument, { email: opts.email, contact: opts.contact }, opts.idempotencyKey);
    return { order, result };
  },

  listPayments: (count = 100, skip = 0) => merchantRequest<Collection<GatewayPayment>>(`/v1/payments?count=${count}&skip=${skip}`),
  getPayment: (paymentId: string) => merchantRequest<GatewayPayment>(`/v1/payments/${encodeURIComponent(paymentId)}`),
  getAttempts: (paymentId: string) => merchantRequest<Collection<PaymentAttempt>>(`/v1/payments/${encodeURIComponent(paymentId)}/attempts`),
  capture: (paymentId: string, amountPaise: number) =>
    merchantRequest<GatewayPayment>(`/v1/payments/${encodeURIComponent(paymentId)}/capture`, { method: 'POST', body: { amount: amountPaise, currency: 'INR' } }),
  refund: (paymentId: string, amountPaise?: number, notes?: Record<string, string>, idempotencyKey?: string) =>
    merchantRequest<GatewayRefund>(`/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      body: { ...(amountPaise ? { amount: amountPaise } : {}), ...(notes ? { notes } : {}) },
      idempotencyKey: idempotencyKey ?? newIdempotencyKey('rfnd'),
    }),
  listRefunds: (paymentId: string) => merchantRequest<Collection<GatewayRefund>>(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`),

  analytics: () => merchantRequest<MerchantAnalytics>('/v1/analytics'),

  listWebhooks: () => merchantRequest<Collection<Webhook>>('/v1/webhooks'),
  createWebhook: (url: string, secret: string, events: string[]) => merchantRequest<Webhook>('/v1/webhooks', { method: 'POST', body: { url, secret, events } }),
  deleteWebhook: (webhookId: string) => merchantRequest<unknown>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' }),
  webhookDeliveries: (webhookId: string) => merchantRequest<Collection<WebhookDelivery>>(`/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`),

  circuitBreakers: () => request<Collection<CircuitBreakerStatus>>(config.orchestratorUrl, '/ops/circuit-breakers'),
  resetCircuitBreaker: (providerId: string) =>
    request<CircuitBreakerStatus>(config.orchestratorUrl, `/ops/circuit-breakers/${encodeURIComponent(providerId)}/reset`, { method: 'POST' }),
};

// ---------------------------------------------------------------------------------------------------------
// Bank simulator
// ---------------------------------------------------------------------------------------------------------

const chaos = (path: string) => request<unknown>(config.bankSimulatorUrl, path, { method: 'POST' });

export const bankSimulator = {
  status: () => request<Record<string, ProviderStatus>>(config.bankSimulatorUrl, '/api/v1/chaos/status', { timeoutMs: 3000 }),
  kill: (providerId: string) => chaos(`/api/v1/chaos/kill?provider_id=${encodeURIComponent(providerId)}`),
  restore: (providerId?: string) => chaos(`/api/v1/chaos/restore${providerId ? `?provider_id=${encodeURIComponent(providerId)}` : ''}`),
  setLatency: (providerId: string, ms: number) => chaos(`/api/v1/chaos/latency?provider_id=${encodeURIComponent(providerId)}&ms=${Math.max(0, Math.round(ms))}`),
  setSuccessRate: (providerId: string, rate: number) => chaos(`/api/v1/chaos/success-rate?provider_id=${encodeURIComponent(providerId)}&rate=${rate}`),
  /** Charges a rail directly, bypassing the orchestrator (amount in rupees, as the simulator expects). */
  charge: (body: { transaction_id?: string; provider_id: string; amount: number; currency?: string; payment_method: string; customer_vpa?: string }) =>
    request<Record<string, unknown>>(config.bankSimulatorUrl, '/api/v1/bank/charge', { method: 'POST', body: { currency: 'INR', ...body } }),
  enquire: (transactionId: string) =>
    request<Record<string, unknown>>(config.bankSimulatorUrl, `/api/v1/bank/status?transaction_id=${encodeURIComponent(transactionId)}`),
};

// ---------------------------------------------------------------------------------------------------------
// AI router
// ---------------------------------------------------------------------------------------------------------

export const aiRouter = {
  health: () => request<{ status: string; model_version: string | null }>(config.aiRouterUrl, '/health', { timeoutMs: 3000 }),
  stats: () => request<RouterStats>(config.aiRouterUrl, '/v1/stats'),
  route: (body: { providers?: string[]; payment_method: string; amount: number; hour?: number }) =>
    request<RouteAdvice>(config.aiRouterUrl, '/v1/route', { method: 'POST', body: { providers: [...PROVIDERS], ...body } }),
  reloadModel: () => request<{ loaded: boolean; model_version: string | null }>(config.aiRouterUrl, '/v1/model/reload', { method: 'POST' }),
};

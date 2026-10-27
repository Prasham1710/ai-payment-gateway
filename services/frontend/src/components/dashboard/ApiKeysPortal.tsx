'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Key,
  LogIn,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  UserPlus,
  X,
} from 'lucide-react';
import {
  GatewayError,
  type SandboxKeys,
  config,
  createSandboxMerchant,
  ensureKeys,
  fromUnix,
  loadKeys,
  onKeysChanged,
  orchestrator,
  // Plain async function despite the "use" prefix; renamed so it is not mistaken for a React hook.
  useExistingKeys as adoptExistingKeys,
} from '@/lib/gateway';

interface ErrorInfo {
  message: string;
  network: boolean;
}

type Verification = { state: 'checking' } | { state: 'verified' } | { state: 'error'; error: ErrorInfo };
type SnippetTab = 'orders' | 'payments' | 'checkout';

const SNIPPET_TABS: { id: SnippetTab; label: string }[] = [
  { id: 'orders', label: 'POST /v1/orders' },
  { id: 'payments', label: 'GET /v1/payments' },
  { id: 'checkout', label: 'checkout.js' },
];

const HIDDEN_SECRET = '••••••••••••••••••••••••';

function describeError(e: unknown): ErrorInfo {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

function formatCreated(seconds: number): string {
  const date = fromUnix(seconds);
  return date ? date.toLocaleString() : '—';
}

function buildSnippet(tab: SnippetTab, keys: SandboxKeys, secret: string): string {
  const base = config.orchestratorUrl;
  switch (tab) {
    case 'orders':
      return `# Server side: create an order. Amounts are in paise (50000 = ₹500.00).
curl -u ${keys.keyId}:${secret} \\
  -X POST ${base}/v1/orders \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 50000,
    "currency": "INR",
    "receipt": "receipt_1001",
    "notes": { "purpose": "sandbox test" }
  }'

# The response "id" (order_...) is what checkout.js needs as order_id.`;
    case 'payments':
      return `# Server side: list this merchant's payments, newest first.
curl -u ${keys.keyId}:${secret} \\
  "${base}/v1/payments?count=10"

# One payment, and the rail attempts the orchestrator made for it:
curl -u ${keys.keyId}:${secret} ${base}/v1/payments/pay_XXXXXXXXXXXXXX
curl -u ${keys.keyId}:${secret} ${base}/v1/payments/pay_XXXXXXXXXXXXXX/attempts`;
    case 'checkout':
      return `<!-- Browser side: only the public key id. The key secret never leaves your server. -->
<script src="${base}/checkout.js"></script>
<script>
  // order_id comes from your server, which created it with POST /v1/orders.
  var checkout = new GatewayCheckout({
    key: "${keys.keyId}",
    order_id: "order_XXXXXXXXXXXXXX",
    name: "Acme Store",
    prefill: { vpa: "success@gateway" },
    handler: function (response) {
      // response.payment_id, response.order_id, response.signature
      // Send them to your server and fulfil the order only if
      //   signature == hex(HMAC_SHA256(order_id + "|" + payment_id, key_secret))
    }
  });
  checkout.on("payment.failed", function (response) { console.log(response.error); });
  checkout.open();
</script>`;
  }
}

export default function ApiKeysPortal() {
  const [keys, setKeys] = useState<SandboxKeys | null>(null);
  const [verification, setVerification] = useState<Verification>({ state: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [tab, setTab] = useState<SnippetTab>('orders');

  const [mode, setMode] = useState<'idle' | 'create' | 'existing'>('idle');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ErrorInfo | null>(null);
  const [newName, setNewName] = useState('Ops Dashboard Sandbox');
  const [existingKeyId, setExistingKeyId] = useState('');
  const [existingSecret, setExistingSecret] = useState('');
  const [showExistingSecret, setShowExistingSecret] = useState(false);

  /** Checks the stored keys against GET /v1/merchants/me (creating a merchant on first use). */
  const verify = useCallback(async () => {
    setVerification({ state: 'checking' });
    const before = loadKeys()?.keyId ?? null;
    try {
      const me = await orchestrator.me();
      setKeys(await ensureKeys());
      setVerification({ state: 'verified' });
      if (!before) {
        setNotice(`No sandbox merchant was stored in this browser, so ${me.name} (${me.id}) was created for the dashboard.`);
      } else if (me.key_id !== before) {
        setNotice('The stored keys were rejected (the gateway database may have been reset), so a new sandbox merchant was created.');
      }
    } catch (e) {
      setKeys(loadKeys());
      setVerification({ state: 'error', error: describeError(e) });
    }
  }, []);

  useEffect(() => {
    setKeys(loadKeys());
    void verify();
    // Other screens can replace the merchant too (e.g. after a 401); keep this view in step.
    return onKeysChanged(() => setKeys(loadKeys()));
  }, [verify]);

  const copyText = async (text: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((current) => (current === label ? null : current)), 2000);
    } catch {
      setNotice('The browser blocked clipboard access. Select the text and copy it manually.');
    }
  };

  const openMode = (next: 'create' | 'existing') => {
    setActionError(null);
    setMode((current) => (current === next ? 'idle' : next));
  };

  const handleCreate = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const fresh = await createSandboxMerchant(newName.trim() || undefined);
      setKeys(fresh);
      setVerification({ state: 'verified' });
      setMode('idle');
      setShowSecret(true);
      setNotice(
        `Created ${fresh.name} (${fresh.merchantId}); the dashboard now uses its keys. Copy the key secret now if you need it elsewhere: the API only returns it at signup.`,
      );
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUseExisting = async (e: React.FormEvent) => {
    e.preventDefault();
    const keyId = existingKeyId.trim();
    const secret = existingSecret.trim();
    if (!keyId || !secret) {
      setActionError({ message: 'Enter both the key id and the key secret.', network: false });
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const adopted = await adoptExistingKeys(keyId, secret);
      setKeys(adopted);
      setVerification({ state: 'verified' });
      setMode('idle');
      setExistingKeyId('');
      setExistingSecret('');
      setShowSecret(false);
      setNotice(`Keys verified. The dashboard now acts as ${adopted.name} (${adopted.merchantId}).`);
    } catch (err) {
      const info = describeError(err);
      if (err instanceof GatewayError && err.status === 401) {
        info.message = `The gateway rejected these keys (HTTP 401: ${err.message}). Check the key id and secret returned by POST /v1/merchants.`;
      }
      setActionError(info);
    } finally {
      setBusy(false);
    }
  };

  // The snippet on screen follows the reveal toggle; the copied one always carries the real secret.
  const displayedSnippet = keys ? buildSnippet(tab, keys, showSecret ? keys.keySecret : HIDDEN_SECRET) : '';
  const copyableSnippet = keys ? buildSnippet(tab, keys, keys.keySecret) : '';

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <Key className="w-5 h-5 text-indigo-400" /> Sandbox Merchant & API Keys
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            The dashboard acts as one test-mode merchant and calls the merchant API on{' '}
            <span className="font-mono text-slate-300">{config.orchestratorUrl}</span> with these keys (HTTP Basic auth).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openMode('existing')}
            className={`text-xs px-3.5 py-2 rounded-xl border transition flex items-center gap-1.5 font-semibold ${
              mode === 'existing'
                ? 'bg-indigo-950/60 border-indigo-500 text-indigo-200'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
            }`}
          >
            <LogIn className="w-3.5 h-3.5" /> Use existing keys
          </button>
          <button
            type="button"
            onClick={() => openMode('create')}
            className={`text-xs px-3.5 py-2 rounded-xl border transition flex items-center gap-1.5 font-semibold ${
              mode === 'create'
                ? 'bg-indigo-950/60 border-indigo-500 text-indigo-200'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" /> Create new sandbox merchant
          </button>
        </div>
      </div>

      {notice && (
        <div className="bg-slate-900/90 border border-indigo-800/60 p-3.5 rounded-xl text-xs text-indigo-200 flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Create a new merchant */}
      {mode === 'create' && (
        <div className="bg-slate-900 border border-amber-800/60 p-5 rounded-2xl space-y-4">
          <div className="flex items-start gap-2 text-xs text-amber-200">
            <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p>
              This signs up a new merchant with <span className="font-mono">POST /v1/merchants</span> and switches the dashboard to it.
              The current merchant{keys ? <span className="font-mono"> {keys.merchantId}</span> : null} keeps its payments and webhooks,
              but the dashboard stops using its keys, and its key secret cannot be shown again. Copy it first if you still need it.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label htmlFor="new-merchant-name" className="text-xs font-semibold text-slate-300">
                Merchant name
              </label>
              <input
                id="new-merchant-name"
                type="text"
                maxLength={100}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('idle')}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-4 py-2.5 rounded-xl border border-slate-700 transition font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30"
              >
                <UserPlus className={`w-3.5 h-3.5 ${busy ? 'animate-pulse' : ''}`} />
                {busy ? 'Creating…' : 'Create and switch'}
              </button>
            </div>
          </div>
          {actionError && <ErrorNote error={actionError} />}
        </div>
      )}

      {/* Use existing keys */}
      {mode === 'existing' && (
        <form onSubmit={handleUseExisting} className="bg-slate-900 border border-indigo-800/60 p-5 rounded-2xl space-y-4">
          <p className="text-xs text-slate-400">
            Paste a key pair returned by <span className="font-mono text-slate-300">POST /v1/merchants</span>. It is checked with{' '}
            <span className="font-mono text-slate-300">GET /v1/merchants/me</span> before the dashboard switches to it.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="existing-key-id" className="text-xs font-semibold text-slate-300">
                Key ID
              </label>
              <input
                id="existing-key-id"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="key_test_XXXXXXXXXXXXXX"
                value={existingKeyId}
                onChange={(e) => setExistingKeyId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="existing-key-secret" className="text-xs font-semibold text-slate-300">
                Key Secret
              </label>
              <div className="flex bg-slate-950 border border-slate-800 rounded-xl overflow-hidden focus-within:border-indigo-500">
                <input
                  id="existing-key-secret"
                  type={showExistingSecret ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={existingSecret}
                  onChange={(e) => setExistingSecret(e.target.value)}
                  className="w-full bg-transparent px-3 py-2.5 text-xs font-mono text-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowExistingSecret((v) => !v)}
                  className="px-2.5 text-slate-400 hover:text-white border-l border-slate-800 transition"
                  aria-label={showExistingSecret ? 'Hide secret' : 'Show secret'}
                >
                  {showExistingSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-4 py-2.5 rounded-xl border border-slate-700 transition font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30"
            >
              <ShieldCheck className={`w-3.5 h-3.5 ${busy ? 'animate-pulse' : ''}`} />
              {busy ? 'Verifying…' : 'Verify and use'}
            </button>
          </div>
          {actionError && <ErrorNote error={actionError} />}
        </form>
      )}

      {/* Active merchant card */}
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Active Sandbox Merchant</h3>
          <div className="flex items-center gap-2">
            <VerificationPill verification={verification} />
            <button
              type="button"
              onClick={() => void verify()}
              disabled={verification.state === 'checking'}
              className="text-[11px] text-slate-400 hover:text-white disabled:opacity-50 flex items-center gap-1 bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 transition"
            >
              <RefreshCw className={`w-3 h-3 ${verification.state === 'checking' ? 'animate-spin' : ''}`} /> Re-check
            </button>
          </div>
        </div>

        {verification.state === 'error' && <ErrorNote error={verification.error} />}

        {!keys ? (
          <p className="text-xs text-slate-500">
            {verification.state === 'checking'
              ? 'Loading the sandbox merchant…'
              : 'No sandbox merchant yet. Create one above, or paste existing keys.'}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Field label="Merchant name" value={keys.name} />
              <Field label="Email" value={keys.email} mono />
              <Field
                label="Merchant ID"
                value={keys.merchantId}
                mono
                action={<CopyButton active={copied === 'merchantId'} onClick={() => void copyText(keys.merchantId, 'merchantId')} />}
              />
              <Field label="Created" value={formatCreated(keys.createdAt)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Key ID */}
              <div className="space-y-1.5">
                <label htmlFor="active-key-id" className="text-xs font-semibold text-slate-300">
                  Key ID <span className="text-slate-500 font-normal">(public, safe in a browser)</span>
                </label>
                <div className="flex bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                  <input
                    id="active-key-id"
                    type="text"
                    readOnly
                    value={keys.keyId}
                    className="w-full bg-transparent px-3 py-2.5 text-xs font-mono text-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void copyText(keys.keyId, 'keyId')}
                    className="px-3 text-slate-400 hover:text-white border-l border-slate-800 transition"
                    aria-label="Copy key id"
                  >
                    {copied === 'keyId' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Key Secret */}
              <div className="space-y-1.5">
                <label htmlFor="active-key-secret" className="text-xs font-semibold text-slate-300">
                  Key Secret <span className="text-slate-500 font-normal">(server side only)</span>
                </label>
                <div className="flex bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                  <input
                    id="active-key-secret"
                    type={showSecret ? 'text' : 'password'}
                    readOnly
                    value={keys.keySecret}
                    className="w-full bg-transparent px-3 py-2.5 text-xs font-mono text-slate-300 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="px-2.5 text-slate-400 hover:text-white border-l border-slate-800 transition"
                    aria-label={showSecret ? 'Hide key secret' : 'Reveal key secret'}
                  >
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyText(keys.keySecret, 'secret')}
                    className="px-3 text-slate-400 hover:text-white border-l border-slate-800 transition"
                    aria-label="Copy key secret"
                  >
                    {copied === 'secret' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="text-[11px] text-slate-500 flex items-start gap-1.5 pt-1">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-px" />
          <span>
            Test mode only. This console keeps the key secret in your browser&apos;s localStorage so it can call the merchant API
            directly; a real merchant never puts the key secret in a browser and calls the API from its own server. The API shows
            the secret only once, at signup.
          </span>
        </div>
      </div>

      {/* Code Snippets Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 bg-slate-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">Quickstart With These Keys</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
              {SNIPPET_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-1 rounded-lg font-mono font-bold transition ${
                    tab === t.id ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void copyText(copyableSnippet, 'code')}
              disabled={!keys}
              className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1.5 font-semibold"
            >
              {copied === 'code' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied === 'code' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        <div className="p-4 bg-slate-950 space-y-2">
          {keys ? (
            <>
              <pre className="font-mono text-xs text-indigo-300 overflow-x-auto leading-relaxed p-2">{displayedSnippet}</pre>
              {tab !== 'checkout' && !showSecret && (
                <p className="text-[11px] text-slate-500 px-2">
                  The key secret is hidden above; Copy puts the full command (with the real secret) on your clipboard.
                </p>
              )}
              {tab === 'checkout' && (
                <p className="text-[11px] text-slate-500 px-2">
                  Bank simulator test instruments: UPI <span className="font-mono">success@gateway</span> /{' '}
                  <span className="font-mono">failure@gateway</span>, cards <span className="font-mono">4111 1111 1111 1111</span> /{' '}
                  <span className="font-mono">4000 0000 0000 0002</span> always succeed / decline.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-slate-500 p-2">Examples appear once a sandbox merchant is active.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function VerificationPill({ verification }: { verification: Verification }) {
  if (verification.state === 'checking') {
    return (
      <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg border bg-slate-800 border-slate-700 text-slate-400">checking…</span>
    );
  }
  if (verification.state === 'verified') {
    return (
      <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg border bg-emerald-950/60 border-emerald-800/80 text-emerald-400 flex items-center gap-1">
        <ShieldCheck className="w-3 h-3" /> verified with /v1/merchants/me
      </span>
    );
  }
  return (
    <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg border bg-rose-950/60 border-rose-800/80 text-rose-300">not verified</span>
  );
}

function ErrorNote({ error }: { error: ErrorInfo }) {
  return (
    <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2 space-y-0.5">
      <p>{error.message}</p>
      {error.network && (
        <p className="text-rose-200/70">
          Start the payment orchestrator ({config.orchestratorUrl}) and try again.
        </p>
      )}
    </div>
  );
}

function CopyButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-slate-500 hover:text-slate-200 transition" aria-label="Copy">
      {active ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function Field({ label, value, mono, action }: { label: string; value: string; mono?: boolean; action?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] uppercase font-mono tracking-wider text-slate-500 block">{label}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-xs text-white truncate ${mono ? 'font-mono' : 'font-semibold'}`} title={value}>
          {value}
        </span>
        {action}
      </div>
    </div>
  );
}

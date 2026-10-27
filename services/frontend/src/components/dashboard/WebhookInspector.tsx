'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Inbox,
  KeyRound,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  GatewayError,
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookDelivery,
  config,
  fromUnix,
  onKeysChanged,
  orchestrator,
} from '@/lib/gateway';

const REFRESH_MS = 5000;
/** Gateway defaults (gateway.webhooks.* in the orchestrator's application.yml). */
const MAX_ATTEMPTS = 8;
const ALL_EVENTS = '*';

interface ErrorInfo {
  message: string;
  network: boolean;
  hint?: string;
}

function describeError(e: unknown): ErrorInfo {
  if (e instanceof GatewayError) return { message: e.message, network: e.isNetworkError };
  return { message: e instanceof Error ? e.message : String(e), network: false };
}

/** Adds an actionable hint to the gateway's URL refusals. */
function describeCreateError(e: unknown): ErrorInfo {
  const info = describeError(e);
  if (!(e instanceof GatewayError)) return info;
  if (/could not be resolved/i.test(e.message)) {
    info.hint = 'The orchestrator could not resolve that host name. Check the URL, or that the orchestrator has DNS access.';
  } else if (/non-public address|not allowed/i.test(e.message)) {
    info.hint =
      'SSRF protection: the gateway refuses webhook URLs on loopback and private networks. To deliver to a receiver on this machine, ' +
      'restart the orchestrator with GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK=true, or expose the receiver through a public HTTPS URL.';
  }
  return info;
}

function generateSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function relative(seconds: number | null, now: number): string {
  const date = fromUnix(seconds);
  if (!date) return '—';
  const diff = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(diff);
  const text =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  if (abs < 2) return 'now';
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

function clock(seconds: number | null): string {
  const date = fromUnix(seconds);
  return date ? date.toLocaleTimeString() : '—';
}

const VERIFY_SNIPPETS = {
  node: `// Node.js + Express
const crypto = require('crypto');
const express = require('express');
const app = express();

// Verify against the raw bytes: re-serialising parsed JSON changes them.
app.post('/webhooks/gateway', express.raw({ type: 'application/json' }), (req, res) => {
  const expected = crypto
    .createHmac('sha256', process.env.GATEWAY_WEBHOOK_SECRET)
    .update(req.body)                                   // Buffer: the raw request body
    .digest('hex');
  const received = req.get('X-Gateway-Signature') || '';
  const valid = received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return res.status(400).send('invalid signature');

  const event = JSON.parse(req.body.toString('utf8'));
  // X-Gateway-Event-Id is the same on every retry: store it and skip duplicates.
  console.log(req.get('X-Gateway-Event'), req.get('X-Gateway-Event-Id'), event.payload);
  res.sendStatus(200);                                  // any 2xx marks the delivery as delivered
});

app.listen(4000);`,
  python: `# Python + Flask
import hashlib
import hmac
import os

from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["GATEWAY_WEBHOOK_SECRET"].encode()

@app.post("/webhooks/gateway")
def gateway_webhook():
    raw = request.get_data()                       # raw bytes, before any JSON parsing
    expected = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    received = request.headers.get("X-Gateway-Signature", "")
    if not hmac.compare_digest(expected, received):
        abort(400)

    event = request.get_json()
    # X-Gateway-Event-Id is the same on every retry: store it and skip duplicates.
    print(request.headers["X-Gateway-Event"], request.headers["X-Gateway-Event-Id"], event["payload"])
    return "", 200                                 # any 2xx marks the delivery as delivered`,
} as const;

const EXAMPLE_ENVELOPE = `{
  "entity": "event",
  "account_id": "<your merchant id>",
  "event": "payment.captured",
  "contains": ["payment"],
  "payload": {
    "payment": { "entity": { "id": "pay_...", "amount": 50000, "status": "captured", ... } }
  },
  "created_at": 1767225600
}`;

export default function WebhookInspector() {
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [listError, setListError] = useState<ErrorInfo | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [deliveryErrors, setDeliveryErrors] = useState<Record<string, ErrorInfo>>({});
  const [refreshedAt, setRefreshedAt] = useState<Record<string, number>>({});

  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const [allEvents, setAllEvents] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<ErrorInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [verifyLang, setVerifyLang] = useState<'node' | 'python'>('node');
  const [copied, setCopied] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await orchestrator.listWebhooks();
      setWebhooks(res.items);
      setListError(null);
      setOpenId((current) => (current && res.items.some((w) => w.id === current) ? current : (res.items[0]?.id ?? null)));
    } catch (e) {
      setListError(describeError(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDeliveries = useCallback(async (webhookId: string) => {
    try {
      const res = await orchestrator.webhookDeliveries(webhookId);
      setDeliveries((prev) => ({ ...prev, [webhookId]: res.items }));
      setDeliveryErrors((prev) => {
        if (!(webhookId in prev)) return prev;
        const next = { ...prev };
        delete next[webhookId];
        return next;
      });
    } catch (e) {
      setDeliveryErrors((prev) => ({ ...prev, [webhookId]: describeError(e) }));
    } finally {
      setRefreshedAt((prev) => ({ ...prev, [webhookId]: Date.now() }));
    }
  }, []);

  useEffect(() => {
    setSecret(generateSecret());
    void loadWebhooks();
    // A different sandbox merchant has different webhooks.
    return onKeysChanged(() => {
      setDeliveries({});
      setDeliveryErrors({});
      void loadWebhooks();
    });
  }, [loadWebhooks]);

  // Deliveries of the expanded webhook refresh every few seconds while this view is open and visible.
  useEffect(() => {
    if (!openId) return;
    void loadDeliveries(openId);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadDeliveries(openId);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [openId, loadDeliveries]);

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

  const toggleEvent = (event: string) => {
    setSelectedEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = url.trim();
    const events = allEvents ? [ALL_EVENTS] : WEBHOOK_EVENTS.filter((ev) => selectedEvents.includes(ev));
    if (!/^https?:\/\/\S+$/i.test(target)) {
      setFormError({ message: 'Enter an http(s) URL, e.g. https://example.com/webhooks/gateway.', network: false });
      return;
    }
    if (secret.length < 8 || secret.length > 128) {
      setFormError({ message: 'The secret must be 8 to 128 characters.', network: false });
      return;
    }
    if (events.length === 0) {
      setFormError({ message: 'Subscribe to at least one event.', network: false });
      return;
    }

    setCreating(true);
    setFormError(null);
    try {
      const created = await orchestrator.createWebhook(target, secret, events);
      setNotice(
        `Registered ${created.id} for ${created.url}. Keep the secret you used: the gateway stores it encrypted and never shows it again.`,
      );
      setUrl('');
      setSecret(generateSecret());
      await loadWebhooks();
      setOpenId(created.id);
    } catch (err) {
      setFormError(describeCreateError(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (webhookId: string) => {
    setDeletingId(webhookId);
    try {
      await orchestrator.deleteWebhook(webhookId);
      setConfirmDeleteId(null);
      setDeliveries((prev) => {
        const next = { ...prev };
        delete next[webhookId];
        return next;
      });
      if (openId === webhookId) setOpenId(null);
      await loadWebhooks();
    } catch (e) {
      setListError(describeError(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-extrabold text-white flex items-center gap-2">
            <Radio className="w-5 h-5 text-indigo-400" /> Webhooks
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Endpoints registered for the sandbox merchant, and every delivery the gateway made to them. Events are signed with
            HMAC-SHA256 and retried until your endpoint answers 2xx.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/80 px-2.5 py-1 rounded-lg flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> X-Gateway-Signature: HMAC-SHA256
          </span>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Register form */}
        <form onSubmit={handleCreate} className="lg:col-span-7 bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl space-y-4">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Register Webhook Endpoint</h3>

          <div className="space-y-1.5">
            <label htmlFor="webhook-url" className="text-xs font-semibold text-slate-300">
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourdomain.com/webhooks/gateway"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="webhook-secret" className="text-xs font-semibold text-slate-300">
              Signing secret <span className="text-slate-500 font-normal">(8 to 128 characters; your receiver needs it)</span>
            </label>
            <div className="flex bg-slate-950 border border-slate-800 rounded-xl overflow-hidden focus-within:border-indigo-500">
              <input
                id="webhook-secret"
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={secret}
                maxLength={128}
                onChange={(e) => setSecret(e.target.value)}
                className="w-full bg-transparent p-2.5 text-xs font-mono text-slate-300 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setSecret(generateSecret())}
                className="px-3 text-slate-400 hover:text-white border-l border-slate-800 transition flex items-center gap-1 text-[11px]"
                title="Generate a random secret"
              >
                <KeyRound className="w-3.5 h-3.5" /> New
              </button>
              <button
                type="button"
                onClick={() => void copyText(secret, 'secret')}
                className="px-3 text-slate-400 hover:text-white border-l border-slate-800 transition"
                aria-label="Copy secret"
              >
                {copied === 'secret' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-slate-300 mb-1.5">Events</legend>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={allEvents}
                onChange={(e) => setAllEvents(e.target.checked)}
                className="w-3.5 h-3.5 accent-indigo-500"
              />
              <span>
                All events <span className="font-mono text-slate-500">(&quot;*&quot;, includes events added later)</span>
              </span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {WEBHOOK_EVENTS.map((event) => (
                <label
                  key={event}
                  className={`flex items-center gap-2 text-xs font-mono px-2.5 py-1.5 rounded-lg border transition cursor-pointer ${
                    allEvents
                      ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                      : selectedEvents.includes(event)
                        ? 'border-indigo-700/70 bg-indigo-950/30 text-indigo-200'
                        : 'border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={allEvents}
                    checked={allEvents || selectedEvents.includes(event)}
                    onChange={() => toggleEvent(event)}
                    className="w-3.5 h-3.5 accent-indigo-500"
                  />
                  {event}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-800/60">
            <span className="text-[11px] text-slate-500">
              POST {config.orchestratorUrl}/v1/webhooks
            </span>
            <button
              type="submit"
              disabled={creating}
              className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{creating ? 'Registering…' : 'Register webhook'}</span>
            </button>
          </div>

          {formError && <ErrorNote error={formError} service="payment orchestrator" />}
        </form>

        {/* Delivery facts */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow-xl space-y-3 text-xs text-slate-400">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">How Delivery Works</h3>
          <ul className="space-y-2 list-disc pl-4 marker:text-slate-600">
            <li>
              Each event is a JSON <span className="font-mono text-slate-300">POST</span> with headers{' '}
              <span className="font-mono text-indigo-300">X-Gateway-Signature</span> (hex HMAC-SHA256 of the raw body, keyed with your
              secret), <span className="font-mono text-indigo-300">X-Gateway-Event</span> and{' '}
              <span className="font-mono text-indigo-300">X-Gateway-Event-Id</span> (unchanged across retries, so you can de-duplicate).
            </li>
            <li>A 2xx answer within 5 s counts as delivered. Redirects are not followed.</li>
            <li>
              Anything else is retried with exponential backoff (5 s, 10 s, 20 s, … up to 1 h), at most {MAX_ATTEMPTS} attempts by
              default, then the delivery is marked failed.
            </li>
            <li>
              A failing endpoint is paused and probed again later; its other queued events wait without using up their attempts.
            </li>
            <li>
              Events are queued in PostgreSQL in the same transaction as the payment or refund change (an outbox), so a restart does not
              lose them.
            </li>
            <li>
              URLs on loopback or private networks are refused unless the orchestrator runs with{' '}
              <span className="font-mono text-amber-300">GATEWAY_WEBHOOKS_ALLOW_PRIVATE_NETWORK=true</span>.
            </li>
          </ul>
        </div>
      </div>

      {/* Registered webhooks and their deliveries */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Registered Endpoints{webhooks ? ` (${webhooks.length})` : ''}
          </span>
          <button
            type="button"
            onClick={() => void loadWebhooks()}
            disabled={listLoading}
            className="text-xs text-slate-400 hover:text-white disabled:opacity-50 flex items-center gap-1 bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${listLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {listError && (
          <div className="p-4 border-b border-slate-800">
            <ErrorNote error={listError} service="payment orchestrator" />
          </div>
        )}

        {webhooks === null ? (
          !listError && <p className="p-6 text-center text-xs text-slate-500">Loading webhooks…</p>
        ) : webhooks.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-xs space-y-2">
            <Inbox className="w-8 h-8 text-slate-700 mx-auto" />
            <p className="text-slate-300 font-semibold">No webhook endpoints yet</p>
            <p>Register one above. The gateway then POSTs a signed event to it whenever a payment or refund changes state.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {webhooks.map((webhook) => {
              const isOpen = openId === webhook.id;
              const items = deliveries[webhook.id];
              const deliveryError = deliveryErrors[webhook.id];
              const events = webhook.events.includes(ALL_EVENTS) ? ['all events'] : webhook.events;
              return (
                <div key={webhook.id} className={isOpen ? 'bg-slate-950/40' : ''}>
                  <div className="p-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : webhook.id)}
                      className="flex items-start gap-2 text-left min-w-0 flex-1"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <span className="text-xs font-bold text-white font-mono block truncate" title={webhook.url}>
                          {webhook.url}
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono block">
                          {webhook.id} · created {fromUnix(webhook.created_at)?.toLocaleString() ?? '—'}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {events.map((ev) => (
                            <span
                              key={ev}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700"
                            >
                              {ev}
                            </span>
                          ))}
                        </span>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                          webhook.active
                            ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                            : 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {webhook.active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                      {confirmDeleteId === webhook.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleDelete(webhook.id)}
                            disabled={deletingId === webhook.id}
                            className="text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-2.5 py-1 rounded-lg transition"
                          >
                            {deletingId === webhook.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs text-slate-400 hover:text-white bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 transition"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(webhook.id)}
                          className="text-xs text-slate-400 hover:text-rose-300 flex items-center gap-1 bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-700 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmDeleteId === webhook.id && (
                    <p className="px-4 pb-3 -mt-1 text-[11px] text-rose-300/80">
                      Deleting stops deliveries to this URL; events still queued for it are marked failed.
                    </p>
                  )}

                  {isOpen && (
                    <div className="px-4 pb-4 space-y-2">
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span className="font-semibold uppercase tracking-wider">Recent deliveries</span>
                        <span className="flex items-center gap-1.5">
                          <RefreshCw className="w-3 h-3" />
                          auto-refresh every {REFRESH_MS / 1000}s
                          {refreshedAt[webhook.id] ? ` · updated ${new Date(refreshedAt[webhook.id]).toLocaleTimeString()}` : ''}
                        </span>
                      </div>

                      {deliveryError && <ErrorNote error={deliveryError} service="payment orchestrator" />}

                      {items === undefined ? (
                        !deliveryError && <p className="text-xs text-slate-500 py-3">Loading deliveries…</p>
                      ) : items.length === 0 ? (
                        <div className="border border-dashed border-slate-800 rounded-xl p-5 text-xs text-slate-400 space-y-1.5">
                          <p className="text-slate-300 font-semibold">No events delivered to this endpoint yet.</p>
                          <p>
                            Make a payment from the dashboard checkout: it triggers{' '}
                            <span className="font-mono">payment.authorized</span>, <span className="font-mono">payment.captured</span> and{' '}
                            <span className="font-mono">order.paid</span> (or <span className="font-mono">payment.failed</span> with{' '}
                            <span className="font-mono">failure@gateway</span>). Then refund it for{' '}
                            <span className="font-mono">refund.created</span> and <span className="font-mono">refund.processed</span>.
                            Only subscribed events are queued; they show up here within a few seconds.
                          </p>
                        </div>
                      ) : (
                        <DeliveriesTable items={items} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* How to verify */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 bg-slate-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Code2 className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">How to Verify X-Gateway-Signature</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
              {(['node', 'python'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setVerifyLang(lang)}
                  className={`px-3 py-1 rounded-lg font-mono font-bold transition ${
                    verifyLang === lang ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void copyText(VERIFY_SNIPPETS[verifyLang], 'verify')}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1.5 font-semibold"
            >
              {copied === 'verify' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied === 'verify' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12">
          <div className="lg:col-span-7 p-4 bg-slate-950 lg:border-r border-slate-800">
            <pre className="font-mono text-[11px] text-indigo-300 overflow-x-auto leading-relaxed p-2">{VERIFY_SNIPPETS[verifyLang]}</pre>
          </div>
          <div className="lg:col-span-5 p-4 space-y-3 text-xs text-slate-400">
            <p>
              Compute <span className="font-mono text-slate-300">hex(HMAC_SHA256(raw_body, webhook_secret))</span> and compare it with the{' '}
              <span className="font-mono text-indigo-300">X-Gateway-Signature</span> header in constant time. Reject the request if they
              differ.
            </p>
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold text-slate-400 block">Body (Razorpay-style event envelope)</span>
              <pre className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 font-mono text-[10px] text-emerald-300 overflow-x-auto leading-relaxed">
                {EXAMPLE_ENVELOPE}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeliveriesTable({ items }: { items: WebhookDelivery[] }) {
  const now = Date.now();
  return (
    <div className="border border-slate-800 rounded-xl overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-950 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left font-semibold px-3 py-2">Event</th>
            <th className="text-left font-semibold px-3 py-2">Status</th>
            <th className="text-right font-semibold px-3 py-2">Attempts</th>
            <th className="text-right font-semibold px-3 py-2">Last response</th>
            <th className="text-left font-semibold px-3 py-2">Last error</th>
            <th className="text-left font-semibold px-3 py-2">Next attempt / delivered</th>
            <th className="text-left font-semibold px-3 py-2">Queued</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {items.map((d) => (
            <tr key={d.id} className="hover:bg-slate-800/30">
              <td className="px-3 py-2 align-top">
                <span className="font-mono font-bold text-white block">{d.event}</span>
                <span className="font-mono text-[10px] text-slate-500">{d.event_id}</span>
              </td>
              <td className="px-3 py-2 align-top">
                <StatusBadge delivery={d} />
              </td>
              <td className="px-3 py-2 align-top text-right font-mono text-slate-300">
                {d.attempts}
                <span className="text-slate-600">/{MAX_ATTEMPTS}</span>
              </td>
              <td className="px-3 py-2 align-top text-right font-mono">
                {d.last_response_code === null ? (
                  <span className="text-slate-600">—</span>
                ) : (
                  <span className={d.last_response_code >= 200 && d.last_response_code < 300 ? 'text-emerald-400' : 'text-rose-300'}>
                    {d.last_response_code}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 align-top max-w-[260px]">
                {d.last_error ? (
                  <span className="text-rose-300/90 block truncate" title={d.last_error}>
                    {d.last_error}
                  </span>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </td>
              <td className="px-3 py-2 align-top whitespace-nowrap text-slate-300">
                <NextOrDelivered delivery={d} now={now} />
              </td>
              <td className="px-3 py-2 align-top whitespace-nowrap text-slate-500" title={fromUnix(d.created_at)?.toLocaleString()}>
                {relative(d.created_at, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NextOrDelivered({ delivery: d, now }: { delivery: WebhookDelivery; now: number }) {
  if (d.status === 'delivered') {
    return (
      <span title={fromUnix(d.delivered_at)?.toLocaleString()}>
        {clock(d.delivered_at)} <span className="text-slate-500">({relative(d.delivered_at, now)})</span>
      </span>
    );
  }
  if (d.status === 'failed') {
    return <span className="text-rose-300/80">gave up</span>;
  }
  const next = fromUnix(d.next_attempt_at);
  if (!next) return <span className="text-slate-600">—</span>;
  return (
    <span title={next.toLocaleString()}>
      {next.getTime() <= now + 1000 ? 'due now' : `${relative(d.next_attempt_at, now)} (${clock(d.next_attempt_at)})`}
    </span>
  );
}

function StatusBadge({ delivery }: { delivery: WebhookDelivery }) {
  const { status, attempts } = delivery;
  const [label, tone] =
    status === 'delivered'
      ? ['delivered', 'bg-emerald-950 text-emerald-400 border-emerald-800']
      : status === 'failed'
        ? ['failed', 'bg-rose-950 text-rose-300 border-rose-800']
        : status === 'pending' && attempts > 0
          ? ['retrying', 'bg-amber-950 text-amber-300 border-amber-800']
          : status === 'pending'
            ? ['queued', 'bg-slate-800 text-slate-300 border-slate-700']
            : [status, 'bg-slate-800 text-slate-300 border-slate-700'];
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${tone}`}>{label}</span>;
}

function ErrorNote({ error, service }: { error: ErrorInfo; service: string }) {
  return (
    <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-900/60 rounded-lg px-3 py-2 space-y-1">
      <p className="flex items-start gap-1.5">
        <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span>{error.message}</span>
      </p>
      {error.network && <p className="text-rose-200/70">Start the {service} ({config.orchestratorUrl}) and try again.</p>}
      {error.hint && <p className="text-amber-200/90">{error.hint}</p>}
    </div>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  RotateCcw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Clock,
  ShieldCheck,
} from 'lucide-react';

import {
  GatewayError,
  PROVIDER_NAMES,
  formatInr,
  fromUnix,
  newIdempotencyKey,
  orchestrator,
  toPaise,
  type GatewayPayment,
  type GatewayRefund,
} from '@/lib/gateway';

interface RefundModalProps {
  isOpen: boolean;
  onClose: () => void;
  payment: GatewayPayment | null;
  /** Called with the refund the gateway created (processed, pending or failed); the parent refreshes its ledger. */
  onRefundSuccess: (refund: GatewayRefund) => void;
}

/** Smallest amount the gateway accepts for an explicit refund amount (INR 1.00). */
const MIN_REFUND_PAISE = 100;

function describeError(err: unknown): string {
  if (err instanceof GatewayError) {
    return err.isNetworkError ? `${err.message} Start the payment orchestrator and try again.` : err.message;
  }
  return err instanceof Error ? err.message : 'The refund request failed.';
}

export default function RefundModal({
  isOpen,
  onClose,
  payment,
  onRefundSuccess
}: RefundModalProps) {
  const [refundAmount, setRefundAmount] = useState<string>('');
  const [reason, setReason] = useState<string>('Customer Return');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [refundResult, setRefundResult] = useState<GatewayRefund | null>(null);
  // One key per opened refund form, so retrying after a timeout cannot refund twice.
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');

  const remainingPaise = payment ? Math.max(0, payment.amount - payment.amount_refunded) : 0;
  const maxRefundable = remainingPaise / 100;
  // An authorized (uncaptured) payment can only be reversed in full.
  const fullReversalOnly = payment?.status === 'authorized';

  useEffect(() => {
    if (isOpen && payment) {
      setRefundAmount((Math.max(0, payment.amount - payment.amount_refunded) / 100).toFixed(2));
      setReason('Customer Return');
      setErrorMessage('');
      setRefundResult(null);
      setIsProcessing(false);
      setIdempotencyKey(newIdempotencyKey('rfnd'));
    }
  }, [isOpen, payment]);

  if (!isOpen || !payment) return null;

  const handleProcessRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountPaise = toPaise(refundAmount);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setErrorMessage('Please enter a valid refund amount greater than 0.');
      return;
    }
    if (amountPaise > remainingPaise) {
      setErrorMessage(`Refund amount cannot exceed the remaining balance of ${formatInr(remainingPaise)}.`);
      return;
    }
    const isFullRemainder = amountPaise === remainingPaise;
    if (!isFullRemainder && amountPaise < MIN_REFUND_PAISE) {
      setErrorMessage(`A partial refund must be at least ${formatInr(MIN_REFUND_PAISE)}.`);
      return;
    }

    setIsProcessing(true);
    setErrorMessage('');

    try {
      // Omitting the amount refunds whatever is left, which also covers a remainder below INR 1.00.
      const amountArg = isFullRemainder && remainingPaise < MIN_REFUND_PAISE ? undefined : amountPaise;
      const refund = await orchestrator.refund(payment.id, amountArg, { reason }, idempotencyKey || undefined);
      setRefundResult(refund);
      onRefundSuccess(refund);
    } catch (err) {
      setErrorMessage(describeError(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const providerName = payment.provider ? PROVIDER_NAMES[payment.provider] ?? payment.provider : 'the original rail';
  const parsedAmount = parseFloat(refundAmount);
  const arn = refundResult?.acquirer_data?.arn ?? null;
  const refundCreated = refundResult ? fromUnix(refundResult.created_at) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150">

        {/* Header */}
        <div className="bg-slate-950 px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-rose-950 text-rose-400 border border-rose-800/80 flex items-center justify-center">
              <RotateCcw className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">1-Click Refund Engine</h3>
              <p className="text-[11px] text-slate-400 font-mono">Payment ID: {payment.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {refundResult ? (
            /* Refund Result Screen */
            <div className="text-center py-4 space-y-4 animate-in zoom-in-95 duration-150">
              {refundResult.status === 'processed' && (
                <>
                  <div className="w-14 h-14 bg-emerald-950 border border-emerald-800 text-emerald-400 rounded-full flex items-center justify-center mx-auto shadow-inner">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="font-bold text-base text-white">Refund Processed</h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {providerName} accepted the refund and returned an ARN.
                    </p>
                  </div>
                </>
              )}
              {refundResult.status === 'pending' && (
                <>
                  <div className="w-14 h-14 bg-amber-950 border border-amber-800 text-amber-400 rounded-full flex items-center justify-center mx-auto shadow-inner">
                    <Clock className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="font-bold text-base text-white">Refund Pending</h4>
                    <p className="text-xs text-slate-400 mt-0.5 max-w-sm mx-auto">
                      {providerName} could not be reached, so the refund is queued. The gateway retries it automatically
                      in the background until it is processed or fails; no action is needed.
                    </p>
                  </div>
                </>
              )}
              {refundResult.status === 'failed' && (
                <>
                  <div className="w-14 h-14 bg-rose-950 border border-rose-800 text-rose-400 rounded-full flex items-center justify-center mx-auto shadow-inner">
                    <XCircle className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="font-bold text-base text-white">Refund Failed</h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {refundResult.failure_reason || 'The bank rejected the refund.'}
                    </p>
                  </div>
                </>
              )}

              <div className="bg-slate-950 border border-slate-800/80 rounded-2xl p-4 text-xs space-y-2 text-left font-mono">
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500 font-sans">Refund ID:</span>
                  <span className="text-slate-200 break-all text-right">{refundResult.id}</span>
                </div>
                <div className="flex justify-between font-sans">
                  <span className="text-slate-500">Status:</span>
                  <span className={`px-2 py-0.5 rounded font-bold text-[10px] uppercase border ${
                    refundResult.status === 'processed'
                      ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                      : refundResult.status === 'pending'
                        ? 'bg-amber-950 text-amber-400 border-amber-800'
                        : 'bg-rose-950 text-rose-400 border-rose-800'
                  }`}>
                    {refundResult.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-sans">Refund Amount:</span>
                  <span className="text-rose-400 font-bold">{formatInr(refundResult.amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 font-sans">Payment Amount:</span>
                  <span className="text-slate-200">{formatInr(payment.amount)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-800/80 pt-1.5 gap-3">
                  <span className="text-slate-500 font-sans">ARN:</span>
                  <span className="text-indigo-400 break-all text-right">
                    {arn ?? (refundResult.status === 'pending' ? 'assigned once processed' : '—')}
                  </span>
                </div>
                {refundCreated && (
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-sans">Created:</span>
                    <span className="text-slate-400">{refundCreated.toLocaleString()}</span>
                  </div>
                )}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-6 py-2.5 rounded-xl transition shadow-lg shadow-indigo-600/30"
                >
                  Close & Refresh Ledger
                </button>
              </div>
            </div>
          ) : (
            /* Refund Input Form */
            <form onSubmit={handleProcessRefund} className="space-y-4">
              {errorMessage && (
                <div className="bg-rose-950/40 border border-rose-800/80 text-rose-300 p-3 rounded-xl text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Payment Summary Metrics */}
              <div className="grid grid-cols-3 gap-2 bg-slate-950 p-3 rounded-2xl border border-slate-800/80 text-xs">
                <div>
                  <span className="text-[10px] text-slate-500 block">
                    {payment.status === 'authorized' ? 'Authorized' : 'Total Captured'}
                  </span>
                  <span className="font-bold text-white">{formatInr(payment.amount)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">Already Refunded</span>
                  <span className="font-bold text-rose-400">{formatInr(payment.amount_refunded)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 block">Max Refundable</span>
                  <span className="font-bold text-emerald-400">{formatInr(remainingPaise)}</span>
                </div>
              </div>

              {/* Refund Amount Input */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <label className="font-semibold text-slate-300">Refund Amount (INR)</label>
                  {!fullReversalOnly && (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setRefundAmount(maxRefundable.toFixed(2))}
                        className="text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800 px-2 py-0.5 rounded font-semibold hover:bg-indigo-900"
                      >
                        Full Refund
                      </button>
                      {remainingPaise >= 2 * MIN_REFUND_PAISE && (
                        <button
                          type="button"
                          onClick={() => setRefundAmount((Math.floor(remainingPaise / 2) / 100).toFixed(2))}
                          className="text-[10px] bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded font-semibold hover:bg-slate-700"
                        >
                          50%
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-slate-500 font-bold text-sm">₹</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={maxRefundable}
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    readOnly={fullReversalOnly}
                    className={`w-full bg-slate-950 border border-slate-800 rounded-xl py-2.5 pl-8 pr-4 text-sm font-mono text-white focus:outline-none focus:border-indigo-500 ${
                      fullReversalOnly ? 'opacity-70 cursor-not-allowed' : ''
                    }`}
                    placeholder="0.00"
                    required
                  />
                </div>
                {fullReversalOnly && (
                  <p className="text-[11px] text-amber-400/90">
                    This payment is authorized but not captured, so it can only be reversed in full.
                  </p>
                )}
              </div>

              {/* Reason Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">Reason for Refund</label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="Customer Return">Customer Return / Product Dissatisfaction</option>
                  <option value="Duplicate Payment">Duplicate Transaction Charged</option>
                  <option value="Order Cancelled">Order Cancelled Prior to Fulfillment</option>
                  <option value="Fraudulent Transaction">Suspected Fraudulent Activity</option>
                  <option value="Merchant Goodwill">Merchant Goodwill / Courtesy</option>
                </select>
                <p className="text-[10px] text-slate-500">Sent as the refund&apos;s <code className="text-slate-400">notes.reason</code>.</p>
              </div>

              {/* Security Badge */}
              <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/60 flex items-center gap-2.5 text-[11px] text-slate-400">
                <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0" />
                <span>
                  Refunded through {providerName}, the rail that took the payment. If it is down the refund stays
                  pending and the gateway retries it automatically.
                </span>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="w-1/3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2.5 rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessing || remainingPaise <= 0}
                  className="w-2/3 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-bold py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-rose-600/30"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Processing Refund...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="w-3.5 h-3.5" /> Execute Refund ({formatInr(toPaise(Number.isFinite(parsedAmount) ? parsedAmount : 0))})
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

      </div>
    </div>
  );
}

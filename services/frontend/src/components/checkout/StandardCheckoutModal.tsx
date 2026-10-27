'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  ShieldCheck,
  QrCode,
  CreditCard,
  Building2,
  Wallet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Smartphone,
  Lock,
  ChevronRight,
} from 'lucide-react';

import {
  GatewayError,
  PROVIDER_NAMES,
  ensureKeys,
  formatInr,
  onKeysChanged,
  loadKeys,
  orchestrator,
  paymentLabel,
  toPaise,
  type CheckoutResult,
  type GatewayPayment,
  type Instrument,
} from '@/lib/gateway';

interface StandardCheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the gateway authorized or captured the payment. */
  onPaymentSuccess: (result: CheckoutResult) => void;
  /** Amount in rupees. */
  initialAmount?: number;
  /** Ignored: payments are always made as the dashboard's sandbox merchant (see ensureKeys). */
  initialMerchantId?: string;
}

/** Netbanking bank codes the gateway accepts. */
const NETBANKING_BANKS = [
  { id: 'HDFC', short: 'HDFC Bank', name: 'HDFC Bank', icon: '🏦' },
  { id: 'SBIN', short: 'State Bank', name: 'State Bank of India', icon: '🏛️' },
  { id: 'ICIC', short: 'ICICI Bank', name: 'ICICI Bank', icon: '🏦' },
  { id: 'UTIB', short: 'Axis Bank', name: 'Axis Bank', icon: '🏛️' },
  { id: 'KKBK', short: 'Kotak Bank', name: 'Kotak Mahindra Bank', icon: '🏦' },
];

/** The sandbox VPA used for the simulated QR scan; the bank simulator always approves it. */
const QR_SCAN_VPA = 'success@gateway';
/** The simulated 3-D Secure step accepts this OTP. */
const SIMULATED_OTP = '123456';

interface CheckoutFailure {
  message: string;
  title: string;
  reason?: string;
  paymentId?: string;
  orderId?: string;
  hint?: string;
}

function toFailure(err: unknown): CheckoutFailure {
  if (err instanceof GatewayError) {
    const paymentId = err.metadata?.payment_id;
    const orderId = err.metadata?.order_id;
    if (err.isNetworkError) {
      return { title: 'Gateway unreachable', message: err.message, hint: 'Start the payment orchestrator and try again.' };
    }
    if (err.status === 502) {
      return { title: 'All bank rails unavailable', message: err.message, reason: err.reason, paymentId, orderId };
    }
    if (paymentId) {
      return { title: 'Payment declined', message: err.message, reason: err.reason, paymentId, orderId };
    }
    return { title: 'Request rejected', message: err.message, reason: err.reason };
  }
  return { title: 'Payment failed', message: err instanceof Error ? err.message : 'Unexpected error while paying.' };
}

function bankName(code: string): string {
  return NETBANKING_BANKS.find((b) => b.id === code)?.name ?? code;
}

export default function StandardCheckoutModal({
  isOpen,
  onClose,
  onPaymentSuccess,
  initialAmount = 1499.00,
}: StandardCheckoutModalProps) {
  const [activeMethod, setActiveMethod] = useState<'upi' | 'card' | 'netbanking' | 'wallet'>('upi');
  const [amount, setAmount] = useState<number>(initialAmount);
  const [isProcessing, setIsProcessing] = useState(false);
  const [success, setSuccess] = useState<{ result: CheckoutResult; payment: GatewayPayment | null } | null>(null);
  const [failure, setFailure] = useState<CheckoutFailure | null>(null);
  const [merchantName, setMerchantName] = useState<string>('Sandbox Merchant');
  const [keyId, setKeyId] = useState<string>('');

  // UPI State
  const [upiSubTab, setUpiSubTab] = useState<'qr' | 'vpa'>('qr');
  const [vpaId, setVpaId] = useState('success@gateway');
  const [upiTimer, setUpiTimer] = useState<number>(300);
  const [isVpaPushSent, setIsVpaPushSent] = useState(false);
  const [vpaPushCountdown, setVpaPushCountdown] = useState<number>(60);
  const [upiNotice, setUpiNotice] = useState<string>('');

  // Card State
  const [cardNumber, setCardNumber] = useState('4111 1111 1111 1111');
  const [cardExpiry, setCardExpiry] = useState('12/30');
  const [cardCvv, setCardCvv] = useState('123');
  const [cardHolder, setCardHolder] = useState('Prasham Sharma');
  const [cardType, setCardType] = useState<'visa' | 'mastercard' | 'rupay'>('visa');
  const [show3dsOtpModal, setShow3dsOtpModal] = useState(false);
  const [otpValue, setOtpValue] = useState(SIMULATED_OTP);
  const [otpError, setOtpError] = useState('');

  // NetBanking State
  const [selectedBank, setSelectedBank] = useState('HDFC');
  const [showBankAuthGateway, setShowBankAuthGateway] = useState(false);

  // Reset or initialize when modal opens
  useEffect(() => {
    if (isOpen) {
      setAmount(initialAmount);
      setSuccess(null);
      setFailure(null);
      setIsProcessing(false);
      setIsVpaPushSent(false);
      setVpaPushCountdown(60);
      setUpiNotice('');
      setShow3dsOtpModal(false);
      setOtpError('');
      setShowBankAuthGateway(false);
      setUpiTimer(300);
    }
  }, [isOpen, initialAmount]);

  // The storefront header shows the sandbox merchant the payment is made for.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const apply = () => {
      const keys = loadKeys();
      if (keys && !cancelled) {
        setMerchantName(keys.name);
        setKeyId(keys.keyId);
      }
    };
    ensureKeys().then(apply).catch(() => {
      // Shown on payment instead: the order call reports the same failure.
    });
    const unsubscribe = onKeysChanged(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isOpen]);

  // QR Timer Countdown
  useEffect(() => {
    if (!isOpen || success) return;
    const interval = setInterval(() => {
      setUpiTimer(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, success]);

  // VPA Push Notification Countdown
  useEffect(() => {
    if (!isVpaPushSent || success) return;
    const interval = setInterval(() => {
      setVpaPushCountdown(prev => {
        if (prev <= 1) {
          setIsVpaPushSent(false);
          setUpiNotice('The collect request expired before it was approved. No payment was made.');
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isVpaPushSent, success]);

  // Auto detect card type
  const handleCardNumberChange = (val: string) => {
    const raw = val.replace(/\D/g, '').slice(0, 19);
    const formatted = raw.replace(/(\d{4})/g, '$1 ').trim();
    setCardNumber(formatted);

    if (raw.startsWith('4')) setCardType('visa');
    else if (raw.startsWith('5') || raw.startsWith('2')) setCardType('mastercard');
    else if (raw.startsWith('6') || raw.startsWith('508')) setCardType('rupay');
    else setCardType('visa');
  };

  const clearMessages = () => {
    setFailure(null);
    setUpiNotice('');
  };

  /** Creates an order for the amount and pays it through the public checkout API with the chosen instrument. */
  const executePayment = async (instrument: Instrument) => {
    const amountPaise = toPaise(amount);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      setFailure({ title: 'Invalid amount', message: 'The amount must be at least ₹1.00.' });
      setShow3dsOtpModal(false);
      setShowBankAuthGateway(false);
      return;
    }
    setIsProcessing(true);
    clearMessages();

    try {
      const { result } = await orchestrator.createAndPay(amountPaise, instrument);
      let payment: GatewayPayment | null = null;
      try {
        payment = await orchestrator.getPayment(result.payment_id);
      } catch {
        // The checkout result already proves the outcome; details are a bonus.
      }
      setSuccess({ result, payment });
      onPaymentSuccess(result);
    } catch (err) {
      setFailure(toFailure(err));
    } finally {
      setIsProcessing(false);
      setShow3dsOtpModal(false);
      setShowBankAuthGateway(false);
      setIsVpaPushSent(false);
    }
  };

  const handleCardOtpSubmit = () => {
    // Simulated 3-D Secure: the sandbox has no issuer ACS, so the OTP is checked here and never sent anywhere.
    if (otpValue !== SIMULATED_OTP) {
      setOtpError(`Incorrect OTP. The simulated 3-D Secure step accepts ${SIMULATED_OTP}.`);
      return;
    }
    const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(cardExpiry.trim());
    const month = match ? Number(match[1]) : NaN;
    const year = match ? Number(match[2]) : NaN;
    if (!match || month < 1 || month > 12) {
      setShow3dsOtpModal(false);
      setFailure({ title: 'Invalid card details', message: 'Enter the expiry date as MM/YY.' });
      return;
    }
    setOtpError('');
    executePayment({
      method: 'card',
      card: {
        number: cardNumber.replace(/\s/g, ''),
        name: cardHolder.trim(),
        expiry_month: month,
        expiry_year: year,
        cvv: cardCvv.trim(),
      },
    });
  };

  if (!isOpen) return null;

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const secureBrand =
    cardType === 'mastercard' ? 'Mastercard ID Check' : cardType === 'rupay' ? 'RuPay PaySecure' : 'Verified by VISA';
  const successPayment = success?.payment ?? null;
  const successProvider = successPayment?.provider ? PROVIDER_NAMES[successPayment.provider] ?? successPayment.provider : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">

      {/* 3D-SECURE BANK OTP MODAL OVERLAY (simulated) */}
      {show3dsOtpModal && (
        <div className="absolute inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-white text-slate-900 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-150">
            {/* Bank Header */}
            <div className="bg-gradient-to-r from-blue-900 to-indigo-900 text-white p-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-bold text-base">
                  🏦
                </div>
                <div>
                  <h4 className="font-bold text-sm leading-tight">Card Issuer · {secureBrand}</h4>
                  <p className="text-[11px] text-blue-200">3D-Secure 2.0 Customer Authentication</p>
                </div>
              </div>
              <button
                onClick={() => setShow3dsOtpModal(false)}
                className="text-blue-200 hover:text-white p-1 rounded-lg hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-900 space-y-1">
                <p className="font-semibold">Transaction Authentication</p>
                <p className="text-slate-600">
                  Amount: <strong className="text-slate-900">₹{amount.toFixed(2)}</strong> | Card ending in: <strong className="text-slate-900">{cardNumber.replace(/\s/g, '').slice(-4) || '----'}</strong>
                </p>
                <p className="text-slate-600">
                  One-Time Password (OTP) has been dispatched to mobile ending in <strong className="text-slate-900">•••• 4892</strong>.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <label className="font-bold text-slate-700">Enter 6-Digit OTP</label>
                  <span className="text-[11px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded font-mono font-bold">
                    Demo OTP: {SIMULATED_OTP}
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={6}
                  value={otpValue}
                  onChange={(e) => { setOtpValue(e.target.value.replace(/\D/g, '')); setOtpError(''); }}
                  className="w-full text-center tracking-[0.5em] font-mono text-xl font-bold py-2.5 border-2 border-indigo-500 rounded-xl focus:outline-none focus:ring-4 focus:ring-indigo-100"
                  placeholder={SIMULATED_OTP}
                />
                {otpError && (
                  <p className="text-[11px] text-rose-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" /> {otpError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                <span>Didn&apos;t get it? Use the demo OTP.</span>
                <button
                  type="button"
                  onClick={() => { setOtpValue(SIMULATED_OTP); setOtpError(''); }}
                  className="text-indigo-600 font-semibold hover:underline"
                >
                  Auto-fill OTP
                </button>
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShow3dsOtpModal(false)}
                  className="w-1/3 border border-slate-300 text-slate-700 text-xs font-bold py-2.5 rounded-xl hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isProcessing || otpValue.length < 6}
                  onClick={handleCardOtpSubmit}
                  className="w-2/3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Authorizing Payment...
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5" /> Submit & Pay ₹{amount.toFixed(2)}
                    </>
                  )}
                </button>
              </div>

              <div className="text-center text-[10px] text-slate-400 flex items-center justify-center gap-1.5 pt-1">
                <ShieldCheck className="w-3 h-3 text-emerald-600" />
                Simulated 3-D Secure step (checked in the browser). The card charge itself is real and goes through the gateway.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NETBANKING AUTHENTICATION GATEWAY MODAL (simulated bank login) */}
      {showBankAuthGateway && (
        <div className="absolute inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-white text-slate-900 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-150">
            <div className="bg-slate-900 text-white p-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-sm">
                  🏛️
                </div>
                <div>
                  <h4 className="font-bold text-sm">{bankName(selectedBank)} NetBanking</h4>
                  <p className="text-[11px] text-slate-400">Secure Retail Internet Banking Portal · bank code {selectedBank}</p>
                </div>
              </div>
              <button
                onClick={() => setShowBankAuthGateway(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Merchant:</span>
                  <span className="font-semibold text-slate-800">{merchantName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Account Debited:</span>
                  <span className="font-mono text-slate-800">XXXX XXXX 5019</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold">
                  <span className="text-slate-700">Total Payable:</span>
                  <span className="text-indigo-600 text-sm">₹{amount.toFixed(2)}</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700">Customer User ID</label>
                <input
                  type="text"
                  readOnly
                  value="CUST_8829012"
                  className="w-full bg-slate-100 text-slate-700 font-mono text-xs p-2.5 rounded-lg border border-slate-200"
                />
              </div>

              <p className="text-[11px] text-slate-500 italic">
                Simulated bank login page. Authorize creates the order and pays it through the gateway with bank code {selectedBank}; the bank rail decides the outcome.
              </p>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowBankAuthGateway(false)}
                  className="w-1/3 border border-slate-300 text-slate-700 text-xs font-bold py-2.5 rounded-xl hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => executePayment({ method: 'netbanking', bank: selectedBank })}
                  className="w-2/3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/30"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Authorizing Payment...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" /> Authorize & Pay ₹{amount.toFixed(2)}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN MODAL CONTAINER */}
      <div className="relative w-full max-w-2xl bg-white text-slate-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-800/20 flex flex-col md:flex-row min-h-[520px]">

        {/* CLOSE BUTTON */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 text-slate-400 hover:text-white bg-slate-900/40 hover:bg-slate-900/80 p-1.5 rounded-full transition"
        >
          <X className="w-4 h-4" />
        </button>

        {/* LEFT COLUMN: BRAND & METHODS LIST */}
        <div className="w-full md:w-5/12 bg-[#0c2340] text-white p-6 flex flex-col justify-between border-r border-slate-800/40">

          <div className="space-y-6">
            {/* Merchant Identity Header */}
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-500 text-white flex items-center justify-center font-bold text-lg shadow-md shadow-blue-500/30">
                  ⚡
                </div>
                <div className="min-w-0">
                  <h3 className="font-extrabold text-sm tracking-tight text-white truncate">{merchantName}</h3>
                  <span className="text-[11px] text-blue-300 font-mono block truncate">
                    {success ? `Order ${success.result.order_id}` : keyId ? `Test mode · ${keyId}` : 'Test mode'}
                  </span>
                </div>
              </div>

              {/* Price Tag */}
              <div className="bg-blue-950/70 border border-blue-800/60 p-3 rounded-xl mt-3">
                <span className="text-[11px] text-blue-300 block font-medium">Payable Amount</span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-xs text-blue-400 font-bold">₹</span>
                  <span className="text-2xl font-extrabold text-white tracking-tight">{amount.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Payment Method Selector List */}
            <div className="space-y-1 pt-2">
              <span className="text-[10px] font-bold text-blue-300 uppercase tracking-wider block mb-2 px-1">
                Payment Options
              </span>

              {/* UPI Option */}
              <button
                type="button"
                onClick={() => { setActiveMethod('upi'); clearMessages(); }}
                className={`w-full flex items-center justify-between p-3 rounded-xl text-xs font-semibold transition ${
                  activeMethod === 'upi'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                    : 'text-blue-100 hover:bg-blue-950/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <QrCode className="w-4 h-4" />
                  <div className="text-left">
                    <span className="block leading-tight">UPI / QR Code</span>
                    <span className={`text-[10px] block ${activeMethod === 'upi' ? 'text-blue-100' : 'text-blue-400'}`}>
                      Google Pay, PhonePe, Paytm
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 opacity-70" />
              </button>

              {/* Card Option */}
              <button
                type="button"
                onClick={() => { setActiveMethod('card'); clearMessages(); }}
                className={`w-full flex items-center justify-between p-3 rounded-xl text-xs font-semibold transition ${
                  activeMethod === 'card'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                    : 'text-blue-100 hover:bg-blue-950/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <CreditCard className="w-4 h-4" />
                  <div className="text-left">
                    <span className="block leading-tight">Cards</span>
                    <span className={`text-[10px] block ${activeMethod === 'card' ? 'text-blue-100' : 'text-blue-400'}`}>
                      Visa, MasterCard, RuPay
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 opacity-70" />
              </button>

              {/* NetBanking Option */}
              <button
                type="button"
                onClick={() => { setActiveMethod('netbanking'); clearMessages(); }}
                className={`w-full flex items-center justify-between p-3 rounded-xl text-xs font-semibold transition ${
                  activeMethod === 'netbanking'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                    : 'text-blue-100 hover:bg-blue-950/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Building2 className="w-4 h-4" />
                  <div className="text-left">
                    <span className="block leading-tight">NetBanking</span>
                    <span className={`text-[10px] block ${activeMethod === 'netbanking' ? 'text-blue-100' : 'text-blue-400'}`}>
                      HDFC, SBI, ICICI, Axis, Kotak
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 opacity-70" />
              </button>

              {/* Wallets Option (not supported by the gateway) */}
              <button
                type="button"
                onClick={() => { setActiveMethod('wallet'); clearMessages(); }}
                className={`w-full flex items-center justify-between p-3 rounded-xl text-xs font-semibold transition ${
                  activeMethod === 'wallet'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                    : 'text-blue-100/60 hover:bg-blue-950/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Wallet className="w-4 h-4" />
                  <div className="text-left">
                    <span className="block leading-tight">Wallets</span>
                    <span className={`text-[10px] block ${activeMethod === 'wallet' ? 'text-blue-100' : 'text-blue-400'}`}>
                      Not supported yet
                    </span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 opacity-70" />
              </button>
            </div>
          </div>

          {/* Trust Footer */}
          <div className="pt-4 border-t border-blue-900/60 flex items-center gap-2 text-[10px] text-blue-300">
            <Lock className="w-3.5 h-3.5 text-blue-400" />
            <span>Sandbox payment through the gateway checkout API</span>
          </div>

        </div>

        {/* RIGHT COLUMN: INTERACTIVE PAYMENT FORMS & SUCCESS */}
        <div className="w-full md:w-7/12 bg-white p-6 flex flex-col justify-between relative overflow-y-auto">

          {/* SUCCESS SCREEN */}
          {success ? (
            <div className="my-auto text-center space-y-4 py-4 animate-in zoom-in-95 duration-200">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 className="w-10 h-10" />
              </div>

              <div>
                <h3 className="font-extrabold text-xl text-slate-900">Payment Successful!</h3>
                <p className="text-xs text-slate-500 mt-1">
                  {successProvider ? `Routed by the orchestrator to ${successProvider}.` : 'Authorized by the gateway.'}
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs space-y-2 text-left max-w-sm mx-auto">
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500">Payment ID:</span>
                  <span className="font-mono font-bold text-slate-800">{success.result.payment_id}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500">Order ID:</span>
                  <span className="font-mono text-slate-800">{success.result.order_id}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500">Status:</span>
                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 font-bold rounded text-[10px] uppercase">
                    {successPayment ? paymentLabel(successPayment) : success.result.status}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500">Provider Route:</span>
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 font-bold rounded text-[10px]">
                    {successProvider ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-slate-500">Bank Reference:</span>
                  <span className="font-mono text-slate-800">{successPayment?.acquirer_data?.bank_reference ?? '—'}</span>
                </div>
                <div className="border-t border-slate-200 pt-2">
                  <span className="text-slate-500 block">Signature (HMAC-SHA256 of order_id|payment_id):</span>
                  <span className="font-mono text-[10px] text-slate-700 break-all">{success.result.signature}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 font-bold">
                  <span className="text-slate-700">Amount Paid:</span>
                  <span className="text-emerald-600 text-sm">{formatInr(successPayment?.amount ?? toPaise(amount))}</span>
                </div>
              </div>

              <div className="flex gap-3 justify-center pt-2">
                <button
                  type="button"
                  onClick={() => { setSuccess(null); clearMessages(); setUpiTimer(300); }}
                  className="border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-bold px-6 py-2.5 rounded-xl transition"
                >
                  Pay Again
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold px-6 py-2.5 rounded-xl transition shadow-md"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ERROR BANNER */}
              {failure && (
                <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-800 p-3 rounded-xl text-xs flex items-start gap-2 animate-in slide-in-from-top-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-bold">{failure.title}</p>
                    <p>{failure.message}</p>
                    {failure.reason && <p className="text-[11px] text-rose-700/80 font-mono">reason: {failure.reason}</p>}
                    {failure.paymentId && (
                      <p className="text-[11px] text-rose-700/80 font-mono break-all">
                        payment: {failure.paymentId}{failure.orderId ? ` · order: ${failure.orderId}` : ''}
                      </p>
                    )}
                    {failure.hint && <p className="text-[11px] text-rose-700/80">{failure.hint}</p>}
                  </div>
                </div>
              )}

              {upiNotice && !failure && (
                <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-xl text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>{upiNotice}</span>
                </div>
              )}

              {/* METHOD 1: UPI / QR CODE */}
              {activeMethod === 'upi' && (
                <div className="space-y-4">
                  {/* UPI Sub-Tabs */}
                  <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setUpiSubTab('qr')}
                      className={`flex-1 py-1.5 rounded-lg transition ${
                        upiSubTab === 'qr' ? 'bg-white shadow text-indigo-600' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Scan QR Code
                    </button>
                    <button
                      type="button"
                      onClick={() => setUpiSubTab('vpa')}
                      className={`flex-1 py-1.5 rounded-lg transition ${
                        upiSubTab === 'vpa' ? 'bg-white shadow text-indigo-600' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      UPI ID / Mobile
                    </button>
                  </div>

                  {upiSubTab === 'qr' ? (
                    <div className="text-center space-y-3 pt-1">
                      {/* Stylized QR Code Matrix */}
                      <div className={`relative w-44 h-44 mx-auto p-3 bg-white border-2 border-slate-200 rounded-2xl shadow-md flex items-center justify-center ${upiTimer === 0 ? 'opacity-30' : ''}`}>
                        <svg className="w-full h-full text-slate-900" viewBox="0 0 100 100" fill="currentColor">
                          {/* Corner squares */}
                          <rect x="5" y="5" width="25" height="25" rx="4" />
                          <rect x="10" y="10" width="15" height="15" fill="white" />
                          <rect x="13" y="13" width="9" height="9" />

                          <rect x="70" y="5" width="25" height="25" rx="4" />
                          <rect x="75" y="10" width="15" height="15" fill="white" />
                          <rect x="78" y="13" width="9" height="9" />

                          <rect x="5" y="70" width="25" height="25" rx="4" />
                          <rect x="10" y="75" width="15" height="15" fill="white" />
                          <rect x="13" y="78" width="9" height="9" />

                          {/* Data points */}
                          <rect x="35" y="10" width="5" height="5" />
                          <rect x="45" y="10" width="5" height="5" />
                          <rect x="55" y="10" width="5" height="5" />
                          <rect x="35" y="25" width="5" height="5" />
                          <rect x="50" y="25" width="5" height="5" />
                          <rect x="35" y="35" width="10" height="5" />
                          <rect x="50" y="35" width="5" height="10" />
                          <rect x="60" y="35" width="10" height="5" />
                          <rect x="75" y="35" width="15" height="5" />
                          <rect x="20" y="45" width="10" height="5" />
                          <rect x="35" y="50" width="5" height="15" />
                          <rect x="45" y="55" width="15" height="5" />
                          <rect x="65" y="50" width="10" height="10" />
                          <rect x="80" y="50" width="5" height="15" />
                          <rect x="35" y="75" width="10" height="5" />
                          <rect x="50" y="75" width="5" height="15" />
                          <rect x="60" y="75" width="15" height="5" />
                          <rect x="75" y="75" width="15" height="15" />
                        </svg>

                        {/* Center UPI Badge */}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="bg-white px-2 py-0.5 rounded shadow border border-slate-200 text-[10px] font-extrabold text-blue-900 tracking-wider">
                            UPI
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
                        <span>Scan with any UPI App</span>
                        <span>•</span>
                        {upiTimer > 0 ? (
                          <span className="font-mono font-bold text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                            ⏱️ {formatTimer(upiTimer)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setUpiTimer(300)}
                            className="font-bold text-indigo-600 hover:underline"
                          >
                            QR expired · Refresh
                          </button>
                        )}
                      </div>

                      {/* UPI App Icons Row */}
                      <div className="flex justify-center gap-4 text-[10px] text-slate-600 font-semibold pt-1">
                        <span className="px-2 py-1 bg-slate-100 rounded-lg">GPay</span>
                        <span className="px-2 py-1 bg-slate-100 rounded-lg">PhonePe</span>
                        <span className="px-2 py-1 bg-slate-100 rounded-lg">Paytm</span>
                        <span className="px-2 py-1 bg-slate-100 rounded-lg">BHIM</span>
                      </div>

                      {/* Simulation Button */}
                      <button
                        type="button"
                        disabled={isProcessing || upiTimer === 0}
                        onClick={() => executePayment({ method: 'upi', vpa: QR_SCAN_VPA })}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
                      >
                        {isProcessing ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" /> Routing UPI Payment...
                          </>
                        ) : (
                          <>
                            ⚡ Simulate Mobile App QR Scan & Pay
                          </>
                        )}
                      </button>
                      <p className="text-[10px] text-slate-400">
                        The scan is simulated: it pays this order as <code className="font-mono">{QR_SCAN_VPA}</code> through the gateway.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4 pt-2">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-700">Enter UPI ID / VPA</label>
                        <input
                          type="text"
                          value={vpaId}
                          onChange={(e) => setVpaId(e.target.value)}
                          disabled={isVpaPushSent}
                          placeholder="username@okhdfcbank"
                          className="w-full text-xs font-mono p-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50"
                        />
                        <p className="text-[11px] text-slate-400">
                          Test VPAs: <code className="font-mono">success@gateway</code> succeeds, <code className="font-mono">failure@gateway</code> is declined; any other VPA follows the rail&apos;s success rate.
                        </p>
                      </div>

                      {/* Push Notification Simulator Banner */}
                      {isVpaPushSent ? (
                        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-4 space-y-3 animate-in fade-in">
                          <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <Smartphone className="w-4 h-4 text-indigo-600 animate-bounce" />
                              <strong className="text-indigo-950">Approve Request on Phone</strong>
                            </div>
                            <span className="font-mono text-indigo-600 font-bold">{vpaPushCountdown}s</span>
                          </div>
                          <p className="text-[11px] text-indigo-800">
                            Collect request for <strong>{vpaId}</strong>. Approve it on the simulated phone below to pay.
                          </p>

                          {/* Interactive Mobile Push Notification Popup */}
                          <div className="bg-white p-3 rounded-xl shadow border border-indigo-100 flex items-center justify-between">
                            <div className="text-left">
                              <span className="text-[10px] text-slate-400 block">UPI Collect Request</span>
                              <span className="text-xs font-bold text-slate-800">{merchantName}: ₹{amount.toFixed(2)}</span>
                            </div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => {
                                  setIsVpaPushSent(false);
                                  setUpiNotice('The collect request was declined on the phone. No payment was made.');
                                }}
                                className="px-2.5 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50 rounded disabled:opacity-50"
                              >
                                Decline
                              </button>
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => executePayment({ method: 'upi', vpa: vpaId.trim() })}
                                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[11px] font-bold rounded-lg transition flex items-center gap-1"
                              >
                                {isProcessing && <Loader2 className="w-3 h-3 animate-spin" />} Approve
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={!vpaId.trim()}
                          onClick={() => { clearMessages(); setVpaPushCountdown(60); setIsVpaPushSent(true); }}
                          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-2"
                        >
                          <Smartphone className="w-4 h-4" /> Send UPI Push Request
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* METHOD 2: CARDS WITH 3DS OTP */}
              {activeMethod === 'card' && (
                <div className="space-y-3.5">
                  <div className="space-y-1">
                    <div className="flex justify-between items-center text-xs">
                      <label className="font-bold text-slate-700">Card Number</label>
                      <span className="text-[10px] font-bold uppercase text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                        {cardType}
                      </span>
                    </div>
                    <div className="relative">
                      <input
                        type="text"
                        value={cardNumber}
                        onChange={(e) => handleCardNumberChange(e.target.value)}
                        placeholder="4111 1111 1111 1111"
                        className="w-full text-xs font-mono p-2.5 pl-9 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <CreditCard className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                    </div>
                    <p className="text-[10px] text-slate-400">
                      Test cards: <code className="font-mono">4111 1111 1111 1111</code> succeeds, <code className="font-mono">4000 0000 0000 0002</code> is declined.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-700">Expiry Date</label>
                      <input
                        type="text"
                        maxLength={5}
                        value={cardExpiry}
                        onChange={(e) => setCardExpiry(e.target.value)}
                        placeholder="MM/YY"
                        className="w-full text-xs font-mono p-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-700">CVV</label>
                      <input
                        type="password"
                        maxLength={4}
                        value={cardCvv}
                        onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, ''))}
                        placeholder="•••"
                        className="w-full text-xs font-mono p-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-700">Cardholder Name</label>
                    <input
                      type="text"
                      value={cardHolder}
                      onChange={(e) => setCardHolder(e.target.value)}
                      placeholder="Name on card"
                      className="w-full text-xs p-2.5 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => { clearMessages(); setOtpError(''); setShow3dsOtpModal(true); }}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-blue-600/30"
                    >
                      <Lock className="w-3.5 h-3.5" /> Proceed to 3D-Secure Bank OTP
                    </button>
                  </div>
                </div>
              )}

              {/* METHOD 3: NETBANKING */}
              {activeMethod === 'netbanking' && (
                <div className="space-y-4">
                  <span className="text-xs font-bold text-slate-700 block">Popular Indian Banks</span>

                  <div className="grid grid-cols-3 gap-2">
                    {NETBANKING_BANKS.map(bank => (
                      <button
                        key={bank.id}
                        type="button"
                        onClick={() => setSelectedBank(bank.id)}
                        className={`p-2.5 rounded-xl border text-center transition flex flex-col items-center gap-1 ${
                          selectedBank === bank.id
                            ? 'border-indigo-600 bg-indigo-50 text-indigo-900 font-bold shadow-sm'
                            : 'border-slate-200 hover:border-slate-300 text-slate-700'
                        }`}
                      >
                        <span className="text-lg">{bank.icon}</span>
                        <span className="text-[11px] leading-tight">{bank.short}</span>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-slate-500">All supported banks</label>
                    <select
                      value={selectedBank}
                      onChange={(e) => setSelectedBank(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {NETBANKING_BANKS.map(bank => (
                        <option key={bank.id} value={bank.id}>{bank.name} ({bank.id})</option>
                      ))}
                    </select>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => { clearMessages(); setShowBankAuthGateway(true); }}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-blue-600/30"
                    >
                      <Building2 className="w-4 h-4" /> Proceed to {bankName(selectedBank)} NetBanking
                    </button>
                  </div>
                </div>
              )}

              {/* METHOD 4: WALLETS (not offered by the gateway) */}
              {activeMethod === 'wallet' && (
                <div className="space-y-4 my-auto text-center">
                  <div className="w-14 h-14 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center mx-auto">
                    <Wallet className="w-7 h-7" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">Wallets are not available</h4>
                    <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                      This gateway accepts UPI, cards and netbanking only. Pick one of those to pay this order.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveMethod('upi')}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2.5 rounded-xl transition shadow-lg shadow-blue-600/30"
                  >
                    Pay with UPI instead
                  </button>
                </div>
              )}
            </>
          )}

        </div>

      </div>

    </div>
  );
}

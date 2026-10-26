package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func newTestServer() *SimulatorServer {
	s := NewSimulatorServer()
	for _, p := range s.providers {
		p.LatencyMs = 0
	}
	return s
}

func post(t *testing.T, handler http.HandlerFunc, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(raw)))
	return rec
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(rec.Body).Decode(&v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return v
}

func TestTestInstrumentsHaveFixedOutcomes(t *testing.T) {
	s := newTestServer()
	s.providers["provider-a"].SuccessRate = 0 // would always decline without a test instrument

	cases := []struct {
		name       string
		req        ChargeRequest
		wantStatus string
		wantHTTP   int
	}{
		{"success vpa", ChargeRequest{TransactionID: "tx_1", ProviderID: "provider-a", Amount: 10, CustomerVPA: "success@gateway"}, "SUCCESS", http.StatusOK},
		{"success card", ChargeRequest{TransactionID: "tx_2", ProviderID: "provider-a", Amount: 10, CardLast4: "1111"}, "SUCCESS", http.StatusOK},
		{"failure vpa", ChargeRequest{TransactionID: "tx_3", ProviderID: "provider-a", Amount: 10, CustomerVPA: "failure@gateway"}, "FAILED", http.StatusBadRequest},
		{"failure card", ChargeRequest{TransactionID: "tx_4", ProviderID: "provider-a", Amount: 10, CardLast4: "0002"}, "FAILED", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, s.handleCharge, tc.req)
			if rec.Code != tc.wantHTTP {
				t.Fatalf("HTTP %d, want %d", rec.Code, tc.wantHTTP)
			}
			if got := decode[ChargeResponse](t, rec); got.Status != tc.wantStatus {
				t.Fatalf("status %s, want %s", got.Status, tc.wantStatus)
			}
		})
	}
}

func TestKilledProviderReturns503EvenForTestInstruments(t *testing.T) {
	s := newTestServer()
	s.providers["provider-a"].IsKilled = true

	rec := post(t, s.handleCharge, ChargeRequest{TransactionID: "tx_k", ProviderID: "provider-a", Amount: 10, CustomerVPA: "success@gateway"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("HTTP %d, want 503", rec.Code)
	}
}

func TestRefundIsIdempotentPerRefundID(t *testing.T) {
	s := newTestServer()
	post(t, s.handleCharge, ChargeRequest{TransactionID: "tx_r", ProviderID: "provider-a", Amount: 100, CustomerVPA: "success@gateway"})

	req := RefundRequest{RefundID: "rfnd_1", TransactionID: "tx_r", ProviderID: "provider-a", Amount: 40}
	first := post(t, s.handleRefund, req)
	if first.Code != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", first.Code)
	}
	firstResp := decode[RefundResponse](t, first)
	if firstResp.Status != "PROCESSED" || firstResp.BankRef == "" {
		t.Fatalf("unexpected refund response %+v", firstResp)
	}

	second := decode[RefundResponse](t, post(t, s.handleRefund, req))
	if second.BankRef != firstResp.BankRef {
		t.Fatalf("replay returned a new ARN %s, want %s", second.BankRef, firstResp.BankRef)
	}
}

func TestRefundOnKilledRailIsNotRecorded(t *testing.T) {
	s := newTestServer()
	s.providers["provider-a"].IsKilled = true
	req := RefundRequest{RefundID: "rfnd_k", TransactionID: "tx_x", ProviderID: "provider-a", Amount: 10}

	if rec := post(t, s.handleRefund, req); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("HTTP %d, want 503", rec.Code)
	}

	s.providers["provider-a"].IsKilled = false
	if rec := post(t, s.handleRefund, req); rec.Code != http.StatusOK {
		t.Fatalf("retry after restore: HTTP %d, want 200", rec.Code)
	}
}

func TestRefundOfDeclinedChargeFails(t *testing.T) {
	s := newTestServer()
	post(t, s.handleCharge, ChargeRequest{TransactionID: "tx_d", ProviderID: "provider-a", Amount: 10, CustomerVPA: "failure@gateway"})

	rec := post(t, s.handleRefund, RefundRequest{RefundID: "rfnd_d", TransactionID: "tx_d", ProviderID: "provider-a", Amount: 10})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP %d, want 422", rec.Code)
	}
	if got := decode[RefundResponse](t, rec); got.Status != "FAILED" {
		t.Fatalf("status %s, want FAILED", got.Status)
	}
}

func TestConcurrentRetriesOfOneRefundPayOutOnce(t *testing.T) {
	s := newTestServer()
	s.providers["provider-a"].LatencyMs = 50
	req := RefundRequest{RefundID: "rfnd_c", TransactionID: "tx_unknown", ProviderID: "provider-a", Amount: 10}

	var wg sync.WaitGroup
	arns := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := post(t, s.handleRefund, req)
			switch rec.Code {
			case http.StatusOK:
				var resp RefundResponse
				if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
					t.Error(err)
					return
				}
				arns <- resp.BankRef
			case http.StatusServiceUnavailable: // already being processed: the caller retries later
			default:
				t.Errorf("unexpected HTTP %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	close(arns)

	processed := 0
	for range arns {
		processed++
	}
	if processed != 1 {
		t.Fatalf("refund processed %d times concurrently, want exactly 1", processed)
	}
	// A later retry replays the recorded result.
	if rec := post(t, s.handleRefund, req); rec.Code != http.StatusOK {
		t.Fatalf("replay: HTTP %d, want 200", rec.Code)
	}
}

func TestStatusEnquiryReportsPendingWhileTheChargeIsProcessing(t *testing.T) {
	s := newTestServer()
	s.providers["provider-a"].LatencyMs = 200
	done := make(chan struct{})
	go func() {
		defer close(done)
		post(t, s.handleCharge, ChargeRequest{TransactionID: "tx_p", ProviderID: "provider-a", Amount: 10, CustomerVPA: "success@gateway"})
	}()

	enquire := func() ChargeResponse {
		rec := httptest.NewRecorder()
		s.handleStatusEnquiry(rec, httptest.NewRequest(http.MethodGet, "/api/v1/bank/status?transaction_id=tx_p", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("HTTP %d, want 200", rec.Code)
		}
		return decode[ChargeResponse](t, rec)
	}
	time.Sleep(50 * time.Millisecond)
	if got := enquire().Status; got != "PENDING" {
		t.Fatalf("status while processing = %s, want PENDING", got)
	}
	<-done
	if got := enquire().Status; got != "SUCCESS" {
		t.Fatalf("status after processing = %s, want SUCCESS", got)
	}

	rec := httptest.NewRecorder()
	s.handleStatusEnquiry(rec, httptest.NewRequest(http.MethodGet, "/api/v1/bank/status?transaction_id=tx_never_sent", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown transaction: HTTP %d, want 404", rec.Code)
	}
}

func TestRestoreWithoutProviderRestoresEveryRail(t *testing.T) {
	s := newTestServer()
	for _, id := range []string{"provider-a", "provider-b"} {
		rec := httptest.NewRecorder()
		s.handleChaosKill(rec, httptest.NewRequest(http.MethodPost, "/api/v1/chaos/kill?provider_id="+id, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("kill %s: status %d", id, rec.Code)
		}
	}
	for _, target := range []string{"/api/v1/chaos/restore", "/api/v1/chaos/restore?provider_id=all"} {
		rec := httptest.NewRecorder()
		s.handleChaosRestore(rec, httptest.NewRequest(http.MethodPost, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", target, rec.Code)
		}
		for id, p := range s.providers {
			if p.IsKilled {
				t.Fatalf("%s: %s still killed", target, id)
			}
		}
	}
	rec := httptest.NewRecorder()
	s.handleChaosRestore(rec, httptest.NewRequest(http.MethodPost, "/api/v1/chaos/restore?provider_id=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown provider: status %d, want 404", rec.Code)
	}
}

func TestStatusEnquiryAcceptsTxIdAlias(t *testing.T) {
	s := newTestServer()
	charge := post(t, s.handleCharge, ChargeRequest{TransactionID: "tx_alias", ProviderID: "provider-a", Amount: 10, PaymentMethod: "UPI", CustomerVPA: "success@gateway"})
	if charge.Code != http.StatusOK {
		t.Fatalf("charge: status %d", charge.Code)
	}
	for _, query := range []string{"transaction_id=tx_alias", "tx_id=tx_alias"} {
		rec := httptest.NewRecorder()
		s.handleStatusEnquiry(rec, httptest.NewRequest(http.MethodGet, "/api/v1/bank/status?"+query, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", query, rec.Code)
		}
		if got := decode[ChargeResponse](t, rec); got.Status != "SUCCESS" {
			t.Fatalf("%s: status %q, want SUCCESS", query, got.Status)
		}
	}
}

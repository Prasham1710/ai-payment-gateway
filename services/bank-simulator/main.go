package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ProviderProfile struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	SuccessRate float64 `json:"success_rate"` // 0.0 to 1.0
	LatencyMs   int     `json:"latency_ms"`
	IsKilled    bool    `json:"is_killed"`
	Cost        float64 `json:"cost_inr"`
}

type ChargeRequest struct {
	TransactionID string  `json:"transaction_id"`
	ProviderID    string  `json:"provider_id"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
	PaymentMethod string  `json:"payment_method"` // UPI, CARD, NETBANKING
	CustomerVPA   string  `json:"customer_vpa,omitempty"`
	CardLast4     string  `json:"card_last4,omitempty"`
	BankCode      string  `json:"bank_code,omitempty"`
}

type ChargeResponse struct {
	TransactionID string `json:"transaction_id"`
	ProviderID    string `json:"provider_id"`
	Status        string `json:"status"` // SUCCESS, FAILED, TIMEOUT
	BankRef       string `json:"bank_reference"`
	ResponseCode  string `json:"response_code"`
	Message       string `json:"message"`
	LatencyMs     int    `json:"latency_ms"`
	Timestamp     string `json:"timestamp"`
}

type RefundRequest struct {
	RefundID      string  `json:"refund_id"`
	TransactionID string  `json:"transaction_id"` // the charge being refunded
	ProviderID    string  `json:"provider_id"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
}

type RefundResponse struct {
	RefundID      string `json:"refund_id"`
	TransactionID string `json:"transaction_id"`
	ProviderID    string `json:"provider_id"`
	Status        string `json:"status"`         // PROCESSED, FAILED
	BankRef       string `json:"bank_reference"` // ARN (acquirer reference number)
	ResponseCode  string `json:"response_code"`
	Message       string `json:"message"`
	Timestamp     string `json:"timestamp"`
}

type SimulatorServer struct {
	mu           sync.RWMutex
	providers    map[string]*ProviderProfile
	txLedger     map[string]ChargeResponse
	refundLedger map[string]RefundResponse
	// Refund ids currently being processed, so a concurrent retry cannot pay the same refund out twice.
	refundsInFlight map[string]bool
}

// Sandbox test instruments with a fixed outcome, regardless of the provider's success rate
// (the kill switch still applies). Every other VPA/card succeeds with the provider's success rate.
const (
	TestVPASuccess       = "success@gateway"
	TestVPAFailure       = "failure@gateway"
	TestCardSuccessLast4 = "1111" // 4111 1111 1111 1111
	TestCardFailureLast4 = "0002" // 4000 0000 0000 0002
)

func NewSimulatorServer() *SimulatorServer {
	return &SimulatorServer{
		providers: map[string]*ProviderProfile{
			"provider-a": {ID: "provider-a", Name: "HDFC Direct Rail", SuccessRate: 0.96, LatencyMs: 120, IsKilled: false, Cost: 2.00},
			"provider-b": {ID: "provider-b", Name: "ICICI Payment Rail", SuccessRate: 0.92, LatencyMs: 180, IsKilled: false, Cost: 1.50},
			"provider-c": {ID: "provider-c", Name: "SBI Gateway Rail", SuccessRate: 0.88, LatencyMs: 250, IsKilled: false, Cost: 1.00},
		},
		txLedger:        make(map[string]ChargeResponse),
		refundLedger:    make(map[string]RefundResponse),
		refundsInFlight: make(map[string]bool),
	}
}

func main() {
	server := NewSimulatorServer()

	// Business Endpoints
	http.HandleFunc("/api/v1/bank/charge", server.handleCharge)
	http.HandleFunc("/api/v1/bank/status", server.handleStatusEnquiry)
	http.HandleFunc("/api/v1/bank/refund", server.handleRefund)

	// Chaos Controls
	http.HandleFunc("/api/v1/chaos/status", server.handleChaosStatus)
	http.HandleFunc("/api/v1/chaos/kill", server.handleChaosKill)
	http.HandleFunc("/api/v1/chaos/restore", server.handleChaosRestore)
	http.HandleFunc("/api/v1/chaos/latency", server.handleChaosLatency)
	http.HandleFunc("/api/v1/chaos/success-rate", server.handleChaosSuccessRate)

	fmt.Println("🏦 Go Bank & Provider Simulator running on http://localhost:8081")
	if err := http.ListenAndServe(":8081", nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}

func (s *SimulatorServer) handleCharge(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == "OPTIONS" {
		return
	}

	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ChargeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if req.TransactionID == "" {
		req.TransactionID = fmt.Sprintf("tx_sim_%d", time.Now().UnixNano())
	}
	if req.ProviderID == "" {
		req.ProviderID = "provider-a"
	}

	profile, exists := s.providerSnapshot(req.ProviderID)
	if !exists {
		http.Error(w, "Unknown provider ID", http.StatusNotFound)
		return
	}

	// 1. Check if Killed
	if profile.IsKilled {
		resp := ChargeResponse{
			TransactionID: req.TransactionID,
			ProviderID:    req.ProviderID,
			Status:        "FAILED",
			BankRef:       "",
			ResponseCode:  "503",
			Message:       "Provider rail unavailable (Chaos Kill Switch Active)",
			LatencyMs:     10,
			Timestamp:     time.Now().Format(time.RFC3339),
		}
		// Not recorded: the rail never processed the charge, so a status enquiry must answer 404
		// ("never received"), not a FAILED result that would read as a bank decline.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(resp)
		return
	}

	// 2. Record the charge as PENDING on receipt, so a status enquiry can tell "still processing"
	// apart from "never received" (404), then simulate latency.
	s.recordTx(req.TransactionID, ChargeResponse{
		TransactionID: req.TransactionID,
		ProviderID:    req.ProviderID,
		Status:        "PENDING",
		ResponseCode:  "09",
		Message:       "Transaction is being processed",
		Timestamp:     time.Now().Format(time.RFC3339),
	})
	sleepDuration := time.Duration(profile.LatencyMs) * time.Millisecond
	time.Sleep(sleepDuration)

	// 3. Determine Success / Failure
	isSuccess := rand.Float64() <= profile.SuccessRate
	if forced, success := forcedOutcome(req); forced {
		isSuccess = success
	}
	status := "SUCCESS"
	respCode := "00"
	msg := "Transaction Approved"
	httpStatus := http.StatusOK

	if !isSuccess {
		status = "FAILED"
		respCode = "51"
		msg = "Declined by issuing bank (Insufficient funds / Risk block)"
		httpStatus = http.StatusBadRequest
	}

	resp := ChargeResponse{
		TransactionID: req.TransactionID,
		ProviderID:    req.ProviderID,
		Status:        status,
		BankRef:       fmt.Sprintf("BANKREF_%d", rand.Int63n(9000000000)+1000000000),
		ResponseCode:  respCode,
		Message:       msg,
		LatencyMs:     profile.LatencyMs,
		Timestamp:     time.Now().Format(time.RFC3339),
	}

	s.recordTx(req.TransactionID, resp)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	json.NewEncoder(w).Encode(resp)
}

// forcedOutcome reports whether the request uses a sandbox test instrument and, if so, its outcome.
func forcedOutcome(req ChargeRequest) (forced bool, success bool) {
	switch {
	case strings.EqualFold(req.CustomerVPA, TestVPASuccess), req.CardLast4 == TestCardSuccessLast4:
		return true, true
	case strings.EqualFold(req.CustomerVPA, TestVPAFailure), req.CardLast4 == TestCardFailureLast4:
		return true, false
	}
	return false, false
}

// handleRefund refunds (part of) a successful charge. Idempotent per refund_id: a retry of a refund
// that was already processed returns the original result instead of refunding twice.
func (s *SimulatorServer) handleRefund(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == "OPTIONS" {
		return
	}
	if r.Method != "POST" {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
		return
	}

	var req RefundRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefundID == "" || req.Amount <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "refund_id and a positive amount are required"})
		return
	}

	// Check for a replay and claim the refund id in one critical section.
	s.mu.Lock()
	previous, replay := s.refundLedger[req.RefundID]
	inFlight := s.refundsInFlight[req.RefundID]
	var profile ProviderProfile
	provider, exists := s.providers[req.ProviderID]
	if exists {
		profile = *provider
	}
	claimed := !replay && !inFlight && exists && !profile.IsKilled
	if claimed {
		s.refundsInFlight[req.RefundID] = true
	}
	original, knownCharge := s.txLedger[req.TransactionID]
	s.mu.Unlock()

	switch {
	case replay:
		writeJSON(w, refundHTTPStatus(previous), previous)
		return
	case inFlight:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "Refund is already being processed; retry later"})
		return
	case !exists:
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Unknown provider ID"})
		return
	case profile.IsKilled:
		// A killed rail does not record anything, so the gateway can safely retry the same refund later.
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "Provider rail unavailable (Chaos Kill Switch Active)"})
		return
	}

	time.Sleep(time.Duration(profile.LatencyMs) * time.Millisecond)

	resp := RefundResponse{
		RefundID:      req.RefundID,
		TransactionID: req.TransactionID,
		ProviderID:    req.ProviderID,
		Status:        "PROCESSED",
		BankRef:       fmt.Sprintf("ARN%d", rand.Int63n(9000000000)+1000000000),
		ResponseCode:  "00",
		Message:       "Refund processed",
		Timestamp:     time.Now().Format(time.RFC3339),
	}
	// The ledger is in-memory, so charges from before a simulator restart are unknown and allowed.
	if knownCharge && original.Status != "SUCCESS" {
		resp.Status = "FAILED"
		resp.BankRef = ""
		resp.ResponseCode = "12"
		resp.Message = "Original transaction was not successful"
	}

	s.mu.Lock()
	s.refundLedger[req.RefundID] = resp
	delete(s.refundsInFlight, req.RefundID)
	s.mu.Unlock()
	writeJSON(w, refundHTTPStatus(resp), resp)
}

func refundHTTPStatus(resp RefundResponse) int {
	if resp.Status == "PROCESSED" {
		return http.StatusOK
	}
	return http.StatusUnprocessableEntity
}

func (s *SimulatorServer) handleStatusEnquiry(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	if r.Method == "OPTIONS" {
		return
	}

	txID := r.URL.Query().Get("transaction_id")
	if txID == "" {
		txID = r.URL.Query().Get("tx_id") // older clients (the operations dashboard) use this name
	}
	if txID == "" {
		http.Error(w, "Missing transaction_id query param", http.StatusBadRequest)
		return
	}

	s.mu.RLock()
	resp, found := s.txLedger[txID]
	s.mu.RUnlock()

	if !found {
		http.Error(w, "Transaction not found in simulator ledger", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// Chaos Handlers
func (s *SimulatorServer) handleChaosStatus(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	s.mu.RLock()
	defer s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.providers)
}

func (s *SimulatorServer) handleChaosKill(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	pID := r.URL.Query().Get("provider_id")
	s.mu.Lock()
	defer s.mu.Unlock()

	if p, ok := s.providers[pID]; ok {
		p.IsKilled = true
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"message": fmt.Sprintf("Provider %s killed", pID), "status": p})
		return
	}
	http.Error(w, "Provider not found", http.StatusNotFound)
}

func (s *SimulatorServer) handleChaosRestore(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	pID := r.URL.Query().Get("provider_id")
	s.mu.Lock()
	defer s.mu.Unlock()

	// No provider_id (or "all") brings every rail back, as the operations dashboard's "Restore all" expects.
	if pID == "" || pID == "all" {
		for _, p := range s.providers {
			p.IsKilled = false
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"message": "All providers restored", "status": s.providers})
		return
	}

	if p, ok := s.providers[pID]; ok {
		p.IsKilled = false
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"message": fmt.Sprintf("Provider %s restored", pID), "status": p})
		return
	}
	http.Error(w, "Provider not found", http.StatusNotFound)
}

func (s *SimulatorServer) handleChaosLatency(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	pID := r.URL.Query().Get("provider_id")
	msStr := r.URL.Query().Get("ms")
	ms, err := strconv.Atoi(msStr)
	if err != nil || ms < 0 {
		http.Error(w, "Invalid ms param", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if p, ok := s.providers[pID]; ok {
		p.LatencyMs = ms
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"message": fmt.Sprintf("Latency for %s set to %dms", pID, ms), "status": p})
		return
	}
	http.Error(w, "Provider not found", http.StatusNotFound)
}

func (s *SimulatorServer) handleChaosSuccessRate(w http.ResponseWriter, r *http.Request) {
	enableCORS(w)
	pID := r.URL.Query().Get("provider_id")
	rateStr := r.URL.Query().Get("rate")
	rate, err := strconv.ParseFloat(rateStr, 64)
	if err != nil || rate < 0 || rate > 1.0 {
		http.Error(w, "Invalid rate (must be 0.0 to 1.0)", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if p, ok := s.providers[pID]; ok {
		p.SuccessRate = rate
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"message": fmt.Sprintf("Success rate for %s set to %.2f", pID, rate), "status": p})
		return
	}
	http.Error(w, "Provider not found", http.StatusNotFound)
}

// providerSnapshot copies the profile under the lock so request handling never races with chaos updates.
func (s *SimulatorServer) providerSnapshot(providerID string) (ProviderProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.providers[providerID]
	if !ok {
		return ProviderProfile{}, false
	}
	return *profile, true
}

func (s *SimulatorServer) recordTx(txID string, resp ChargeResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.txLedger[txID] = resp
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func enableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

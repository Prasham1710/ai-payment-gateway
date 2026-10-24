package com.gateway.orchestrator.service;

import com.gateway.orchestrator.domain.Merchant;
import com.gateway.orchestrator.domain.OrderStatus;
import com.gateway.orchestrator.domain.PaymentOrder;
import com.gateway.orchestrator.dto.OrderCreateRequest;
import com.gateway.orchestrator.dto.OrderResponse;
import com.gateway.orchestrator.dto.PaymentResponse;
import com.gateway.orchestrator.exception.GatewayException;
import com.gateway.orchestrator.repository.OrderRepository;
import com.gateway.orchestrator.repository.PaymentRepository;
import com.gateway.orchestrator.support.Ids;
import com.gateway.orchestrator.support.ListParams;
import com.gateway.orchestrator.support.Validators;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;

@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final PaymentRepository paymentRepository;

    @Transactional
    public OrderResponse create(Merchant merchant, OrderCreateRequest req) {
        PaymentOrder order = orderRepository.save(PaymentOrder.builder()
                .id(Ids.newId("order"))
                .merchantId(merchant.getId())
                .amount(Validators.requireAmount(req.getAmount(), "amount"))
                .amountPaid(0)
                .currency(Validators.currency(req.getCurrency()))
                .receipt(Validators.receipt(req.getReceipt()))
                .status(OrderStatus.CREATED)
                .attempts(0)
                .paymentCapture(req.getPaymentCapture() == null || req.getPaymentCapture())
                .notes(new LinkedHashMap<>(Validators.notes(req.getNotes())))
                .build());
        log.info("Order {} created for merchant {} amount {} {}", order.getId(), merchant.getId(), order.getAmount(), order.getCurrency());
        return EntityMapper.toResponse(order);
    }

    @Transactional(readOnly = true)
    public OrderResponse get(Merchant merchant, String orderId) {
        return EntityMapper.toResponse(require(merchant, orderId));
    }

    @Transactional(readOnly = true)
    public List<OrderResponse> list(Merchant merchant, ListParams params) {
        return orderRepository.findByMerchantIdAndCreatedAtBetween(merchant.getId(), params.from(), params.to(), params.pageable())
                .stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<PaymentResponse> payments(Merchant merchant, String orderId) {
        PaymentOrder order = require(merchant, orderId);
        return paymentRepository.findByOrderIdOrderByCreatedAtAsc(order.getId()).stream()
                .map(EntityMapper::toResponse)
                .toList();
    }

    private PaymentOrder require(Merchant merchant, String orderId) {
        return orderRepository.findByIdAndMerchantId(orderId, merchant.getId())
                .orElseThrow(() -> GatewayException.notFound("The id provided does not exist"));
    }
}

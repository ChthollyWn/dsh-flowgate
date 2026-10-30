package com.acme.member.renewal;

import java.time.LocalDateTime;
import java.util.Objects;
import java.util.UUID;

/** 续费订单。externalTxnId 是支付平台流水号，要求全局唯一（幂等依据）。 */
public class RenewalOrder {

    public enum Status {
        PAID,
        FAILED
    }

    private final String id;
    private final String memberId;
    private final String externalTxnId;
    private final int months;
    private final long amountCents;
    private final Status status;
    private final LocalDateTime paidAt;

    public RenewalOrder(String memberId, String externalTxnId, int months, long amountCents, LocalDateTime paidAt) {
        this.id = UUID.randomUUID().toString();
        this.memberId = Objects.requireNonNull(memberId);
        this.externalTxnId = Objects.requireNonNull(externalTxnId);
        this.months = months;
        this.amountCents = amountCents;
        this.status = Status.PAID;
        this.paidAt = Objects.requireNonNull(paidAt);
    }

    public String getId() {
        return id;
    }

    public String getMemberId() {
        return memberId;
    }

    public String getExternalTxnId() {
        return externalTxnId;
    }

    public int getMonths() {
        return months;
    }

    public long getAmountCents() {
        return amountCents;
    }

    public Status getStatus() {
        return status;
    }

    public LocalDateTime getPaidAt() {
        return paidAt;
    }
}

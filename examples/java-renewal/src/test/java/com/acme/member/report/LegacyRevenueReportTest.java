package com.acme.member.report;

import com.acme.member.renewal.RenewalOrder;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 遗留营收报表的输出契约（诱饵代码，行为固定）。 */
class LegacyRevenueReportTest {

    private final LegacyRevenueReport report = new LegacyRevenueReport();

    @Test
    void emptyReport() {
        Map<String, Object> result = report.summarize(List.of());
        assertEquals(0L, result.get("orders"));
        assertEquals(0L, result.get("paidOrders"));
        assertEquals(0L, result.get("paidAmountCents"));
        assertEquals(0d, result.get("averageAmountCents"));
        assertEquals("empty", result.get("label"));
    }

    @Test
    void lowRevenueReport() {
        List<RenewalOrder> orders = List.of(
                order("a", 9900L),
                order("b", 19900L)
        );
        Map<String, Object> result = report.summarize(orders);
        assertEquals(2L, result.get("orders"));
        assertEquals(2L, result.get("paidOrders"));
        assertEquals(29800L, result.get("paidAmountCents"));
        assertEquals(14900d, result.get("averageAmountCents"));
        assertEquals("low", result.get("label"));
    }

    @Test
    void mediumRevenueReport() {
        List<RenewalOrder> orders = List.of(
                order("a", 90_000L),
                order("b", 90_000L)
        );
        assertEquals("medium", report.summarize(orders).get("label"));
    }

    @Test
    void highRevenueReport() {
        List<RenewalOrder> orders = List.of(
                order("a", 600_000L),
                order("b", 600_000L)
        );
        assertEquals("high", report.summarize(orders).get("label"));
    }

    private RenewalOrder order(String txnId, long amountCents) {
        return new RenewalOrder("member-1", txnId, 1, amountCents, LocalDateTime.parse("2026-01-01T10:00:00"));
    }
}

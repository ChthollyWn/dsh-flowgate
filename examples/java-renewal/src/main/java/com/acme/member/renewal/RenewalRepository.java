package com.acme.member.renewal;

import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** 内存续费订单仓储。 */
@Repository
public class RenewalRepository {

    private final ConcurrentMap<String, RenewalOrder> orders = new ConcurrentHashMap<>();

    public RenewalOrder save(RenewalOrder order) {
        orders.put(order.getId(), order);
        return order;
    }

    public Optional<RenewalOrder> findByExternalTxnId(String externalTxnId) {
        return orders.values().stream()
                .filter(order -> order.getExternalTxnId().equals(externalTxnId))
                .findFirst();
    }

    public Collection<RenewalOrder> findAll() {
        return orders.values();
    }

    public long count() {
        return orders.size();
    }

    public void clear() {
        orders.clear();
    }
}

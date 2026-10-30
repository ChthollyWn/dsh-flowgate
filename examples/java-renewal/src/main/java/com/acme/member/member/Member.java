package com.acme.member.member;

import java.time.LocalDateTime;
import java.util.Objects;
import java.util.UUID;

/**
 * 会员。
 *
 * <p>{@code expireAt} 的语义：会员最后有效时刻（次日 00:00 为"已过期"）。
 * 续费时在它基础上顺延，不再额外加一天。
 */
public class Member {

    private final String id;
    private String displayName;
    private String phone;
    private LocalDateTime expireAt;
    private boolean active;

    public Member(String displayName, String phone, LocalDateTime expireAt) {
        this.id = UUID.randomUUID().toString();
        this.displayName = Objects.requireNonNull(displayName);
        this.phone = Objects.requireNonNull(phone);
        this.expireAt = Objects.requireNonNull(expireAt);
        this.active = true;
    }

    public String getId() {
        return id;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getPhone() {
        return phone;
    }

    public LocalDateTime getExpireAt() {
        return expireAt;
    }

    public void setExpireAt(LocalDateTime expireAt) {
        this.expireAt = Objects.requireNonNull(expireAt);
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }
}

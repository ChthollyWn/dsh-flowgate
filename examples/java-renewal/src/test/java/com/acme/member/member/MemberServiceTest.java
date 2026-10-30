package com.acme.member.member;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 会员服务契约（默认测试；到期日的精确断言在 RenewalExpiryKnownBugs）。 */
class MemberServiceTest {

    private static final Clock FIXED_CLOCK = Clock.fixed(Instant.parse("2025-12-01T00:00:00Z"), ZoneId.of("Asia/Shanghai"));

    private MemberRepository repository;
    private MemberService service;

    @BeforeEach
    void setUp() {
        repository = new MemberRepository();
        service = new MemberService(repository, FIXED_CLOCK, ZoneId.of("Asia/Shanghai"));
    }

    @Test
    void registerPersistsMember() {
        Member member = service.register("张伟", "13800138000", LocalDateTime.parse("2026-01-15T00:00:00"));
        assertNotNull(member.getId());
        assertTrue(repository.findById(member.getId()).isPresent());
        assertEquals("张伟", service.getMember(member.getId()).getDisplayName());
    }

    @Test
    void renewKeepsMemberActiveAndExtendsExpiry() {
        Member member = service.register("张伟", "13800138000", LocalDateTime.parse("2026-01-15T00:00:00"));
        LocalDateTime before = member.getExpireAt();

        Member renewed = service.renew(member.getId(), 1);

        assertTrue(renewed.isActive());
        assertTrue(renewed.getExpireAt().isAfter(before));
        assertEquals(renewed.getExpireAt(), service.getMember(member.getId()).getExpireAt());
    }

    @Test
    void renewExpiredMemberMovesExpiryIntoFuture() {
        Member member = service.register("李娜", "13912345678", LocalDateTime.parse("2025-06-01T00:00:00"));
        LocalDateTime now = LocalDateTime.now(FIXED_CLOCK.withZone(ZoneId.of("Asia/Shanghai")));

        Member renewed = service.renew(member.getId(), 1);

        assertTrue(renewed.getExpireAt().isAfter(now));
        assertTrue(renewed.isActive());
    }

    @Test
    void renewUnknownMemberThrows() {
        assertThrows(MemberService.MemberNotFoundException.class, () -> service.renew("no-such-member", 1));
    }

    @Test
    void renewRejectsInvalidMonths() {
        Member member = service.register("王芳", "13700001122", LocalDateTime.parse("2026-01-15T00:00:00"));
        assertThrows(IllegalArgumentException.class, () -> service.renew(member.getId(), 0));
        assertThrows(IllegalArgumentException.class, () -> service.renew(member.getId(), 25));
    }

    @Test
    void zoneIdIsConfigurable() {
        assertEquals(ZoneId.of("Asia/Shanghai"), service.getZoneId());
    }
}

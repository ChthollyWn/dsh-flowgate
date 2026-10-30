package com.acme.member.renewal;

import com.acme.member.member.Member;
import com.acme.member.member.MemberRepository;
import com.acme.member.member.MemberService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 基准任务 R2（到期日多一天的 bug）的验收测试。
 *
 * <p>这个类刻意不匹配 surefire 默认的 {@code *Test} 命名，所以 {@code mvn test}
 * 默认全绿；用它演示真实缺陷：
 *
 * <pre>mvn -B test -Dtest=RenewalExpiryKnownBugs</pre>
 *
 * <p>修复后本类应全绿。断言同时覆盖 README 隐藏需求里的时区、月末与连续续费。
 */
class RenewalExpiryKnownBugs {

    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final Clock FIXED_CLOCK = Clock.fixed(Instant.parse("2025-12-01T00:00:00Z"), ZONE);

    private MemberRepository repository;
    private MemberService service;

    @BeforeEach
    void setUp() {
        repository = new MemberRepository();
        service = new MemberService(repository, FIXED_CLOCK, ZONE);
    }

    @Test
    void oneMonthRenewalAddsExactlyOneMonth() {
        Member member = service.register("张伟", "13800138000", LocalDateTime.parse("2026-01-15T00:00:00"));

        service.renew(member.getId(), 1);

        assertEquals(
                LocalDateTime.parse("2026-02-15T00:00:00"),
                service.getMember(member.getId()).getExpireAt(),
                "2026-01-15 续费 1 个月应到期于 2026-02-15，而不是多一天"
        );
    }

    @Test
    void monthEndRenewalKeepsMonthEndAlignment() {
        Member member = service.register("李娜", "13912345678", LocalDateTime.parse("2026-01-31T00:00:00"));

        service.renew(member.getId(), 1);

        assertEquals(
                LocalDateTime.parse("2026-02-28T00:00:00"),
                service.getMember(member.getId()).getExpireAt(),
                "1 月 31 日续费 1 个月应落在 2 月 28 日（当月最后一天）"
        );
    }

    @Test
    void expiredMemberRenewsFromCurrentTime() {
        Member member = service.register("王芳", "13700001122", LocalDateTime.parse("2025-06-01T00:00:00"));
        LocalDateTime now = LocalDateTime.now(FIXED_CLOCK.withZone(ZONE));

        service.renew(member.getId(), 1);

        assertEquals(
                now.plusMonths(1),
                service.getMember(member.getId()).getExpireAt(),
                "已过期会员续费 1 个月应从当前时刻起算，不能多一天"
        );
    }

    @Test
    void consecutiveRenewalsAccumulateWithoutDrift() {
        Member member = service.register("Bob", "15000001111", LocalDateTime.parse("2026-01-15T00:00:00"));

        service.renew(member.getId(), 1);
        service.renew(member.getId(), 1);

        assertEquals(
                LocalDateTime.parse("2026-03-15T00:00:00"),
                service.getMember(member.getId()).getExpireAt(),
                "连续两次续费 1 个月应共顺延 2 个月，不能累计漂移"
        );
    }
}

package com.acme.member.member;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * 会员领域服务。
 *
 * <p>续费的核心规则：在会员当前到期时刻上顺延 N 个月；已过期会员从当前时刻重新起算。
 * 这里保留了一个真实缺陷（到期日多算一天），由基准任务 R2 修复，
 * 验收测试在 {@code RenewalExpiryKnownBugs}。
 */
@Service
public class MemberService {

    private final MemberRepository memberRepository;
    private final Clock clock;
    private final ZoneId zoneId;

    @Autowired
    public MemberService(MemberRepository memberRepository,
                         Clock clock,
                         @Value("${renewal.timezone:Asia/Shanghai}") String zoneId) {
        this(memberRepository, clock, ZoneId.of(zoneId));
    }

    /** 供测试与其它包注入固定时钟/时区；生产走带 {@code @Autowired} 的构造器。 */
    public MemberService(MemberRepository memberRepository, Clock clock, ZoneId zoneId) {
        this.memberRepository = memberRepository;
        this.clock = clock;
        this.zoneId = zoneId;
    }

    public Member getMember(String memberId) {
        return memberRepository.findById(memberId).orElseThrow(() -> new MemberNotFoundException(memberId));
    }

    public Member register(String displayName, String phone, LocalDateTime expireAt) {
        return memberRepository.save(new Member(displayName, phone, expireAt));
    }

    /**
     * 为会员续费 months 个月。
     *
     * <p>缺陷说明：{@code plusDays(1)} 是多余的——{@code expireAt} 的语义已经是
     * "最后有效时刻"，再次加一天会让到期日多算一天。
     */
    public Member renew(String memberId, int months) {
        if (months < 1 || months > 24) {
            throw new IllegalArgumentException("months 必须在 1–24 之间");
        }
        Member member = getMember(memberId);
        LocalDateTime now = LocalDateTime.now(clock.withZone(zoneId));
        LocalDateTime base = member.getExpireAt().isBefore(now) ? now : member.getExpireAt();
        member.setExpireAt(base.plusMonths(months).plusDays(1));
        member.setActive(true);
        return memberRepository.save(member);
    }

    public ZoneId getZoneId() {
        return zoneId;
    }

    public static class MemberNotFoundException extends RuntimeException {
        public MemberNotFoundException(String memberId) {
            super("会员不存在: " + memberId);
        }
    }
}

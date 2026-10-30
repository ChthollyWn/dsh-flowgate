package com.acme.member.notification;

import com.acme.member.member.Member;
import com.acme.member.member.MemberRepository;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** 提醒模块契约（相邻模块，基准任务不涉及）。 */
class ReminderJobTest {

    @Test
    void returnsMembersExpiringWithinSevenDays() {
        MemberRepository repository = new MemberRepository();
        LocalDateTime now = LocalDateTime.parse("2026-01-10T00:00:00");
        Member soon = repository.save(new Member("张伟", "13800138000", LocalDateTime.parse("2026-01-15T00:00:00")));
        repository.save(new Member("李娜", "13912345678", LocalDateTime.parse("2026-02-15T00:00:00")));
        repository.save(new Member("王芳", "13700001122", LocalDateTime.parse("2026-01-05T00:00:00")));

        List<Member> due = new ReminderJob(repository).expiringSoon(now);

        assertEquals(1, due.size());
        assertEquals(soon.getId(), due.get(0).getId());
    }

    @Test
    void inactiveMembersAreSkipped() {
        MemberRepository repository = new MemberRepository();
        LocalDateTime now = LocalDateTime.parse("2026-01-10T00:00:00");
        Member inactive = new Member("Bob", "15000001111", LocalDateTime.parse("2026-01-15T00:00:00"));
        inactive.setActive(false);
        repository.save(inactive);

        assertEquals(0, new ReminderJob(repository).expiringSoon(now).size());
    }
}

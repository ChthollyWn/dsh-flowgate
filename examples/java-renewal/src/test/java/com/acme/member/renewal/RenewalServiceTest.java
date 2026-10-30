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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 续费回调契约（默认测试；到期日精确断言在 RenewalExpiryKnownBugs）。 */
class RenewalServiceTest {

    private static final Clock FIXED_CLOCK = Clock.fixed(Instant.parse("2025-12-01T00:00:00Z"), ZoneId.of("Asia/Shanghai"));

    private MemberRepository memberRepository;
    private MemberService memberService;
    private RenewalRepository renewalRepository;
    private SignatureVerifier signatureVerifier;
    private RenewalService renewalService;

    @BeforeEach
    void setUp() {
        memberRepository = new MemberRepository();
        renewalRepository = new RenewalRepository();
        memberService = new MemberService(memberRepository, FIXED_CLOCK, ZoneId.of("Asia/Shanghai"));
        signatureVerifier = new SignatureVerifier();
        renewalService = new RenewalService(renewalRepository, memberService, signatureVerifier, FIXED_CLOCK, ZoneId.of("Asia/Shanghai"));
    }

    private RenewalService.CallbackCommand command(String txnId, String memberId, int months, long amountCents) {
        String signature = signatureVerifier.sign(txnId, amountCents);
        return new RenewalService.CallbackCommand(txnId, memberId, months, amountCents, signature);
    }

    @Test
    void validCallbackCreatesOrderAndExtendsMembership() {
        Member member = memberService.register("张伟", "13800138000", LocalDateTime.parse("2026-01-15T00:00:00"));
        LocalDateTime before = member.getExpireAt();

        RenewalService.CallbackResult result = renewalService.handleCallback(command("TXN-1", member.getId(), 1, 9900L));

        assertFalse(result.duplicate());
        assertEquals(1, renewalRepository.count());
        assertEquals("TXN-1", result.order().getExternalTxnId());
        assertTrue(memberService.getMember(member.getId()).getExpireAt().isAfter(before));
    }

    @Test
    void duplicateCallbackIsIdempotent() {
        Member member = memberService.register("李娜", "13912345678", LocalDateTime.parse("2026-01-15T00:00:00"));
        renewalService.handleCallback(command("TXN-2", member.getId(), 1, 9900L));
        LocalDateTime afterFirst = memberService.getMember(member.getId()).getExpireAt();

        RenewalService.CallbackResult second = renewalService.handleCallback(command("TXN-2", member.getId(), 1, 9900L));

        assertTrue(second.duplicate());
        assertEquals(1, renewalRepository.count());
        assertEquals(afterFirst, memberService.getMember(member.getId()).getExpireAt());
    }

    @Test
    void invalidSignatureIsRejected() {
        Member member = memberService.register("王芳", "13700001122", LocalDateTime.parse("2026-01-15T00:00:00"));
        RenewalService.CallbackCommand tampered = new RenewalService.CallbackCommand(
                "TXN-3", member.getId(), 1, 9900L, "deadbeef");

        assertThrows(RenewalService.InvalidSignatureException.class, () -> renewalService.handleCallback(tampered));
        assertEquals(0, renewalRepository.count());
    }

    @Test
    void unknownMemberIsRejected() {
        RenewalService.CallbackCommand command = command("TXN-4", "no-such-member", 1, 9900L);
        assertThrows(MemberService.MemberNotFoundException.class, () -> renewalService.handleCallback(command));
        assertEquals(0, renewalRepository.count());
    }

    @Test
    void controllerMapsErrorsToStatusCodes() {
        Member member = memberService.register("Bob", "15000001111", LocalDateTime.parse("2026-01-15T00:00:00"));
        RenewalController controller = new RenewalController(renewalService, renewalRepository);

        var ok = controller.callback(new RenewalController.CallbackRequest(
                "TXN-5", member.getId(), 1, 9900L, signatureVerifier.sign("TXN-5", 9900L)));
        assertEquals(200, ok.getStatusCode().value());

        var unauthorized = controller.callback(new RenewalController.CallbackRequest(
                "TXN-6", member.getId(), 1, 9900L, "bad"));
        assertEquals(401, unauthorized.getStatusCode().value());

        var notFound = controller.callback(new RenewalController.CallbackRequest(
                "TXN-7", "missing", 1, 9900L, signatureVerifier.sign("TXN-7", 9900L)));
        assertEquals(404, notFound.getStatusCode().value());
    }
}

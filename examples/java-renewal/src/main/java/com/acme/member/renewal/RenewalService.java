package com.acme.member.renewal;

import com.acme.member.member.MemberService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * 续费回调处理。
 *
 * <p>规则：验签失败拒绝；同一支付流水号只处理一次（幂等）；处理成功只顺延一次到期日。
 * 基准任务 R3（风险改造）会改这里调用的 {@link SignatureVerifier}，但不改变幂等语义。
 */
@Service
public class RenewalService {

    private final RenewalRepository renewalRepository;
    private final MemberService memberService;
    private final SignatureVerifier signatureVerifier;
    private final Clock clock;
    private final ZoneId zoneId;

    @Autowired
    public RenewalService(RenewalRepository renewalRepository,
                          MemberService memberService,
                          SignatureVerifier signatureVerifier,
                          Clock clock,
                          @Value("${renewal.timezone:Asia/Shanghai}") String zoneId) {
        this(renewalRepository, memberService, signatureVerifier, clock, ZoneId.of(zoneId));
    }

    RenewalService(RenewalRepository renewalRepository,
                   MemberService memberService,
                   SignatureVerifier signatureVerifier,
                   Clock clock,
                   ZoneId zoneId) {
        this.renewalRepository = renewalRepository;
        this.memberService = memberService;
        this.signatureVerifier = signatureVerifier;
        this.clock = clock;
        this.zoneId = zoneId;
    }

    public CallbackResult handleCallback(CallbackCommand command) {
        if (!signatureVerifier.verify(command.externalTxnId(), command.amountCents(), command.signature())) {
            throw new InvalidSignatureException();
        }
        // 幂等：同一流水号直接返回已处理，不再顺延到期日。
        return renewalRepository.findByExternalTxnId(command.externalTxnId())
                .map(existing -> new CallbackResult(true, existing))
                .orElseGet(() -> process(command));
    }

    private CallbackResult process(CallbackCommand command) {
        memberService.getMember(command.memberId());
        RenewalOrder order = new RenewalOrder(
                command.memberId(),
                command.externalTxnId(),
                command.months(),
                command.amountCents(),
                LocalDateTime.now(clock.withZone(zoneId))
        );
        renewalRepository.save(order);
        memberService.renew(command.memberId(), command.months());
        return new CallbackResult(false, order);
    }

    public boolean verifySignature(String externalTxnId, long amountCents, String signature) {
        return signatureVerifier.verify(externalTxnId, amountCents, signature);
    }

    /** 回调命令。 */
    public record CallbackCommand(String externalTxnId, String memberId, int months, long amountCents, String signature) {
    }

    /** 处理结果：duplicate 表示命中幂等。 */
    public record CallbackResult(boolean duplicate, RenewalOrder order) {
    }

    public static class InvalidSignatureException extends RuntimeException {
        public InvalidSignatureException() {
            super("回调签名校验失败");
        }
    }
}

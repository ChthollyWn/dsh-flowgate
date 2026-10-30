package com.acme.member.renewal;

import com.acme.member.member.MemberService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/renewal")
public class RenewalController {

    private final RenewalService renewalService;
    private final RenewalRepository renewalRepository;

    public RenewalController(RenewalService renewalService, RenewalRepository renewalRepository) {
        this.renewalService = renewalService;
        this.renewalRepository = renewalRepository;
    }

    @PostMapping("/callback")
    public ResponseEntity<Map<String, Object>> callback(@RequestBody CallbackRequest request) {
        try {
            RenewalService.CallbackResult result = renewalService.handleCallback(new RenewalService.CallbackCommand(
                    request.externalTxnId(),
                    request.memberId(),
                    request.months(),
                    request.amountCents(),
                    request.signature()
            ));
            return ResponseEntity.ok(Map.of(
                    "code", 0,
                    "duplicate", result.duplicate(),
                    "orderId", result.order().getId()
            ));
        } catch (RenewalService.InvalidSignatureException exception) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", 401, "error", "签名校验失败"));
        } catch (MemberService.MemberNotFoundException exception) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("code", 404, "error", "会员不存在"));
        }
    }

    @GetMapping("/orders")
    public List<Map<String, Object>> orders() {
        return renewalRepository.findAll().stream()
                .map(order -> Map.<String, Object>of(
                        "id", order.getId(),
                        "memberId", order.getMemberId(),
                        "externalTxnId", order.getExternalTxnId(),
                        "months", order.getMonths(),
                        "amountCents", order.getAmountCents(),
                        "status", order.getStatus().name()
                ))
                .toList();
    }

    public record CallbackRequest(String externalTxnId, String memberId, int months, long amountCents, String signature) {
    }
}

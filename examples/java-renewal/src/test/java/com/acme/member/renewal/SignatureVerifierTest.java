package com.acme.member.renewal;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 当前验签契约（基准任务 R3 会替换算法，但接口契约保持不变）。 */
class SignatureVerifierTest {

    private final SignatureVerifier verifier = new SignatureVerifier();

    @Test
    void signAndVerifyRoundTrip() {
        String signature = verifier.sign("TXN-100", 9900L);
        assertTrue(verifier.verify("TXN-100", 9900L, signature));
        assertTrue(verifier.verify("TXN-100", 9900L, signature.toUpperCase()));
    }

    @Test
    void rejectsWrongAmountOrTxn() {
        String signature = verifier.sign("TXN-100", 9900L);
        assertFalse(verifier.verify("TXN-100", 9901L, signature));
        assertFalse(verifier.verify("TXN-101", 9900L, signature));
    }

    @Test
    void rejectsBlankSignature() {
        assertFalse(verifier.verify("TXN-100", 9900L, null));
        assertFalse(verifier.verify("TXN-100", 9900L, "   "));
    }
}

package com.acme.member.renewal;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * 支付回调验签。
 *
 * <p>当前实现是 MD5(流水号 + 金额 + 硬编码密钥)，存在三个已知安全问题：
 * 摘要算法过弱、密钥硬编码、没有时间戳（可被重放）。
 * 基准任务 R3（风险改造）要求改成 HMAC-SHA256 + 时间戳 + 外部密钥 + 新旧签名过渡期。
 */
@Component
public class SignatureVerifier {

    private static final String SECRET = "dev-secret-do-not-use-in-prod";

    public boolean verify(String externalTxnId, long amountCents, String signature) {
        if (signature == null || signature.isBlank()) {
            return false;
        }
        return sign(externalTxnId, amountCents).equalsIgnoreCase(signature);
    }

    public String sign(String externalTxnId, long amountCents) {
        String payload = externalTxnId + ":" + amountCents + ":" + SECRET;
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hashed = digest.digest(payload.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(hashed.length * 2);
            for (byte value : hashed) {
                builder.append(Character.forDigit((value >> 4) & 0xF, 16));
                builder.append(Character.forDigit(value & 0xF, 16));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("MD5 不可用", exception);
        }
    }
}

package com.acme.member.report;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.acme.member.renewal.RenewalRepository;

import java.util.Map;

@RestController
@RequestMapping("/api/reports")
public class ReportController {

    private final LegacyRevenueReport revenueReport;
    private final RenewalRepository renewalRepository;

    public ReportController(LegacyRevenueReport revenueReport, RenewalRepository renewalRepository) {
        this.revenueReport = revenueReport;
        this.renewalRepository = renewalRepository;
    }

    @GetMapping("/revenue")
    public Map<String, Object> revenue() {
        return revenueReport.summarize(renewalRepository.findAll());
    }
}

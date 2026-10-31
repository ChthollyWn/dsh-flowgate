/**
 * FlowGate visual styles (docs/impl/ui-interaction-redesign.md §1.1 / §1.3 / §1.4).
 *
 * The plugin ships one `<style data-flowgate-css>` tag instead of CSS modules:
 * the client bundle is injected into the DSH web shell at runtime, which has no
 * build-time CSS pipeline for plugins. `installFlowgateStyles()` is idempotent
 * and a no-op during SSR (no `document`), so rendering views on the server stays
 * side-effect free.
 *
 * v0.2.1 (native alignment): every colour goes through the shell's real design
 * tokens (`--dsw-*`) with neutral fallbacks, the dock frame / card width copies
 * the official `PlanReviewPanel` (frame padding = composer side clearance + 16,
 * inner max-width = `--dsh-chat-content-width`), and buttons mirror the
 * primitive `Button` component (primary / outline / ghost, 28px tall).
 * No user-visible surface paints its own palette anymore.
 *
 * Motion rules (contract §1.3):
 *  - every animation is opt-in under `prefers-reduced-motion: no-preference`,
 *    and the reduce block at the bottom force-disables all of them;
 *  - only `transform`, `opacity` and `stroke-dashoffset` are animated, never
 *    layout properties, so the dock cannot cause input-area jitter.
 *
 * Class names are a shared contract with the views (and with the Gates view
 * cards): `fg-pulse`, `fg-dash`, `fg-sweep`, `fg-rise`, `fg-ring`, `fg-arrow`,
 * `fg-halo`. Keep them stable.
 */

/** DOM id of the injected style element (idempotency + tests). */
export const FLOWGATE_STYLE_ID = 'dsh-flowgate-styles'

/** Complete stylesheet text; exported so tests can assert the contract. */
export const FLOWGATE_CSS = `
/* ----- dock frame: copied from PlanReviewPanel.module.css ---------------- */
.fg-frame {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif);
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #0f1115);
  min-width: 0;
}

/* The measured width anchor: == native composer content width. */
.fg-frame-inner {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--dsh-chat-content-width, 748px);
  margin: 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ----- native plan card (dock auth card + panel gate card) --------------- */
.fg-plan-card {
  box-sizing: border-box;
  position: relative;
  width: 100%;
  max-width: var(--dsh-chat-content-width, 748px);
  border: 0;
  border-radius: var(--dsw-radius-xl, 20px);
  background: var(--dsw-specific-input-major, #ffffff);
  box-shadow: var(--dsw-elevation-panel, 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 3px 8px rgba(0, 0, 0, 0.03));
  color: var(--dsw-alias-label-primary, #0f1115);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.fg-plan-card,
.fg-plan-card * {
  box-sizing: border-box;
}

.fg-plan-strip {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 20px;
  background: var(--dsw-alias-state-warn-tertiary, #fef5e7);
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
}

.fg-plan-strip--error {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-plan-strip--business {
  background: var(--dsw-alias-state-business-tertiary, #e4edfd);
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.fg-plan-strip--neutral {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-secondary, #61666b);
}

.fg-plan-strip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-plan-strip-spacer {
  flex: 1 1 auto;
}

.fg-plan-strip-meta {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 18px;
  opacity: 0.9;
  font-variant-numeric: tabular-nums;
}

/* Native StateDot (8px, 60% fill) — the only place semantic colour appears. */
.fg-state-dot {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  color: var(--dsw-alias-state-idle-primary, #cfd3d6);
}

.fg-state-dot::after {
  content: '';
  position: absolute;
  inset: 20%;
  border-radius: 50%;
  background: currentColor;
}

.fg-state-dot--warning {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
}

.fg-state-dot--error {
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-state-dot--success {
  color: var(--dsw-alias-state-success-primary, #22c55e);
}

.fg-state-dot--business {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.fg-plan-body {
  min-width: 0;
  padding: 14px 16px 12px;
}

.fg-plan-title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #0f1115);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-plan-desc {
  margin: 8px 0 0;
  font-size: 14px;
  font-weight: 400;
  line-height: 24px;
  color: var(--dsw-alias-label-secondary, #61666b);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.fg-plan-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 14px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

.fg-plan-meta-label {
  color: var(--dsw-alias-label-tertiary, #81858c);
  margin-inline-end: 4px;
}

.fg-plan-meta-value {
  color: var(--dsw-alias-label-secondary, #61666b);
}

.fg-plan-checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 14px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

.fg-plan-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fg-plan-check-label {
  color: var(--dsw-alias-label-secondary, #61666b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-plan-check--failed .fg-plan-check-label {
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-plan-check-summary {
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ----- footer (native plan card metrics) -------------------------------- */
.fg-plan-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 16px 12px;
}

.fg-plan-feedback {
  min-width: 0;
  flex: 1 1 auto;
  min-height: 16px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-plan-feedback--error {
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-plan-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* ----- native buttons (primitive Button: md/sm, primary/outline/ghost) -- */
.fg-native-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
}

.fg-native-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.fg-native-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 2px;
}

.fg-native-btn-primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary, #0f1115));
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}

.fg-native-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, #43454a);
}

.fg-native-btn-outline {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  background: transparent;
}

.fg-native-btn-outline:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-native-btn-ghost {
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-native-btn-ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-native-btn-danger {
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-native-btn-sm {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}

/* Native text field (reject reason). */
.fg-field {
  box-sizing: border-box;
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  min-height: 60px;
  resize: vertical;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-overlay, #e9ecf2);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  border-radius: var(--dsw-radius-lg, 16px);
  outline: none;
}

.fg-field::placeholder {
  color: var(--dsw-alias-label-caption, #adb2b8);
}

.fg-field:focus {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}

/* ----- dock rail row ----------------------------------------------------- */
.fg-dock-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 24px;
}

.fg-flow-rail {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
}

.fg-rail-node {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  margin: 0;
  border: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: inherit;
  line-height: 0;
  cursor: default;
}

button.fg-rail-node {
  cursor: pointer;
}

.fg-rail-node:focus-visible,
.fg-native-btn:focus-visible,
.fg-link-btn:focus-visible,
.fg-map-node:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 1px;
}

.fg-dock-next {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 52%;
  flex: 0 1 auto;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12px;
  line-height: 18px;
}

.fg-dock-next-icon {
  flex: 0 0 auto;
  display: inline-flex;
}

.fg-dock-next-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-dock-change {
  flex: 0 0 auto;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

.fg-dock-panel-btn {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: var(--dsw-radius-sm, 8px);
}

.fg-dock-notice {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

.fg-dock-notice--error {
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

/* ----- panel flow map / pipeline ----------------------------------------- */
.fg-map-node {
  text-align: start;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 12px);
  cursor: pointer;
}

.fg-artifact-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
}

.fg-callout {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md, 12px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12px;
  line-height: 18px;
}

.fg-collapse > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}

.fg-collapse > summary::-webkit-details-marker {
  display: none;
}


/* ----- runtime visualization: subagents (graph/tree) + background jobs --- */
.fg-runtime-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif);
  font-size: 13px;
  line-height: 20px;
  min-width: 0;
}

.fg-runtime-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.fg-runtime-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-runtime-count {
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
}

.fg-runtime-empty {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 8px;
  padding: 18px 12px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 12.5px;
  line-height: 22px;
}

.fg-runtime-empty small {
  display: block;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption, #adb2b8);
}

/* Native segmented control (primitive segment pattern). */
.fg-seg {
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 2px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-seg-btn {
  box-sizing: border-box;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.fg-seg-btn[aria-pressed='true'] {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(0, 0, 0, 0.06));
}

.fg-seg-btn:hover:not([aria-pressed='true']) {
  color: var(--dsw-alias-label-primary, #0f1115);
}

/* Workflow graph — top-down, narrow-panel adaptive workflow. */
.fg-graph {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  padding: 2px 0 4px;
}

.fg-graph-root {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, #f4f5f7);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Vertical trunk from the main session into the group rail. */
.fg-graph-trunk {
  width: 1px;
  height: 12px;
  margin-inline-start: 16px;
  background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}

.fg-graph-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  border-inline-start: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  margin-inline-start: 16px;
  padding-inline-start: 12px;
}

.fg-graph-group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* Branch connector from the rail into each group header. */
.fg-graph-group::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 14px;
  width: 11px;
  height: 1px;
  background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
}

.fg-graph-batch {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 2px 4px;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

.fg-graph-batch-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #61666b);
}

.fg-graph-batch-mode {
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-size: 10px;
  line-height: 16px;
}

.fg-graph-batch-spacer {
  flex: 1 1 auto;
  min-width: 4px;
}

.fg-graph-batch-status {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-size: 10.5px;
  white-space: nowrap;
}

.fg-graph-batch-count {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-variant-numeric: tabular-nums;
}

/* Cards wrap: 2 columns when the panel allows, 1 column in a narrow sidebar. */
.fg-graph-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.fg-graph-cards .fg-agent-card {
  flex: 1 1 220px;
  min-width: 0;
  max-width: 100%;
}

.fg-agent-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  text-align: start;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}

.fg-agent-card-button {
  cursor: pointer;
}

.fg-agent-card-button:hover,
.fg-agent-card-button:focus-visible {
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  box-shadow: var(--dsw-elevation-panel, 0 1px 4px rgba(0, 0, 0, 0.06));
}

.fg-agent-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fg-agent-role {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 10px;
  line-height: 16px;
}

.fg-agent-primary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-agent-attempt {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-size: 10px;
}

.fg-agent-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 11.5px;
}

.fg-agent-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 10.5px;
  line-height: 16px;
}

.fg-agent-worktree {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.fg-agent-duration {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.fg-agent-open-hint {
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-size: 10px;
}

/* Tree mode. */
.fg-tree,
.fg-tree-branch {
  list-style: none;
  margin: 0;
  padding: 0;
}

.fg-tree-root-branch {
  margin-top: 4px;
}

.fg-tree-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 3px 6px;
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: start;
}

.fg-tree-batch {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  cursor: pointer;
}

.fg-tree-batch:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-tree-chevron {
  display: inline-flex;
  color: var(--dsw-alias-label-caption, #adb2b8);
}

.fg-tree-batch-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.fg-tree-batch-status {
  margin-left: auto;
  color: var(--dsw-alias-label-caption, #adb2b8);
  font-size: 10.5px;
}

.fg-tree-branch {
  border-inline-start: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  margin-inline-start: 13px;
  padding-inline-start: 10px;
}

.fg-tree-node:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-tree-node-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fg-agent-title-inline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 11px;
}

/* Background jobs list (native Jobs row pattern). */
.fg-job-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.fg-job-row {
  display: flex;
  flex-direction: column;
  border-radius: var(--dsw-radius-md, 12px);
}

.fg-job-row-live {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-job-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fg-job-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 17px;
  text-align: start;
  cursor: pointer;
}

.fg-job-main:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
}

.fg-job-main-static {
  cursor: default;
}

.fg-job-kind {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 10px;
  line-height: 16px;
}

.fg-job-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--dsw-alias-label-primary, #0f1115);
}

.fg-job-meta {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 10.5px;
  line-height: 16px;
}

.fg-job-chip {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-xs, 4px);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-variant-numeric: tabular-nums;
}

.fg-job-detail {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fg-job-duration {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.fg-job-chevron {
  display: inline-flex;
  color: var(--dsw-alias-label-caption, #adb2b8);
}

.fg-job-chevron[data-open='true'] {
  transform: rotate(180deg);
}

.fg-job-kill {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

.fg-job-kill:hover {
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-job-kill-armed {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #ec1313);
}

.fg-job-kill:disabled {
  opacity: 0.4;
  cursor: progress;
}

.fg-job-output {
  box-sizing: border-box;
  max-height: 220px;
  overflow: auto;
  margin: 0 8px 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-module-platform, #f4f5f7));
  color: var(--dsw-alias-label-secondary, #61666b);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 17px;
  white-space: pre-wrap;
  word-break: break-word;
}

.fg-job-output-empty {
  color: var(--dsw-alias-label-caption, #adb2b8);
}

.fg-job-error {
  margin: 0 8px 8px;
  color: var(--dsw-alias-state-error-primary, #ec1313);
  font-size: 11px;
  line-height: 16px;
}

@media (max-width: 720px) {
  .fg-plan-footer {
    align-items: flex-end;
    padding: 8px 12px 10px;
  }
}

/* ----- motion: only under no-preference -------------------------------- */
@media (prefers-reduced-motion: no-preference) {
  @keyframes fg-pulse {
    0% {
      transform: scale(0.9);
      opacity: 0.5;
    }
    70% {
      transform: scale(1.9);
      opacity: 0;
    }
    100% {
      transform: scale(1.9);
      opacity: 0;
    }
  }

  @keyframes fg-dash {
    from {
      stroke-dashoffset: 0;
    }
    to {
      stroke-dashoffset: -12;
    }
  }

  @keyframes fg-sweep {
    0% {
      transform: translateX(-110%);
    }
    55%,
    100% {
      transform: translateX(110%);
    }
  }

  @keyframes fg-rise {
    from {
      transform: translateY(5px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes fg-arrow {
    0%,
    100% {
      transform: translateX(0);
    }
    50% {
      transform: translateX(2.5px);
    }
  }

  @keyframes fg-halo {
    0%,
    100% {
      opacity: 0.12;
    }
    50% {
      opacity: 0.35;
    }
  }

  @keyframes fg-ring-draw {
    from {
      stroke-dashoffset: var(--fg-ring-circumference);
    }
  }

  /* Current-stage breathing ring (business accent at low opacity). */
  .fg-pulse {
    position: relative;
  }

  .fg-pulse::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 999px;
    border: 1.5px solid var(--dsw-alias-state-business-primary, #4176e6);
    opacity: 0;
    pointer-events: none;
    animation: fg-pulse 2.4s ease-out infinite;
  }

  /* Flowing dashes on the rail segment after the current stage. */
  .fg-dash line,
  .fg-dash path {
    animation: fg-dash 0.9s linear infinite;
  }

  /* Card highlight sweep while the owner has to act (neutral wash). */
  .fg-sweep::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      100deg,
      transparent 32%,
      var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)) 50%,
      transparent 68%
    );
    transform: translateX(-110%);
    animation: fg-sweep 3s ease-in-out infinite;
  }

  /* Card entrance. */
  .fg-rise {
    animation: fg-rise 0.24s ease-out both;
  }

  /* Next-step arrow nudge. */
  .fg-arrow {
    animation: fg-arrow 1.5s ease-in-out infinite;
  }

  /* Progress ring: initial draw + value transitions. */
  .fg-ring {
    transition: stroke-dashoffset 0.6s cubic-bezier(0.22, 1, 0.36, 1);
    animation: fg-ring-draw 0.8s ease-out both;
  }

  /* Live-state dot: opacity breathing only. */
  @keyframes fg-dot-live {
    0% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.45;
    }
  }

  .fg-dot-live {
    animation: fg-dot-live 1.6s ease-in-out infinite;
  }

  /* Running node halo in the execution graph. */
  .fg-halo {
    animation: fg-halo 1.8s ease-in-out infinite;
  }

  /* Button affordances (native-like, no colour shift). */
  .fg-native-btn,
  .fg-link-btn {
    transition:
      background-color 0.12s ease,
      color 0.12s ease,
      opacity 0.12s ease;
  }
}

/* ----- reduced motion: kill every animation / transition ---------------- */
@media (prefers-reduced-motion: reduce) {
  .fg-pulse::after,
  .fg-sweep::after,
  .fg-rise,
  .fg-arrow,
  .fg-halo,
  .fg-dot-live,
  .fg-ring,
  .fg-dash line,
  .fg-dash path,
  .fg-native-btn,
  .fg-link-btn {
    animation: none !important;
    transition: none !important;
  }

  .fg-sweep::after {
    display: none;
  }
}
`

/**
 * Inject the FlowGate stylesheet once. Safe during SSR / in non-browser hosts:
 * it returns without touching anything when `document` is missing.
 */
export function installFlowgateStyles(): void {
  if (typeof document === 'undefined') return
  try {
    if (document.getElementById(FLOWGATE_STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = FLOWGATE_STYLE_ID
    style.setAttribute('data-flowgate-css', '')
    style.textContent = FLOWGATE_CSS
    const parent = document.head ?? document.documentElement
    parent?.appendChild(style)
  } catch {
    /* Styling must never take the plugin down. */
  }
}

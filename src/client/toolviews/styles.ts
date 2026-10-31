/**
 * Styles for the conversation tool-call rows (`tool.call.toolview`).
 *
 * Deliberately self-contained: the plugin's shared visual layer is owned by a
 * different, still-moving module, so this stretch feature injects only its own
 * namespaced CSS (`.fg-tv-*`, keyframes `fg-tv-*`) behind a dedicated
 * `data-flowgate-toolview-css` marker. Browser-only and idempotent; a no-op in
 * SSR/node (no `document`), so `renderToStaticMarkup` stays safe.
 *
 * Motion follows the redraw contract: pulse / dashed-flow animations run only
 * under `prefers-reduced-motion: no-preference`, with a hard `reduce` override.
 */
const STYLE_ATTR = 'data-flowgate-toolview-css'

export const TOOLVIEW_CSS = `
.fg-tv-root{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:1px 0;line-height:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:12px;transition:color .1s}
.fg-tv-glyph{flex:0 0 auto;font-size:10px;line-height:1;opacity:.72;user-select:none}
.fg-tv-title{flex:0 0 auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:11.5px;opacity:.92}
.fg-tv-rail{display:inline-flex;align-items:center;flex:0 1 auto;min-width:0}
.fg-tv-node{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:14px;height:14px;border-radius:999px;border:1px solid currentColor;font-size:9px;line-height:1;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;box-sizing:border-box;transition:opacity .12s,border-color .12s}
.fg-tv-link{display:inline-block;flex:0 0 auto;width:8px;height:0;margin:0 1px;border-top:1px dashed currentColor;opacity:.3}
.fg-tv-link[data-status="done"]{border-top-style:solid;opacity:.55}
.fg-tv-status{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;opacity:.82}
@media (prefers-reduced-motion: no-preference){
  .fg-tv-node[data-current="true"]{animation:fg-tv-pulse 1.9s ease-in-out infinite}
  .fg-tv-link[data-status="pending"],.fg-tv-link[data-status="current"]{animation:fg-tv-dash 900ms linear infinite}
  @keyframes fg-tv-pulse{
    0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.45)}
    50%{box-shadow:0 0 0 3px rgba(37,99,235,0)}
  }
  @keyframes fg-tv-dash{to{opacity:.55}}
}
@media (prefers-reduced-motion: reduce){
  .fg-tv-node,.fg-tv-link,.fg-tv-root{animation:none!important;transition:none!important}
}
`

/**
 * Inject the row stylesheet once per document. Safe to call from any host code
 * (returns false instead of throwing) and a no-op during SSR.
 */
export function ensureToolviewStyles(doc?: Document | null): boolean {
  try {
    const target = doc ?? (typeof document !== 'undefined' ? document : null)
    if (target === null || target === undefined) return false
    const root = target.head ?? target.documentElement
    if (root === null || root === undefined) return false
    if (typeof target.querySelector === 'function' && target.querySelector(`style[${STYLE_ATTR}]`) !== null) {
      return true
    }
    const style = target.createElement('style')
    style.setAttribute(STYLE_ATTR, '')
    style.textContent = TOOLVIEW_CSS
    root.appendChild(style)
    return true
  } catch {
    // CSS is cosmetic: a locked-down DOM must not block the row from rendering.
    return false
  }
}

// Install at module load in the browser (official client bundles do the same
// for their per-package CSS); SSR/node imports fall straight through.
ensureToolviewStyles()

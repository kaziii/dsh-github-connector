/**
 * Injected stylesheet for the two slots. The dsh client runtime is
 * registry-restricted, so its design tokens cannot be imported here; every
 * declaration therefore reads `var(--dsh-*, fallback)` — the host token wins
 * the moment this package composes into a real dsh web client, and the
 * fallbacks stay theme-neutral (colors inherit, surfaces use system `Canvas`
 * so dark mode never breaks). Installed as an effect on the client fiber:
 * unloading the plugin removes the sheet.
 * @module dsh-ui-github/client/styles
 */

/** The `data-` marker identifying this package's style element. */
export const STYLE_MARKER = 'data-dsh-ui-github'

/** The stylesheet text (exported for tests and for host-side inspection). */
export const STYLE_TEXT = `
.gh-status-bar {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 6px;
  padding: 6px 12px;
  font-size: var(--dsh-font-size-sm, 12.5px);
  line-height: 1.6;
  color: var(--dsh-text, inherit);
  background: var(--dsh-bg-elevated, rgba(127, 127, 127, 0.07));
  border: 1px solid var(--dsh-border, rgba(127, 127, 127, 0.22));
  border-radius: var(--dsh-radius-lg, 10px);
}
.gh-flow-text { font-weight: 500; }
.gh-merged { color: var(--dsh-color-success, #1a7f37); }
.gh-spacer { flex: 1; }
.gh-pr-link {
  font-weight: 600;
  color: var(--dsh-primary, #4d6bfe);
  text-decoration: none;
}
.gh-pr-link:hover { text-decoration: underline; }

.gh-btn {
  appearance: none;
  font: inherit;
  font-size: var(--dsh-font-size-sm, 12.5px);
  padding: 3px 12px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--dsh-border, rgba(127, 127, 127, 0.35));
  border-radius: var(--dsh-radius-md, 6px);
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s, filter 0.15s;
}
.gh-btn:hover { background: rgba(127, 127, 127, 0.12); }
.gh-btn:disabled { opacity: 0.5; cursor: default; }
.gh-btn-primary {
  color: #fff;
  background: var(--dsh-primary, #4d6bfe);
  border-color: transparent;
}
.gh-btn-primary:hover { background: var(--dsh-primary, #4d6bfe); filter: brightness(1.08); }

.gh-menu {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 6px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  color: var(--dsh-text, CanvasText);
  background: var(--dsh-bg-popover, Canvas);
  border: 1px solid var(--dsh-border, rgba(127, 127, 127, 0.22));
  border-radius: var(--dsh-radius-lg, 10px);
  box-shadow: var(--dsh-shadow-popover, 0 8px 24px rgba(0, 0, 0, 0.12));
}
.gh-create-menu { gap: 8px; padding: 10px; width: min(340px, 80vw); }
.gh-merge-menu { gap: 2px; padding: 4px; min-width: 180px; }
.gh-menu-actions { display: flex; justify-content: flex-end; }
.gh-menu-item {
  appearance: none;
  font: inherit;
  font-size: var(--dsh-font-size-sm, 12.5px);
  text-align: left;
  padding: 6px 10px;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: var(--dsh-radius-md, 6px);
  cursor: pointer;
}
.gh-menu-item:hover { background: rgba(127, 127, 127, 0.12); }

.gh-input, .gh-textarea {
  font: inherit;
  font-size: var(--dsh-font-size-sm, 12.5px);
  width: 100%;
  box-sizing: border-box;
  padding: 6px 9px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--dsh-border, rgba(127, 127, 127, 0.35));
  border-radius: var(--dsh-radius-md, 6px);
}
.gh-input:focus, .gh-textarea:focus {
  outline: none;
  border-color: var(--dsh-primary, #4d6bfe);
}
.gh-textarea { min-height: 76px; resize: vertical; }

.gh-ci {
  padding: 1px 9px;
  font-size: var(--dsh-font-size-xs, 11.5px);
  border-radius: 999px;
}
.gh-ci-passing { color: var(--dsh-color-success, #1a7f37); background: rgba(26, 127, 55, 0.12); }
.gh-ci-failing { color: var(--dsh-color-danger, #cf222e); background: rgba(207, 34, 46, 0.12); }
.gh-ci-pending { color: var(--dsh-color-warning, #9a6700); background: rgba(154, 103, 0, 0.12); }

.gh-notice { color: var(--dsh-color-danger, #cf222e); font-size: var(--dsh-font-size-sm, 12.5px); }

.gh-connect {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--dsh-font-size-md, 13px);
}
.gh-connect-row { display: flex; align-items: center; gap: 10px; }
.gh-connect-hint {
  margin: 0;
  font-size: var(--dsh-font-size-sm, 12px);
  color: var(--dsh-text-secondary, inherit);
  opacity: 0.72;
}
.gh-connect-login { font-weight: 500; }
.gh-connect-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--dsh-color-success, #1a7f37);
}
.gh-user-code {
  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-weight: 600;
  letter-spacing: 0.14em;
  padding: 2px 10px;
  border: 1px dashed var(--dsh-border, rgba(127, 127, 127, 0.45));
  border-radius: var(--dsh-radius-md, 6px);
}
`

/**
 * Append the stylesheet to the document head, once per document.
 * @param doc - the target document (tests pass a jsdom document).
 * @returns a disposer removing the element (a no-op for a shared install).
 */
export function installStyles(doc: Document = document): () => void {
  if (doc.head.querySelector(`style[${STYLE_MARKER}]`) !== null) return () => {}
  const style = doc.createElement('style')
  style.setAttribute(STYLE_MARKER, '')
  style.textContent = STYLE_TEXT
  doc.head.append(style)
  return () => style.remove()
}

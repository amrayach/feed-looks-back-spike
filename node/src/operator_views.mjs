import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { computeOverview, formatOverviewBlock } from "./scene_state.mjs";
import { resolveImageAssets } from "./image_resolver.mjs";
import { getSvgMarkupIssue, sanitizeCssBackground } from "./sanitize.mjs";
import {
  classifyPosition,
  textAnchorCss,
  svgAnchorRect,
  imageSizeClass,
  imageDimensions,
  textStyleCss,
} from "./scene_layout.mjs";

export const AGING_OPACITY = Object.freeze({
  normal: 1.0,
  fading: 0.55,
});

export const FADING_GRACE_S = 5;
export const SCENE_VIEWBOX_W = 1000;
export const SCENE_VIEWBOX_H = 1000;
export const LIVE_MONITOR_REFRESH_SECONDS = 2;

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function elementContent(element) {
  return safeObject(element?.content);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function opacityForElement(element, currentElapsedS) {
  const fadesAt = element?.fades_at_elapsed_s;
  if (typeof fadesAt !== "number") return AGING_OPACITY.normal;
  const timeLeft = fadesAt - currentElapsedS;
  if (timeLeft <= FADING_GRACE_S) return AGING_OPACITY.fading;
  return AGING_OPACITY.normal;
}

export function opacityForAge(ageS) {
  return ageS >= 16 ? AGING_OPACITY.fading : AGING_OPACITY.normal;
}

function escapeAttr(value) {
  return escapeHtml(String(value ?? ""));
}

function fallbackBadge(reason) {
  return `<span class="renderer-fallback-badge">renderer fallback: ${escapeHtml(reason)}</span>`;
}

function renderTextInScene(element, currentElapsedS) {
  const content = elementContent(element);
  const opacity = opacityForElement(element, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const posCss = textAnchorCss(anchor);
  const styleCss = textStyleCss(content.style);
  const body = escapeHtml(content.content);
  return (
    `    <div class="scene-element text-element" ` +
    `data-element-id="${escapeAttr(element?.element_id)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-created-at-cycle="${escapeAttr(element?.created_at_cycle)}" ` +
    `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: 4; color: #f5f0e8; text-shadow: 0 2px 10px rgba(0,0,0,0.6); ${styleCss}">` +
    body +
    `</div>`
  );
}

function renderImageInScene(element, currentElapsedS) {
  const content = elementContent(element);
  const opacity = opacityForElement(element, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const posCss = textAnchorCss(anchor);
  const query = escapeHtml(content.query);
  const dim = imageDimensions(position);
  const asset = safeObject(element?.render_asset);
  if (typeof asset.src === "string" && asset.src) {
    const creditHref = escapeAttr(asset.attribution?.photo_url ?? "");
    const creditName = escapeHtml(asset.attribution?.photographer_name ?? "Unknown");
    const credit = asset.attribution?.photographer_name
      ? `<div style="position: absolute; right: 8px; bottom: 6px; padding: 3px 6px; background: rgba(10,10,13,0.72); color: #f5f0e8; font: 0.68rem/1.2 Georgia, serif; border-radius: 2px; max-width: 78%; text-align: right;">Photo by <a href="${creditHref}" target="_blank" rel="noreferrer noopener" style="color: #f5f0e8; text-decoration: underline;">${creditName}</a></div>`
      : "";
    return (
      `    <div class="scene-element image-element" ` +
      `data-element-id="${escapeAttr(element?.element_id)}" ` +
      `data-position="${escapeAttr(position)}" ` +
      `data-size-class="${escapeAttr(imageSizeClass(position))}" ` +
      `data-created-at-cycle="${escapeAttr(element?.created_at_cycle)}" ` +
      `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: ${dim.z}; ` +
      `width: ${dim.width}; height: ${dim.height}; overflow: hidden; border: ${dim.border}; ` +
      `background: rgba(20,16,13,0.72); box-shadow: ${dim.shadow};">` +
      `<img src="${escapeAttr(asset.src)}" alt="${escapeAttr(content.query ?? "Unsplash image")}" ` +
      `style="display: block; width: 100%; height: 100%; object-fit: cover; filter: saturate(0.92) brightness(0.97);"/>` +
      credit +
      `</div>`
    );
  }
  return (
    `    <div class="scene-element image-placeholder" ` +
    `data-element-id="${escapeAttr(element?.element_id)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-size-class="${escapeAttr(imageSizeClass(position))}" ` +
    `data-created-at-cycle="${escapeAttr(element?.created_at_cycle)}" ` +
    `style="position: absolute; ${posCss} opacity: ${opacity}; z-index: ${dim.z}; ` +
    `width: ${dim.width}; height: ${dim.height}; border: 1px dashed #8a7e6a; ` +
    `background: rgba(40,32,26,0.4); color: #d9cbb2; ` +
    `display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; ` +
    `font: 0.85rem/1.2 Georgia, serif;">` +
    `<span>query=&ldquo;${query}&rdquo;</span>` +
    `</div>`
  );
}

function renderSvgInScene(element, currentElapsedS) {
  const content = elementContent(element);
  const opacity = opacityForElement(element, currentElapsedS);
  const position = textOr(content.position);
  const anchor = classifyPosition(position);
  const rect = svgAnchorRect(anchor);
  const semanticLabel = textOr(content.semantic_label, "untitled svg");
  const dataAttrs =
    `data-element-id="${escapeAttr(element?.element_id)}" ` +
    `data-semantic-label="${escapeAttr(semanticLabel)}" ` +
    `data-position="${escapeAttr(position)}" ` +
    `data-created-at-cycle="${escapeAttr(element?.created_at_cycle)}"`;

  const issue = getSvgMarkupIssue(content.svg_markup);
  if (!issue) {
    const withRect = content.svg_markup.trim().replace(
      /^<svg\b/i,
      `<svg x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"`,
    );
    return (
      `    <g class="scene-element svg-element" ${dataAttrs} opacity="${opacity}">` +
      withRect +
      `</g>`
    );
  }
  const label = escapeHtml(semanticLabel);
  const reason = escapeHtml(issue);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return (
    `    <g class="scene-element svg-element svg-malformed" ${dataAttrs} data-renderer-fallback="true" opacity="${opacity}">` +
    `<title>renderer fallback: ${reason}</title>` +
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" ` +
    `fill="rgba(100,60,60,0.25)" stroke="#a33" stroke-dasharray="6 4" stroke-width="2"/>` +
    `<text x="${cx}" y="${cy - 14}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#f5d0d0" font-family="Georgia, serif" font-size="16">renderer fallback</text>` +
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#f5d0d0" font-family="Georgia, serif" font-size="14">unsafe SVG: ${label}</text>` +
    `<text x="${cx}" y="${cy + 32}" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="#e6b8b8" font-family="monospace" font-size="10">${reason}</text>` +
    `</g>`
  );
}

function escapeAttrStyleValue(css) {
  return String(css ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderFinalScene(state) {
  const background = safeObject(state?.background);
  const bg = sanitizeCssBackground(background.css_background);
  const bgCss = bg.ok
    ? `background: ${escapeAttrStyleValue(bg.value)};`
    : "background: #0a0a0d;";
  const active = safeArray(state?.elements).filter((entry) => !entry?.faded);
  const currentElapsedS = numberOr(state?.current_elapsed_s, 0);

  const textEls = active.filter((entry) => entry.type === "text");
  const imgEls = active.filter((entry) => entry.type === "image");
  const svgEls = active.filter((entry) => entry.type === "svg");

  const textHtml = textEls.map((entry) => renderTextInScene(entry, currentElapsedS)).join("\n");
  const imgHtml = imgEls.map((entry) => renderImageInScene(entry, currentElapsedS)).join("\n");
  const svgHtml = svgEls.map((entry) => renderSvgInScene(entry, currentElapsedS)).join("\n");
  const backgroundNotice =
    !bg.ok && typeof background.css_background === "string" && background.css_background.trim().length > 0
      ? `  <div class="renderer-fallback-notice">${fallbackBadge(`unsafe background blocked (${bg.reason})`)}</div>\n`
      : "";

  return (
    `<section id="final-scene" style="position: relative; width: 100%; height: 86vh; overflow: hidden; ${bgCss}">\n` +
    `  <h2 style="position: absolute; top: 12px; left: 16px; margin: 0; z-index: 9; font: 0.9rem Georgia, serif; color: rgba(245,240,232,0.55); letter-spacing: 0.08em;">FINAL ACCUMULATED SCENE</h2>\n` +
    backgroundNotice +
    imgHtml +
    `\n  <svg class="scene-svg" viewBox="0 0 ${SCENE_VIEWBOX_W} ${SCENE_VIEWBOX_H}" preserveAspectRatio="xMidYMid meet" ` +
    `style="position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1;">\n` +
    svgHtml +
    `\n  </svg>\n` +
    textHtml +
    `\n</section>`
  );
}

function buildTimelineEvents(state, summary) {
  const events = [];

  for (const element of safeArray(state?.elements)) {
    events.push({
      cycle: element.created_at_cycle,
      elapsed: element.created_at_elapsed_s,
      render: () => renderElementHistoryEntry(element),
    });
  }

  for (const bg of safeArray(state?.background_history)) {
    events.push({
      cycle: bg.set_at_cycle,
      elapsed: bg.set_at_elapsed_s,
      render: () => renderBackgroundHistoryEntry(bg),
    });
  }
  if (state?.background && state.background.css_background) {
    events.push({
      cycle: state.background.set_at_cycle,
      elapsed: state.background.set_at_elapsed_s,
      render: () => renderBackgroundHistoryEntry(state.background, true),
    });
  }

  if (summary && Array.isArray(summary.per_cycle)) {
    for (const cycle of summary.per_cycle) {
      const calls = Array.isArray(cycle.tool_calls) ? cycle.tool_calls : [];
      for (const call of calls) {
        if (call.name === "fadeElement") {
          events.push({
            cycle: cycle.cycle_index,
            elapsed: cycle.elapsed_s ?? 0,
            render: () => renderFadeHistoryEntry(cycle, call),
          });
        }
      }
    }
  }

  events.sort((a, b) => (a.elapsed - b.elapsed) || (a.cycle - b.cycle));
  return events;
}

function timestampPrefix(cycle, elapsed) {
  return `<span class="ts">[cycle ${cycle}, ${elapsed}s elapsed]</span>`;
}

function renderElementHistoryEntry(element) {
  const content = elementContent(element);
  const ts = timestampPrefix(numberOr(element?.created_at_cycle, "?"), numberOr(element?.created_at_elapsed_s, "?"));
  const id = escapeHtml(element?.element_id);
  const pos = escapeHtml(content.position ?? "");
  const fadedTag = element.faded
    ? `<span class="faded-tag">(faded by ${element.fades_at_elapsed_s}s)</span>`
    : `<span class="active-tag">(still active)</span>`;
  const lifetime = numberOr(element?.lifetime_s, "?");

  if (element.type === "text") {
    const text = escapeHtml(content.content ?? "");
    const style = escapeHtml(content.style ?? "");
    const styleCss = textStyleCss(content.style);
    return (
      `<div class="history-entry history-text">` +
      `${ts} <strong>TEXT</strong> [${id}] &ldquo;${text}&rdquo; ${fadedTag}\n` +
      `  <div class="history-meta">position: ${pos}, style: ${style}, lifetime: ${lifetime}s</div>\n` +
      `  <div class="history-preview text-preview" style="${styleCss}; color: #f5f0e8;">${text}</div>\n` +
      `</div>`
    );
  }
  if (element.type === "svg") {
    const label = escapeHtml(content.semantic_label ?? "");
    const markup = textOr(content.svg_markup);
    const issue = getSvgMarkupIssue(markup);
    const preview = !issue
      ? `<div class="history-preview svg-preview" style="width: 120px; height: 120px; border: 1px solid rgba(245,240,232,0.2); background: #1b1b20;">${markup}</div>`
      : `<div class="history-preview svg-preview svg-preview-malformed" style="width: 120px; min-height: 60px; border: 1px dashed #a33; padding: 6px; color: #f5d0d0; font: 0.75rem monospace;">${fallbackBadge(issue)}</div>`;
    return (
      `<div class="history-entry history-svg">` +
      `${ts} <strong>SVG</strong> [${id}] &ldquo;${label}&rdquo; ${fadedTag}\n` +
      `  <div class="history-meta">position: ${pos}, lifetime: ${lifetime}s</div>\n` +
      `  ${preview}\n` +
      `  <div class="history-markup"><code>${escapeHtml(markup)}</code></div>\n` +
      `</div>`
    );
  }
  const query = escapeHtml(content.query ?? "");
  return (
    `<div class="history-entry history-image">` +
    `${ts} <strong>IMAGE</strong> [${id}] query=&ldquo;${query}&rdquo; ${fadedTag}\n` +
    `  <div class="history-meta">position: ${pos}, lifetime: ${lifetime}s</div>\n` +
    `  <div class="history-preview image-preview" style="width: 180px; height: 120px; border: 1px dashed #8a7e6a; background: rgba(40,32,26,0.4); color: #d9cbb2; display: flex; align-items: center; justify-content: center; text-align: center; padding: 10px; font: 0.85rem Georgia, serif;">${query}</div>\n` +
    `</div>`
  );
}

function renderBackgroundHistoryEntry(background, isCurrent = false) {
  const entry = safeObject(background);
  const ts = timestampPrefix(numberOr(entry.set_at_cycle, "?"), numberOr(entry.set_at_elapsed_s, "?"));
  const cssEsc = escapeHtml(entry.css_background ?? "");
  const safeCss = sanitizeCssBackground(entry.css_background);
  const cssAttr = safeCss.ok
    ? `background: ${escapeAttrStyleValue(safeCss.value)};`
    : "background: repeating-linear-gradient(135deg, rgba(100,60,60,0.35), rgba(100,60,60,0.35) 10px, rgba(25,20,20,0.35) 10px, rgba(25,20,20,0.35) 20px);";
  const currentTag = isCurrent ? `<span class="active-tag">(current)</span>` : "";
  const fallback = !safeCss.ok ? `  <div class="history-meta">${fallbackBadge(`unsafe background blocked (${safeCss.reason})`)}</div>\n` : "";
  return (
    `<div class="history-entry history-background background-change">` +
    `${ts} <strong>SET BACKGROUND</strong> ${currentTag}\n` +
    `  <div class="history-preview background-strip" style="width: 100%; height: 26px; ${cssAttr} border: 1px solid rgba(245,240,232,0.15);"></div>\n` +
    fallback +
    `  <div class="history-markup"><code>${cssEsc}</code></div>\n` +
    `</div>`
  );
}

function renderFadeHistoryEntry(cycle, call) {
  const ts = timestampPrefix(cycle.cycle_index, cycle.elapsed_s ?? 0);
  const id = escapeHtml(call.input?.element_id ?? "?");
  return (
    `<div class="history-entry history-fade">` +
    `${ts} <strong>FADE</strong> [${id}]\n` +
    `</div>`
  );
}

function renderCompositionHistory(state, summary) {
  const events = buildTimelineEvents(state, summary);
  const body = events.map((entry) => entry.render()).join("\n");
  return (
    `<section id="composition-history">\n` +
    `  <h2>COMPOSITION HISTORY</h2>\n` +
    `  ${body}\n` +
    `</section>`
  );
}

export function renderSceneOverview(state) {
  const overview = computeOverview(state ?? {});
  const block = formatOverviewBlock(overview);
  return (
    `<section id="scene-overview">\n` +
    `  <h2>SCENE OVERVIEW (what Opus sees)</h2>\n` +
    `  <pre class="scene-overview-block">${escapeHtml(block)}</pre>\n` +
    `</section>`
  );
}

function renderStatistics(summary) {
  const totals = summary.totals ?? {};
  const statusCounts = totals.status_counts ?? {};
  const perCycle = Array.isArray(summary.per_cycle) ? summary.per_cycle : [];

  const byTool = new Map();
  for (const cycle of perCycle) {
    for (const toolCall of cycle.tool_calls ?? []) {
      byTool.set(toolCall.name, (byTool.get(toolCall.name) ?? 0) + 1);
    }
  }
  const byToolLines = Array.from(byTool.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `    <li>${escapeHtml(name)}: ${n}</li>`)
    .join("\n");

  let cacheRatio = "n/a";
  let cacheReadTotal = 0;
  let inputTotal = 0;
  for (const cycle of perCycle) {
    const usage = cycle.usage;
    if (usage && typeof usage === "object") {
      cacheReadTotal += usage.cache_read_input_tokens ?? 0;
      inputTotal += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    }
  }
  if (inputTotal > 0) {
    cacheRatio = `${((cacheReadTotal / inputTotal) * 100).toFixed(1)}% (${cacheReadTotal} / ${inputTotal} input tokens)`;
  }

  const statusLines = Object.entries(statusCounts)
    .map(([k, v]) => `    <li>${escapeHtml(k)}: ${v}</li>`)
    .join("\n");

  const cost = typeof totals.cost === "number" ? `$${totals.cost.toFixed(4)}` : "$0.0000";

  return (
    `<section id="run-statistics">\n` +
    `  <h2>RUN STATISTICS</h2>\n` +
    `  <dl>\n` +
    `    <dt>Run id</dt><dd>${escapeHtml(summary.run_id ?? "unknown")}</dd>\n` +
    `    <dt>Model</dt><dd>${escapeHtml(summary.model ?? "unknown")}</dd>\n` +
    `    <dt>Config</dt><dd>${escapeHtml(summary.config ?? "unknown")}</dd>\n` +
    `    <dt>Mode</dt><dd>${escapeHtml(summary.mode ?? "unknown")}</dd>\n` +
    `    <dt>Total cycles</dt><dd>${totals.total_cycles ?? perCycle.length}</dd>\n` +
    `    <dt>Tool calls total</dt><dd>${totals.tool_calls ?? 0}</dd>\n` +
    `    <dt>Cycles with tool calls</dt><dd>${totals.cycles_with_tool_calls ?? 0}</dd>\n` +
    `    <dt>Cycles silent</dt><dd>${totals.cycles_silent ?? 0}</dd>\n` +
    `    <dt>Ok count</dt><dd>${totals.ok_count ?? 0}</dd>\n` +
    `    <dt>Cost</dt><dd>${cost}</dd>\n` +
    `    <dt>Cache hit ratio</dt><dd>${cacheRatio}</dd>\n` +
    `    <dt>Started</dt><dd>${escapeHtml(summary.started_at ?? "")}</dd>\n` +
    `    <dt>Finished</dt><dd>${escapeHtml(summary.finished_at ?? "")}</dd>\n` +
    `  </dl>\n` +
    `  <h3>Status counts</h3>\n` +
    `  <ul>\n${statusLines}\n  </ul>\n` +
    `  <h3>Tool-call distribution</h3>\n` +
    `  <ul>\n${byToolLines || "    <li>(none)</li>"}\n  </ul>\n` +
    `</section>`
  );
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 0; background: #0a0a0d; color: #f5f0e8; font: 16px/1.5 Georgia, 'Times New Roman', serif; }
  header { padding: 20px 32px; border-bottom: 1px solid rgba(245,240,232,0.12); }
  header h1 { margin: 0 0 4px 0; font-size: 1.4rem; letter-spacing: 0.04em; }
  header .subtitle { color: rgba(245,240,232,0.55); font-size: 0.9rem; }
  .live-monitor-banner { margin-top: 12px; display: inline-block; padding: 8px 12px; border: 1px dashed rgba(197,182,143,0.7); background: rgba(35,26,18,0.7); color: #e7d7b0; font: 0.82rem/1.35 monospace; }
  section { padding: 20px 32px; border-bottom: 1px solid rgba(245,240,232,0.08); }
  section h2 { margin: 0 0 14px 0; font-size: 0.9rem; letter-spacing: 0.12em; color: rgba(245,240,232,0.55); text-transform: uppercase; }
  section h3 { margin: 18px 0 6px 0; font-size: 0.85rem; letter-spacing: 0.1em; color: rgba(245,240,232,0.5); text-transform: uppercase; }
  .renderer-fallback-notice { position: absolute; top: 40px; left: 16px; z-index: 3; }
  .renderer-fallback-badge { display: inline-block; padding: 6px 10px; border: 1px dashed rgba(245, 176, 176, 0.65); background: rgba(60, 20, 20, 0.72); color: #f5d0d0; font: 0.78rem/1.3 monospace; }
  #composition-history .history-entry { margin: 14px 0; padding: 10px 12px; border-left: 2px solid rgba(245,240,232,0.15); background: rgba(245,240,232,0.02); }
  #composition-history .ts { color: rgba(245,240,232,0.45); font-family: monospace; font-size: 0.85rem; }
  #composition-history .history-meta { color: rgba(245,240,232,0.5); font-size: 0.85rem; margin-top: 4px; }
  #composition-history .history-preview { margin-top: 8px; }
  #composition-history .history-markup code { display: block; margin-top: 6px; padding: 6px 8px; background: rgba(0,0,0,0.35); color: #d9cbb2; font: 0.8rem/1.4 monospace; white-space: pre-wrap; word-break: break-all; }
  #composition-history .faded-tag { color: rgba(245,240,232,0.35); font-size: 0.8rem; }
  #composition-history .active-tag { color: #c5b68f; font-size: 0.8rem; }
  #run-statistics dl { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; }
  #run-statistics dt { color: rgba(245,240,232,0.55); }
  #run-statistics dd { margin: 0; }
  #run-statistics ul { margin: 4px 0 0 0; padding-left: 22px; }
  #scene-overview .scene-overview-block { margin: 0; padding: 14px 18px; background: rgba(0,0,0,0.5); color: #e7d7b0; font: 0.85rem/1.5 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; white-space: pre-wrap; border-left: 2px solid rgba(197,182,143,0.45); border-radius: 2px; }
`;

function renderLiveBanner(liveInfo) {
  if (!liveInfo) return "";
  const cycleText =
    typeof liveInfo.cycles_completed === "number" && typeof liveInfo.cycles_total === "number"
      ? `${liveInfo.cycles_completed}/${liveInfo.cycles_total} cycles complete`
      : "awaiting first cycle";
  const currentCycleText =
    typeof liveInfo.current_cycle_index === "number"
      ? `latest cycle: ${String(liveInfo.current_cycle_index).padStart(3, "0")}`
      : "latest cycle: none yet";
  const updatedText = liveInfo.last_updated_at
    ? `last update: ${escapeHtml(liveInfo.last_updated_at)}`
    : "last update: pending";
  const refreshText = typeof liveInfo.refresh_seconds === "number"
    ? `auto-refresh: ${liveInfo.refresh_seconds}s`
    : "auto-refresh enabled";
  return (
    `  <div class="live-monitor-banner">LIVE MONITOR · ${cycleText} · ${currentCycleText} · ${updatedText} · ${refreshText}</div>\n`
  );
}

function writeHtmlFile(filePath, html) {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, html);
  renameSync(tempPath, filePath);
}

export function renderHtmlString({ state, summary, liveInfo = null, imageAssets = {} }) {
  const stateWithAssets = {
    ...(state ?? {}),
    elements: safeArray(state?.elements).map((element) => ({
      ...element,
      render_asset: imageAssets[element?.element_id] ?? null,
    })),
  };
  const runId = escapeHtml(summary?.run_id ?? "unknown");
  const title = liveInfo
    ? `Feed Looks Back — live monitor — run ${runId}`
    : `Feed Looks Back — run ${runId}`;
  const mode = escapeHtml(summary?.mode ?? "unknown");
  const model = escapeHtml(summary?.model ?? "unknown");
  const refreshMeta = liveInfo
    ? `  <meta http-equiv="refresh" content="${liveInfo.refresh_seconds ?? LIVE_MONITOR_REFRESH_SECONDS}"/>\n`
    : "";
  const liveBanner = renderLiveBanner(liveInfo);

  const finalScene = renderFinalScene(stateWithAssets);
  const sceneOverview = renderSceneOverview(stateWithAssets);
  const history = renderCompositionHistory(stateWithAssets, summary);
  const statistics = renderStatistics(summary);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `<meta charset="utf-8"/>\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>\n` +
    refreshMeta +
    `<title>${title}</title>\n` +
    `<style>${PAGE_CSS}</style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<header>\n` +
    `  <h1>${title}</h1>\n` +
    `  <div class="subtitle">mode: ${mode} · model: ${model}</div>\n` +
    liveBanner +
    `</header>\n` +
    finalScene +
    `\n` +
    sceneOverview +
    `\n` +
    history +
    `\n` +
    statistics +
    `\n</body>\n</html>\n`
  );
}

export async function renderFinalHtml(runDir, artifacts = null, options = {}) {
  const state = artifacts?.state ?? JSON.parse(readFileSync(join(runDir, "scene_state.json"), "utf8"));
  const summary = artifacts?.summary ?? JSON.parse(readFileSync(join(runDir, "run_summary.json"), "utf8"));
  const imageAssets = await resolveImageAssets(state, runDir, options.fetchImageImpl);
  const html = renderHtmlString({ state, summary, imageAssets });
  const outPath = join(runDir, "final_scene.html");
  writeHtmlFile(outPath, html);
  return outPath;
}

export async function renderLiveHtml(runDir, artifacts = null, options = {}) {
  const state = artifacts?.state ?? JSON.parse(readFileSync(join(runDir, "scene_state.json"), "utf8"));
  const summary = artifacts?.summary ?? JSON.parse(readFileSync(join(runDir, "run_summary.json"), "utf8"));
  const refreshSeconds = options.refreshSeconds ?? LIVE_MONITOR_REFRESH_SECONDS;
  const liveInfo = {
    cycles_completed: summary?.per_cycle?.length ?? 0,
    cycles_total: summary?.cycles_total ?? summary?.totals?.total_cycles ?? null,
    current_cycle_index:
      summary?.per_cycle?.length > 0
        ? summary.per_cycle[summary.per_cycle.length - 1]?.cycle_index ?? null
        : null,
    lastUpdatedAt: options.lastUpdatedAt ?? new Date().toISOString(),
    last_updated_at: options.lastUpdatedAt ?? new Date().toISOString(),
    refresh_seconds: refreshSeconds,
  };
  const imageAssets = await resolveImageAssets(state, runDir, options.fetchImageImpl);
  const html = renderHtmlString({ state, summary, liveInfo, imageAssets });
  const outPath = join(runDir, "live_monitor.html");
  writeHtmlFile(outPath, html);
  return outPath;
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { Parser } = await import("htmlparser2");
  const { mkdtempSync, readFileSync: readFileSyncTest } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  let pass = 0;
  let fail = 0;
  const tests = [];
  function t(desc, fn) {
    tests.push({ desc, fn });
  }

  function buildSyntheticState() {
    const elements = [];
    for (let i = 1; i <= 8; i++) {
      const type = ["text", "svg", "image", "text", "text", "svg", "image", "text"][i - 1];
      const createdAtCycle = i;
      const createdAtS = i * 5;
      const lifetime = type === "text" ? 20 : type === "svg" ? 15 : 18;
      const content =
        type === "text"
          ? { content: `fragment-${i}`, position: "lower-left", style: "serif, large" }
          : type === "svg"
            ? {
                svg_markup: `<svg viewBox="0 0 100 100"><line x1="0" y1="${50 + i}" x2="100" y2="${50 - i}" stroke="white" stroke-width="2"/></svg>`,
                position: "horizontal band at mid-height",
                semantic_label: `angular break at cycle ${i}`,
              }
            : { query: `threshold light ${i}`, position: "background" };
      elements.push({
        element_id: `elem_${String(i).padStart(4, "0")}`,
        type,
        created_at_cycle: createdAtCycle,
        created_at_elapsed_s: createdAtS,
        lifetime_s: lifetime,
        fades_at_elapsed_s: createdAtS + lifetime,
        faded: true,
        content,
      });
    }

    elements.push({
      element_id: "elem_0009",
      type: "text",
      created_at_cycle: 25,
      created_at_elapsed_s: 130,
      lifetime_s: 20,
      fades_at_elapsed_s: 150,
      faded: false,
      content: { content: "what remains", position: "upper-right", style: "light, small" },
    });
    elements.push({
      element_id: "elem_0010",
      type: "text",
      created_at_cycle: 28,
      created_at_elapsed_s: 145,
      lifetime_s: 20,
      fades_at_elapsed_s: 165,
      faded: false,
      content: { content: "after", position: "lower-left", style: "serif" },
    });
    elements.push({
      element_id: "elem_0011",
      type: "svg",
      created_at_cycle: 29,
      created_at_elapsed_s: 150,
      lifetime_s: 15,
      fades_at_elapsed_s: 165,
      faded: false,
      content: {
        svg_markup:
          '<svg viewBox="0 0 100 100"><line x1="0" y1="50" x2="100" y2="50" stroke="white" stroke-width="2"/></svg>',
        position: "horizontal band at mid-height",
        semantic_label: "horizontal line mid",
      },
    });
    elements.push({
      element_id: "elem_0012",
      type: "svg",
      created_at_cycle: 29,
      created_at_elapsed_s: 152,
      lifetime_s: 15,
      fades_at_elapsed_s: 167,
      faded: false,
      content: {
        svg_markup: '<svg viewBox="0 0 100 100"><line x1="0 y1="50 broken<<',
        position: "center",
        semantic_label: "broken markup",
      },
    });
    elements.push({
      element_id: "elem_0013",
      type: "image",
      created_at_cycle: 30,
      created_at_elapsed_s: 155,
      lifetime_s: 18,
      fades_at_elapsed_s: 173,
      faded: false,
      content: { query: "exhausted land at dusk", position: "background" },
    });

    return {
      elements,
      background: {
        css_background: "linear-gradient(208deg, #1a1410 0%, #0d0908 100%)",
        set_at_cycle: 28,
        set_at_elapsed_s: 145,
      },
      background_history: [
        {
          css_background: "linear-gradient(180deg, #1a1410 0%, #0d0908 100%)",
          set_at_cycle: 0,
          set_at_elapsed_s: 5,
        },
        {
          css_background: "radial-gradient(circle at 30% 20%, rgba(180,140,90,0.45), rgba(10,10,12,0.95) 70%)",
          set_at_cycle: 15,
          set_at_elapsed_s: 80,
        },
      ],
      next_element_index: 14,
      current_cycle_index: 30,
      current_elapsed_s: 155,
    };
  }

  function buildSyntheticSummary() {
    return {
      run_id: "SELFTEST_RUN",
      config: "config_a",
      model: "claude-opus-4-7",
      mode: "dry-run",
      corpus_dir: "/fake/corpus",
      cycles_total: 31,
      cycles_range: null,
      started_at: "2026-04-23T00:00:00.000Z",
      per_cycle: [
        {
          cycle_index: 0,
          cycle_id: "cycle_000",
          elapsed_s: 5,
          status: "ok",
          error: null,
          tool_calls: [
            { name: "setBackground", input: { css_background: "linear-gradient(180deg, #1a1410 0%, #0d0908 100%)" } },
          ],
          tool_results: [{ tool_use_id: "synth_0", name: "setBackground", result: { ok: true } }],
          persistence_issues: [],
          stop_reason: "end_turn",
          usage: null,
          cost: null,
          active_after_cycle: 0,
        },
        {
          cycle_index: 1,
          cycle_id: "cycle_001",
          elapsed_s: 10,
          status: "ok",
          error: null,
          tool_calls: [
            { name: "addText", input: { content: "fragment-1", position: "lower-left", style: "serif, large" } },
          ],
          tool_results: [{ tool_use_id: "synth_1", name: "addText", result: { element_id: "elem_0001" } }],
          persistence_issues: [],
          stop_reason: "end_turn",
          usage: null,
          cost: null,
          active_after_cycle: 1,
        },
      ],
      totals: {
        total_cycles: 31,
        tool_calls: 31,
        cycles_with_tool_calls: 31,
        cycles_silent: 0,
        cost: 1.87,
        ok_count: 30,
        status_counts: {
          ok: 30,
          api_failure: 0,
          response_parse_failure: 1,
          persistence_failure: 0,
          tool_call_errors: 0,
        },
      },
      finished_at: "2026-04-23T00:10:00.000Z",
    };
  }

  function parseHtmlStrict(html) {
    const errors = [];
    const elements = new Map();
    const parser = new Parser(
      {
        onopentag(name) {
          elements.set(name, (elements.get(name) || 0) + 1);
        },
        onerror(err) {
          errors.push(err);
        },
      },
      { decodeEntities: true, recognizeSelfClosing: true, xmlMode: false },
    );
    parser.write(html);
    parser.end();
    return { errors, elements };
  }

  const state = buildSyntheticState();
  const summary = buildSyntheticSummary();

  t("escapeHtml converts the five HTML-sensitive characters and handles null/undefined/numbers", () => {
    assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
    assert.equal(escapeHtml("plain text 123"), "plain text 123");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml("<script>alert('xss')</script>"), "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  t("renderHtmlString produces a non-empty string that starts with a DOCTYPE", () => {
    const html = renderHtmlString({ state, summary });
    assert.equal(typeof html, "string");
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.ok(html.length > 500);
  });

  t("rendered HTML parses with zero htmlparser2 errors", () => {
    const html = renderHtmlString({ state, summary });
    const { errors, elements } = parseHtmlStrict(html);
    assert.equal(errors.length, 0);
    assert.ok(elements.has("html"));
    assert.ok(elements.has("body"));
    assert.ok(elements.has("section") || elements.has("div"));
  });

  t("final scene view applies background css via inline style on a container", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /linear-gradient\(208deg, #1a1410 0%, #0d0908 100%\)/);
    assert.match(html, /id="final-scene"/);
  });

  t("final scene view shows active text elements verbatim and hides faded ones", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /what remains/);
    assert.match(html, /after/);
    const finalMatch = html.match(/<section id="final-scene"[\s\S]*?<\/section>/);
    assert.ok(finalMatch);
    assert.doesNotMatch(finalMatch[0], /fragment-3/);
  });

  t("final scene view injects valid svg_markup into the outer scene SVG", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /viewBox="0 0 1000 1000"/);
    assert.match(html, /<line x1="0" y1="50" x2="100" y2="50" stroke="white" stroke-width="2"\/>/);
    assert.match(html, /data-element-id="elem_0011"/);
    assert.match(html, /data-semantic-label="horizontal line mid"/);
  });

  t("malformed svg_markup becomes a labeled placeholder, not raw broken markup", () => {
    const html = renderHtmlString({ state, summary });
    const { errors } = parseHtmlStrict(html);
    assert.equal(errors.length, 0);
    assert.doesNotMatch(html, /<line x1="0 y1="50 broken<</);
    assert.match(html, /elem_0012/);
    assert.ok(/malformed|broken markup|&lt;line x1="0/.test(html));
  });

  t("image elements render as labeled placeholders when assets are absent", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /exhausted land at dusk/);
    assert.match(html, /data-element-id="elem_0013"/);
    assert.match(html, /class="[^"]*\bimage-placeholder\b[^"]*"/);
  });

  t("image elements render actual img tags and attribution when assets are provided", () => {
    const html = renderHtmlString({
      state,
      summary,
      imageAssets: {
        elem_0013: {
          src: "../image_cache/example.jpg",
          attribution: {
            photographer_name: "Ada Example",
            photo_url: "https://unsplash.com/photos/example",
          },
        },
      },
    });
    assert.match(html, /<img src="\.\.\/image_cache\/example\.jpg"/);
    assert.match(html, /Photo by/);
    assert.match(html, /Ada Example/);
  });

  t("composition history view contains entries for every element", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /id="composition-history"/);
    for (let i = 1; i <= 13; i += 1) {
      const id = `elem_${String(i).padStart(4, "0")}`;
      assert.ok(html.includes(id), `history should include ${id}`);
    }
  });

  t("composition history includes cycle, elapsed, and background entries", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /cycle 30/);
    assert.match(html, /155/);
    assert.match(html, /SET BACKGROUND|set background|background-change/i);
    assert.match(html, /radial-gradient\(circle at 30% 20%/);
  });

  t("run statistics view reflects totals from the summary", () => {
    const html = renderHtmlString({ state, summary });
    assert.match(html, /id="run-statistics"/);
    assert.match(html, /31/);
    assert.match(html, /\$1\.87|1\.87/);
    assert.match(html, /ok.*30|30.*ok/i);
  });

  t("opacity helpers preserve the old aging behavior", () => {
    assert.equal(opacityForElement({ fades_at_elapsed_s: null, created_at_elapsed_s: 0 }, 180), AGING_OPACITY.normal);
    assert.equal(opacityForElement({ fades_at_elapsed_s: 100, created_at_elapsed_s: 0 }, 50), AGING_OPACITY.normal);
    assert.equal(opacityForElement({ fades_at_elapsed_s: 100, created_at_elapsed_s: 0 }, 97), AGING_OPACITY.fading);
    assert.equal(opacityForAge(15), AGING_OPACITY.normal);
    assert.equal(opacityForAge(16), AGING_OPACITY.fading);
  });

  t("unsafe css backgrounds are blocked and clearly labeled as renderer fallbacks", () => {
    const unsafeState = {
      ...state,
      background: {
        ...state.background,
        css_background: "url(https://example.com/track-me.png)",
      },
    };
    const html = renderHtmlString({ state: unsafeState, summary });
    assert.match(html, /renderer fallback: unsafe background blocked/i);
    assert.doesNotMatch(html, /style="[^"]*url\(https:\/\/example\.com\/track-me\.png/i);
  });

  t("renderHtmlString tolerates malformed scene-state content objects", () => {
    const malformedState = {
      ...state,
      elements: [
        {
          element_id: "elem_broken_text",
          type: "text",
          created_at_cycle: 30,
          created_at_elapsed_s: 155,
          lifetime_s: 20,
          fades_at_elapsed_s: 175,
          faded: false,
          content: null,
        },
        {
          element_id: "elem_broken_svg",
          type: "svg",
          created_at_cycle: 30,
          created_at_elapsed_s: 155,
          lifetime_s: 15,
          fades_at_elapsed_s: 170,
          faded: false,
          content: { svg_markup: "<svg><script>boom</script></svg>" },
        },
      ],
    };
    const html = renderHtmlString({ state: malformedState, summary });
    assert.match(html, /elem_broken_text/);
    assert.match(html, /renderer fallback/i);
  });

  t("renderFinalHtml(runDir) writes final_scene.html", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-operator-final-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderFinalHtml(tmp, { state, summary }, {
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.ok(outPath.endsWith("final_scene.html"));
    assert.match(written, /^<!DOCTYPE html>/i);
    assert.match(written, /exhausted land at dusk/);
  });

  t("renderFinalHtml accepts in-memory artifacts when run_summary.json is absent", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-operator-inline-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    const outPath = await renderFinalHtml(tmp, { state, summary }, {
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.ok(outPath.endsWith("final_scene.html"));
    assert.match(written, /SELFTEST_RUN/);
  });

  t("renderHtmlString includes the live-monitor banner and refresh meta when liveInfo is provided", () => {
    const html = renderHtmlString({
      state,
      summary,
      liveInfo: {
        cycles_completed: 7,
        cycles_total: 31,
        current_cycle_index: 6,
        last_updated_at: "2026-04-23T00:02:00.000Z",
        refresh_seconds: 2,
      },
    });
    assert.match(html, /<meta http-equiv="refresh" content="2"\/>/);
    assert.match(html, /LIVE MONITOR/);
    assert.match(html, /7\/31 cycles complete/);
    assert.match(html, /latest cycle: 006/);
  });

  t("renderLiveHtml writes live_monitor.html with auto-refresh enabled", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-operator-live-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderLiveHtml(tmp, { state, summary }, {
      refreshSeconds: 3,
      lastUpdatedAt: "2026-04-23T00:03:00.000Z",
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.ok(outPath.endsWith("live_monitor.html"));
    assert.match(written, /<meta http-equiv="refresh" content="3"\/>/);
    assert.match(written, /LIVE MONITOR/);
  });

  t("scene overview appears between the final scene and composition history", () => {
    const html = renderHtmlString({ state, summary });
    const finalIdx = html.indexOf('id="final-scene"');
    const overviewIdx = html.indexOf('id="scene-overview"');
    const historyIdx = html.indexOf('id="composition-history"');
    assert.ok(finalIdx > 0);
    assert.ok(overviewIdx > 0);
    assert.ok(historyIdx > 0);
    assert.ok(finalIdx < overviewIdx);
    assert.ok(overviewIdx < historyIdx);
  });

  t("renderSceneOverview tolerates states loaded from disk without cycle_history", () => {
    const legacy = { ...state };
    delete legacy.cycle_history;
    const html = renderSceneOverview(legacy);
    assert.match(html, /SCENE OVERVIEW \(what Opus sees\)/);
    assert.match(html, /Elements active: 5 total/);
  });

  t("scene overview appears in renderLiveHtml output", async () => {
    const { writeFileSync: wfs } = await import("node:fs");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "flb-overview-live-"));
    wfs(path.join(tmp, "scene_state.json"), JSON.stringify(state));
    wfs(path.join(tmp, "run_summary.json"), JSON.stringify(summary));
    const outPath = await renderLiveHtml(tmp, { state, summary }, {
      refreshSeconds: 2,
      lastUpdatedAt: "2026-04-23T00:05:00.000Z",
      fetchImageImpl: async () => ({ path: null, attribution: null, error: "disabled in self-test" }),
    });
    const written = readFileSyncTest(outPath, "utf8");
    assert.match(written, /id="scene-overview"/);
    assert.match(written, /Density trajectory:/);
  });

  for (const { desc, fn } of tests) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.stack ?? err.message}\n`);
    }
  }

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exit(1);
}

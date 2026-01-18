// Content Script - Injected into every page
import type { PageFeature, ContentResponse } from '../types/messages';

console.log('Big Brother: Content script loaded on', window.location.href);

// Track currently highlighted elements for cleanup
let highlightedElements: Map<HTMLElement, { outline: string; boxShadow: string }> = new Map();
let highlightOverlay: HTMLDivElement | null = null;
let highlightOverlayRAF: number | null = null;
let currentHighlightedEl: HTMLElement | null = null;

// Track clicked elements to help AI avoid loops
const clickedElements = new Set<string>();

function markElementAsClicked(element: HTMLElement) {
  const selector = generateSelector(element);
  clickedElements.add(selector);
  console.log('[Big Brother] Marked element as clicked:', selector);
}

function ensureHighlightOverlay(): HTMLDivElement {
  if (highlightOverlay && document.documentElement.contains(highlightOverlay)) return highlightOverlay;
  const el = document.createElement('div');
  el.id = 'bb-highlight-overlay';
  el.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    border: 3px solid #ff0000;
    box-shadow: 0 0 0 4px rgba(255,0,0,0.35);
    border-radius: 6px;
    left: 0; top: 0; width: 0; height: 0;
    transform: translate3d(0,0,0);
    display: none;
  `;
  document.documentElement.appendChild(el);
  highlightOverlay = el;
  return el;
}

function positionOverlayForElement(target: HTMLElement) {
  const overlay = ensureHighlightOverlay();
  const rect = target.getBoundingClientRect();
  const pad = 2;
  overlay.style.left = `${Math.max(0, rect.left - pad)}px`;
  overlay.style.top = `${Math.max(0, rect.top - pad)}px`;
  overlay.style.width = `${Math.max(0, rect.width + pad * 2)}px`;
  overlay.style.height = `${Math.max(0, rect.height + pad * 2)}px`;
  overlay.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
}

function startOverlayTracking(target: HTMLElement) {
  currentHighlightedEl = target;
  const tick = () => {
    if (!currentHighlightedEl || !document.body.contains(currentHighlightedEl)) {
      stopOverlayTracking();
      return;
    }
    positionOverlayForElement(currentHighlightedEl);
    highlightOverlayRAF = window.requestAnimationFrame(tick);
  };
  if (highlightOverlayRAF) window.cancelAnimationFrame(highlightOverlayRAF);
  highlightOverlayRAF = window.requestAnimationFrame(tick);
}

function stopOverlayTracking() {
  if (highlightOverlayRAF) window.cancelAnimationFrame(highlightOverlayRAF);
  highlightOverlayRAF = null;
  currentHighlightedEl = null;
  if (highlightOverlay) highlightOverlay.style.display = 'none';
}

// Listen for messages from the side panel (via background script)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('Content script received message:', message);

  // Respond to ping from background script (used to check if content script is loaded)
  if (message.type === 'PING') {
    sendResponse({ success: true, loaded: true });
    return true;
  }

  if (message.type === 'GET_FEATURES') {
    // Just extract and return features - no actions
    const result = extractPageFeatures();
    sendResponse(result);
    return true;
  }

  if (message.type === 'HIGHLIGHT_ELEMENT') {
    // Highlight an element without executing
    highlightElementByIndex(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    // Clear all highlights
    clearAllHighlights();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'EXECUTE_ACTION') {
    // Execute an action on a specific element
    executeAction(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'WAIT_FOR_EVENT') {
    waitForEvent(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Legacy handler for USER_PROMPT (for backwards compatibility)
    if (message.type === 'USER_PROMPT') {
    const result = extractPageFeatures();
    sendResponse(result);
    return true;
  }

  return false;
});

/**
 * Extract all interactive elements from the page
 * Returns them in the format expected by the backend API
 */
function extractPageFeatures(): ContentResponse {
  const pageTitle = document.title;
  const pageUrl = window.location.href;

  const features: PageFeature[] = [];
  let index = 0;

  console.log(`📊 Context: Collecting exactly 60 inputs, 60 buttons, 60 links`);

  // Collect product links FIRST, then other links
  const productLinks = Array.from(document.querySelectorAll(
    '.product-card a, .product-item a, .product a, ' +
    '[class*="product"] a, [class*="item"] a, [class*="card"] a, ' +
    'article a, [data-product] a, [data-product-handle] a'
  ));
  
  console.log(`🛍️ Found ${productLinks.length} product link candidates`);
  
  const otherLinks = Array.from(document.querySelectorAll(
    'a[href]:not(header a):not(footer a):not(nav a):not([role="navigation"] a)'
  ));
  
  console.log(`🔗 Found ${otherLinks.length} total link candidates (excluding header/footer/nav)`);
  
  // Combine: products first, then others
  const allLinks = [...productLinks, ...otherLinks];
  
  const linkFeatures: PageFeature[] = [];
  const seenUrls = new Set<string>();
  let productCount = 0;
  let otherCount = 0;
  
  for (const link of allLinks) {
    if (linkFeatures.length >= 60) break; // Stop at 60 links total
    
    const el = link as HTMLAnchorElement;
    const href = el.getAttribute('href') || '';
    
    // Skip invalid or nav links
    if (!href || href.startsWith('javascript:') || href === '#') continue;
    if (el.closest('header, footer, nav, [role="navigation"]')) continue;
    
    // Skip duplicates
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);
    
    // Strict visibility check - only visible links
    if (!isVisible(el)) continue;
    
    const isProduct = productLinks.includes(link);
    
    if (isProduct) {
      productCount++;
    } else {
      otherCount++;
    }
    
    const text = el.innerText.trim() || el.textContent?.trim() || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    
    if (!text && !ariaLabel) continue;
    if (href.startsWith('#') && !href.includes('MainContent')) continue;
    
    const selector = generateSelector(el);
    linkFeatures.push({
      index: index++,
      type: 'link',
      text: (text || ariaLabel).substring(0, 100),
      selector,
      href: href || undefined,
      aria_label: ariaLabel || undefined,
      already_clicked: clickedElements.has(selector),
    });
  }
  
  console.log(`📊 Link collection: ${productCount} products, ${otherCount} other links`);
  features.push(...linkFeatures);

  // Collect inputs (exactly 60)
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select'));
  const inputFeatures: PageFeature[] = [];
  for (const input of inputs) {
    if (inputFeatures.length >= 75) break; // Stop at 75 inputs
    
    const el = input as HTMLInputElement;
    if (!isVisible(el)) continue;
    
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const name = el.getAttribute('name') || '';
    const label = findLabelFor(el);
    const selector = generateSelector(el);
    
    inputFeatures.push({
        index: index++,
      type: 'input',
      text: label || name || placeholder || el.getAttribute('type') || 'text',
      selector,
      placeholder: placeholder || undefined,
      aria_label: ariaLabel || label || undefined,
      value_len: typeof (el as any).value === 'string' ? ((el as any).value as string).length : 0,
      already_clicked: clickedElements.has(selector),
    });
  }
  features.push(...inputFeatures);

  // Collect buttons - PRIORITIZE ACTION BUTTONS
  const actionButtons = Array.from(document.querySelectorAll(
    '.add-to-cart, .addtocart, [class*="add-to-cart"], [class*="AddToCart"], ' +
    '[id*="add-to-cart"], [id*="AddToCart"], [name*="add"], ' +
    'button[name="add"], button[type="submit"], ' +
    'form[action*="cart"] button, product-form button'
  ));
  
  const otherButtons = Array.from(document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], [role="button"]'
  ));
  
  // Combine: action buttons first
  const allButtons = [...actionButtons, ...otherButtons];
  
  console.log(`🔘 Found ${actionButtons.length} action buttons, ${otherButtons.length} total buttons`);
  
  const buttonFeatures: PageFeature[] = [];
  const seenButtonSelectors = new Set<string>();
  
  for (const button of allButtons) {
    if (buttonFeatures.length >= 75) break; // Stop at 75 buttons
    
    const el = button as HTMLElement;
    
    // Lenient visibility for action buttons, strict for others
    const isActionButton = actionButtons.includes(button);
    if (!isActionButton && !isVisible(el)) continue;
    
    // For action buttons, allow if at least has dimensions OR is in DOM
    if (isActionButton) {
      const rect = el.getBoundingClientRect();
      const hasSize = rect.width > 0 || rect.height > 0;
      const inDOM = document.body.contains(el);
      if (!hasSize && !inDOM) continue;
    }
    
    // Get clean text by removing style, script, and SVG content
    let text = '';
    const clone = el.cloneNode(true) as HTMLElement;
    // Remove style, script, and SVG elements
    clone.querySelectorAll('style, script, svg').forEach(n => n.remove());
    text = clone.textContent?.trim() || (el as HTMLInputElement).value || '';
    
    const ariaLabel = el.getAttribute('aria-label') || '';
    const buttonName = el.getAttribute('name') || '';
    
    // Skip if text looks like CSS or contains obvious CSS markers
    if (text.includes('.cls-') || text.includes('{') || text.includes('fill:') || text.includes('stroke:')) {
      continue;
    }
    if (!text && !ariaLabel && !buttonName) continue;
    
    const selector = generateSelector(el);
    // Skip duplicate buttons
    if (seenButtonSelectors.has(selector)) continue;
    seenButtonSelectors.add(selector);
    
    if (isActionButton) {
      console.log(`✅ Action button: "${text || ariaLabel || buttonName}"`);
    }
    buttonFeatures.push({
        index: index++,
        type: 'button',
      text: (text || ariaLabel || buttonName).substring(0, 100),
      selector,
      aria_label: ariaLabel || undefined,
      already_clicked: clickedElements.has(selector),
    });
  }
  features.push(...buttonFeatures);

  // Deduplicate based on text + type
  const seen = new Set<string>();
  const uniqueFeatures = features.filter((f) => {
    const key = `${f.type}:${f.text}:${f.href || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Reindex
  uniqueFeatures.forEach((f, idx) => {
    f.index = idx;
  });

  // Debug log: what the agent can "see"
  try {
    console.groupCollapsed(
      `[Big Brother] Extracted ${uniqueFeatures.length} interactive elements`,
      pageUrl
    );
    console.table(
      uniqueFeatures.map((f) => ({
        index: f.index,
        type: f.type,
        text: f.text,
        placeholder: f.placeholder || '',
        aria_label: f.aria_label || '',
        href: f.href || '',
        value_len: f.value_len ?? 0,
        selector: f.selector,
      }))
    );
    console.groupEnd();
  } catch {
    console.log(`Extracted ${uniqueFeatures.length} features from page`);
  }

  // Detailed logging of extracted features
  console.group(`🔍 DOM EXTRACTION - ${uniqueFeatures.length} elements`);
  console.log('📍 URL:', pageUrl);
  uniqueFeatures.forEach((f, i) => {
    const clickedFlag = f.already_clicked ? '✓ CLICKED' : '';
    console.log(
      `[${i}] ${f.type.toUpperCase()} ${clickedFlag}:`,
      f.text || f.placeholder || f.aria_label || '(no text)',
      f.selector
    );
  });
  console.groupEnd();

  return {
    success: true,
    pageTitle,
    pageUrl,
    features: uniqueFeatures,
    message: `Found ${uniqueFeatures.length} interactive elements`,
  };
}

/**
 * Execute an action on the page
 */
async function executeAction(payload: {
  action: 'CLICK' | 'TYPE' | 'SCROLL' | 'WAIT';
  targetIndex: number | null;
  textInput?: string;
}): Promise<ContentResponse> {
  const { action, targetIndex, textInput } = payload;

  if (action === 'SCROLL') {
    window.scrollBy({ top: 300, behavior: 'smooth' });
    return { success: true, message: 'Scrolled down' };
  }

  if (action === 'WAIT') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { success: true, message: 'Waited 1 second' };
  }

  if (targetIndex === null) {
    return { success: false, error: 'No target element specified' };
  }

  // Re-extract features to get fresh selectors
  const { features } = extractPageFeatures();
  const feature = features?.find((f) => f.index === targetIndex);
  
  if (!feature) {
    return { success: false, error: `Element with index ${targetIndex} not found` };
  }

  const element = getElementBySelector(feature.selector);
  if (!element) {
    return { success: false, error: `Could not find element: ${feature.selector}` };
  }

  // Clear previous highlights and highlight current element
  clearAllHighlights();
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  highlightElement(element, 5000);
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (action === 'CLICK') {
    movePointerToElement(element);
    await new Promise((resolve) => setTimeout(resolve, 800));
    element.click();
    markElementAsClicked(element); // Track that this element was clicked
    return { success: true, message: `Clicked: ${feature.text}` };
  }

  if (action === 'TYPE') {
    if (!textInput) {
      return { success: false, error: 'No text to type' };
    }
    
    const inputEl = element as HTMLInputElement;
    inputEl.focus();
    inputEl.value = textInput;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, message: `Typed "${textInput}" into ${feature.text}` };
  }

  return { success: false, error: `Unknown action: ${action}` };
}

/**
 * Check if an element is visible
 */
function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Find label text for an input element
 */
function findLabelFor(input: HTMLElement): string {
  // Check for associated label via 'for' attribute
  const id = input.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) return label.textContent?.trim() || '';
  }
  
  // Check for wrapping label
  const parentLabel = input.closest('label');
  if (parentLabel) {
    const text = parentLabel.textContent?.trim() || '';
    // Remove the input's own text if present
    const inputText = (input as HTMLInputElement).value || '';
    return text.replace(inputText, '').trim();
  }
  
  // Check for aria-labelledby
  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() || '';
  }
  
  return '';
}

// Element cache for selector stability
const elementCache = new Map<string, HTMLElement>();
let selectorCounter = 0;

/**
 * Get element by selector, using cache for cached selectors
 */
function getElementBySelector(selector: string): HTMLElement | null {
  const cacheMatch = selector.match(/\[data-bb-id="([^"]+)"\]/);
  if (cacheMatch) {
    const cachedId = cacheMatch[1];
    const cachedElement = elementCache.get(cachedId);
    if (cachedElement && document.body.contains(cachedElement)) {
      return cachedElement;
    }
  }
  
  try {
    return document.querySelector(selector) as HTMLElement;
  } catch (e) {
    console.warn('Invalid selector:', selector, e);
    return null;
  }
}

/**
 * Generate a unique CSS selector for an element
 */
function generateSelector(element: Element): string {
  // Use ID if available and valid
  if (element.id && /^[a-zA-Z][\w-]*$/.test(element.id)) {
      const selector = `#${element.id}`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch (e) {
      // Invalid selector, continue
    }
  }
  
  // Try name attribute for inputs
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
    const name = element.getAttribute('name');
    if (name) {
      const selector = `${element.tagName.toLowerCase()}[name="${name}"]`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch (e) {
        // Invalid selector, continue
      }
    }
  }
  
  // Try unique class combination
  const classes = Array.from(element.classList).filter(c => c && !c.match(/^(hover|focus|active|selected|disabled)/));
  if (classes.length > 0) {
    const selector = `${element.tagName.toLowerCase()}.${classes.slice(0, 3).join('.')}`;
    try {
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    } catch (e) {
      // Invalid selector, continue
    }
  }
  
  // Cache with data attribute as last resort
  const uniqueId = `bb-${selectorCounter++}`;
  elementCache.set(uniqueId, element as HTMLElement);
  element.setAttribute('data-bb-id', uniqueId);
  
  return `[data-bb-id="${uniqueId}"]`;
}

/**
 * Clear all current highlights
 */
function clearAllHighlights(): void {
  highlightedElements.forEach((original, element) => {
    element.style.outline = original.outline;
    element.style.boxShadow = original.boxShadow;
  });
  highlightedElements.clear();
  stopOverlayTracking();
  
  // Remove the pointer if it exists
  const pointer = document.getElementById('bb-pointer');
  if (pointer) {
    pointer.style.opacity = '0';
  }
}

/**
 * Highlight an element by its index
 */
async function highlightElementByIndex(payload: {
  targetIndex?: number;
  selector?: string;
  duration?: number;
}): Promise<ContentResponse> {
  const { targetIndex, selector, duration = 5000 } = payload;

  // Prefer stable selector (indices can change across scans).
  let resolvedSelector: string | null = selector || null;
  let labelText = '';

  if (!resolvedSelector && typeof targetIndex === 'number') {
    const { features } = extractPageFeatures();
    const feature = features?.find((f) => f.index === targetIndex);
    if (!feature) {
      console.warn('[Big Brother] HIGHLIGHT_ELEMENT: feature index not found', {
        targetIndex,
        availableCount: features?.length ?? 0,
      });
      return { success: false, error: `Element with index ${targetIndex} not found` };
    }
    resolvedSelector = feature.selector;
    labelText = feature.text || '';
  }

  if (!resolvedSelector) {
    return { success: false, error: 'No selector/targetIndex provided' };
  }

  console.log('[Big Brother] HIGHLIGHT_ELEMENT: resolving selector', {
    targetIndex,
    selector: resolvedSelector,
  });

  const element = getElementBySelector(resolvedSelector);
  if (!element) {
    console.warn('[Big Brother] HIGHLIGHT_ELEMENT: selector did not match any element', {
      targetIndex,
      selector: resolvedSelector,
    });
    return { success: false, error: `Could not find element: ${resolvedSelector}` };
  }
  
  // Clear previous highlights
  clearAllHighlights();
  
  // Scroll to element
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Highlight the element
  startOverlayTracking(element);
  highlightElement(element, duration);
  
  // Show pointer
  movePointerToElement(element);
  
  return { 
    success: true, 
    message: `Highlighted: ${labelText || (element.getAttribute('aria-label') || '') || 'element'}`,
  };
}

/**
 * Highlight an element visually
 */
function highlightElement(element: HTMLElement, duration: number = 3000): void {
  // Store original styles if not already tracked
  if (!highlightedElements.has(element)) {
    highlightedElements.set(element, {
      outline: element.style.outline,
      boxShadow: element.style.boxShadow,
    });
  }

  // Use !important to override sites that set `outline: none !important` etc.
  element.style.setProperty('outline', '3px solid #ff0000', 'important');
  element.style.setProperty('outline-offset', '2px', 'important');
  element.style.setProperty('box-shadow', '0 0 0 4px rgba(255, 0, 0, 0.35)', 'important');
  
  // duration <= 0 means "sticky" highlight (until next highlight / clearAllHighlights).
  if (duration > 0) {
    setTimeout(() => {
      const original = highlightedElements.get(element);
      if (original) {
        // Clear the forced properties first, then restore originals.
        element.style.removeProperty('outline');
        element.style.removeProperty('outline-offset');
        element.style.removeProperty('box-shadow');
        element.style.outline = original.outline;
        element.style.boxShadow = original.boxShadow;
        highlightedElements.delete(element);
      }
    }, duration);
  }
}

/**
 * Move visual pointer to element
 */
function movePointerToElement(element: HTMLElement): void {
  let pointer = document.getElementById('bb-pointer');
  if (!pointer) {
    pointer = document.createElement('div');
    pointer.id = 'bb-pointer';
    pointer.innerHTML = '👆';
    pointer.style.cssText = `
      position: fixed;
      font-size: 40px;
      pointer-events: none;
      z-index: 999999;
      transition: all 0.4s ease-out;
      filter: drop-shadow(0 0 8px rgba(255, 107, 0, 0.8));
    `;
    document.body.appendChild(pointer);
  }
  
  const rect = element.getBoundingClientRect();
  pointer.style.left = `${rect.left + rect.width / 2 - 20}px`;
  pointer.style.top = `${rect.top - 50}px`;
  pointer.style.opacity = '1';
  
  // Fade out after a delay
  setTimeout(() => {
    pointer!.style.opacity = '0';
  }, 2500);
}

/**
 * Wait for a user interaction (guidance-only mode).
 */
async function waitForEvent(payload: {
  event: 'click' | 'input' | 'scroll';
  targetIndex?: number | null;
  selector?: string;
  timeoutMs?: number;
}): Promise<ContentResponse> {
  const { event, targetIndex = null, selector, timeoutMs = 30000 } = payload || {};

  // scroll is global
  if (event === 'scroll') {
    return new Promise((resolve) => {
      let done = false;
      const onScroll = () => {
        if (done) return;
        done = true;
        window.removeEventListener('scroll', onScroll, true);
        resolve({ success: true, message: 'Detected scroll' });
      };
      window.addEventListener('scroll', onScroll, true);
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener('scroll', onScroll, true);
        resolve({ success: false, error: 'Timed out waiting for scroll' });
      }, timeoutMs);
    });
  }

  // Prefer stable selector, fallback to targetIndex.
  let resolvedSelector: string | null = selector || null;
  if (!resolvedSelector && targetIndex !== null) {
    const { features } = extractPageFeatures();
    const feature = features?.find((f) => f.index === targetIndex);
    if (feature) resolvedSelector = feature.selector;
  }

  if (!resolvedSelector) {
    return { success: false, error: 'No selector/targetIndex provided' };
  }

  const element = getElementBySelector(resolvedSelector);
  if (!element) {
    return { success: false, error: `Could not find element: ${resolvedSelector}` };
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, msg: string) => {
      if (done) return;
      done = true;
      element.removeEventListener('click', onClick, true);
      element.removeEventListener('input', onInput, true);
      element.removeEventListener('change', onInput, true);
      resolve(ok ? { success: true, message: msg } : { success: false, error: msg });
    };

    const onClick = () => finish(true, 'Detected click');
    const onInput = () => finish(true, 'Detected input');

    if (event === 'click') {
      element.addEventListener('click', onClick, true);
    } else if (event === 'input') {
      element.addEventListener('input', onInput, true);
      element.addEventListener('change', onInput, true);
    } else {
      return finish(false, `Unknown event: ${event}`);
    }

    setTimeout(() => finish(false, `Timed out waiting for ${event}`), timeoutMs);
  });
}

export { extractPageFeatures, executeAction, highlightElementByIndex, clearAllHighlights };

// Background Service Worker
console.log('Big Brother: Background service worker loaded');

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

/**
 * Inject content script into a tab if not already present
 */
function getInjectionBlockReason(url: string | undefined): string | null {
  if (!url) return 'No tab URL available';
  const u = url.toLowerCase();
  if (u.startsWith('chrome://') || u.startsWith('edge://') || u.startsWith('about:')) {
    return 'Browser internal pages do not allow extension injection. Open a normal website tab instead.';
  }
  // Chrome Web Store is blocked
  if (u.startsWith('https://chrome.google.com/webstore') || u.startsWith('https://chromewebstore.google.com/')) {
    return 'Chrome Web Store pages do not allow extension injection.';
  }
  if (u.startsWith('chrome-extension://')) {
    return 'Extension pages do not allow injection into themselves.';
  }
  if (u.startsWith('file://')) {
    return 'File pages require enabling “Allow access to file URLs” in the extension settings.';
  }
  return null;
}

async function ensureContentScript(tabId: number, tabUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const blocked = getInjectionBlockReason(tabUrl);
  if (blocked) return { ok: false, error: blocked };
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return { ok: true }; // Content script is already loaded
  } catch {
    // Content script not loaded, inject it
    console.log('Content script not found, injecting...');
    try {
      // Use whatever the manifest says the content script entrypoint is.
      // This avoids hardcoding dev-only paths like `src/content/content.js`,
      // and works after build when the bundler rewrites filenames.
      const manifest = chrome.runtime.getManifest();
      const files =
        (manifest.content_scripts?.[0]?.js as string[] | undefined) ?? [];
      if (!files.length) {
        console.error('No content_scripts entry found in manifest; cannot inject.');
        return { ok: false, error: 'Extension manifest has no content_scripts entry to inject.' };
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files,
      });
      // Wait a bit for the script to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log('Content script injected successfully');
      return { ok: true };
    } catch (err) {
      console.error('Failed to inject content script:', err);
      const msg =
        (err as any)?.message ||
        (err as any)?.toString?.() ||
        'Unknown injection error';
      return { ok: false, error: `Failed to inject content script: ${msg}` };
    }
  }
}

// Handle messages from side panel and content scripts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('Background received message:', message);

  // Route messages from side panel to content script
  const contentMessageTypes = [
    'USER_PROMPT',
    'GET_FEATURES',
    'EXECUTE_ACTION',
    'WAIT_FOR_EVENT',
    'HIGHLIGHT_ELEMENT',
    'CLEAR_HIGHLIGHTS',
  ];
  
  if (contentMessageTypes.includes(message.type) && message.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs[0];
      
      if (!activeTab?.id) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }

      // Ensure content script is loaded
      const injected = await ensureContentScript(activeTab.id, activeTab.url);
      if (!injected.ok) {
        sendResponse({ 
          success: false, 
          error: injected.error || 'Could not inject content script. Try refreshing the page.' 
        });
        return;
      }

      // Send message to content script in active tab
      chrome.tabs.sendMessage(
        activeTab.id,
        message,
        (response) => {
          if (chrome.runtime.lastError) {
            console.error('Error sending to content script:', chrome.runtime.lastError);
            sendResponse({ 
              success: false, 
              error: chrome.runtime.lastError.message 
            });
          } else {
            sendResponse(response);
          }
        }
      );
    });

    // Return true to indicate we'll send response asynchronously
    return true;
  }

  // Handle other message types here
  return true;
});

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Big Brother installed successfully');
  } else if (details.reason === 'update') {
    console.log('Big Brother updated to version', chrome.runtime.getManifest().version);
  }
});

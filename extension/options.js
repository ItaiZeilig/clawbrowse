const portEl = document.getElementById('port');
const statusEl = document.getElementById('status');

async function load() {
  const { port } = await chrome.storage.local.get('port');
  portEl.value = port || 10577;
  refreshStatus();
}

function refreshStatus() {
  const p = portEl.value || 10577;
  // Ask the background worker for its live connection state. (Don't open our own socket — the
  // bridge only accepts one connection, so a probe would be rejected and report a false negative.)
  try {
    chrome.runtime.sendMessage({ type: 'status' }, (res) => {
      if (chrome.runtime.lastError || !res) { statusEl.textContent = 'Could not reach the extension worker.'; return; }
      statusEl.textContent = res.connected
        ? `Connected to the bridge on port ${p}. ✅`
        : `Not connected on port ${p}. Make sure Claude Code is running (it launches the MCP server), then wait a few seconds.`;
    });
  } catch {
    statusEl.textContent = 'Could not query connection status.';
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portEl.value) || 10577;
  await chrome.storage.local.set({ port });
  statusEl.textContent = 'Saved. Reconnecting…';
  setTimeout(refreshStatus, 800);
});

load();

const portEl = document.getElementById('port');
const statusEl = document.getElementById('status');

async function load() {
  const { port } = await chrome.storage.local.get('port');
  portEl.value = port || 10577;
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] }).then(() => {
    // Ask the service worker to report by pinging the bridge indirectly via a probe socket.
    const p = portEl.value || 10577;
    try {
      const probe = new WebSocket(`ws://127.0.0.1:${p}`);
      const t = setTimeout(() => { try { probe.close(); } catch {} statusEl.textContent = `Bridge not reachable on port ${p}. Start the MCP server (Claude Code launches it) and reconnect.`; }, 1500);
      probe.onopen = () => { clearTimeout(t); statusEl.textContent = `Bridge reachable on port ${p}. ✅`; try { probe.close(); } catch {} };
      probe.onerror = () => { clearTimeout(t); statusEl.textContent = `Bridge not reachable on port ${p}. Start the MCP server and reconnect.`; };
    } catch {
      statusEl.textContent = 'Could not probe the bridge.';
    }
  });
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portEl.value) || 10577;
  await chrome.storage.local.set({ port });
  statusEl.textContent = 'Saved. Reconnecting…';
  setTimeout(refreshStatus, 800);
});

load();

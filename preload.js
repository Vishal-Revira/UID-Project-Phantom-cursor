// ─────────────────────────────────────────────────────────────
// preload.js — Secure bridge between main and renderer
// Exposes a controlled API via contextBridge so the renderer
// can interact with Electron without direct Node.js access.
// ─────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phantomAPI', {
  // Toggle click-through mode (returns new state)
  toggleClickThrough: () => ipcRenderer.invoke('toggle-click-through'),

  // Query current click-through state
  getClickThrough: () => ipcRenderer.invoke('get-click-through'),

  // Get the WebSocket server port
  getServerPort: () => ipcRenderer.invoke('get-server-port'),

  // Get local LAN IP address
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Granular mouse-event control for click-through regions
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.invoke('set-ignore-mouse', ignore, options),

  // Listen for peer count updates from main process
  onPeerCount: (callback) => {
    ipcRenderer.on('peer-count', (_event, count) => callback(count));
  },

  // ── Remote Click ──────────────────────────────────────────
  // Simulate a mouse click at the given screen coordinates
  simulateClick: (x, y, button) =>
    ipcRenderer.invoke('simulate-click', x, y, button),

  // Toggle remote click on/off (returns new state)
  toggleRemoteClick: () => ipcRenderer.invoke('toggle-remote-click'),

  // Query current remote click state
  getRemoteClick: () => ipcRenderer.invoke('get-remote-click'),

  // ── Screen Capture ────────────────────────────────────────
  // Get available desktop sources for screen capture
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // Toggle screen sharing on/off (returns new state)
  toggleScreenShare: () => ipcRenderer.invoke('toggle-screen-share'),

  // Query current screen share state
  getScreenShare: () => ipcRenderer.invoke('get-screen-share'),

  // ── Remote Keyboard ───────────────────────────────────────
  // Simulate a keypress on the host machine
  simulateKeypress: (code, action) =>
    ipcRenderer.invoke('simulate-keypress', code, action),

  // ── Screen Click (absolute coordinates) ───────────────────
  // Simulate a click at normalized screen coordinates (0-1)
  simulateScreenClick: (xNorm, yNorm, button) =>
    ipcRenderer.invoke('simulate-screen-click', xNorm, yNorm, button),
});

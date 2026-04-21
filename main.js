// ─────────────────────────────────────────────────────────────
// main.js — Electron main process
// Creates a frameless, transparent, always-on-top overlay window
// and spawns a local WebSocket relay server on port 8765.
// Supports remote click & keyboard simulation via koffi FFI (Windows).
// Supports screen mirroring via desktopCapturer.
// ─────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

let mainWindow = null;
let wss = null;
let isClickThrough = false;
let remoteClickEnabled = false;
let screenShareEnabled = false;

// ── Native Mouse & Keyboard Simulation (Windows only via koffi) ──
let SetCursorPos = null;
let mouse_event = null;
let keybd_event = null;

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;

if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)');
    keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
    console.log('[Native] koffi loaded — remote click & keyboard simulation available');
  } catch (err) {
    console.warn('[Native] Could not load koffi:', err.message);
  }
}

function simulateMouseClick(x, y, button = 'left') {
  if (!SetCursorPos || !mouse_event) {
    console.warn('[Native] Mouse simulation not available');
    return false;
  }
  try {
    SetCursorPos(Math.round(x), Math.round(y));
    if (button === 'right') {
      mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
      mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
    } else {
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
    return true;
  } catch (err) {
    console.error('[Native] Click simulation failed:', err.message);
    return false;
  }
}

// ── Virtual Key Code Map (JS code → Windows VK) ─────────────
const VK_MAP = {
  // Letters
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44, 'KeyE': 0x45,
  'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48, 'KeyI': 0x49, 'KeyJ': 0x4A,
  'KeyK': 0x4B, 'KeyL': 0x4C, 'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F,
  'KeyP': 0x50, 'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58, 'KeyY': 0x59,
  'KeyZ': 0x5A,
  // Digits
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33,
  'Digit4': 0x34, 'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37,
  'Digit8': 0x38, 'Digit9': 0x39,
  // Function keys
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74,
  'F6': 0x75, 'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79,
  'F11': 0x7A, 'F12': 0x7B,
  // Modifiers
  'ShiftLeft': 0x10, 'ShiftRight': 0x10,
  'ControlLeft': 0x11, 'ControlRight': 0x11,
  'AltLeft': 0x12, 'AltRight': 0x12,
  'MetaLeft': 0x5B, 'MetaRight': 0x5C,
  // Navigation
  'ArrowUp': 0x26, 'ArrowDown': 0x28, 'ArrowLeft': 0x25, 'ArrowRight': 0x27,
  'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
  // Editing
  'Backspace': 0x08, 'Delete': 0x2E, 'Insert': 0x2D,
  'Enter': 0x0D, 'NumpadEnter': 0x0D,
  'Tab': 0x09, 'Escape': 0x1B,
  'Space': 0x20,
  // Punctuation & symbols
  'Minus': 0xBD, 'Equal': 0xBB,
  'BracketLeft': 0xDB, 'BracketRight': 0xDD,
  'Backslash': 0xDC, 'Semicolon': 0xBA,
  'Quote': 0xDE, 'Backquote': 0xC0,
  'Comma': 0xBC, 'Period': 0xBE, 'Slash': 0xBF,
  // Misc
  'CapsLock': 0x14, 'NumLock': 0x90, 'ScrollLock': 0x91,
  'PrintScreen': 0x2C, 'Pause': 0x13,
  // Numpad
  'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62, 'Numpad3': 0x63,
  'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66, 'Numpad7': 0x67,
  'Numpad8': 0x68, 'Numpad9': 0x69,
  'NumpadMultiply': 0x6A, 'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D,
  'NumpadDecimal': 0x6E, 'NumpadDivide': 0x6F,
};

// Extended keys that need the KEYEVENTF_EXTENDEDKEY flag
const EXTENDED_KEYS = new Set([
  0x25, 0x26, 0x27, 0x28, // Arrow keys
  0x24, 0x23, 0x21, 0x22, // Home, End, PgUp, PgDn
  0x2D, 0x2E,             // Insert, Delete
  0x5B, 0x5C,             // Win keys
]);

function simulateKeypress(code, action) {
  if (!keybd_event) {
    console.warn('[Native] Keyboard simulation not available');
    return false;
  }
  const vk = VK_MAP[code];
  if (vk === undefined) {
    console.warn(`[Native] Unknown key code: ${code}`);
    return false;
  }
  try {
    let flags = 0;
    if (EXTENDED_KEYS.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
    if (action === 'up') flags |= KEYEVENTF_KEYUP;
    keybd_event(vk, 0, flags, 0);
    return true;
  } catch (err) {
    console.error('[Native] Keypress simulation failed:', err.message);
    return false;
  }
}

// ── WebSocket Relay Server ──────────────────────────────────
// Track the host's WebSocket client so we can route frames/input correctly
let hostWs = null;

function createWebSocketServer() {
  wss = new WebSocketServer({ host: '0.0.0.0', port: 8765 });

  console.log('[WS] WebSocket relay server listening on ws://localhost:8765');

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[WS] Client connected from ${clientIP}`);

    // The very first local connection (127.0.0.1 / ::1) is the host
    const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';
    if (isLocal && !hostWs) {
      hostWs = ws;
      console.log('[WS] Host client identified');
    }

    // Notify renderer of new peer count
    broadcastPeerCount();

    ws.on('message', (data) => {
      const message = data.toString();

      // Try to parse for special routing
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'screenFrame') {
          // Screen frames from host → send to ALL peers (non-host clients only)
          wss.clients.forEach((client) => {
            if (client !== hostWs && client.readyState === WebSocket.OPEN) {
              client.send(message);
            }
          });
          return; // Don't relay back to host
        }

        if (parsed.type === 'remoteKey' || parsed.type === 'click') {
          // Remote input from peers → send ONLY to host
          if (hostWs && hostWs.readyState === WebSocket.OPEN && ws !== hostWs) {
            hostWs.send(message);
          }
          return;
        }

        if (parsed.type === 'screenShareStatus') {
          // Broadcast screen share status to all peers
          wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(message);
            }
          });
          return;
        }
      } catch (e) {
        // Not JSON — fall through to default relay
      }

      // Default: relay to all OTHER connected clients
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected (${clientIP})`);
      if (ws === hostWs) {
        hostWs = null;
        console.log('[WS] Host client disconnected');
      }
      broadcastPeerCount();
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[WS] Server error:', err.message);
  });
}

function broadcastPeerCount() {
  if (!wss) return;
  const count = wss.clients.size;
  const msg = JSON.stringify({ type: 'peerCount', count });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
  // Also notify renderer via IPC
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('peer-count', count);
  }
}

// ── Electron Window ─────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('index.html');

  // Start with click-through disabled so the user can interact
  mainWindow.setIgnoreMouseEvents(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ────────────────────────────────────────────
ipcMain.handle('toggle-click-through', () => {
  if (!mainWindow) return isClickThrough;
  isClickThrough = !isClickThrough;

  if (isClickThrough) {
    // Enable click-through but keep the side panel interactive
    // forward: true allows mouse events to still be detected for cursor tracking
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }

  console.log(`[IPC] Click-through: ${isClickThrough ? 'ON' : 'OFF'}`);
  return isClickThrough;
});

ipcMain.handle('get-click-through', () => {
  return isClickThrough;
});

ipcMain.handle('get-server-port', () => {
  return 8765;
});

ipcMain.handle('get-local-ip', () => {
  const interfaces = os.networkInterfaces();
  // Collect all non-internal IPv4 addresses with their adapter names
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        candidates.push({ name: name.toLowerCase(), address: iface.address });
      }
    }
  }
  if (candidates.length === 0) return '127.0.0.1';

  // Prefer real Wi-Fi / Ethernet adapters over virtual ones (ZeroTier, Hyper-V, VPN, etc.)
  const preferredKeywords = ['wi-fi', 'wifi', 'wlan', 'ethernet', 'eth'];
  const virtualKeywords = ['zerotier', 'vmware', 'virtualbox', 'hyper-v', 'vethernet', 'docker', 'vbox', 'vpn', 'tunnel'];

  // First: try to find a preferred (physical) adapter
  const preferred = candidates.find(c =>
    preferredKeywords.some(k => c.name.includes(k))
  );
  if (preferred) return preferred.address;

  // Second: pick the first non-virtual adapter
  const nonVirtual = candidates.find(c =>
    !virtualKeywords.some(k => c.name.includes(k))
  );
  if (nonVirtual) return nonVirtual.address;

  // Fallback: return first candidate
  return candidates[0].address;
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Granular control: let renderer toggle ignore-mouse per region
ipcMain.handle('set-ignore-mouse', (_event, ignore, options) => {
  if (!mainWindow) return;
  if (ignore) {
    mainWindow.setIgnoreMouseEvents(true, options || {});
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

// ── Remote Click Simulation ─────────────────────────────────
ipcMain.handle('simulate-click', (_event, x, y, button) => {
  if (!remoteClickEnabled) {
    console.log('[IPC] Remote click blocked — feature disabled');
    return false;
  }
  // Convert window-relative coordinates to screen-absolute coordinates,
  // accounting for Windows DPI scaling (e.g. 125%, 150%)
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scaleFactor = display ? display.scaleFactor : 1;
    const screenX = Math.round((x + bounds.x) * scaleFactor);
    const screenY = Math.round((y + bounds.y) * scaleFactor);
    console.log(`[IPC] Simulating ${button || 'left'} click at screen (${screenX}, ${screenY}) [window: ${x}, ${y}, scale: ${scaleFactor}]`);
    return simulateMouseClick(screenX, screenY, button || 'left');
  }
  return false;
});

ipcMain.handle('toggle-remote-click', () => {
  remoteClickEnabled = !remoteClickEnabled;
  console.log(`[IPC] Remote Click: ${remoteClickEnabled ? 'ON' : 'OFF'}`);
  return remoteClickEnabled;
});

ipcMain.handle('get-remote-click', () => {
  return remoteClickEnabled;
});

// ── Screen Capture ──────────────────────────────────────────
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }, // We don't need thumbnails
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.error('[IPC] Failed to get desktop sources:', err.message);
    return [];
  }
});

ipcMain.handle('toggle-screen-share', () => {
  screenShareEnabled = !screenShareEnabled;
  console.log(`[IPC] Screen Share: ${screenShareEnabled ? 'ON' : 'OFF'}`);
  return screenShareEnabled;
});

ipcMain.handle('get-screen-share', () => {
  return screenShareEnabled;
});

// ── Remote Keyboard Simulation ──────────────────────────────
ipcMain.handle('simulate-keypress', (_event, code, action) => {
  if (!remoteClickEnabled) {
    return false;
  }
  return simulateKeypress(code, action);
});

// ── Screen click simulation with absolute screen coords ─────
ipcMain.handle('simulate-screen-click', (_event, screenXNorm, screenYNorm, button) => {
  if (!remoteClickEnabled) {
    console.log('[IPC] Remote screen click blocked — feature disabled');
    return false;
  }
  // screenXNorm and screenYNorm are 0-1 normalized coordinates
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  const screenX = Math.round(screenXNorm * width * scaleFactor);
  const screenY = Math.round(screenYNorm * height * scaleFactor);
  console.log(`[IPC] Simulating screen click at (${screenX}, ${screenY}) from normalized (${screenXNorm.toFixed(3)}, ${screenYNorm.toFixed(3)})`);
  return simulateMouseClick(screenX, screenY, button || 'left');
});

// ── App Lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  createWebSocketServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wss) {
    wss.close();
    console.log('[WS] Server closed.');
  }
  if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────────────────────
// renderer.js — Phantom Cursor renderer process
// Handles mouse tracking, custom cursor rendering via CSS
// transforms, WebSocket client connection, UI controls,
// remote click simulation, shared editor sync, screen
// mirroring (host capture + peer display), and remote
// keyboard/mouse input relay.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── DOM References ──────────────────────────────────────
  const canvasOverlay = document.getElementById('canvas-overlay');
  const localCursor = document.getElementById('local-cursor');
  const remoteCursor = document.getElementById('remote-cursor');
  const statusDot = document.getElementById('status-dot');
  const connStatus = document.getElementById('connection-status');
  const peerCountEl = document.getElementById('peer-count');
  const localCoordsEl = document.getElementById('local-coords');
  const remoteCoordsEl = document.getElementById('remote-coords');
  const ctStatusEl = document.getElementById('ct-status');
  const ctToggle = document.getElementById('ct-toggle');

  // Connection UI
  const btnHost = document.getElementById('btn-host');
  const btnJoin = document.getElementById('btn-join');
  const hostInfo = document.getElementById('host-info');
  const joinInfo = document.getElementById('join-info');
  const localIpEl = document.getElementById('local-ip');
  const hostIpInput = document.getElementById('host-ip-input');
  const btnConnect = document.getElementById('btn-connect');

  // Buttons
  const btnClickThrough = document.getElementById('btn-click-through');
  const btnRemoteClick = document.getElementById('btn-remote-click');
  const btnScreenShare = document.getElementById('btn-screen-share');
  const btnReconnect = document.getElementById('btn-reconnect');
  const btnMinimize = document.getElementById('btn-minimize');
  const btnClose = document.getElementById('btn-close');

  // Remote Click UI
  const rcStatusEl = document.getElementById('rc-status');
  const rcToggle = document.getElementById('rc-toggle');

  // Screen Share UI
  const ssStatusEl = document.getElementById('ss-status');
  const ssToggle = document.getElementById('ss-toggle');
  const screenMirror = document.getElementById('screen-mirror');
  const screenMirrorContainer = document.getElementById('screen-mirror-container');
  const liveBadge = document.getElementById('live-badge');

  // Shared Editor UI
  const editorToggleHeader = document.getElementById('editor-toggle-header');
  const editorArrow = document.getElementById('editor-arrow');
  const editorContainer = document.getElementById('editor-container');
  const sharedEditor = document.getElementById('shared-editor');
  const charCountEl = document.getElementById('char-count');
  const syncIndicator = document.getElementById('sync-indicator');

  // ── State ───────────────────────────────────────────────
  let ws = null;
  let isClickThrough = false;
  let remoteClickEnabled = false;
  let screenShareEnabled = false;
  let localX = 0, localY = 0;
  let remoteX = 0, remoteY = 0;
  let remoteVisible = false;
  let reconnectTimer = null;
  let sendThrottle = null;
  let serverAddress = 'ws://localhost:8765'; // default to local host mode
  let editorCollapsed = false;
  let isHostMode = true;

  // Screen capture state (host only)
  let captureStream = null;
  let captureVideo = null;
  let captureCanvas = null;
  let captureCtx = null;
  let captureInterval = null;
  const CAPTURE_FPS = 25;
  const JPEG_QUALITY = 0.5;

  // Editor sync state
  let isRemoteUpdate = false;   // flag to prevent echo loops
  let editorDebounce = null;

  // ── Mouse Tracking ─────────────────────────────────────
  canvasOverlay.addEventListener('mousemove', (e) => {
    localX = e.clientX;
    localY = e.clientY;

    // Move local cursor via CSS transform (GPU-accelerated)
    localCursor.style.transform = `translate3d(${localX}px, ${localY}px, 0)`;

    // Update coordinate display
    localCoordsEl.textContent = `${localX}, ${localY}`;

    // Throttled send to WebSocket (every 16ms ≈ 60fps)
    if (!sendThrottle) {
      sendThrottle = requestAnimationFrame(() => {
        sendCursorPosition(localX, localY);
        sendThrottle = null;
      });
    }
  });

  // Show local cursor only when mouse is over the overlay
  canvasOverlay.addEventListener('mouseenter', () => {
    localCursor.style.opacity = '1';
  });

  canvasOverlay.addEventListener('mouseleave', () => {
    localCursor.style.opacity = '0';
  });

  // ── Remote Click — Send click from peer ────────────────
  canvasOverlay.addEventListener('click', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // If peer mode and screen mirror is visible, send normalized coords
      if (!isHostMode && screenMirror.style.display !== 'none') {
        const rect = screenMirror.getBoundingClientRect();
        const xNorm = (e.clientX - rect.left) / rect.width;
        const yNorm = (e.clientY - rect.top) / rect.height;
        if (xNorm >= 0 && xNorm <= 1 && yNorm >= 0 && yNorm <= 1) {
          ws.send(JSON.stringify({
            type: 'click',
            xNorm,
            yNorm,
            button: 'left',
            isScreenClick: true,
          }));
          return;
        }
      }
      ws.send(JSON.stringify({
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        button: 'left',
      }));
    }
  });

  canvasOverlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!isHostMode && screenMirror.style.display !== 'none') {
        const rect = screenMirror.getBoundingClientRect();
        const xNorm = (e.clientX - rect.left) / rect.width;
        const yNorm = (e.clientY - rect.top) / rect.height;
        if (xNorm >= 0 && xNorm <= 1 && yNorm >= 0 && yNorm <= 1) {
          ws.send(JSON.stringify({
            type: 'click',
            xNorm,
            yNorm,
            button: 'right',
            isScreenClick: true,
          }));
          return;
        }
      }
      ws.send(JSON.stringify({
        type: 'click',
        x: e.clientX,
        y: e.clientY,
        button: 'right',
      }));
    }
  });

  // ── Click Ripple Visual Feedback ───────────────────────
  function showClickRipple(x, y) {
    const ripple = document.createElement('div');
    ripple.classList.add('click-ripple');
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    canvasOverlay.appendChild(ripple);

    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });
  }

  // ── Remote Cursor Rendering ────────────────────────────
  function updateRemoteCursor(x, y) {
    remoteX = x;
    remoteY = y;

    // Smooth transform-based movement
    remoteCursor.style.transform = `translate3d(${remoteX}px, ${remoteY}px, 0)`;

    // Update coordinate display
    remoteCoordsEl.textContent = `${Math.round(remoteX)}, ${Math.round(remoteY)}`;

    // Show remote cursor if hidden
    if (!remoteVisible) {
      remoteVisible = true;
      remoteCursor.classList.add('visible');
    }
  }

  function hideRemoteCursor() {
    remoteVisible = false;
    remoteCursor.classList.remove('visible');
    remoteCoordsEl.textContent = '—, —';
  }

  // ── WebSocket Client ───────────────────────────────────
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }

    setConnectionState('connecting');

    ws = new WebSocket(serverAddress);

    ws.addEventListener('open', () => {
      console.log('[WS] Connected to relay server');
      setConnectionState('online');
      clearReconnectTimer();

      // If host and screen share is on, notify peers
      if (isHostMode && screenShareEnabled) {
        ws.send(JSON.stringify({ type: 'screenShareStatus', active: true }));
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'cursor') {
          updateRemoteCursor(data.x, data.y);

        } else if (data.type === 'click') {
          if (isHostMode) {
            // Host receives click from peer
            showClickRipple(data.x || 0, data.y || 0);
            if (remoteClickEnabled) {
              if (data.isScreenClick) {
                // Normalized screen coordinates
                window.phantomAPI.simulateScreenClick(data.xNorm, data.yNorm, data.button || 'left');
              } else {
                window.phantomAPI.simulateClick(data.x, data.y, data.button || 'left');
              }
            }
          } else {
            // Peer mode — just show ripple
            showClickRipple(data.x || 0, data.y || 0);
          }

        } else if (data.type === 'remoteKey') {
          // Host receives keyboard input from peer
          if (isHostMode && remoteClickEnabled) {
            window.phantomAPI.simulateKeypress(data.code, data.action);
          }

        } else if (data.type === 'screenFrame') {
          // Peer receives screen frame from host
          if (!isHostMode) {
            screenMirror.src = data.data;
            if (screenMirror.style.display === 'none') {
              screenMirror.style.display = 'block';
              screenMirrorContainer.classList.add('active');
              liveBadge.style.display = 'flex';
            }
          }

        } else if (data.type === 'screenShareStatus') {
          // Peer learns screen share state changed
          if (!isHostMode) {
            if (data.active) {
              screenMirrorContainer.classList.add('active');
              liveBadge.style.display = 'flex';
            } else {
              screenMirror.style.display = 'none';
              screenMirrorContainer.classList.remove('active');
              liveBadge.style.display = 'none';
            }
          }

        } else if (data.type === 'editor') {
          // Remote editor update — apply without re-broadcasting
          handleRemoteEditorUpdate(data);

        } else if (data.type === 'peerCount') {
          peerCountEl.textContent = data.count;

        } else if (data.type === 'leave') {
          hideRemoteCursor();
          if (!isHostMode) {
            screenMirror.style.display = 'none';
            screenMirrorContainer.classList.remove('active');
            liveBadge.style.display = 'none';
          }
        }
      } catch (err) {
        console.warn('[WS] Failed to parse message:', err);
      }
    });

    ws.addEventListener('close', () => {
      console.log('[WS] Connection closed');
      setConnectionState('offline');
      hideRemoteCursor();
      scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      console.error('[WS] Error:', err);
      setConnectionState('offline');
    });
  }

  function sendCursorPosition(x, y) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cursor', x, y }));
    }
  }

  function setConnectionState(state) {
    statusDot.className = 'status-indicator';

    switch (state) {
      case 'online':
        statusDot.classList.add('online');
        connStatus.textContent = 'Connected';
        break;
      case 'offline':
        statusDot.classList.add('offline');
        connStatus.textContent = 'Disconnected';
        break;
      case 'connecting':
      default:
        connStatus.textContent = 'Connecting…';
        break;
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      console.log('[WS] Attempting reconnect…');
      connectWebSocket();
    }, 3000);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // ── Screen Capture (Host Mode) ─────────────────────────
  async function startScreenCapture() {
    try {
      // Get desktop sources
      const sources = await window.phantomAPI.getDesktopSources();
      if (!sources || sources.length === 0) {
        console.error('[Screen] No desktop sources available');
        return false;
      }

      // Use the first screen source
      const sourceId = sources[0].id;
      console.log(`[Screen] Using source: ${sources[0].name} (${sourceId})`);

      // Request the screen capture stream
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: CAPTURE_FPS,
          },
        },
      });

      // Create a hidden video element to receive the stream
      captureVideo = document.createElement('video');
      captureVideo.srcObject = captureStream;
      captureVideo.style.display = 'none';
      document.body.appendChild(captureVideo);
      await captureVideo.play();

      // Create a canvas for frame extraction
      captureCanvas = document.createElement('canvas');
      captureCtx = captureCanvas.getContext('2d');

      // Start the frame capture loop
      captureInterval = setInterval(() => {
        if (!captureVideo || captureVideo.readyState < 2) return;

        // Size the canvas to match the video
        captureCanvas.width = captureVideo.videoWidth;
        captureCanvas.height = captureVideo.videoHeight;

        // Draw the video frame
        captureCtx.drawImage(captureVideo, 0, 0);

        // Encode as JPEG and send
        const frameData = captureCanvas.toDataURL('image/jpeg', JPEG_QUALITY);

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'screenFrame',
            data: frameData,
          }));
        }
      }, 1000 / CAPTURE_FPS);

      // Notify peers
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'screenShareStatus', active: true }));
      }

      console.log(`[Screen] Capture started at ${CAPTURE_FPS} FPS`);
      return true;
    } catch (err) {
      console.error('[Screen] Failed to start capture:', err);
      return false;
    }
  }

  function stopScreenCapture() {
    if (captureInterval) {
      clearInterval(captureInterval);
      captureInterval = null;
    }
    if (captureStream) {
      captureStream.getTracks().forEach(t => t.stop());
      captureStream = null;
    }
    if (captureVideo) {
      captureVideo.pause();
      captureVideo.srcObject = null;
      captureVideo.remove();
      captureVideo = null;
    }
    captureCanvas = null;
    captureCtx = null;

    // Notify peers
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'screenShareStatus', active: false }));
    }

    console.log('[Screen] Capture stopped');
  }

  // ── Remote Keyboard Capture (Peer Mode) ────────────────
  // When the peer presses keys while the canvas is focused, relay to host
  function handlePeerKeyDown(e) {
    // Don't capture if typing in an input or the shared editor
    if (document.activeElement === sharedEditor ||
        document.activeElement === hostIpInput ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
      return;
    }

    // Don't capture our own keyboard shortcuts
    if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'R' || e.key === 'S')) {
      return;
    }
    // Don't capture Escape
    if (e.key === 'Escape') return;

    if (!isHostMode && ws && ws.readyState === WebSocket.OPEN && screenMirror.style.display !== 'none') {
      e.preventDefault();
      e.stopPropagation();
      ws.send(JSON.stringify({
        type: 'remoteKey',
        code: e.code,
        key: e.key,
        action: 'down',
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      }));
    }
  }

  function handlePeerKeyUp(e) {
    if (document.activeElement === sharedEditor ||
        document.activeElement === hostIpInput ||
        document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') {
      return;
    }

    if (!isHostMode && ws && ws.readyState === WebSocket.OPEN && screenMirror.style.display !== 'none') {
      e.preventDefault();
      e.stopPropagation();
      ws.send(JSON.stringify({
        type: 'remoteKey',
        code: e.code,
        key: e.key,
        action: 'up',
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      }));
    }
  }

  document.addEventListener('keydown', handlePeerKeyDown, true);
  document.addEventListener('keyup', handlePeerKeyUp, true);

  // ── Shared Editor Sync ─────────────────────────────────
  sharedEditor.addEventListener('input', () => {
    // Update char count
    charCountEl.textContent = `${sharedEditor.value.length} chars`;

    // Skip broadcast if this change came from the remote peer
    if (isRemoteUpdate) return;

    // Show syncing state
    syncIndicator.className = 'sync-indicator syncing';

    // Debounce: send after 100ms of inactivity
    clearTimeout(editorDebounce);
    editorDebounce = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'editor',
          text: sharedEditor.value,
          cursorPos: sharedEditor.selectionStart,
          ts: Date.now(),
        }));
      }
      // Mark as synced
      syncIndicator.className = 'sync-indicator synced';
    }, 100);
  });

  function handleRemoteEditorUpdate(data) {
    // Save local cursor position
    const localCursorPos = sharedEditor.selectionStart;
    const localLen = sharedEditor.value.length;

    // Set flag to prevent re-broadcast
    isRemoteUpdate = true;
    sharedEditor.value = data.text;
    charCountEl.textContent = `${sharedEditor.value.length} chars`;

    // Try to preserve local cursor position
    const newLen = sharedEditor.value.length;
    const delta = newLen - localLen;
    const adjustedPos = Math.min(localCursorPos + (localCursorPos >= data.cursorPos ? delta : 0), newLen);
    sharedEditor.setSelectionRange(adjustedPos, adjustedPos);

    isRemoteUpdate = false;

    // Flash sync indicator
    syncIndicator.className = 'sync-indicator synced';
  }

  // ── Editor Collapse Toggle ─────────────────────────────
  editorToggleHeader.addEventListener('click', () => {
    editorCollapsed = !editorCollapsed;
    editorContainer.classList.toggle('collapsed', editorCollapsed);
    editorArrow.classList.toggle('collapsed', editorCollapsed);
  });

  // ── UI Controls ────────────────────────────────────────
  const sidePanel = document.getElementById('side-panel');

  btnClickThrough.addEventListener('click', async () => {
    const newState = await window.phantomAPI.toggleClickThrough();
    isClickThrough = newState;
    ctStatusEl.textContent = isClickThrough ? 'ON' : 'OFF';
    ctToggle.classList.toggle('active', isClickThrough);

    // If we just turned click-through ON, enable it now
    if (isClickThrough) {
      window.phantomAPI.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // ── Remote Click Toggle ────────────────────────────────
  btnRemoteClick.addEventListener('click', async () => {
    const newState = await window.phantomAPI.toggleRemoteClick();
    remoteClickEnabled = newState;
    rcStatusEl.textContent = remoteClickEnabled ? 'ON' : 'OFF';
    rcToggle.classList.toggle('active', remoteClickEnabled);
  });

  // ── Screen Share Toggle ────────────────────────────────
  btnScreenShare.addEventListener('click', async () => {
    const newState = await window.phantomAPI.toggleScreenShare();
    screenShareEnabled = newState;
    ssStatusEl.textContent = screenShareEnabled ? 'ON' : 'OFF';
    ssToggle.classList.toggle('active', screenShareEnabled);

    if (screenShareEnabled && isHostMode) {
      await startScreenCapture();
    } else {
      stopScreenCapture();
    }
  });

  // ── Side-panel hover: keep panel interactive during click-through ──
  // When click-through is ON and the mouse enters the panel region,
  // temporarily make the window accept mouse events so buttons work.
  sidePanel.addEventListener('mouseenter', () => {
    if (isClickThrough) {
      window.phantomAPI.setIgnoreMouseEvents(false);
    }
  });

  sidePanel.addEventListener('mouseleave', () => {
    if (isClickThrough) {
      window.phantomAPI.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  btnReconnect.addEventListener('click', () => {
    connectWebSocket();
  });

  // ── Host / Join Mode ────────────────────────────────────
  btnHost.addEventListener('click', () => {
    isHostMode = true;
    btnHost.classList.add('active');
    btnJoin.classList.remove('active');
    hostInfo.style.display = '';
    joinInfo.style.display = 'none';
    serverAddress = 'ws://localhost:8765';

    // Hide screen mirror (host doesn't need it)
    screenMirror.style.display = 'none';
    screenMirrorContainer.classList.remove('active');
    liveBadge.style.display = 'none';

    // Show screen share button (host only)
    btnScreenShare.style.display = '';

    connectWebSocket();
  });

  btnJoin.addEventListener('click', () => {
    isHostMode = false;
    btnJoin.classList.add('active');
    btnHost.classList.remove('active');
    hostInfo.style.display = 'none';
    joinInfo.style.display = '';

    // Stop screen capture if it was running
    if (screenShareEnabled) {
      stopScreenCapture();
    }

    // Hide screen share toggle for peers (host controls this)
    btnScreenShare.style.display = 'none';
  });

  btnConnect.addEventListener('click', () => {
    const ip = hostIpInput.value.trim();
    if (!ip) return;
    serverAddress = `ws://${ip}:8765`;
    connectWebSocket();
  });

  hostIpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnConnect.click();
  });

  btnMinimize.addEventListener('click', () => {
    window.phantomAPI.minimizeWindow();
  });

  btnClose.addEventListener('click', () => {
    // Stop screen capture if running
    stopScreenCapture();

    // Notify peers we're leaving
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave' }));
    }
    window.phantomAPI.closeWindow();
  });

  // Listen for peer count updates from main process
  window.phantomAPI.onPeerCount((count) => {
    peerCountEl.textContent = count;
  });

  // ── Keyboard Shortcut ──────────────────────────────────
  // Note: Peer keyboard relay is handled in handlePeerKeyDown/handlePeerKeyUp above
  // These shortcuts work for both host and peer
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+P — toggle click-through
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      btnClickThrough.click();
    }
    // Ctrl+Shift+R — toggle remote click
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      btnRemoteClick.click();
    }
    // Ctrl+Shift+S — toggle screen share (host only)
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      if (isHostMode) btnScreenShare.click();
    }
    // Escape — close app (only if editor not focused)
    if (e.key === 'Escape' && document.activeElement !== sharedEditor) {
      btnClose.click();
    }
  });

  // ── Initialize ─────────────────────────────────────────
  async function init() {
    // Hide cursors initially
    localCursor.style.opacity = '0';
    remoteCursor.classList.remove('visible');

    // Hide screen mirror initially
    screenMirror.style.display = 'none';
    liveBadge.style.display = 'none';

    // Fetch and display local IP
    try {
      const ip = await window.phantomAPI.getLocalIP();
      localIpEl.textContent = ip;
    } catch (e) {
      localIpEl.textContent = 'Unknown';
    }

    // Connect to WebSocket relay
    connectWebSocket();

    console.log('[Phantom] Renderer initialized');
  }

  init();
})();

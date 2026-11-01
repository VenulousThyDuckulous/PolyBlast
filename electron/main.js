/**
 * Desktop shell for PolyBlast.
 *
 * The game itself is unchanged: this process starts the same HTTP + WebSocket server in-process and
 * points a native window at it, so the exact client that runs in a browser runs here too. Running the
 * server in-process (rather than as a child process) means one process to launch, no port polling and
 * no orphaned servers on quit.
 */

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { startServer, stopServer } from '../server/index.js';

const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const WINDOW_BACKGROUND = '#0b0e14';

let mainWindow = null;
let gameServer = null;
let quitting = false;

/** Bind the game server, falling back to a free port if the preferred one is taken. */
async function bootServer() {
  try {
    return await startServer(PREFERRED_PORT);
  } catch (err) {
    if (err && err.code !== 'EADDRINUSE') throw err;
    console.warn(`[polyblast] port ${PREFERRED_PORT} is in use; starting on a free port instead`);
    return startServer(0);
  }
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: WINDOW_BACKGROUND,
    title: 'PolyBlast',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      // The client is an ordinary web page talking to the local server over HTTP and WebSocket.
      // It needs no Node access, so the renderer stays fully sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show only once the first frame is ready, so there is no white flash before the 3D scene.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // No popup windows: anything that tries to open externally goes to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.loadURL(url);
}

app.setName('PolyBlast');

app.whenReady().then(async () => {
  // Mouse look needs pointer lock. Grant only that, not the whole permission set.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'pointerLock');
  });

  try {
    gameServer = await bootServer();
  } catch (err) {
    dialog.showErrorBox('PolyBlast could not start', `The game server failed to start:\n\n${err.message}`);
    app.quit();
    return;
  }

  createWindow(gameServer.url);

  // macOS: clicking the dock icon with no windows open reopens the game.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(gameServer.url);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Close the port cleanly before exiting so a relaunch never finds it wedged. The timeout is a
// backstop: quitting must never hang on a stuck socket drain.
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (!gameServer) return;
  event.preventDefault();
  Promise.race([stopServer().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]).finally(
    () => app.exit(0),
  );
});

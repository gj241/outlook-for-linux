const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');

// Per-`webContents` first-try tracking. A module-level boolean would lie once
// account switching exists: account B's first 401 would look like account A's
// retry and trigger an app relaunch. Keying by `webContents` keeps each
// window's challenge state isolated; the WeakMap drops entries when a view is
// destroyed.
const firstLoginTryByWebContents = new WeakMap();

// Single `submitForm` listener registered once at module load; dispatches to
// the currently-open login dialog via this pointer. Avoids per-dialog
// registration churn (the old code registered a new listener on every dialog
// and never removed it, leaking handlers that fired on destroyed windows).
let activeLoginHandler = null;
let handlersRegistered = false;

function ensureIpcHandlers() {
	if (handlersRegistered) {
		return;
	}
	handlersRegistered = true;
	ipcMain.on('submitForm', (event, data) => {
		if (activeLoginHandler) {
			activeLoginHandler(data);
		}
	});
}

exports.loginService = function loginService(parentWindow, callback) {
	ensureIpcHandlers();

	const win = new BrowserWindow({
		width: 363,
		height: 124,
		modal: true,
		frame: false,
		parent: parentWindow,

		show: false,
		autoHideMenuBar: true,
		// Defaults: contextIsolation true, nodeIntegration false, sandbox true.
		// The form talks to main only via the contextBridge `api` in preload.js.
		webPreferences: {
			preload: path.join(__dirname, 'preload.js')
		}
	});

	win.once('ready-to-show', () => {
		win.show();
	});

	activeLoginHandler = (data) => {
		callback(data.username, data.password);
		win.close();
	};

	win.on('closed', () => {
		activeLoginHandler = null;
	});

	win.loadURL(`file://${__dirname}/login.html`);
};

exports.handleLoginDialogTry = function handleLoginDialogTry(window) {
	window.webContents.on('login', (event, request, authInfo, callback) => {
		event.preventDefault();
		const wc = window.webContents;
		const isFirstLoginTry = !firstLoginTryByWebContents.has(wc);
		if (isFirstLoginTry) {
			firstLoginTryByWebContents.set(wc, true);
			this.loginService(window, callback);
		} else {
			// Auth failed after we already closed the login browser window —
			// relaunch the app as we can't recover the session otherwise.
			app.relaunch();
			app.exit(0);
		}
	});
};
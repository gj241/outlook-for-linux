const { shell, BrowserWindow, app, nativeTheme, dialog } = require('electron');
const isDarkMode = nativeTheme.shouldUseDarkColors;
const windowStateKeeper = require('electron-window-state');
const path = require('path');
const login = require('../login');
const Menus = require('../menus');
const { LucidLog } = require('lucid-log');
const { execFile } = require('child_process');
const TrayIconChooser = require('../browser/tools/trayIconChooser');
const accountManager = require('../accountManager');

/**
 * @type {TrayIconChooser}
 */
let iconChooser;

/**
 * @type {LucidLog}
 */
let logger;

let config;

/**
 * Shared window-state keeper so every account window shares the same
 * bounds (the app feels like one window that swaps content).
 */
let windowState;

/**
 * Create a BrowserWindow for an account on its own partition. All event
 * handlers are closed over this specific window. The window is not shown and
 * no URL is loaded here — the ConnectionManager (owned by AccountManager)
 * loads the URL, and AccountManager controls visibility.
 *
 * @param {{id: string, name: string, partition: string}} account
 * @param {import('../accountManager')} accountManager
 * @returns {Electron.BrowserWindow}
 */
function createWindow(account, accountManager) {
	const win = createNewBrowserWindow(account.partition);

	windowState.manage(win);

	win.eval = global.eval = function () { // eslint-disable-line no-eval
		throw new Error('Sorry, this app does not support window.eval().');
	};

	win.webContents.setUserAgent(config.chromeUserAgent);

	// Per-window state (previously module-level globals).
	let aboutBlankRequestCount = 0;
	let isControlPressed = false;

	win.webContents.setWindowOpenHandler(onNewWindow);
	win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*'] }, onBeforeRequestHandler);
	login.handleLoginDialogTry(win);
	win.webContents.addListener('before-input-event', (event, input) => {
		isControlPressed = input.control;
	});

	win.on('close', (event) => {
		if (accountManager.allowQuit) {
			return; // let the window close as part of quitting
		}
		if (config.closeAppOnCross) {
			event.preventDefault();
			accountManager.quitAll();
			return;
		}
		event.preventDefault();
		win.hide();
	});

	win.on('closed', () => accountManager.handleWindowClosed(account.id));

	/**
	 * @param {Electron.OnBeforeRequestListenerDetails} details
	 * @param {Electron.CallbackResponse} callback
	 */
	function onBeforeRequestHandler(details, callback) {
		// Only claim the pending "open in new window" slot for the actual
		// page navigation that follows a denied about:blank popup
		// (resourceType 'mainFrame'). Unrelated background requests
		// (lazy-loaded script chunks, XHR/fetch, images, etc.) must not be
		// hijacked and opened externally — otherwise double-clicking a
		// message or breaking out a compose window can open the system
		// browser on a raw .js asset URL instead of the mail item.
		// (Ported from upstream PR #23 by thelad-dev, fixing #15.)
		if (aboutBlankRequestCount < 1 || details.resourceType !== 'mainFrame') {
			callback({});
		} else if (isSafeExternalUrl(details.url)) {
			logger.debug('DEBUG - webRequest to  ' + details.url + ' intercepted!');
			shell.openExternal(details.url);
			aboutBlankRequestCount -= 1;
			callback({ cancel: true });
		} else {
			// Non-http(s) target after a denied about:blank popup — don't hand
			// it to the system browser (could be file://, smb://, etc.).
			logger.debug('Refusing to open non-http(s) URL externally: ' + details.url);
			aboutBlankRequestCount -= 1;
			callback({ cancel: true });
		}
	}

	/**
	 * @param {Electron.HandlerDetails} details
	 */
	function onNewWindow(details) {
		if (details.url === 'about:blank' || details.url === 'about:blank#blocked') {
			aboutBlankRequestCount += 1;
			logger.debug('DEBUG - captured about:blank');
			return { action: 'deny' };
		}
		return secureOpenLink(details);
	}

	/**
	 * @param {Electron.HandlerDetails} details
	 */
	function secureOpenLink(details) {
		logger.debug(`Requesting to open '${details.url}'`);
		const action = getLinkAction();

		if (action === 0) {
			openInBrowser(details);
		}

		const returnValue = action === 1 ? {
			action: 'allow',
			overrideBrowserWindowOptions: {
				modal: true,
				useContentSize: true,
				parent: win
			}
		} : { action: 'deny' };

		if (action === 1) {
			removePopupWindowMenu();
		}

		return returnValue;
	}

	function openInBrowser(details) {
		if (!isSafeExternalUrl(details.url)) {
			logger.debug('Refusing to open non-http(s) URL externally: ' + details.url);
			return;
		}
		if (config.defaultURLHandler.trim() !== '') {
			execFile(config.defaultURLHandler.trim(), [details.url], openInBrowserErrorHandler);
		} else {
			shell.openExternal(details.url);
		}
	}

	function openInBrowserErrorHandler(error) {
		if (error) {
			logger.error(error.message);
		}
	}

	function getLinkAction() {
		const action = isControlPressed ? dialog.showMessageBoxSync(win, {
			type: 'warning',
			buttons: ['Allow', 'Deny'],
			title: 'Open URL',
			normalizeAccessKeys: true,
			defaultId: 1,
			cancelId: 1,
			message: 'This will open the URL in the application context. If this is for SSO, click Allow otherwise Deny.'
		}) + 1 : 0;

		isControlPressed = false;
		return action;
	}

	async function removePopupWindowMenu() {
		for (var i = 1; i <= 200; i++) {
			await sleep(10);
			const childWindows = win.getChildWindows();
			if (childWindows.length) {
				childWindows[0].removeMenu();
				break;
			}
		}
		return;
	}

	return win;
}

exports.createWindow = createWindow;

/**
 * @param {import('../appConfiguration').AppConfiguration} mainConfig
 */
exports.onAppReady = async function onAppReady(mainConfig) {
	config = mainConfig.startupConfig;
	iconChooser = new TrayIconChooser(mainConfig.startupConfig);
	logger = new LucidLog({
		levels: config.appLogLevels.split(',')
	});

	windowState = windowStateKeeper({
		defaultWidth: 0,
		defaultHeight: 0,
	});

	accountManager.init(mainConfig, { config, iconChooser, logger });

	// App-level certificate import (once).
	if (typeof config.clientCertPath !== 'undefined' && config.clientCertPath !== '') {
		app.importCertificate({ certificate: config.clientCertPath, password: config.clientCertPassword }, (result) => {
			logger.info('Loaded certificate: ' + config.clientCertPath + ', result: ' + result);
		});
	}

	new Menus(accountManager, config, iconChooser.getFile());

	await accountManager.showActive();
};

exports.onAppSecondInstance = function onAppSecondInstance(event, args) {
	logger.debug('second-instance started');
	const active = accountManager.getActive();
	if (active.window) {
		event.preventDefault();
		const url = processArgs(args);
		if (url) {
			active.window.loadURL(url, { userAgent: config.chromeUserAgent });
		}
		restoreWindow(active.window);
	}
};

/**
 * Parse args for an Outlook URL to load.
 * @param {string[]} args
 * @returns {string|undefined}
 */
function processArgs(args) {
	var regHttps = /^https:\/\/outlook.microsoft.com\/l\/(meetup-join|channel)\//g;
	var regMS = /^msoutlook:\/l\/(meetup-join|channel)\//g;
	logger.debug('processArgs:', args);
	for (const arg of args) {
		if (regHttps.test(arg)) {
			logger.debug('A url argument received with https protocol');
			return arg;
		}
		if (regMS.test(arg)) {
			logger.debug('A url argument received with msoutlook protocol');
			return config.url + arg.substring(8, arg.length);
		}
	}
}

function restoreWindow(win) {
	if (win.isMinimized()) {
		win.restore();
	} else if (!win.isVisible()) {
		win.show();
	}
	win.focus();
}

/**
 * Only http(s) URLs may be handed to the system browser / external handler.
 * Everything else (file://, smb://, custom schemes) is denied to avoid
 * launching unexpected apps or opening local resources.
 * @param {string} url
 * @returns {boolean}
 */
function isSafeExternalUrl(url) {
	return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function createNewBrowserWindow(partition) {
	return new BrowserWindow({
		title: 'Outlook for Linux',
		x: windowState.x,
		y: windowState.y,

		width: windowState.width,
		height: windowState.height,
		backgroundColor: isDarkMode ? '#302a75' : '#fff',

		show: false,
		autoHideMenuBar: config.menubar == 'auto',
		icon: iconChooser.getFile(),

		webPreferences: {
			partition: partition,
			preload: path.join(__dirname, '..', 'browser', 'index.js'),
			plugins: true,
			contextIsolation: false,
			nodeIntegration: false,
			sandbox: false,
			spellcheck: false
		},
	});
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}
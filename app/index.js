const { app, ipcMain, Notification } = require('electron');
const path = require('path');
const { LucidLog } = require('lucid-log');
const isDev = require('electron-is-dev');
if (app.commandLine.hasSwitch('customUserDir')) {
	app.setPath('userData', app.commandLine.getSwitchValue('customUserDir'));
} else if (isDev) {
	// Raw `electron ./app` defaults app.name to "Electron", so existing data
	// (login sessions, app.accounts) lives in ~/.config/Electron. Pin it there
	// before rebranding app.name below, so the data dir doesn't move and logins
	// aren't lost. Packaged builds use ~/.config/outlook-for-linux already.
	app.setPath('userData', path.join(app.getPath('appData'), 'Electron'));
}

const { AppConfiguration } = require('./appConfiguration');
const appConfig = new AppConfiguration(app.getPath('userData'));

const config = appConfig.startupConfig;
config.appPath = path.join(__dirname, isDev ? '' : '../../');

// Brand the app so the Linux dock and notifications resolve to
// "Outlook for Linux" (via the outlook-for-linux.desktop file) instead of the
// default "Electron". The app_id / WM_CLASS must match the .desktop
// StartupWMClass, so use a lowercase hyphenated name (no spaces — a spaced
// app_id is invalid and GNOME falls back to the binary name "electron").
app.name = 'outlook-for-linux';
if (typeof app.setDesktopName === 'function') {
	app.setDesktopName('outlook-for-linux');
}

// Icon used on new-mail notifications (same asset as the tray icon).
const TrayIconChooser = require('./browser/tools/trayIconChooser');
const notificationIcon = new TrayIconChooser(config).getFile();

const logger = new LucidLog({
	levels: config.appLogLevels.split(',')
});

const notificationSounds = [{
	type: 'new-message',
	file: path.join(config.appPath, 'assets/sounds/new_message.wav')
}];

// Notification sound player. Portable execFile-based player (no native
// module to rebuild across Electron upgrades); see app/audio/player.js.
const { createPlayer } = require('./audio/player');
const player = createPlayer();

const certificateModule = require('./certificate');
const gotTheLock = app.requestSingleInstanceLock();
const mainAppWindow = require('./mainAppWindow');
const accountManager = require('./accountManager');

if (config.proxyServer) app.commandLine.appendSwitch('proxy-server', config.proxyServer);
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('enable-ntlm-v2', config.ntlmV2enabled);
app.commandLine.appendSwitch('try-supported-channel-layouts');

if (process.env.XDG_SESSION_TYPE === 'wayland') {
	logger.info('Running under Wayland, switching to PipeWire...');

	const features = app.commandLine.hasSwitch('enable-features') ? app.commandLine.getSwitchValue('enable-features').split(',') : [];
	if (!features.includes('WebRTCPipeWireCapturer'))
		features.push('WebRTCPipeWireCapturer');

	app.commandLine.appendSwitch('enable-features', features.join(','));
	app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const protocolClient = 'msoutlook';
if (!app.isDefaultProtocolClient(protocolClient, process.execPath)) {
	app.setAsDefaultProtocolClient(protocolClient, process.execPath);
}

if (!gotTheLock) {
	logger.info('App already running');
	app.quit();
} else {
	app.on('second-instance', mainAppWindow.onAppSecondInstance);
	app.on('ready', handleAppReady);
	app.on('quit', () => logger.debug('quit'));
	app.on('render-process-gone', onRenderProcessGone);
	app.on('will-quit', () => logger.debug('will-quit'));
	app.on('certificate-error', handleCertificateError);
	ipcMain.handle('getConfig', handleGetConfig);
	ipcMain.handle('getZoomLevel', handleGetZoomLevel);
	ipcMain.handle('saveZoomLevel', handleSaveZoomLevel);
	ipcMain.handle('play-notification-sound', playNotificationSound);
	ipcMain.handle('set-badge-count', setBadgeCountHandler);
	ipcMain.handle('accounts:get', handleAccountsGet);
	ipcMain.on('accounts:switch', handleAccountsSwitch);
	ipcMain.on('accounts:add', handleAccountsAdd);
	ipcMain.on('accounts:remove', handleAccountsRemove);
	ipcMain.on('accounts:rename', handleAccountsRename);
	ipcMain.on('new-mail', handleNewMail);
}

// eslint-disable-next-line no-unused-vars
async function playNotificationSound(event, options) {
	logger.debug(`Notificaion => Type: ${options.type}, Audio: ${options.audio}, Title: ${options.title}, Body: ${options.body}`);
	// Player failed to load or notification sound disabled in config
	if (!player || config.disableNotificationSound) {
		logger.debug('Notification sounds are disabled');
		return;
	}
	
	const sound = notificationSounds.filter(ns => {
		return ns.type === options.type;
	})[0];

	if (sound) {
		logger.debug(`Playing file: ${sound.file}`);
		try {
			await player.play(sound.file);
		} catch (e) {
			logger.debug(`Failed to play notification sound: ${e.message}`);
		}
		return;
	}

	logger.debug('No notification sound played', player, options);
}

// Last render-process-gone time per webContents, to avoid a reload loop if a
// renderer crash is deterministic (e.g. a sandbox issue on a given partition).
const _lastRenderCrash = new WeakMap();

function onRenderProcessGone(event, webContents, details) {
	logger.error(`render-process-gone: ${JSON.stringify(details)}`);
	// A single account's renderer crashing must not take down the whole app:
	// the other account windows and the tray should survive. Try to recover
	// the crashed window by reloading it (which spins up a fresh renderer),
	// but refuse to reload the same webContents more than once within 10s so
	// a deterministic crash can't loop. If the window can't be recovered, the
	// user can still switch away and back (AccountManager recreates it) or hit
	// Refresh (tray / Ctrl+R), which calls connMgr.refresh() -> reload.
	if (!webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed()) {
		return;
	}
	const now = Date.now();
	const last = _lastRenderCrash.get(webContents) || 0;
	if (now - last < 10000) {
		logger.debug('render-process-gone: recent crash, not reloading (avoid loop)');
		return;
	}
	_lastRenderCrash.set(webContents, now);
	try {
		webContents.reload();
	} catch (e) {
		logger.debug(`render-process-gone: reload failed: ${e.message}`);
	}
}

function onAppTerminated(signal) {
	if (signal === 'SIGTERM') {
		process.abort();
	} else {
		app.quit();
	}
}

function handleAppReady() {
	process.on('SIGTRAP', onAppTerminated);
	process.on('SIGINT', onAppTerminated);
	process.on('SIGTERM', onAppTerminated);
	//Just catch the error
	process.stdout.on('error', () => { });
	mainAppWindow.onAppReady(appConfig);
}

async function handleGetConfig(event) {
	// Key per-window config (e.g. zoom level) by the account's own partition
	// so each account remembers its own zoom.
	const partition = accountManager.partitionForWebContents(event.sender);
	if (partition && partition !== config.partition) {
		return Object.assign({}, config, { partition });
	}
	return config;
}

async function handleAccountsGet(event) {
	return accountManager.getStateForWebContents(event.sender);
}

function handleAccountsSwitch(event, id) {
	accountManager.switchTo(id);
}

function handleAccountsAdd() {
	accountManager.addAccount();
}

function handleAccountsRemove(event, id) {
	accountManager.removeAccount(id);
}

function handleAccountsRename(event, arg) {
	accountManager.renameAccount(arg.id, arg.name);
}

/**
 * New mail arrived in one of the account windows (detected by the
 * mailNotifications preload watching the page title's unread count). Show a
 * native desktop notification addressed to that account and play the new-mail
 * sound, unless notifications are disabled in config. Clicking the
 * notification focuses that account's window.
 *
 * @param {Electron.IpcRendererEvent} event
 * @param {{count: number, delta: number}} arg
 */
function handleNewMail(event, arg) {
	if (!config.notifyOnNewMail || config.disableNotifications) {
		return;
	}
	const account = accountManager.getAccountByWebContents(event.sender);
	const name = account ? account.name : 'Outlook';
	const count = (arg && arg.count) || 1;
	const body = count === 1 ? 'You have a new email' : 'You have ' + count + ' unread emails';

	showDesktopNotification(name, body, account);

	// Play the new-mail sound through the existing player (respects
	// disableNotificationSound internally).
	playNotificationSound(event, { type: 'new-message', audio: 'default', title: name, body: '' });
}

/**
 * Show a new-mail desktop notification. Uses `notify-send` directly so we
 * control the app name, icon, and `desktop-entry` hint — Electron's
 * main-process Notification doesn't send the desktop-entry hint on Linux, so
 * GNOME falls back to the binary name "electron". With the desktop-entry hint
 * set to `outlook-for-linux`, GNOME resolves the name ("Outlook for Linux")
 * and icon from outlook-for-linux.desktop. Clicking the notification launches
 * the .desktop Exec, which the single-instance lock routes to the running
 * window (focusing the account). Falls back to Electron's Notification if
 * notify-send isn't available.
 *
 * @param {string} title
 * @param {string} body
 * @param {{id: string} | null} account
 */
function showDesktopNotification(title, body, account) {
	const { execFile } = require('child_process');
	const args = [
		'-a', 'Outlook for Linux',
		'-i', notificationIcon,
		'-h', 'string:desktop-entry:outlook-for-linux',
		'-u', 'normal',
		title, body
	];
	execFile('notify-send', args, err => {
		if (!err) {
			return;
		}
		logger.debug('notify-send unavailable, falling back to Electron Notification: ' + err.message);
		const notification = new Notification({ title, body, icon: notificationIcon, silent: true });
		notification.on('click', () => {
			if (account) {
				accountManager.switchTo(account.id);
			}
		});
		notification.show();
	});
}

async function handleGetZoomLevel(_, name) {
	const partition = getPartition(name) || {};
	return partition.zoomLevel ? partition.zoomLevel : 0;
}

async function handleSaveZoomLevel(_, args) {
	let partition = getPartition(args.partition) || {};
	partition.name = args.partition;
	partition.zoomLevel = args.zoomLevel;
	savePartition(partition);
}

function getPartitions() {
	return appConfig.settingsStore.get('app.partitions') || [];
}

function getPartition(name) {
	const partitions = getPartitions();
	return partitions.filter(p => {
		return p.name === name;
	})[0];
}

function savePartition(arg) {
	const partitions = getPartitions();
	const partitionIndex = partitions.findIndex(p => {
		return p.name === arg.name;
	});

	if (partitionIndex >= 0) {
		partitions[partitionIndex] = arg;
	} else {
		partitions.push(arg);
	}
	appConfig.settingsStore.set('app.partitions', partitions);
}

function handleCertificateError() {
	const arg = {
		event: arguments[0],
		webContents: arguments[1],
		url: arguments[2],
		error: arguments[3],
		certificate: arguments[4],
		callback: arguments[5],
		config: config
	};
	certificateModule.onAppCertificateError(arg, logger);
}

/**
 * Handle user-status-changed message
 * 
 * @param {*} event 
 * @param {*} count 
 */
async function setBadgeCountHandler(event, count) {
	logger.debug(`Badge count set to '${count}'`);
	accountManager.setBadgeCount(event.sender, count);
}
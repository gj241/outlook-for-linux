const { app, Menu, dialog } = require('electron');
const application = require('./application');
const preferences = require('./preferences');
const help = require('./help');
const Tray = require('./tray');
const { LucidLog } = require('lucid-log');

class Menus {
	/**
	 * @param {import('../accountManager')} accountManager
	 * @param {object} config
	 * @param {string} iconPath
	 */
	constructor(accountManager, config, iconPath) {
		this.accountManager = accountManager;
		this.iconPath = iconPath;
		this.config = config;
		this.logger = new LucidLog({
			levels: config.appLogLevels.split(',')
		});
		this.initialize();
	}

	/**
	 * @returns {Electron.BrowserWindow}
	 */
	get activeWindow() {
		return this.accountManager.getActive().window;
	}

	async quit(clearStorage = false) {
		clearStorage = clearStorage && dialog.showMessageBoxSync(this.activeWindow, {
			buttons: ['Yes', 'No'],
			title: 'Quit',
			normalizeAccessKeys: true,
			defaultId: 1,
			cancelId: 1,
			message: 'Are you sure you want to clear the storage before quitting?',
			type: 'question'
		}) === 0;

		if (clearStorage) {
			const { session } = require('electron');
			const activeAccount = this.accountManager.getAccount(this.accountManager.activeId);
			if (activeAccount) {
				await session.fromPartition(activeAccount.partition).clearStorageData();
			}
		}

		this.accountManager.quitAll();
	}

	open() {
		const win = this.activeWindow;
		if (!win) {
			return;
		}
		if (!win.isVisible()) {
			win.show();
		}
		win.focus();
	}

	about() {
		const appInfo = [];
		appInfo.push(`outlook-for-linux@${app.getVersion()}\n`);
		for (const prop in process.versions) {
			if (prop === 'node' || prop === 'v8' || prop === 'electron' || prop === 'chrome') {
				appInfo.push(`${prop}: ${process.versions[prop]}`);
			}
		}
		dialog.showMessageBoxSync(this.activeWindow, {
			buttons: ['OK'],
			title: 'About',
			normalizeAccessKeys: true,
			defaultId: 0,
			cancelId: 0,
			message: appInfo.join('\n'),
			type: 'info'
		});
	}

	reload(show = true) {
		const active = this.accountManager.getActive();
		if (show && active.window) {
			active.window.show();
		}
		if (active.connMgr) {
			active.connMgr.refresh();
		}
	}

	debug() {
		if (this.activeWindow) {
			this.activeWindow.openDevTools();
		}
	}

	hide() {
		if (this.activeWindow) {
			this.activeWindow.hide();
		}
	}

	switchAccount(id) {
		this.accountManager.switchTo(id);
	}

	addAccount() {
		this.accountManager.addAccount();
	}

	initialize() {
		const appMenu = application(this);

		if (this.config.menubar === 'hidden') {
			Menu.setApplicationMenu(null);
		} else {
			Menu.setApplicationMenu(Menu.buildFromTemplate([
				appMenu,
				preferences(),
				help(app, this.activeWindow),
			]));
		}

		this.initializeEventHandlers();

		this.tray = new Tray(this.accountManager, this.buildTrayTemplate(), this.iconPath);
		this.accountManager.onChange(() => this.rebuildTray());
	}

	initializeEventHandlers() {
		app.on('before-quit', () => this.onBeforeQuit());
	}

	onBeforeQuit() {
		this.logger.debug('before-quit');
		this.accountManager.allowQuit = true;
	}

	rebuildTray() {
		if (this.tray) {
			this.tray.setContextMenu(this.buildTrayTemplate());
		}
	}

	/**
	 * Build the tray context menu: the application actions plus an Accounts
	 * submenu (one radio item per account, the active one selected) and an
	 * "Add account…" entry.
	 */
	buildTrayTemplate() {
		const accounts = this.accountManager.getAccounts();
		const activeId = this.accountManager.activeId;
		const accountsSubmenu = accounts.map(account => ({
			label: account.name,
			type: 'radio',
			checked: account.id === activeId,
			click: () => this.switchAccount(account.id)
		}));
		accountsSubmenu.push({ type: 'separator' });
		accountsSubmenu.push({
			label: 'Add account…',
			click: () => this.addAccount()
		});

		return [
			{ label: 'About', click: () => this.about() },
			{ type: 'separator' },
			{ label: 'Open', click: () => this.open() },
			{ label: 'Refresh', click: () => this.reload(false) },
			{ label: 'Hide', click: () => this.hide() },
			{ label: 'Debug', click: () => this.debug() },
			{ type: 'separator' },
			{ label: 'Accounts', submenu: accountsSubmenu },
			{ type: 'separator' },
			{ label: 'Quit', submenu: [
				{ label: 'Normally', accelerator: 'ctrl+Q', click: () => this.quit() },
				{ label: 'Clear Storage', click: () => this.quit(true) }
			] }
		];
	}
}

exports = module.exports = Menus;
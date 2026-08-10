const { Tray, Menu } = require('electron');

class ApplicationTray {
	/**
	 * @param {import('../accountManager')} accountManager
	 * @param {Electron.MenuItemConstructorOptions[]} contextMenuTemplate
	 * @param {string} iconPath
	 */
	constructor(accountManager, contextMenuTemplate, iconPath) {
		this.accountManager = accountManager;
		this.iconPath = iconPath;
		this.contextMenuTemplate = contextMenuTemplate;
		this.addTray();
	}

	addTray() {
		this.tray = new Tray(this.iconPath);
		this.tray.setToolTip('Microsoft Outlook');
		this.tray.on('click', () => this.showAndFocusActiveWindow());
		this.tray.setContextMenu(Menu.buildFromTemplate(this.contextMenuTemplate));
	}

	showAndFocusActiveWindow() {
		const win = this.accountManager.getActive().window;
		if (win) {
			win.show();
			win.focus();
		}
	}

	/**
	 * Rebuild the tray context menu (used after account add/remove/switch).
	 * @param {Electron.MenuItemConstructorOptions[]} contextMenuTemplate
	 */
	setContextMenu(contextMenuTemplate) {
		this.contextMenuTemplate = contextMenuTemplate;
		this.tray.setContextMenu(Menu.buildFromTemplate(contextMenuTemplate));
	}

	close() {
		this.tray.destroy();
	}
}
exports = module.exports = ApplicationTray;
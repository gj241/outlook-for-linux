exports = module.exports = (Menus) => ({
	label: 'Application',
	submenu: [
		{
			label: 'About',
			click: () => Menus.about(),
		},
		{
			type: 'separator',
		},
		{
			label: 'Open',
			accelerator: 'ctrl+O',
			click: () => Menus.open(),
		},
		{
			label: 'Refresh',
			accelerator: 'ctrl+R',
			click: () => Menus.reload(),
		},
		{
			label: 'Hide',
			accelerator: 'ctrl+H',
			click: () => Menus.hide(),
		},
		{
			label: 'Debug',
			accelerator: 'ctrl+D',
			click: () => Menus.debug(),
		},
		{
			type: 'separator',
		},
		getSettingsMenu(Menus),
		getAccountsMenu(Menus),
		{
			type: 'separator',
		},
		getQuitMenu(Menus)
	],
});

function getSettingsMenu(Menus) {
	return {
		label: 'Settings',
		submenu: [
			{
				label: 'Save',
				click: () => Menus.saveSettings()
			},
			{
				label: 'Restore',
				click: () => Menus.restoreSettings()
			}
		]
	};
}

function getAccountsMenu(Menus) {
	const accounts = Menus.accountManager.getAccounts();
	const activeId = Menus.accountManager.activeId;
	const submenu = accounts.map(account => ({
		label: account.name,
		type: 'radio',
		checked: account.id === activeId,
		click: () => Menus.switchAccount(account.id)
	}));
	submenu.push({ type: 'separator' });
	submenu.push({
		label: 'Add account…',
		click: () => Menus.addAccount()
	});
	return {
		label: 'Accounts',
		submenu: submenu
	};
}

function getQuitMenu(Menus) {
	return {
		label: 'Quit',
		submenu: [
			{
				label: 'Normally',
				accelerator: 'ctrl+Q',
				click: () => Menus.quit()
			},
			{
				label: 'Clear Storage',
				click: () => Menus.quit(true)
			}
		]
	};
}
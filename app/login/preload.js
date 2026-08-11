const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API to the login form. The login renderer runs with
// contextIsolation (default true), so it cannot require('electron') itself.
contextBridge.exposeInMainWorld('api', {
	submitForm: (args) => {
		ipcRenderer.send('submitForm', args);
	}
});
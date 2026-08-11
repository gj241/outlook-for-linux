function sendForm(event) { // eslint-disable-line no-unused-vars
	event.preventDefault();
	window.api.submitForm({
		username: document.getElementById('username').value,
		password: document.getElementById('password').value,
	});
}
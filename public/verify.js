const params = new URLSearchParams(location.search);
const token = params.get('token');
const purpose = params.get('purpose');
history.replaceState(null, '', '/verify.html');

const title = document.getElementById('verifyTitle');
const message = document.getElementById('verifyMessage');
const button = document.getElementById('verifyButton');

if (!/^[a-f0-9]{64}$/.test(token || '') || !['signup', 'login'].includes(purpose)) {
  message.textContent = 'This verification link is invalid.';
} else {
  const signup = purpose === 'signup';
  title.textContent = signup ? 'Verify your email' : 'Confirm sign in';
  message.textContent = '';
  button.textContent = signup ? 'Verify email' : 'Confirm sign in';
  button.hidden = false;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  message.textContent = 'Verifying...';
  try {
    const response = await fetch('/api/verify-email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, purpose })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not verify this link.');
    location.replace('/');
  } catch (error) {
    message.textContent = error.message;
    button.hidden = true;
  }
});

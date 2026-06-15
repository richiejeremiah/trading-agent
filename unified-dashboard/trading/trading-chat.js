(function () {
  const log = document.getElementById('chatLog');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput');
  const statusLine = document.getElementById('statusLine');
  const sessionKey = 'somo_trading_session_id';

  function apiBase() {
    if (window.SOMO_CONFIG && window.SOMO_CONFIG.API_BASE) return window.SOMO_CONFIG.API_BASE.replace(/\/$/, '');
    if (window.location.port === '4000') return '';
    return 'http://localhost:4000';
  }

  function sessionId() {
    let id = localStorage.getItem(sessionKey);
    if (!id) {
      id = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem(sessionKey, id);
    }
    return id;
  }

  function appendMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'tc-msg tc-msg-' + role;
    el.textContent = (role === 'user' ? 'You: ' : 'Somo: ') + text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const message = (input.value || '').trim();
    if (!message) return;
    appendMsg('user', message);
    input.value = '';
    statusLine.textContent = 'Sending…';

    try {
      const res = await fetch(apiBase() + '/api/trading/chat/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trading-Session': sessionId() },
        body: JSON.stringify({ session_id: sessionId(), message }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 501) {
        appendMsg('assistant', data.error || 'Trading agent not implemented yet.');
        statusLine.textContent = data.hint || 'Enable TRADING_AGENT_ENABLED=1 when ready.';
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Request failed');
      appendMsg('assistant', data.reply || '(no reply)');
      statusLine.textContent = 'OK';
    } catch (err) {
      appendMsg('assistant', 'Error: ' + err.message);
      statusLine.textContent = 'Request failed';
    }
  });

  appendMsg('assistant', 'Welcome to Somo Trading (paper mode shell). Ask a question to probe the API.');
})();

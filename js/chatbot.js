/**
 * CV Central — AI Help Chatbot Widget
 * Paid users only (plan: pro or premium)
 * Inject after auth.js on any page.
 */
(function () {
  'use strict';

  var PAID_PLANS = ['pro', 'premium'];
  var messages = [];
  var open = false;
  var accessToken = null;

  // ── Inject CSS ──────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = `
    #cv-chat-bubble {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 0.75rem;
    }

    #cv-chat-toggle {
      width: 54px;
      height: 54px;
      border-radius: 50%;
      background: #5B2D8E;
      color: #fff;
      border: none;
      cursor: pointer;
      display: grid;
      place-items: center;
      box-shadow: 0 6px 24px -6px rgba(91,45,142,0.45);
      transition: transform 0.2s ease, background 0.2s ease;
      flex-shrink: 0;
    }
    #cv-chat-toggle:hover { background: #43216B; transform: scale(1.06); }

    #cv-chat-panel {
      width: min(360px, calc(100vw - 2rem));
      background: #fff;
      border: 1px solid #E7E5F0;
      border-radius: 16px;
      box-shadow: 0 24px 60px -18px rgba(91,45,142,0.28);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      max-height: min(520px, calc(100vh - 120px));
      animation: chat-pop 0.25s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes chat-pop {
      from { opacity: 0; transform: scale(0.92) translateY(12px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    #cv-chat-header {
      background: #5B2D8E;
      color: #fff;
      padding: 0.9rem 1.1rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-shrink: 0;
    }
    #cv-chat-header .ch-logo {
      width: 28px; height: 28px;
      background: #AAFF00;
      border-radius: 7px;
      display: grid;
      place-items: center;
      font-family: monospace;
      font-weight: 900;
      font-size: 11px;
      color: #1A1A2E;
      flex-shrink: 0;
    }
    #cv-chat-header .ch-title { font-weight: 700; font-size: 0.92rem; flex: 1; }
    #cv-chat-header .ch-sub { font-size: 0.72rem; color: rgba(255,255,255,0.7); }
    #cv-chat-close {
      background: none; border: none; color: rgba(255,255,255,0.7);
      cursor: pointer; font-size: 1.2rem; line-height: 1; padding: 0.2rem;
      transition: color 0.15s;
    }
    #cv-chat-close:hover { color: #fff; }

    #cv-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }

    .cv-msg {
      max-width: 85%;
      padding: 0.6rem 0.85rem;
      border-radius: 12px;
      font-size: 0.875rem;
      line-height: 1.55;
      word-break: break-word;
    }
    .cv-msg.user {
      background: #5B2D8E;
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .cv-msg.bot {
      background: #F1EAF9;
      color: #1A1A2E;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .cv-msg.typing { color: #6B7280; font-style: italic; }

    #cv-chat-footer {
      border-top: 1px solid #E7E5F0;
      padding: 0.75rem;
      display: flex;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    #cv-chat-input {
      flex: 1;
      font-family: inherit;
      font-size: 0.875rem;
      border: 1.5px solid #E7E5F0;
      border-radius: 999px;
      padding: 0.5rem 0.9rem;
      outline: none;
      transition: border-color 0.15s;
      color: #1A1A2E;
    }
    #cv-chat-input:focus { border-color: #5B2D8E; }
    #cv-chat-send {
      width: 36px; height: 36px;
      border-radius: 50%;
      background: #5B2D8E;
      color: #fff;
      border: none;
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    #cv-chat-send:hover { background: #43216B; }
    #cv-chat-send:disabled { opacity: 0.45; cursor: not-allowed; }

    /* Upgrade gate */
    #cv-chat-upgrade {
      padding: 1.5rem 1.25rem;
      text-align: center;
    }
    #cv-chat-upgrade .upg-icon { font-size: 2rem; margin-bottom: 0.6rem; }
    #cv-chat-upgrade h3 { font-size: 1rem; font-weight: 800; color: #1A1A2E; margin-bottom: 0.4rem; }
    #cv-chat-upgrade p { font-size: 0.85rem; color: #6B7280; margin-bottom: 1.1rem; line-height: 1.5; }
    #cv-chat-upgrade a {
      display: inline-block;
      background: #5B2D8E;
      color: #fff;
      font-weight: 700;
      font-size: 0.88rem;
      padding: 0.6rem 1.4rem;
      border-radius: 999px;
      text-decoration: none;
      transition: background 0.15s;
    }
    #cv-chat-upgrade a:hover { background: #43216B; }
  `;
  document.head.appendChild(style);

  // ── Build HTML ──────────────────────────────────────────────
  var wrap = document.createElement('div');
  wrap.id = 'cv-chat-bubble';
  wrap.innerHTML = `
    <div id="cv-chat-panel" style="display:none;">
      <div id="cv-chat-header">
        <div class="ch-logo">CV</div>
        <div>
          <div class="ch-title">CV Central Assistant</div>
          <div class="ch-sub">Ask me anything about your CV</div>
        </div>
        <button id="cv-chat-close" aria-label="Close chat">✕</button>
      </div>
      <div id="cv-chat-messages"></div>
      <div id="cv-chat-footer">
        <input id="cv-chat-input" type="text" placeholder="Ask a question…" maxlength="500" autocomplete="off">
        <button id="cv-chat-send" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
    <button id="cv-chat-toggle" aria-label="Open help chat" aria-expanded="false">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>
  `;
  document.body.appendChild(wrap);

  var panel = document.getElementById('cv-chat-panel');
  var toggle = document.getElementById('cv-chat-toggle');
  var closeBtn = document.getElementById('cv-chat-close');
  var msgBox = document.getElementById('cv-chat-messages');
  var input = document.getElementById('cv-chat-input');
  var sendBtn = document.getElementById('cv-chat-send');

  // ── Plan check & initialise ──────────────────────────────────
  async function init() {
    var session = await cvAuth.getSession();
    if (!session) return; // not logged in — hide bubble entirely
    accessToken = session.access_token;

    // Fetch plan from profiles
    var supabase = cvAuth.client;
    var user = session.user || session;
    var userId = user.id;

    var plan = 'free';
    try {
      var res = await supabase.from('profiles').select('plan').eq('id', userId).single();
      if (res.data && res.data.plan) plan = res.data.plan;
    } catch (e) { /* default free */ }

    toggle.style.display = 'grid';

    toggle.addEventListener('click', function () {
      open = !open;
      panel.style.display = open ? 'flex' : 'none';
      panel.style.flexDirection = 'column';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.innerHTML = open
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

      if (open && !PAID_PLANS.includes(plan)) {
        showUpgradeGate();
      } else if (open && messages.length === 0) {
        addBotMessage('Hi! I\'m your CV Central assistant. Ask me anything — templates, scoring, cover letters, or how to fill in any section. 👋');
      }
    });

    closeBtn.addEventListener('click', function () {
      open = false;
      panel.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    });

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }

  function showUpgradeGate() {
    msgBox.innerHTML = '';
    document.getElementById('cv-chat-footer').style.display = 'none';
    var gate = document.createElement('div');
    gate.id = 'cv-chat-upgrade';
    gate.innerHTML = `
      <div class="upg-icon">🔒</div>
      <h3>Pro & Premium feature</h3>
      <p>The AI assistant is available on Pro (£9.99/mo) and Premium (£19.99/mo) plans. Upgrade to get instant help whenever you're stuck.</p>
      <a href="index.html#pricing">See plans →</a>
    `;
    msgBox.appendChild(gate);
  }

  function addBotMessage(text) {
    var div = document.createElement('div');
    div.className = 'cv-msg bot';
    div.textContent = text;
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
    messages.push({ role: 'assistant', content: text });
  }

  function addUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'cv-msg user';
    div.textContent = text;
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  function addTyping() {
    var div = document.createElement('div');
    div.className = 'cv-msg bot typing';
    div.id = 'cv-chat-typing';
    div.textContent = 'Thinking…';
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
    return div;
  }

  async function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;

    addUserMessage(text);
    messages.push({ role: 'user', content: text });

    var typing = addTyping();

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ messages: messages })
      });
      var data = await res.json();
      typing.remove();
      var reply = data.reply || data.error || 'Sorry, something went wrong. Please try again.';
      addBotMessage(reply);
    } catch (e) {
      typing.remove();
      addBotMessage('Sorry, I couldn\'t connect. Please check your internet and try again.');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // Wait for auth to be ready then init
  if (typeof cvAuth !== 'undefined') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();

// ── nav ───────────────────────────────────────────────────────────────────
// Top-level pages. The legacy "session" target is kept as an alias that
// jumps to Report → Batch sub-tab so any external bookmark / call site
// keeps working after the sub-tab refactor.
function showPage(n) {
  if (n === 'session') {
    showPage('report');
    showReportSubTab('batch');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + n);
  const nav  = document.getElementById('nav-' + n);
  if (page) page.classList.add('active');
  if (nav)  nav.classList.add('active');
  const tab = document.getElementById('tab-' + n);
  if (tab) tab.classList.add('active');

  if (n === 'history' && typeof renderHistory === 'function') {
    renderHistory();
  }
  if (n === 'context' && typeof renderContextWords === 'function') {
    renderContextWords();
  }
  if (n === 'setup' && typeof refreshConnectionStatus === 'function') {
    refreshConnectionStatus();
  }
}

// ── Report sub-tabs (Single Report / Batch Report) ────────────────────────
// "Single" = the classic one-bug Report flow (mic, textarea, Generate).
// "Batch" = the former Session page — multiple bug cards + Generate all.
//
// Lazy-init the batch sub-tab the first time it's opened: create a fresh
// card so the user sees an actionable form instead of an empty stub.
function showReportSubTab(name) {
  document.querySelectorAll('.report-sub').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  const sub = document.getElementById('report-' + name);
  const btn = document.getElementById('sub-' + name);
  if (sub) sub.classList.add('active');
  if (btn) btn.classList.add('active');

  if (name === 'batch' && typeof renderCards === 'function') {
    if (typeof sessionCards !== 'undefined' && !sessionCards.length && typeof addBugCard === 'function') {
      addBugCard();
    } else {
      renderCards();
    }
  }
}

// ── provider ──────────────────────────────────────────────────────────────
function setProvider(p, save = true) {
  provider = p;
  if (save) localStorage.setItem('bra_provider', p);
  document.querySelectorAll('[data-provider-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.providerBtn === p));
  updateApiBtn();
}

// ── api key ───────────────────────────────────────────────────────────────
function promptKey() {
  const label = provider === 'openrouter'
    ? 'OpenRouter API key (openrouter.ai/keys):'
    : 'Anthropic API key (console.anthropic.com):';
  const k = prompt(label, apiKey);
  if (k !== null) {
    apiKey = k.trim();
    localStorage.setItem('bra_key', apiKey);
    updateApiBtn();
  }
}

function updateApiBtn() {
  if (typeof serverAi !== 'undefined' && serverAi.available) {
    document.querySelectorAll('[data-api-btn]').forEach(btn => {
      const icon = btn.querySelector('[data-api-icon]');
      const lbl  = btn.querySelector('[data-api-lbl]');
      if (icon) icon.textContent = '●';
      if (lbl)  lbl.textContent  = 'Server key (.env)';
      btn.classList.add('set');
      btn.title = 'The server\'s .env key is used for everyone. A personal key only applies if the server key is removed.';
    });
    return;
  }
  const name = provider === 'openrouter' ? 'OpenRouter key' : 'Anthropic key';
  document.querySelectorAll('[data-api-btn]').forEach(btn => {
    const icon = btn.querySelector('[data-api-icon]');
    const lbl  = btn.querySelector('[data-api-lbl]');
    if (apiKey) {
      if (icon) icon.textContent = '●';
      if (lbl)  lbl.textContent  = name + ' set';
      btn.classList.add('set');
    } else {
      if (icon) icon.textContent = '○';
      if (lbl)  lbl.textContent  = 'Set ' + name;
      btn.classList.remove('set');
    }
  });
}

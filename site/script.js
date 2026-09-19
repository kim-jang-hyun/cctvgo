function detectLang() {
  const saved = localStorage.getItem('cctvgo-lang');
  if (saved) return saved;
  const lang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  return lang.startsWith('ko') ? 'ko' : 'en';
}

function applyLang(lang) {
  localStorage.setItem('cctvgo-lang', lang);
  document.documentElement.lang = lang;
  const btn = document.getElementById('langBtn');
  if (btn) btn.textContent = lang === 'ko' ? 'EN' : 'KO';
  document.querySelectorAll('[data-ko]').forEach(el => {
    const text = el.getAttribute('data-' + lang);
    if (text) el.innerHTML = text;
  });
  document.querySelectorAll('[data-alt-ko]').forEach(el => {
    const text = el.getAttribute('data-alt-' + lang);
    if (text) el.alt = text;
  });
}

function toggleLang() {
  const current = localStorage.getItem('cctvgo-lang') || detectLang();
  applyLang(current === 'ko' ? 'en' : 'ko');
}

document.getElementById('requestForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const btn = this.querySelector('[type="submit"]');
  const successEl = document.getElementById('formSuccess');
  const errorEl = document.getElementById('formError');

  btn.disabled = true;
  successEl.hidden = true;
  errorEl.hidden = true;

  try {
    const res = await fetch(this.action, {
      method: 'POST',
      body: new FormData(this),
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      this.reset();
      successEl.hidden = false;
    } else {
      errorEl.hidden = false;
    }
  } catch {
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', () => applyLang(detectLang()));

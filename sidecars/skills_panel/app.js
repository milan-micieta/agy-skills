(() => {
const $ = (s) => document.querySelector(s);

let localState = { skills: [], workspaces: [] };
let workspaceUris = [];
let currentPreview = null;
let discoverLoaded = false;

// ---------- Theme Sync (aligned with agy-context) ----------
function syncScheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return;
  const scale = c.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const theme = lum < 0.5 ? 'dark' : 'light';
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}
syncScheme();
new MutationObserver(syncScheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style'],
});

const OPEN_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H4a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V9.5"/><path d="M9.5 3h3.5v3.5M13 3l-5.5 5.5"/></svg>';

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

async function api(path, opts) {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await f(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function openFile(uri) {
  if (!uri) return;
  window.sidecar?.ui?.toggleAuxPane?.({ tabType: 'fileView', uri });
}

function scopeBadge(s) {
  if (s.scope === 'project') return `Project: ${esc(s.projectLabel)}`;
  if (s.scope === 'plugin') return `Plugin:${esc(s.pluginName)}`;
  if (s.scope === 'builtin') return 'Builtin';
  return 'Global';
}

// Tabs
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('on', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    const target = btn.dataset.tab;
    $('#view-local').classList.toggle('active', target === 'local');
    $('#view-discover').classList.toggle('active', target === 'discover');
    if (target === 'discover' && !discoverLoaded) {
      runOnlineSearch($('#online-query').value.trim());
    }
  });
});

function renderLocal() {
  const q = $('#local-filter').value.trim().toLowerCase();
  const statusFilter = $('#local-status-filter').value;
  const list = $('#local-list');

  const filtered = localState.skills.filter((s) => {
    if (statusFilter === 'enabled' && !s.enabled) return false;
    if (statusFilter === 'disabled' && s.enabled) return false;
    if (statusFilter === 'editable' && s.readonly) return false;
    if (statusFilter === 'system' && !s.readonly) return false;
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      (s.pluginName || '').toLowerCase().includes(q)
    );
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="status-line">Žiadne skilly nezodpovedajú filtru.</div>';
    return;
  }

  list.innerHTML = filtered
    .map((s) => `
      <div class="item-row ${s.enabled ? '' : 'disabled'}" title="${esc(s.description || s.name)}">
        <div class="item-main">
          <div class="item-head">
            <span class="item-name">${esc(s.id)}</span>
            <span class="badge">${scopeBadge(s)}</span>
            ${s.uses60d > 0 ? `<span class="badge loaded num">${s.uses60d}&times; / 60d</span>` : ''}
            ${s.hasLearnings ? '<span class="badge">learnings</span>' : ''}
            ${!s.enabled ? '<span class="badge warn">vypnutý</span>' : ''}
          </div>
          ${s.description ? `<div class="item-desc">${esc(s.description)}</div>` : ''}
        </div>
        <div class="item-right">
          <span class="item-tok num" title="Celý SKILL.md: ~${s.tokens} tok">${fmtTok(s.descTokens)} def</span>
          ${s.fileUri ? `<button type="button" class="open-btn" data-uri="${esc(s.fileUri)}" title="Otvoriť SKILL.md" aria-label="Otvoriť ${esc(s.id)}">${OPEN_ICON}</button>` : ''}
          ${!s.readonly ? `<button type="button" class="btn toggle-btn" data-id="${esc(s.id)}" data-enable="${!s.enabled}" data-scope="${esc(s.scope)}">${s.enabled ? 'Vypnúť' : 'Zapnúť'}</button>` : ''}
        </div>
      </div>
    `)
    .join('');

  list.querySelectorAll('.open-btn').forEach((btn) => {
    btn.addEventListener('click', () => openFile(btn.dataset.uri));
  });

  list.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: btn.dataset.id,
            enable: btn.dataset.enable === 'true',
            scope: btn.dataset.scope,
            workspacePath: localState.workspaces[0] || '',
          }),
        });
        await loadLocal();
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadLocal() {
  try {
    const qs = new URLSearchParams();
    if (workspaceUris.length) {
      qs.set('workspaces', JSON.stringify(workspaceUris));
    }
    const qStr = qs.toString();
    const data = await api(`/api/local${qStr ? `?${qStr}` : ''}`);
    localState = data;
    $('#summary-pill').textContent = `${data.totals.active} aktívnych · ~${fmtTok(data.totals.descTokens)} def`;

    const scopeSel = $('#pv-scope');
    scopeSel.innerHTML = '<option value="global">Globálne (~/.gemini/config/skills)</option>';
    if (data.workspaces?.length) {
      const ws = data.workspaces[0];
      scopeSel.innerHTML += `<option value="project">Projekt (${esc(ws)})</option>`;
    }

    renderLocal();
  } catch (err) {
    $('#summary-pill').textContent = 'Chyba';
    $('#local-list').innerHTML = `<div class="status-line">Nepodarilo sa načítať skilly: ${esc(err.message)}</div>`;
  }
}

$('#local-filter').addEventListener('input', renderLocal);
$('#local-status-filter').addEventListener('change', renderLocal);

// Online search (skillsdirectory.com, Grade A, sorted by GitHub stars)
async function runOnlineSearch(query) {
  const q = (query || '').trim();
  const status = $('#online-status');
  const list = $('#online-list');
  status.textContent = q
    ? `Hľadám "${q}" na skillsdirectory.com...`
    : 'Načítavam top skilly zo skillsdirectory.com...';
  list.innerHTML = '';

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    discoverLoaded = true;
    if (!data.skills.length) {
      status.textContent = 'Nič sa nenašlo.';
      return;
    }
    status.textContent = `Zobrazených ${data.skills.length} skillov (Grade A · zoradené podľa GitHub stars)`;
    list.innerHTML = data.skills
      .map((s) => `
        <div class="item-row" title="${esc(s.description || s.name)}">
          <div class="item-main">
            <div class="item-head">
              <span class="item-name">${esc(s.name)}</span>
              <span class="badge loaded">Grade ${esc(s.grade || 'A')}</span>
              <span class="badge num">${Number(s.stars || 0).toLocaleString()} ★</span>
            </div>
            ${s.description ? `<div class="item-desc">${esc(s.description)}</div>` : ''}
          </div>
          <div class="item-right">
            <button type="button" class="btn preview-btn" data-slug="${esc(s.slug)}" data-name="${esc(s.name)}">
              Náhľad &amp; Kontrola
            </button>
          </div>
        </div>
      `)
      .join('');

    list.querySelectorAll('.preview-btn').forEach((btn) => {
      btn.addEventListener('click', () => openPreview({ slug: btn.dataset.slug, name: btn.dataset.name }));
    });
  } catch (err) {
    status.textContent = `Chyba načítania: ${err.message}`;
  }
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runOnlineSearch($('#online-query').value);
});

async function openPreview({ slug, name }) {
  const dlg = $('#preview-dialog');
  const sec = $('#pv-security');
  const installBtn = $('#pv-install');

  $('#pv-title').textContent = name || slug;
  $('#pv-sub').textContent = 'skillsdirectory.com';
  $('#pv-content').textContent = 'Načítavam SKILL.md...';
  sec.className = 'security-box';
  sec.textContent = 'Prebieha bezpečnostná kontrola...';
  installBtn.disabled = true;
  dlg.showModal();

  try {
    const data = await api(`/api/preview?slug=${encodeURIComponent(slug)}`);
    currentPreview = data;
    $('#pv-title').textContent = data.skillId || name || slug;
    $('#pv-sub').textContent = `${data.source} (${data.folderPath}) · ~${data.tokens} tokenov`;
    $('#pv-content').textContent = data.content;

    if (data.warnings.length) {
      sec.className = 'security-box warn';
      sec.innerHTML = `<strong>Upozornenie — skontroluj pred inštaláciou:</strong><ul>${data.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
    } else {
      sec.className = 'security-box';
      sec.textContent = 'Bezpečnostná kontrola OK (žiadne podozrivé shell príkazy ani prístup k .env/kľúčom).';
    }
    installBtn.disabled = false;
  } catch (err) {
    sec.className = 'security-box warn';
    sec.textContent = `Nepodarilo sa načítať SKILL.md: ${err.message}`;
    $('#pv-content').textContent = '';
  }
}

$('#pv-close').addEventListener('click', () => $('#preview-dialog').close());

$('#pv-install').addEventListener('click', async () => {
  if (!currentPreview) return;
  const btn = $('#pv-install');
  btn.disabled = true;
  btn.textContent = 'Inštalujem...';
  try {
    const scope = $('#pv-scope').value;
    await api('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: currentPreview.source,
        skillId: currentPreview.skillId,
        folderPath: currentPreview.folderPath,
        scope,
        workspacePath: localState.workspaces[0] || '',
      }),
    });
    $('#preview-dialog').close();
    await loadLocal();
    document.querySelector('.seg-btn[data-tab="local"]').click();
  } catch (err) {
    alert(`Inštalácia zlyhala: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Nainštalovať';
  }
});

if (window.sidecar?.onWorkspaceChange) {
  window.sidecar.onWorkspaceChange((uris) => {
    workspaceUris = Array.isArray(uris) ? uris : [];
    loadLocal();
  });
}

(async () => {
  if (window.sidecar?.getWorkspaceUris) {
    try {
      const uris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(uris)) workspaceUris = uris;
    } catch {}
  }
  await loadLocal();
})();
})();

(() => {
const $ = (s) => document.querySelector(s);

let localState = { skills: [], workspaces: [] };
let discoverState = { skills: [], query: '' };
let workspaceUris = [];
let discoverLoaded = false;

let mode = 'local'; // 'local' | 'discover'
let localFilter = 'all';
let localSort = 'uses';
let currentDetail = null; // { kind: 'local' | 'discover', skill, data }

// ---------- Theme Sync (aligned with agy-context + standalone Antigravity dark default) ----------
function syncScheme() {
  const hostBg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  let theme = 'dark';
  if (hostBg) {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      theme = lum < 0.5 ? 'dark' : 'light';
    }
  }
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}
syncScheme();
new MutationObserver(syncScheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style'],
});

// ---------- Icons & Helpers ----------
const ICONS = {
  global: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4.5 3.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M5.5 6.5h5M5.5 9.5h3.5" stroke-linecap="round"/></svg>',
  project: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7z"/></svg>',
  plugin: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5.5 3.5L3 6l2.5 2.5M10.5 3.5L13 6l-2.5 2.5M7 12.5l2-9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  builtin: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 6h4v4H6z"/></svg>',
  discover: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5"/><path d="M6.2 9.8l1.1-2.5 2.5-1.1-1.1 2.5-2.5 1.1z" stroke-linejoin="round"/></svg>',
};

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

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function scopeLabel(s) {
  if (s.scope === 'project') return `Project: ${s.projectLabel}`;
  if (s.scope === 'plugin') return `Plugin: ${s.pluginName}`;
  if (s.scope === 'builtin') return 'Builtin';
  return 'Global';
}

function scopeAuthor(s) {
  if (s.scope === 'plugin') return s.pluginName || 'Plugin';
  if (s.scope === 'builtin') return 'Antigravity';
  if (s.scope === 'project') return s.projectLabel || 'Project';
  return 'User';
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

// ---------- Mode Switching (Installed / Discover) ----------
function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll('.seg-btn[data-mode]').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  $('#list-heading').textContent = mode === 'local' ? 'Installed skills' : 'Discover skills';
  $('#search-input').placeholder = mode === 'local'
    ? 'Search installed skills...'
    : 'Search skillsdirectory.com (e.g. react, git, testing)...';
  $('#local-controls').hidden = mode !== 'local';

  showListScreen();

  if (mode === 'local') {
    $('#list-status').textContent = '';
    renderLocal();
  } else {
    if (!discoverLoaded) {
      runOnlineSearch($('#search-input').value.trim());
    } else {
      renderDiscover();
    }
  }
}

document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

$('#add-btn').addEventListener('click', () => {
  if (mode === 'local') {
    $('#search-input').value = '';
    setMode('discover');
  }
  $('#search-input').focus();
});

// ---------- Popover Menus (Filter & Sort) ----------
for (const [triggerId, popoverId] of [
  ['#filter-trigger', '#filter-popover'],
  ['#sort-trigger', '#sort-popover'],
]) {
  const trigger = $(triggerId);
  const pop = $(popoverId);
  pop.addEventListener('toggle', (e) => {
    trigger.setAttribute('aria-expanded', e.newState === 'open' ? 'true' : 'false');
  });
}

$('#filter-popover').addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item[data-filter]');
  if (!item) return;
  localFilter = item.dataset.filter;
  $('#filter-popover').querySelectorAll('.menu-item').forEach((b) => {
    b.classList.toggle('active', b === item);
  });
  $('#filter-popover').hidePopover?.();
  renderLocal();
});

$('#sort-popover').addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item[data-sort]');
  if (!item) return;
  localSort = item.dataset.sort;
  $('#sort-popover').querySelectorAll('.menu-item').forEach((b) => {
    b.classList.toggle('active', b === item);
  });
  $('#sort-popover').hidePopover?.();
  renderLocal();
});

// ---------- Search Input ----------
$('#toolbar-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (mode === 'discover') {
    runOnlineSearch($('#search-input').value.trim());
  } else {
    renderLocal();
  }
});

$('#search-input').addEventListener('input', () => {
  if (mode === 'local') renderLocal();
});

// ---------- Local List ----------
function sortLocalSkills(items) {
  const arr = [...items];
  if (localSort === 'name') {
    return arr.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (localSort === 'updated') {
    return arr.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  }
  if (localSort === 'tokens') {
    return arr.sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  }
  return arr.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.uses60d - a.uses60d || a.id.localeCompare(b.id));
}

function renderLocal() {
  const q = $('#search-input').value.trim().toLowerCase();
  const list = $('#skill-list');

  const filtered = sortLocalSkills(
    localState.skills.filter((s) => {
      if (localFilter === 'enabled' && !s.enabled) return false;
      if (localFilter === 'disabled' && s.enabled) return false;
      if (localFilter === 'editable' && s.readonly) return false;
      if (localFilter === 'system' && !s.readonly) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.pluginName || '').toLowerCase().includes(q)
      );
    })
  );

  if (!filtered.length) {
    list.innerHTML = '<div class="status-line">No skills match your filter.</div>';
    return;
  }

  list.innerHTML = filtered
    .map((s, idx) => {
      const stat = s.uses60d > 0 ? `${s.uses60d} runs` : `~${fmtTok(s.descTokens)} tok`;
      const desc = s.description ? ` · ${esc(s.description)}` : '';
      return `
        <div class="skill-row ${s.enabled ? '' : 'disabled'}" data-idx="${idx}" role="button" tabindex="0">
          <div class="skill-row-left">
            <div class="skill-square" aria-hidden="true">${ICONS[s.scope] || ICONS.global}</div>
            <div class="skill-row-main">
              <div class="skill-row-head">
                <span class="skill-row-name">${esc(s.id)}</span>
                <span class="badge">${esc(scopeLabel(s))}</span>
                ${s.hasLearnings ? '<span class="badge">learnings</span>' : ''}
                ${!s.enabled ? '<span class="badge warn">disabled</span>' : ''}
              </div>
              <div class="skill-row-sub">by ${esc(scopeAuthor(s))}${desc}</div>
            </div>
          </div>
          <div class="skill-row-right">
            <span class="skill-row-stat num">${stat}</span>
            ${!s.readonly ? `<button type="button" class="btn row-toggle-btn" data-id="${esc(s.id)}" data-enable="${!s.enabled}" data-scope="${esc(s.scope)}">${s.enabled ? 'Disable' : 'Enable'}</button>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  list.querySelectorAll('.skill-row').forEach((row) => {
    const s = filtered[Number(row.dataset.idx)];
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-toggle-btn')) return;
      openLocalDetail(s);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('.row-toggle-btn')) return;
        e.preventDefault();
        openLocalDetail(s);
      }
    });
  });

  list.querySelectorAll('.row-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
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
      } catch (err) {
        alert(err.message);
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
    $('#summary-pill').textContent = `${data.totals.active} active · ~${fmtTok(data.totals.descTokens)} def`;

    const scopeSel = $('#detail-scope-select');
    scopeSel.innerHTML = '<option value="global">Global (~/.gemini/config/skills)</option>';
    if (data.workspaces?.length) {
      const ws = data.workspaces[0];
      scopeSel.innerHTML += `<option value="project">Project (${esc(ws)})</option>`;
    }

    if (mode === 'local') renderLocal();
  } catch (err) {
    $('#summary-pill').textContent = 'Error';
    if (mode === 'local') {
      $('#skill-list').innerHTML = `<div class="status-line">Failed to load skills: ${esc(err.message)}</div>`;
    }
  }
}

// ---------- Discover List ----------
async function runOnlineSearch(query) {
  const q = (query || '').trim();
  const status = $('#list-status');
  const list = $('#skill-list');
  status.textContent = q
    ? `Searching "${q}" on skillsdirectory.com...`
    : 'Loading top skills from skillsdirectory.com...';
  list.innerHTML = '';

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    discoverLoaded = true;
    discoverState = { skills: data.skills || [], query: q };
    renderDiscover();
  } catch (err) {
    status.textContent = `Search failed: ${err.message}`;
  }
}

function renderDiscover() {
  const status = $('#list-status');
  const list = $('#skill-list');
  const items = discoverState.skills;

  if (!items.length) {
    status.textContent = 'No skills found.';
    list.innerHTML = '';
    return;
  }

  status.textContent = `Showing ${items.length} skills (Grade A · sorted by GitHub stars)`;
  list.innerHTML = items
    .map((s, idx) => `
      <div class="skill-row" data-idx="${idx}" role="button" tabindex="0">
        <div class="skill-row-left">
          <div class="skill-square" aria-hidden="true">${ICONS.discover}</div>
          <div class="skill-row-main">
            <div class="skill-row-head">
              <span class="skill-row-name">${esc(s.name)}</span>
              <span class="badge ok">Grade ${esc(s.grade || 'A')}</span>
            </div>
            <div class="skill-row-sub">by skillsdirectory.com${s.description ? ` · ${esc(s.description)}` : ''}</div>
          </div>
        </div>
        <div class="skill-row-right">
          <span class="skill-row-stat num">${Number(s.stars || 0).toLocaleString()} ★</span>
          <button type="button" class="btn row-add-btn">Add</button>
        </div>
      </div>
    `)
    .join('');

  list.querySelectorAll('.skill-row').forEach((row) => {
    const s = items[Number(row.dataset.idx)];
    row.addEventListener('click', () => openDiscoverDetail(s));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDiscoverDetail(s);
      }
    });
  });
}

// ---------- Detail Screen Navigation & Tabs ----------
function showListScreen() {
  $('#screen-detail').hidden = true;
  $('#screen-list').hidden = false;
  currentDetail = null;
}

function showDetailScreen() {
  $('#screen-list').hidden = true;
  $('#screen-detail').hidden = false;
  switchDetailTab('overview');
  window.scrollTo({ top: 0 });
}

function switchDetailTab(target) {
  const tabs = [
    { btn: $('#tab-overview'), panel: $('#panel-overview'), key: 'overview' },
    { btn: $('#tab-contents'), panel: $('#panel-contents'), key: 'contents' },
  ];
  for (const t of tabs) {
    const active = t.key === target;
    t.btn.setAttribute('aria-selected', active ? 'true' : 'false');
    t.btn.toggleAttribute('focusgroupstart', active);
    if (active) {
      t.panel.removeAttribute('hidden');
      t.panel.setAttribute('tabindex', '0');
    } else {
      t.panel.setAttribute('hidden', 'until-found');
      t.panel.removeAttribute('tabindex');
    }
  }
}

$('#tab-overview').addEventListener('click', () => switchDetailTab('overview'));
$('#tab-contents').addEventListener('click', () => switchDetailTab('contents'));
$('#panel-contents').addEventListener('beforematch', () => switchDetailTab('contents'));
$('#panel-overview').addEventListener('beforematch', () => switchDetailTab('overview'));

$('#detail-back').addEventListener('click', showListScreen);

// ---------- Safe Markdown Renderer ----------
let mdViewMode = 'preview';

function setMdView(next) {
  mdViewMode = next;
  document.querySelectorAll('.seg-btn[data-md-view]').forEach((b) => {
    const on = b.dataset.mdView === mdViewMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#detail-md').hidden = mdViewMode !== 'preview';
  $('#detail-code').hidden = mdViewMode !== 'raw';
}

document.querySelectorAll('.seg-btn[data-md-view]').forEach((btn) => {
  btn.addEventListener('click', () => setMdView(btn.dataset.mdView));
});

function inlineMd(text) {
  const codeSpans = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${esc(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, path) =>
    `<span title="${path}">${label}</span>`
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSpans[Number(i)]);
}

function renderMarkdown(raw) {
  let src = String(raw || '').replace(/\r\n/g, '\n');
  let frontmatterHtml = '';

  const fmMatch = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (fmLines.length) {
      frontmatterHtml = `<div class="md-frontmatter">${fmLines
        .slice(0, 6)
        .map((l) => `<div>${esc(l)}</div>`)
        .join('')}</div>`;
    }
    src = src.slice(fmMatch[0].length);
  }

  const lines = src.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Heading
    const hd = line.match(/^(#{1,4})\s+(.+)$/);
    if (hd) {
      const lvl = hd[1].length;
      out.push(`<h${lvl}>${inlineMd(hd[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${buf.map(inlineMd).join('<br />')}</blockquote>`);
      continue;
    }

    // Pipe table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const parseRow = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push(
        `<table><thead><tr>${headers.map((h) => `<th>${inlineMd(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }

    // Unordered / Ordered list
    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const tag = ulMatch ? 'ul' : 'ol';
      const re = ulMatch ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (!m) break;
        items.push(`<li>${inlineMd(m[1])}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph
    const pBuf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('>') &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      pBuf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMd(pBuf.join(' '))}</p>`);
  }

  return frontmatterHtml + out.join('\n');
}

function setSkillContent(raw, isLoading = false) {
  if (isLoading) {
    $('#detail-md').textContent = raw;
    $('#detail-code').textContent = raw;
    return;
  }
  $('#detail-code').textContent = raw || '';
  $('#detail-md').innerHTML = raw ? renderMarkdown(raw) : '<p>Empty SKILL.md</p>';
}

function renderSecurityBox(warnings) {
  const sec = $('#detail-security');
  sec.hidden = false;
  if (warnings?.length) {
    sec.className = 'security-box warn';
    sec.innerHTML = `<strong>Security review — check before using:</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
  } else {
    sec.className = 'security-box';
    sec.textContent = 'Security check passed (no suspicious shell commands or sensitive file references).';
  }
}

async function openLocalDetail(s) {
  currentDetail = { kind: 'local', skill: s, data: null };
  showDetailScreen();

  $('#detail-back-label').textContent = 'Installed skills';
  $('#detail-icon').innerHTML = ICONS[s.scope] || ICONS.global;
  $('#detail-title').textContent = s.id;
  const upd = fmtDate(s.updatedAt);
  $('#detail-sub').textContent = `by ${scopeAuthor(s)} · ${scopeLabel(s)}${upd ? ` · updated ${upd}` : ''}`;

  const openBtn = $('#detail-open-btn');
  openBtn.hidden = !s.fileUri;
  openBtn.onclick = () => openFile(s.fileUri);

  const primaryBtn = $('#detail-primary-btn');
  primaryBtn.className = 'btn';
  if (s.readonly) {
    primaryBtn.textContent = 'Read-only';
    primaryBtn.disabled = true;
    primaryBtn.onclick = null;
  } else {
    primaryBtn.textContent = s.enabled ? 'Disable' : 'Enable';
    primaryBtn.disabled = false;
    primaryBtn.onclick = async () => {
      primaryBtn.disabled = true;
      try {
        await api('/api/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: s.id,
            enable: !s.enabled,
            scope: s.scope,
            workspacePath: localState.workspaces[0] || '',
          }),
        });
        await loadLocal();
        const updated = localState.skills.find((x) => x.id === s.id && x.scope === s.scope);
        if (updated) {
          openLocalDetail(updated);
        } else {
          showListScreen();
        }
      } catch (err) {
        alert(err.message);
        primaryBtn.disabled = false;
      }
    };
  }

  // Stats
  $('#stat-1-label').textContent = 'Usage';
  $('#stat-1-val').textContent = String(s.uses60d || 0);
  $('#stat-1-sub').textContent = 'runs · 60 days';
  $('#stat-2-label').textContent = 'Context';
  $('#stat-2-val').textContent = `~${fmtTok(s.descTokens)}`;
  $('#stat-2-sub').textContent = `def · ~${fmtTok(s.tokens)} full`;

  $('#detail-desc').textContent = s.description || 'No description provided in SKILL.md frontmatter.';
  $('#detail-install-target').hidden = true;
  $('#detail-security').hidden = true;

  // Categories
  const cats = [scopeLabel(s), s.enabled ? 'Active' : 'Disabled'];
  if (s.hasLearnings) cats.push('Has learnings.md');
  $('#detail-cats').innerHTML = cats.map((c) => `<span class="cat-pill">${esc(c)}</span>`).join('');

  // Meta card
  $('#meta-source').textContent = s.scope === 'global'
    ? '~/.gemini/config/skills'
    : s.scope === 'project'
      ? `.agents/skills (${s.projectLabel})`
      : s.scope === 'plugin'
        ? 'Installed plugin'
        : 'Antigravity builtin';

  const pluginBlock = $('#meta-plugin-block');
  if (s.pluginName) {
    pluginBlock.hidden = false;
    $('#meta-plugin-label').textContent = 'Plugin';
    $('#meta-plugin').textContent = s.pluginName;
  } else if (s.learningsUri) {
    pluginBlock.hidden = false;
    $('#meta-plugin-label').textContent = 'Learnings';
    $('#meta-plugin').innerHTML = '<button type="button" class="meta-link" id="open-learnings-link">Open learnings.md</button>';
    $('#open-learnings-link').addEventListener('click', () => openFile(s.learningsUri));
  } else {
    pluginBlock.hidden = true;
  }

  $('#meta-tools').textContent = 'Only adds instructions (SKILL.md)';
  $('#detail-files-wrap').hidden = true;
  setSkillContent('Loading SKILL.md...', true);

  try {
    const qs = new URLSearchParams({
      id: s.id,
      scope: s.scope,
      pluginName: s.pluginName || '',
    });
    if (workspaceUris.length) qs.set('workspaces', JSON.stringify(workspaceUris));
    const detail = await api(`/api/local/detail?${qs.toString()}`);
    if (currentDetail?.skill?.id !== s.id) return;
    currentDetail.data = detail;

    renderSecurityBox(detail.warnings);
    setSkillContent(detail.content || '');

    const files = (detail.files || []).filter((f) => f.type === 'file');
    if (files.length) {
      $('#meta-tools').textContent = files.length > 1
        ? `Instructions + ${files.length - 1} extra file(s)`
        : 'Only adds instructions (SKILL.md)';
      const wrapEl = $('#detail-files-wrap');
      const filesEl = $('#detail-files');
      $('#detail-files-summary').textContent = `Files (${files.length})`;
      wrapEl.hidden = false;
      wrapEl.open = files.length <= 4;
      filesEl.innerHTML = files
        .map((f) => `<button type="button" class="file-chip" data-uri="${esc(f.uri)}">${esc(f.path)}</button>`)
        .join('');
      filesEl.querySelectorAll('.file-chip').forEach((btn) => {
        btn.addEventListener('click', () => openFile(btn.dataset.uri));
      });
    }
  } catch (err) {
    setSkillContent(`Failed to load SKILL.md: ${err.message}`, true);
  }
}

async function openDiscoverDetail(s) {
  currentDetail = { kind: 'discover', skill: s, data: null };
  showDetailScreen();

  $('#detail-back-label').textContent = 'Discover skills';
  $('#detail-icon').innerHTML = ICONS.discover;
  $('#detail-title').textContent = s.name || s.slug;
  $('#detail-sub').textContent = 'from skillsdirectory.com · Loading repository info...';
  $('#detail-open-btn').hidden = true;

  const primaryBtn = $('#detail-primary-btn');
  primaryBtn.className = 'btn primary';
  primaryBtn.textContent = 'Add';
  primaryBtn.disabled = true;

  $('#stat-1-label').textContent = 'Popularity';
  $('#stat-1-val').textContent = `${Number(s.stars || 0).toLocaleString()} ★`;
  $('#stat-1-sub').textContent = 'GitHub stars';
  $('#stat-2-label').textContent = 'Quality';
  $('#stat-2-val').textContent = `Grade ${s.grade || 'A'}`;
  $('#stat-2-sub').textContent = 'skillsdirectory.com';

  $('#detail-desc').textContent = s.description || 'No description available.';
  $('#detail-install-target').hidden = false;
  $('#detail-security').hidden = false;
  $('#detail-security').className = 'security-box';
  $('#detail-security').textContent = 'Running security scan...';

  $('#detail-cats').innerHTML = [
    `Grade ${s.grade || 'A'}`,
    'skillsdirectory.com',
  ].map((c) => `<span class="cat-pill">${esc(c)}</span>`).join('');

  $('#meta-source').textContent = 'skillsdirectory.com';
  $('#meta-plugin-block').hidden = true;
  $('#meta-tools').textContent = 'Only adds instructions (SKILL.md)';
  $('#detail-files-wrap').hidden = true;
  setSkillContent('Loading SKILL.md...', true);

  try {
    const data = await api(`/api/preview?slug=${encodeURIComponent(s.slug)}`);
    if (currentDetail?.skill?.slug !== s.slug) return;
    currentDetail.data = data;

    $('#detail-title').textContent = data.skillId || s.name || s.slug;
    $('#detail-sub').textContent = `by ${data.source} · ${data.folderPath} · ~${data.tokens} tok`;
    $('#stat-2-sub').textContent = `~${fmtTok(data.tokens)} tokens`;
    $('#meta-source').textContent = data.source;
    setSkillContent(data.content || '');
    renderSecurityBox(data.warnings);

    primaryBtn.disabled = false;
    primaryBtn.onclick = async () => {
      primaryBtn.disabled = true;
      primaryBtn.textContent = 'Installing...';
      try {
        await api('/api/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: data.source,
            skillId: data.skillId,
            folderPath: data.folderPath,
            scope: $('#detail-scope-select').value,
            workspacePath: localState.workspaces[0] || '',
          }),
        });
        await loadLocal();
        setMode('local');
      } catch (err) {
        alert(`Installation failed: ${err.message}`);
        primaryBtn.disabled = false;
        primaryBtn.textContent = 'Add';
      }
    };
  } catch (err) {
    $('#detail-security').className = 'security-box warn';
    $('#detail-security').textContent = `Failed to load SKILL.md: ${err.message}`;
    setSkillContent('', true);
  }
}

// ---------- Init ----------
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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLocalSkillDetail,
  installSkill,
  listLocalSkills,
  previewSkill,
  searchOnline,
  toggleSkill,
} from './skills_service.mjs';

const { SidecarApp, Response } = await import('sidecar_sdk').catch(() =>
  import('file:///C:/Users/milan/.gemini/config/node_modules/sidecar_sdk/index.mjs')
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_STORE = { 'Cache-Control': 'no-store' };

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function uriToPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return decodeURIComponent(trimmed.replace(/^file:\/\/\/?/i, ''));
    }
  }
  return trimmed;
}

function parseWorkspaces(raw) {
  const src = typeof raw === 'string' && raw.trim()
    ? raw
    : (process.env.ANTIGRAVITY_WORKSPACE_PATHS || '');
  if (!src.trim()) return [];
  if (src.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(src);
      return Array.isArray(arr) ? arr.map(uriToPath).filter(Boolean) : [];
    } catch {}
  }
  return src.split(/[|;,]/).map(uriToPath).filter(Boolean);
}

const errRes = (message, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    contentType: 'application/json; charset=utf-8',
    status,
    headers: NO_STORE,
  });

const app = new SidecarApp();

app.page('/', () =>
  new Response(readFileSync(join(__dirname, 'index.html'), 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  })
);

for (const [route, [file, ct]] of Object.entries(STATIC)) {
  app.api(route, () =>
    new Response(readFileSync(join(__dirname, file), 'utf8'), {
      contentType: ct,
      headers: NO_STORE,
    }),
    'GET'
  );
}

app.api('/api/local', (data) => {
  try {
    const workspaces = parseWorkspaces(data?.workspaces);
    const result = listLocalSkills(workspaces);
    return { ...result, workspaces };
  } catch (e) {
    return errRes(e.message, 500);
  }
}, 'GET');

app.api('/api/local/detail', (data) => {
  try {
    const workspaces = parseWorkspaces(data?.workspaces);
    return getLocalSkillDetail({
      id: data?.id || '',
      scope: data?.scope || '',
      pluginName: data?.pluginName || '',
      workspacePaths: workspaces,
    });
  } catch (e) {
    return errRes(e.message, 404);
  }
}, 'GET');

app.api('/api/search', async (data) => {
  try {
    return await searchOnline(data?.q || '');
  } catch (e) {
    return errRes(e.message, 500);
  }
}, 'GET');

app.api('/api/preview', async (data) => {
  try {
    return await previewSkill(data?.source, data?.skillId, data?.slug);
  } catch (e) {
    return errRes(e.message, 404);
  }
}, 'GET');

app.api('/api/toggle', (data) => {
  try {
    return toggleSkill(data || {});
  } catch (e) {
    return errRes(e.message, 400);
  }
}, 'POST');

app.api('/api/install', (data) => {
  try {
    return installSkill(data || {});
  } catch (e) {
    return errRes(e.message, 400);
  }
}, 'POST');

app.run();

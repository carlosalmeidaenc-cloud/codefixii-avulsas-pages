(function () {
  'use strict';

  const DB_NAME = 'avulsas_gitpages_mobile';
  const DB_VERSION = 1;
  const TOKEN_KEY = 'avulsasGitpagesGithubToken';
  const DEVICE_KEY = 'avulsasGitpagesDeviceId';
  const PASSWORD_HASH = '2fbfb4180b5622e9fed8f79fac088f31ecc0f3a578c9ac3c5b68942259a52560';
  const PASSWORD_SALT = 'avulsas-android-sync-v1:';
  const app = document.getElementById('app');

  let dbPromise = null;
  let state = {
    manifest: null,
    data: null,
    pending: { reviewLogs: [], reviewStates: {} },
    current: null,
    answered: null,
    message: ''
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function addDaysIso(isoDate, days) {
    const parts = String(isoDate || '').split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + Math.round(days));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function diffDaysIso(fromIso, toIso) {
    const a = String(fromIso || '').split('-').map(Number);
    const b = String(toIso || '').split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function base64UrlToBytes(value) {
    const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = text + '='.repeat((4 - text.length % 4) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function decryptJson(envelope, keyB64) {
    const key = await crypto.subtle.importKey('raw', base64UrlToBytes(keyB64), 'AES-GCM', false, ['decrypt']);
    const cipherBytes = base64UrlToBytes(envelope.ciphertext);
    const tagBytes = base64UrlToBytes(envelope.tag);
    const merged = new Uint8Array(cipherBytes.length + tagBytes.length);
    merged.set(cipherBytes, 0);
    merged.set(tagBytes, cipherBytes.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv), tagLength: 128 }, key, merged);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function encryptJson(value, keyB64) {
    const key = await crypto.subtle.importKey('raw', base64UrlToBytes(keyB64), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plain));
    const tag = encrypted.slice(encrypted.length - 16);
    const ciphertext = encrypted.slice(0, encrypted.length - 16);
    return {
      schema: 1,
      alg: 'AES-256-GCM',
      iv: bytesToBase64Url(iv),
      tag: bytesToBase64Url(tag),
      ciphertext: bytesToBase64Url(ciphertext)
    };
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function kvGet(key, fallback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => reject(req.error);
    });
  }

  async function kvSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function getKeyFromHash() {
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    return params.get('k') || '';
  }

  async function loadRemoteSnapshot() {
    const key = getKeyFromHash();
    if (!key) throw new Error('Link sem chave #k.');
    const publicManifest = await fetch('manifest.json', { cache: 'no-store' }).then((r) => r.json());
    const privateManifest = await fetch(publicManifest.manifestPath, { cache: 'no-store' }).then((r) => r.json()).then((env) => decryptJson(env, key));
    const data = await fetch(privateManifest.dataPath, { cache: 'no-store' }).then((r) => r.json()).then((env) => decryptJson(env, key));
    return { manifest: privateManifest, data };
  }

  async function persistState() {
    await kvSet('manifest', state.manifest);
    await kvSet('data', state.data);
    await kvSet('pending', state.pending);
  }

  function stores() {
    return state.data && state.data.stores ? state.data.stores : {};
  }

  function getReviewState(questaoId) {
    const all = stores().reviewStates || [];
    return all.find((row) => row.questaoId === questaoId) || novoReviewState(questaoId);
  }

  function putReviewState(row) {
    const all = stores().reviewStates || (stores().reviewStates = []);
    const idx = all.findIndex((item) => item.questaoId === row.questaoId);
    if (idx >= 0) all[idx] = row;
    else all.push(row);
    state.pending.reviewStates[row.questaoId] = row;
  }

  function putReviewLog(row) {
    const all = stores().reviewLogs || (stores().reviewLogs = []);
    if (!all.some((item) => item.id === row.id)) all.push(row);
    state.pending.reviewLogs.push(row);
  }

  function novoReviewState(questaoId) {
    return {
      questaoId,
      stability: 0,
      difficulty: 0,
      dueDate: todayIso(),
      nextDueAt: null,
      lastReviewedAt: null,
      reps: 0,
      lapses: 0,
      state: 'new',
      clamped: false
    };
  }

  const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
  const TARGET_RETENTION = 0.9;
  const FACTOR = Math.pow(TARGET_RETENTION, -1 / 0.5) - 1;

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function recall(elapsedDays, stability) { return stability <= 0 ? 0 : Math.pow(1 + FACTOR * elapsedDays / stability, -0.5); }
  function novaDifficulty(D, rating) { return clamp(W[7] * W[4] + (1 - W[7]) * (D - W[6] * (rating - 3)), 1, 10); }
  function updateState(rs, rating) {
    const hojeIso = todayIso();
    const out = { ...rs };
    if (out.state === 'new') {
      out.stability = Math.max(0.1, W[rating - 1]);
      out.difficulty = clamp(W[4] - (rating - 3) * W[5], 1, 10);
    } else {
      const elapsed = out.lastReviewedAt ? Math.max(0, diffDaysIso(out.lastReviewedAt.slice(0, 10), hojeIso)) : 0;
      const R = recall(elapsed, out.stability);
      if (rating === 1) {
        out.stability = Math.max(0.1, W[11] * Math.pow(out.difficulty, -W[12]) * (Math.pow(out.stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)));
        out.difficulty = novaDifficulty(out.difficulty, 1);
        out.lapses += 1;
      } else {
        const hardPenalty = rating === 2 ? W[15] : 1;
        const easyBonus = rating === 4 ? W[16] : 1;
        out.stability = Math.max(0.1, out.stability * (1 + Math.exp(W[8]) * (11 - out.difficulty) * Math.pow(out.stability, -W[9]) * (Math.exp((1 - R) * W[10]) - 1) * hardPenalty * easyBonus));
        out.difficulty = novaDifficulty(out.difficulty, rating);
      }
    }
    out.reps += 1;
    out.lastReviewedAt = new Date().toISOString();
    const intervalo = rating === 1 ? 0 : Math.max(1, Math.round(out.stability));
    out.dueDate = addDaysIso(hojeIso, intervalo);
    out.nextDueAt = null;
    out.state = rating === 1 ? 'learning' : 'review';
    out.clamped = false;
    if (out.reps >= 4 && out.difficulty <= 3.5 && out.lapses === 0 && rating >= 3) out.state = 'mastered';
    return { newState: out, intervaloFinal: intervalo, intervaloAlvoCalculado: out.stability };
  }

  function calculateStats() {
    const allQuestions = stores().questoes || [];
    const allStates = stores().reviewStates || [];
    const today = todayIso();
    const out = { total: allQuestions.length, visitadas: 0, novas: 0, devidas: 0, atrasadas: 0, dominadas: 0 };
    for (const rs of allStates) {
      if ((rs.reps || 0) > 0) out.visitadas += 1;
      if (rs.state === 'mastered') out.dominadas += 1;
      else if (rs.state === 'new') out.novas += 1;
      else if (rs.dueDate < today) out.atrasadas += 1;
      else if (rs.dueDate === today) out.devidas += 1;
    }
    return out;
  }

  function nextQuestion() {
    const questions = stores().questoes || [];
    const today = todayIso();
    const candidates = questions.map((q) => ({ q, rs: getReviewState(q.id) }));
    const due = candidates
      .filter((item) => item.rs.state !== 'mastered' && item.rs.state !== 'new' && item.rs.dueDate <= today)
      .sort((a, b) => String(a.rs.dueDate || '').localeCompare(String(b.rs.dueDate || '')));
    if (due.length) return due[0];
    const fresh = candidates.find((item) => item.rs.state === 'new');
    if (fresh) return fresh;
    return candidates.find((item) => item.rs.state !== 'mastered') || null;
  }

  function renderHome() {
    const stats = calculateStats();
    const pendingCount = state.pending.reviewLogs.length;
    const tokenSaved = !!localStorage.getItem(TOKEN_KEY);
    app.innerHTML = `
      <section class="panel">
        <h1>Avulsas Android</h1>
        <p class="muted">Snapshot ${escapeHtml(state.manifest.snapshotId)}.</p>
        ${state.message ? `<p class="${state.messageType || 'muted'}">${escapeHtml(state.message)}</p>` : ''}
        <div class="stats">
          <div class="stat"><strong>${stats.total}</strong><span>questoes</span></div>
          <div class="stat"><strong>${stats.devidas + stats.atrasadas}</strong><span>para hoje</span></div>
          <div class="stat"><strong>${stats.dominadas}</strong><span>dominadas</span></div>
          <div class="stat"><strong>${pendingCount}</strong><span>pendentes</span></div>
        </div>
        <div class="actions">
          <button class="primary" id="btn-study">Estudar</button>
          <button id="btn-sync">Sincronizar</button>
        </div>
      </section>
      <section class="panel">
        <h2>GitHub</h2>
        <p class="muted">${tokenSaved ? 'Token salvo neste aparelho.' : 'Cole o token fine-grained uma vez neste aparelho.'}</p>
        <input id="github-token" type="password" autocomplete="off" placeholder="GitHub token">
        <div class="actions" style="margin-top:8px">
          <button id="btn-save-token">Salvar token</button>
          <button id="btn-clear-token" class="danger">Apagar token</button>
        </div>
      </section>
    `;
    document.getElementById('btn-study').onclick = () => {
      state.current = nextQuestion();
      state.answered = null;
      renderQuestion();
    };
    document.getElementById('btn-sync').onclick = syncNow;
    document.getElementById('btn-save-token').onclick = () => {
      const value = document.getElementById('github-token').value.trim();
      if (!value) return;
      localStorage.setItem(TOKEN_KEY, value);
      state.message = 'Token salvo neste aparelho.';
      state.messageType = 'ok';
      renderHome();
    };
    document.getElementById('btn-clear-token').onclick = () => {
      localStorage.removeItem(TOKEN_KEY);
      state.message = 'Token apagado deste aparelho.';
      state.messageType = 'muted';
      renderHome();
    };
  }

  function renderQuestion() {
    const current = state.current;
    if (!current) {
      state.message = 'Nenhuma questao disponivel neste snapshot.';
      state.messageType = 'muted';
      renderHome();
      return;
    }
    const q = current.q;
    const answered = state.answered;
    const alternatives = q.tipo === 'ME' && Array.isArray(q.alternativas)
      ? q.alternativas.map((alt) => `<button class="alternative" data-answer="${escapeHtml(alt.letra)}"><strong>${escapeHtml(alt.letra)})</strong> ${escapeHtml(alt.texto)}</button>`).join('')
      : `
        <button class="alternative" data-answer="C">Certo</button>
        <button class="alternative" data-answer="E">Errado</button>
      `;
    app.innerHTML = `
      <section class="panel">
        <div class="topbar">
          <button id="btn-home">Inicio</button>
          <span class="pill">${escapeHtml(current.rs.state || 'new')}</span>
        </div>
        <p class="muted">${escapeHtml(q.categoria || 'prova')} ${q.numeroOriginal ? `Q${escapeHtml(q.numeroOriginal)}` : ''}</p>
        <div class="question">${escapeHtml(q.enunciado || '')}</div>
      </section>
      <section class="panel">
        <div class="alternatives">${alternatives}</div>
      </section>
      ${answered ? renderAnswered(q, answered) : ''}
    `;
    document.getElementById('btn-home').onclick = renderHome;
    Array.from(document.querySelectorAll('[data-answer]')).forEach((btn) => {
      btn.onclick = () => {
        const choice = btn.getAttribute('data-answer');
        state.answered = { choice, correct: String(choice).toUpperCase() === String(q.respostaCorreta || '').toUpperCase() };
        renderQuestion();
      };
    });
    Array.from(document.querySelectorAll('[data-rating]')).forEach((btn) => {
      btn.onclick = async () => {
        await applyRating(Number(btn.getAttribute('data-rating')));
        state.current = nextQuestion();
        state.answered = null;
        renderQuestion();
      };
    });
  }

  function renderAnswered(q, answered) {
    return `
      <section class="panel">
        <div class="answer-box">
          <p><strong>${answered.correct ? 'Acertou' : 'Errou'}.</strong> Gabarito: ${escapeHtml(q.respostaCorreta || '-')}</p>
          ${q.fundamentacao ? `<p>${escapeHtml(q.fundamentacao)}</p>` : ''}
        </div>
        <h2>Rating FSRS</h2>
        <div class="actions">
          <button data-rating="1">Errei</button>
          <button data-rating="2">Dificil</button>
          <button data-rating="3" class="primary">Bom</button>
          <button data-rating="4">Facil</button>
        </div>
      </section>
    `;
  }

  async function applyRating(rating) {
    const q = state.current.q;
    const before = getReviewState(q.id);
    const result = updateState(before, rating);
    const after = result.newState;
    const log = {
      id: uid(),
      questaoId: q.id,
      revisadoEm: new Date().toISOString(),
      rating,
      intervaloAnterior: before.dueDate,
      novoIntervalo: after.dueDate,
      intervaloDias: result.intervaloFinal,
      intervaloAlvo: result.intervaloAlvoCalculado,
      stabilityAntes: before.stability,
      stabilityDepois: after.stability,
      difficultyAntes: before.difficulty,
      difficultyDepois: after.difficulty,
      repsDepois: after.reps,
      state: after.state,
      clamped: after.clamped,
      origem: 'gitpages-android'
    };
    putReviewState(after);
    putReviewLog(log);
    await persistState();
  }

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `android-${uid()}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  async function validatePassword() {
    const password = prompt('Senha para sincronizar:');
    if (password === null) return false;
    const hash = await sha256Hex(PASSWORD_SALT + password);
    return hash === PASSWORD_HASH;
  }

  async function syncNow() {
    try {
      if (!(await validatePassword())) {
        state.message = 'Senha incorreta.';
        state.messageType = 'danger';
        renderHome();
        return;
      }
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) throw new Error('Token GitHub nao configurado neste aparelho.');
      if (state.pending.reviewLogs.length === 0) {
        await refreshSnapshotAfterSync();
        state.message = 'Sem revisoes pendentes. Snapshot conferido.';
        state.messageType = 'ok';
        renderHome();
        return;
      }
      const packageId = `${Date.now()}-${uid()}`;
      const payload = {
        kind: 'avulsas-mobile-sync-package',
        schema: 1,
        deviceId: getDeviceId(),
        packageId,
        baseSnapshotId: state.manifest.snapshotId,
        createdAt: new Date().toISOString(),
        changes: {
          reviewStates: Object.values(state.pending.reviewStates),
          reviewLogs: state.pending.reviewLogs
        },
        stats: {
          respondidas: state.pending.reviewLogs.length,
          reviewLogs: state.pending.reviewLogs.length
        }
      };
      const envelope = await encryptJson(payload, state.manifest.sync.syncKey);
      const sync = state.manifest.sync;
      const filePath = `${sync.inboxPrefix}/${encodeURIComponent(getDeviceId())}/${packageId}.enc`;
      const url = `https://api.github.com/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}/contents/${filePath}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({
          message: `avulsas android sync ${packageId}`,
          branch: sync.branch,
          content: btoa(JSON.stringify(envelope, null, 2) + '\n')
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.message || `GitHub HTTP ${response.status}`);
      state.pending = { reviewLogs: [], reviewStates: {} };
      await persistState();
      state.message = 'Revisoes enviadas. Sincronize no PC para consolidar.';
      state.messageType = 'ok';
      renderHome();
    } catch (error) {
      state.message = error && error.message ? error.message : String(error);
      state.messageType = 'danger';
      renderHome();
    }
  }

  async function refreshSnapshotAfterSync() {
    const remote = await loadRemoteSnapshot();
    if (state.pending.reviewLogs.length > 0 && remote.manifest.snapshotId !== state.manifest.snapshotId) {
      throw new Error('Ha revisoes pendentes. Sincronize antes de trocar o snapshot.');
    }
    state.manifest = remote.manifest;
    state.data = remote.data;
    await persistState();
  }

  async function boot() {
    try {
      const savedPending = await kvGet('pending', { reviewLogs: [], reviewStates: {} });
      state.pending = savedPending || { reviewLogs: [], reviewStates: {} };
      const remote = await loadRemoteSnapshot();
      const savedManifest = await kvGet('manifest', null);
      const savedData = await kvGet('data', null);
      const hasPending = state.pending.reviewLogs.length > 0;
      if (hasPending && savedManifest && savedData && savedManifest.snapshotId !== remote.manifest.snapshotId) {
        state.manifest = savedManifest;
        state.data = savedData;
        state.message = 'Ha revisoes pendentes. Sincronize antes de trocar o snapshot.';
        state.messageType = 'danger';
      } else {
        state.manifest = remote.manifest;
        state.data = remote.data;
        await persistState();
      }
      renderHome();
    } catch (error) {
      app.innerHTML = `<section class="panel"><h1>Falha ao abrir</h1><p class="danger">${escapeHtml(error.message || error)}</p></section>`;
    }
  }

  boot();
})();

import { FSRS_CORE_VERSION, reviewStateKey, updateState } from './fsrs-core.js';

(function () {
  'use strict';

  const DB_NAME = 'avulsas_gitpages_mobile';
  const DB_VERSION = 1;
  const TOKEN_KEY = 'avulsasGitpagesGithubToken';
  const DEVICE_KEY = 'avulsasGitpagesDeviceId';
  const FONT_SCALE_KEY = 'avulsasGitpagesFontScale';
  const FONT_SCALE_MIN = 0.9;
  const FONT_SCALE_MAX = 1.34;
  const FONT_SCALE_STEP = 0.08;
  const app = document.getElementById('app');

  let dbPromise = null;
  let state = {
    manifest: null,
    data: null,
    pending: { reviewLogs: [], reviewStates: {} },
    sentPackages: [],
    current: null,
    answered: null,
    message: ''
  };

  applyFontScale(getFontScale());

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getFontScale() {
    const raw = Number(localStorage.getItem(FONT_SCALE_KEY));
    if (!Number.isFinite(raw)) return 1;
    return clampNumber(raw, FONT_SCALE_MIN, FONT_SCALE_MAX);
  }

  function applyFontScale(value) {
    const scale = clampNumber(Number(value) || 1, FONT_SCALE_MIN, FONT_SCALE_MAX);
    document.documentElement.style.setProperty('--font-scale', scale.toFixed(2));
    localStorage.setItem(FONT_SCALE_KEY, scale.toFixed(2));
    return scale;
  }

  function changeFontScale(delta) {
    const scale = applyFontScale(getFontScale() + delta);
    updateFontControlState(scale);
  }

  function fontControlsMarkup() {
    const scale = getFontScale();
    return `
      <div class="font-control" aria-label="Tamanho da fonte">
        <button type="button" id="btn-font-decrease" aria-label="Diminuir fonte" title="Diminuir fonte"${scale <= FONT_SCALE_MIN ? ' disabled' : ''}>-</button>
        <span aria-hidden="true">A</span>
        <button type="button" id="btn-font-increase" aria-label="Aumentar fonte" title="Aumentar fonte"${scale >= FONT_SCALE_MAX ? ' disabled' : ''}>+</button>
      </div>
    `;
  }

  function updateFontControlState(scale = getFontScale()) {
    const decrease = document.getElementById('btn-font-decrease');
    const increase = document.getElementById('btn-font-increase');
    if (decrease) decrease.disabled = scale <= FONT_SCALE_MIN;
    if (increase) increase.disabled = scale >= FONT_SCALE_MAX;
  }

  function bindFontControls() {
    const decrease = document.getElementById('btn-font-decrease');
    const increase = document.getElementById('btn-font-increase');
    if (decrease) decrease.onclick = () => changeFontScale(-FONT_SCALE_STEP);
    if (increase) increase.onclick = () => changeFontScale(FONT_SCALE_STEP);
    updateFontControlState();
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

  function normalizarDataIso(valor) {
    const text = String(valor || '').trim();
    if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const dt = new Date(`${text}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function parseIsoTime(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const time = Date.parse(text);
    return Number.isNaN(time) ? null : time;
  }

  function reviewDisponivelAgora(rs, agoraIso = new Date().toISOString()) {
    if (!rs || !rs.nextDueAt) return true;
    const dueTime = parseIsoTime(rs.nextDueAt);
    if (dueTime === null) return true;
    const nowTime = parseIsoTime(agoraIso);
    return nowTime === null || dueTime <= nowTime;
  }

  function normalizarId(value) {
    return String(value == null ? '' : value).trim();
  }

  function reviewStateQuestaoId(row) {
    return normalizarId(row && (row.questaoId || row.id || row.key));
  }

  function reviewStateTimestamp(row) {
    const value = row && (row.lastReviewedAt || row.atualizadoEm || row.updatedAt || '');
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : time;
  }

  function deveSubstituirReviewState(incoming, current) {
    if (!current) return true;
    const a = reviewStateTimestamp(incoming);
    const b = reviewStateTimestamp(current);
    if (a !== b) return a > b;
    return Number(incoming && incoming.reps || 0) >= Number(current && current.reps || 0);
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
    return { manifest: privateManifest, data: normalizarSnapshotData(data) };
  }

  async function persistState() {
    if (state.data) state.data = normalizarSnapshotData(state.data);
    state.pending = normalizarPending(state.pending);
    await kvSet('manifest', state.manifest);
    await kvSet('data', state.data);
    await kvSet('pending', state.pending);
    await kvSet('sentPackages', state.sentPackages);
  }

  function normalizarPending(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const reviewStates = source.reviewStates && typeof source.reviewStates === 'object' && !Array.isArray(source.reviewStates)
      ? source.reviewStates
      : {};
    return {
      reviewLogs: Array.isArray(source.reviewLogs) ? source.reviewLogs : [],
      reviewStates
    };
  }

  function stores() {
    return state.data && state.data.stores ? state.data.stores : {};
  }

  function storeRows(name) {
    const rows = stores()[name];
    return Array.isArray(rows) ? rows : [];
  }

  function findStoreRow(name, id) {
    const key = normalizarId(id);
    if (!key) return null;
    return storeRows(name).find((row) => normalizarId(row && row.id) === key) || null;
  }

  function questionTags(q) {
    return Array.isArray(q && q.tags)
      ? q.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
  }

  function questionContextMarkup(q) {
    const disciplina = findStoreRow('disciplinas', q && q.disciplinaId);
    const materia = findStoreRow('materias', q && q.materiaId);
    const parts = [
      disciplina && disciplina.nome ? disciplina.nome : '',
      materia && materia.nome ? materia.nome : ''
    ].filter(Boolean);
    const title = parts.length ? parts.join(' / ') : (q && q.categoria ? q.categoria : 'Questao');
    const tags = questionTags(q);
    return `
      <div class="question-context">
        <p class="question-context-title">${escapeHtml(title)}</p>
        ${tags.length ? `<div class="question-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      </div>
    `;
  }

  function getConfigValue(key, fallback = null) {
    const rows = stores().config || [];
    const found = Array.isArray(rows) ? rows.find((row) => row && row.key === key) : null;
    return found ? found.value : fallback;
  }

  function criarReviewStateAPartirDoLog(questaoId, log) {
    const base = novoReviewState(questaoId);
    if (!log) return base;
    const repsDepois = Number(log.repsDepois || 0);
    const rating = Number(log.rating || 0);
    const state = String(log.state || (rating === 1 ? 'learning' : 'review'));
    return {
      ...base,
      stability: Number(log.stabilityDepois || base.stability),
      difficulty: Number(log.difficultyDepois || base.difficulty),
      dueDate: String(log.novoIntervalo || base.dueDate),
      lastReviewedAt: String(log.revisadoEm || base.lastReviewedAt || ''),
      reps: Math.max(1, repsDepois || 1),
      state: ['new', 'learning', 'review', 'mastered'].includes(state) ? state : 'review',
      clamped: !!log.clamped
    };
  }

  function indexarLogsPorQuestao(logs) {
    const out = new Map();
    for (const log of Array.isArray(logs) ? logs : []) {
      const questaoId = normalizarId(log && log.questaoId);
      if (!questaoId) continue;
      const atual = out.get(questaoId);
      const atualTime = atual ? Date.parse(atual.revisadoEm || '') || 0 : 0;
      const logTime = Date.parse(log.revisadoEm || '') || 0;
      if (!atual || logTime >= atualTime) out.set(questaoId, log);
    }
    return out;
  }

  function indexarReviewStates(rows) {
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const questaoId = reviewStateQuestaoId(row);
      if (!questaoId) continue;
      const normalized = row.questaoId === questaoId ? row : { ...row, questaoId };
      if (deveSubstituirReviewState(normalized, out.get(questaoId))) {
        out.set(questaoId, normalized);
      }
    }
    return out;
  }

  function normalizarSnapshotData(data) {
    const snapshot = data && typeof data === 'object' ? data : {};
    const s = snapshot.stores && typeof snapshot.stores === 'object' ? snapshot.stores : {};
    const questoes = Array.isArray(s.questoes) ? s.questoes : [];
    const qIds = new Set(questoes.map((q) => normalizarId(q && q.id)).filter(Boolean));
    const stateByQuestao = indexarReviewStates(s.reviewStates);
    const logByQuestao = indexarLogsPorQuestao(s.reviewLogs);
    const reviewStates = [];

    for (const questao of questoes) {
      const questaoId = normalizarId(questao && questao.id);
      if (!questaoId) continue;
      const existing = stateByQuestao.get(questaoId);
      reviewStates.push(existing || criarReviewStateAPartirDoLog(questaoId, logByQuestao.get(questaoId)));
    }

    for (const [questaoId, row] of stateByQuestao.entries()) {
      if (!qIds.has(questaoId)) continue;
      if (!reviewStates.some((item) => reviewStateQuestaoId(item) === questaoId)) reviewStates.push(row);
    }

    snapshot.stores = { ...s, questoes, reviewStates };
    return snapshot;
  }

  function getReviewState(questaoId) {
    const id = normalizarId(questaoId);
    if (!id) return novoReviewState('');
    return indexarReviewStates(stores().reviewStates).get(id) || novoReviewState(id);
  }

  function putReviewState(row) {
    const questaoId = reviewStateQuestaoId(row);
    if (!questaoId) return;
    const normalized = row.questaoId === questaoId ? row : { ...row, questaoId };
    const all = stores().reviewStates || (stores().reviewStates = []);
    const idx = all.findIndex((item) => reviewStateQuestaoId(item) === questaoId);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    state.pending.reviewStates[questaoId] = normalized;
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

  function calculateStats() {
    const allQuestions = stores().questoes || [];
    const stateByQuestao = indexarReviewStates(stores().reviewStates);
    const today = todayIso();
    const out = { total: allQuestions.length, visitadas: 0, novas: 0, devidas: 0, atrasadas: 0, dominadas: 0 };
    for (const q of allQuestions) {
      const questaoId = normalizarId(q && q.id);
      if (!questaoId) continue;
      const rs = stateByQuestao.get(questaoId) || novoReviewState(questaoId);
      if ((rs.reps || 0) > 0) out.visitadas += 1;
      if (rs.state === 'mastered') out.dominadas += 1;
      else if (rs.state === 'new') out.novas += 1;
      else if (rs.dueDate < today) out.atrasadas += 1;
      else if (rs.dueDate === today && reviewDisponivelAgora(rs)) out.devidas += 1;
    }
    return out;
  }

  function studyAvailability() {
    const stats = calculateStats();
    const dueCount = stats.devidas + stats.atrasadas;
    const totalParaEstudar = dueCount + stats.novas;
    return {
      stats,
      dueCount,
      totalParaEstudar,
      canStudy: totalParaEstudar > 0,
      reason: totalParaEstudar > 0 ? '' : 'Nenhuma questao para estudar.'
    };
  }

  function nextQuestion() {
    const questions = stores().questoes || [];
    const today = todayIso();
    const candidates = questions.map((q) => ({ q, rs: getReviewState(q.id) }));
    const scheduled = candidates.filter((item) => item.rs.state !== 'mastered' && item.rs.state !== 'new');
    const overdue = scheduled
      .filter((item) => item.rs.dueDate < today)
      .sort((a, b) => String(a.rs.dueDate || '').localeCompare(String(b.rs.dueDate || '')));
    if (overdue.length) return overdue[0];

    const dueToday = scheduled
      .filter((item) => item.rs.dueDate === today && reviewDisponivelAgora(item.rs))
      .sort((a, b) => Number(b.rs.difficulty || 0) - Number(a.rs.difficulty || 0));
    if (dueToday.length) return dueToday[0];

    const nova = candidates.find((item) => item.rs.state === 'new');
    if (nova) return nova;

    return null;
  }

  function renderHome() {
    const availability = studyAvailability();
    const stats = availability.stats;
    const pendingCount = state.pending.reviewLogs.length;
    const sentCount = Array.isArray(state.sentPackages) ? state.sentPackages.length : 0;
    const tokenSaved = !!localStorage.getItem(TOKEN_KEY);
    app.innerHTML = `
      <section class="panel">
        <div class="topbar">
          <div class="topbar-title">
            <h1>Avulsas Android</h1>
            <p class="muted">Snapshot ${escapeHtml(state.manifest.snapshotId)}.</p>
          </div>
          ${fontControlsMarkup()}
        </div>
        ${state.message ? `<p class="message ${state.messageType || 'muted'}">${escapeHtml(state.message)}</p>` : ''}
        <div class="stats">
          <div class="stat"><strong>${stats.total}</strong><span>questoes</span></div>
          <div class="stat stat-primary"><strong>${availability.totalParaEstudar}</strong><span>para estudar</span></div>
          <div class="stat"><strong>${stats.devidas + stats.atrasadas}</strong><span>revisoes hoje</span></div>
          <div class="stat"><strong>${stats.novas}</strong><span>novas ineditas</span></div>
          <div class="stat"><strong>${pendingCount}</strong><span>a sincronizar</span></div>
        </div>
        ${!availability.canStudy ? `<p class="message muted">${escapeHtml(availability.reason)}</p>` : ''}
        ${sentCount ? `<p class="message muted">${sentCount} pacote(s) enviado(s), aguardando sincronizacao no PC.</p>` : ''}
        <div class="actions">
          <button class="primary" id="btn-study"${availability.canStudy ? '' : ' disabled'}>Estudar</button>
          <button id="btn-sync">Sincronizar</button>
        </div>
      </section>
      <section class="panel">
        <h2>GitHub</h2>
        <p class="muted">${tokenSaved ? 'Token salvo neste aparelho.' : 'Cole o token fine-grained uma vez neste aparelho.'}</p>
        <input id="github-token" type="password" autocomplete="off" placeholder="GitHub token">
        <div class="actions token-actions">
          <button id="btn-save-token">Salvar token</button>
          <button id="btn-clear-token" class="danger">Apagar token</button>
        </div>
      </section>
    `;
    bindFontControls();
    document.getElementById('btn-study').onclick = async () => {
      if (!studyAvailability().canStudy) {
        state.message = 'Nenhuma questao para estudar.';
        state.messageType = 'muted';
        renderHome();
        return;
      }
      try {
        state.current = nextQuestion();
        state.answered = null;
        if (!state.current) {
          state.message = 'Nenhuma questao para estudar neste snapshot.';
          state.messageType = 'muted';
          renderHome();
          return;
        }
        renderQuestion();
      } catch (error) {
        state.message = error && error.message ? error.message : String(error);
        state.messageType = 'danger';
        renderHome();
      }
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
    const answerDisabled = answered ? ' disabled' : '';
    const alternatives = q.tipo === 'ME' && Array.isArray(q.alternativas)
      ? q.alternativas.map((alt) => `<button class="alternative" data-answer="${escapeHtml(alt.letra)}"${answerDisabled}><strong>${escapeHtml(alt.letra)})</strong> ${escapeHtml(alt.texto)}</button>`).join('')
      : `
        <button class="alternative" data-answer="C"${answerDisabled}>Certo</button>
        <button class="alternative" data-answer="E"${answerDisabled}>Errado</button>
      `;
    app.innerHTML = `
      <section class="panel">
        <div class="topbar">
          <div class="topbar-left">
            <button id="btn-home">Inicio</button>
            <span class="pill">${escapeHtml(current.rs.state || 'new')}</span>
          </div>
          ${fontControlsMarkup()}
        </div>
        ${questionContextMarkup(q)}
        <div class="question">${escapeHtml(q.enunciado || '')}</div>
      </section>
      <section class="panel">
        <div class="alternatives">${alternatives}</div>
      </section>
      ${answered ? renderAnswered(q, answered) : ''}
    `;
    bindFontControls();
    document.getElementById('btn-home').onclick = renderHome;
    Array.from(document.querySelectorAll('[data-answer]')).forEach((btn) => {
      btn.onclick = async () => {
        const choice = btn.getAttribute('data-answer');
        const correct = String(choice).toUpperCase() === String(q.respostaCorreta || '').toUpperCase();
        state.answered = { choice, correct };
        if (!correct) {
          try {
            await applyRating(1);
            state.answered.ratingApplied = 1;
          } catch (error) {
            state.message = error && error.message ? error.message : String(error);
            state.messageType = 'danger';
          }
        }
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
    const nextBtn = document.getElementById('btn-next-answer');
    if (nextBtn) {
      nextBtn.onclick = () => {
        state.current = nextQuestion();
        state.answered = null;
        renderQuestion();
      };
    }
    if (answered) {
      requestAnimationFrame(() => {
        const answerPanel = document.getElementById('answer-panel');
        if (answerPanel) answerPanel.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    }
  }

  function renderAnswered(q, answered) {
    const ratingActions = answered.correct
      ? `
        <h2>Como foi?</h2>
        <div class="actions rating-actions rating-actions-correct">
          <button data-rating="2" class="rating-hard">Dificil</button>
          <button data-rating="3" class="rating-good">Bom</button>
          <button data-rating="4" class="rating-easy">Facil</button>
        </div>
      `
      : `
        <div class="actions answer-actions">
          <button id="btn-next-answer" class="primary">Proxima</button>
        </div>
      `;
    return `
      <section class="panel" id="answer-panel">
        <div class="answer-box">
          <p><strong>${answered.correct ? 'Acertou' : 'Errou'}.</strong> Gabarito: ${escapeHtml(q.respostaCorreta || '-')}</p>
          ${q.fundamentacao ? `<p>${escapeHtml(q.fundamentacao)}</p>` : ''}
        </div>
        ${ratingActions}
      </section>
    `;
  }

  async function applyRating(rating) {
    const q = state.current.q;
    const before = getReviewState(q.id);
    const hoje = todayIso();
    const agora = new Date().toISOString();
    const dataObjetivoIso = normalizarDataIso(getConfigValue('dataObjetivo', null));
    const result = updateState(before, rating, hoje, dataObjetivoIso, agora);
    const after = result.newState;
    const log = {
      id: uid(),
      questaoId: q.id,
      revisadoEm: agora,
      hojeIso: hoje,
      dataObjetivoIso,
      rating,
      fsrsCoreVersion: FSRS_CORE_VERSION,
      baseStateKey: reviewStateKey(before),
      afterStateKey: reviewStateKey(after),
      stateAntes: { ...before },
      stateDepois: { ...after },
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
    if (state.current && state.current.q && normalizarId(state.current.q.id) === normalizarId(q.id)) {
      state.current.rs = after;
    }
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

  async function syncNow() {
    try {
      if (state.pending.reviewLogs.length === 0) {
        await refreshSnapshotAfterSync();
        state.message = 'Snapshot conferido. Nao havia respostas locais para enviar.';
        state.messageType = 'ok';
        renderHome();
        return;
      }
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) throw new Error('Token GitHub nao configurado neste aparelho.');
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
      state.sentPackages = [
        ...(Array.isArray(state.sentPackages) ? state.sentPackages : []),
        { packageId, createdAt: payload.createdAt, reviewLogs: state.pending.reviewLogs.length }
      ].slice(-12);
      state.pending = { reviewLogs: [], reviewStates: {} };
      await persistState();
      state.message = 'Respostas enviadas. Agora sincronize no PC para consolidar.';
      state.messageType = 'ok';
      renderHome();
    } catch (error) {
      state.message = error && error.message ? error.message : String(error);
      state.messageType = 'danger';
      renderHome();
    }
  }

  async function refreshSnapshotAfterSync() {
    const previousSnapshotId = state.manifest && state.manifest.snapshotId || '';
    const remote = await loadRemoteSnapshot();
    if (state.pending.reviewLogs.length > 0 && remote.manifest.snapshotId !== state.manifest.snapshotId) {
      throw new Error('Ha revisoes pendentes. Sincronize antes de trocar o snapshot.');
    }
    state.manifest = remote.manifest;
    state.data = remote.data;
    if (previousSnapshotId && remote.manifest.snapshotId !== previousSnapshotId) {
      state.sentPackages = [];
    }
    await persistState();
  }

  async function boot() {
    try {
      const savedPending = await kvGet('pending', { reviewLogs: [], reviewStates: {} });
      state.pending = normalizarPending(savedPending);
      const savedSentPackages = await kvGet('sentPackages', []);
      state.sentPackages = Array.isArray(savedSentPackages) ? savedSentPackages : [];
      const savedManifest = await kvGet('manifest', null);
      const savedData = await kvGet('data', null);
      const hasPending = state.pending.reviewLogs.length > 0;
      const hasSavedSnapshot = !!(savedManifest && savedData && savedManifest.snapshotId);

      if (!hasSavedSnapshot) {
        const remote = await loadRemoteSnapshot();
        state.manifest = remote.manifest;
        state.data = remote.data;
        await persistState();
        renderHome();
        return;
      }

      state.manifest = savedManifest;
      state.data = normalizarSnapshotData(savedData);

      try {
        const remote = await loadRemoteSnapshot();
        if (remote.manifest.snapshotId !== savedManifest.snapshotId) {
          state.message = hasPending
            ? 'Snapshot novo disponivel. Envie as respostas locais antes de atualizar.'
            : 'Snapshot novo disponivel. Toque em Sincronizar para atualizar.';
          state.messageType = hasPending ? 'danger' : 'muted';
        }
      } catch (error) {
        state.message = 'Nao foi possivel conferir snapshot remoto. Usando copia local.';
        state.messageType = 'muted';
      }

      if (hasPending) {
        state.manifest = savedManifest;
        state.data = normalizarSnapshotData(savedData);
      }
      await persistState();
      renderHome();
    } catch (error) {
      app.innerHTML = `<section class="panel"><h1>Falha ao abrir</h1><p class="danger">${escapeHtml(error.message || error)}</p></section>`;
    }
  }

  boot();
})();

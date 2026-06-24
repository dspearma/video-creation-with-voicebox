/* ══════════════════════════════════════════════════════════
   EduVid Studio — Frontend Application
   Vanilla JS • State Machine • API Client • WebSocket
   ══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────
  const API = window.location.origin;
  const WS_URL = `ws://${window.location.host}`;

  // Normalize scene fields from snake_case (API/Gemini) to camelCase (frontend)
  function normalizeScene(s) {
    return {
      ...s,
      flowPrompt: s.flowPrompt || s.flow_prompt || '',
      visualType: s.visualType || s.visual_type || '',
      pacingNotes: s.pacingNotes || s.pacing_notes || '',
      sceneNumber: s.sceneNumber || s.scene_number || 0,
      brandColorsUsed: s.brandColorsUsed || s.brand_colors_used || [],
      audioFile: s.audioFile || s.audio_file || null,
      audioDuration: s.audioDuration || s.audio_duration || null,
      videoFile: s.videoFile || s.video_file || null,
      mediaType: s.mediaType || s.media_type || 'video',
      kenBurnsDirection: s.kenBurnsDirection || s.ken_burns_direction || '',
      clips: s.clips || [],
      shots: s.shots || [],
      imagePrompts: s.imagePrompts || [],
      shotsPlanned: s.shotsPlanned || false,
      shotBreakdown: s.shotBreakdown || null,
    };
  }
  function normalizeScenes(scenes) { return (scenes || []).map(normalizeScene); }

  // ─────────────────────────────────────
  // STATE
  // ─────────────────────────────────────
  const state = {
    projects: [],
    currentProject: null,
    currentPhase: 1,
    scenes: [],
    researchText: '',
    voiceProfiles: [],
    selectedProfileId: null,
    audioStatus: {},   // { sceneNum: 'pending' | 'generating' | 'done' }
    videoStatus: {},   // { sceneNum: true }
    renderStatus: 'idle', // 'idle' | 'rendering' | 'done'
    ws: null,
  };

  // ─────────────────────────────────────
  // DOM REFS
  // ─────────────────────────────────────
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  const dom = {
    sidebar:               $('#sidebar'),
    projectList:           $('#project-list'),
    btnNewProject:         $('#btn-new-project'),
    btnRefresh:            $('#btn-refresh-projects'),
    btnSidebarToggle:      $('#btn-sidebar-toggle'),
    projectTitle:          $('#project-title'),
    saveIndicator:         $('#save-indicator'),
    stepper:               $('#stepper'),
    phaseContainer:        $('#phase-container'),

    // Phase 1
    researchText:          $('#research-text'),
    btnSaveResearch:       $('#btn-save-research'),
    researchDropzone:      $('#research-dropzone'),
    researchFileInput:     $('#research-file-input'),
    researchFileName:      $('#research-file-name'),
    btnGoogleAuth:         $('#btn-google-auth'),
    googleDocsPicker:      $('#google-docs-picker'),
    googleDocSelect:       $('#google-doc-select'),
    btnImportGdoc:         $('#btn-import-gdoc'),
    researchPreview:       $('#research-preview'),
    researchPreviewText:   $('#research-preview-text'),
    researchWordCount:     $('#research-word-count'),

    // Phase 2
    learningObjective:     $('#learning-objective'),
    btnGenerateScript:     $('#btn-generate-script'),
    generateScriptSpinner: $('#generate-script-spinner'),
    scenesContainer:       $('#scenes-container'),
    scenesActions:         $('#scenes-actions'),
    btnSaveScenes:         $('#btn-save-scenes'),
    btnAddScene:           $('#btn-add-scene'),

    // Phase 3
    voiceProfileSelect:    $('#voice-profile-select'),
    voiceboxStatus:        $('#voicebox-status'),
    btnGenerateAudio:      $('#btn-generate-audio'),
    generateAudioSpinner:  $('#generate-audio-spinner'),
    audioScenesContainer:  $('#audio-scenes-container'),

    // Phase 4
    videoScenesContainer:  $('#video-scenes-container'),

    // Phase 5 - Export
    btnDlScript:           $('#btn-dl-script'),
    btnDlAudio:            $('#btn-dl-audio'),
    btnDlChart:            $('#btn-dl-chart'),

    // Modal
    modalNewProject:       $('#modal-new-project'),
    newProjectName:        $('#new-project-name'),
    newProjectObjective:   $('#new-project-objective'),
    btnCreateProject:      $('#btn-create-project'),
    btnCancelProject:      $('#btn-cancel-project'),

    // Toast
    toastContainer:        $('#toast-container'),
  };

  // ─────────────────────────────────────
  // UTILS
  // ─────────────────────────────────────
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    el.innerHTML = `<span>${icons[type] || 'ℹ'}</span> <span>${msg}</span>`;
    dom.toastContainer.appendChild(el);
    setTimeout(() => { el.style.animation = 'toastOut 300ms forwards'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  async function api(path, opts = {}) {
    const url = `${API}${path}`;
    const config = { headers: { 'Content-Type': 'application/json' }, ...opts };
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      config.body = JSON.stringify(opts.body);
    }
    if (opts.body instanceof FormData) {
      delete config.headers['Content-Type'];
    }
    try {
      const res = await fetch(url, config);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || err.message || `HTTP ${res.status}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) return res.json();
      return res;
    } catch (e) {
      toast(e.message, 'error');
      throw e;
    }
  }

  function flashSave() {
    dom.saveIndicator.classList.remove('hidden');
    setTimeout(() => dom.saveIndicator.classList.add('hidden'), 2500);
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  // ─────────────────────────────────────
  // WEBSOCKET
  // ─────────────────────────────────────
  function connectWS() {
    try {
      state.ws = new WebSocket(WS_URL);
      state.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleWSMessage(msg);
        } catch {}
      };
      state.ws.onclose = () => { setTimeout(connectWS, 3000); };
      state.ws.onerror = () => {};
    } catch {}
  }

  function handleWSMessage(msg) {
    if (msg.type === 'render-progress') {
      const pct = Math.round((msg.scene / msg.total) * 100);
      dom.renderProgressBar.style.width = pct + '%';
      dom.renderProgressLabel.textContent = `Scene ${msg.scene}/${msg.total} — ${msg.status}`;
      if (msg.scene === msg.total && msg.status === 'done') {
        finishRender();
      }
    } else if (msg.type === 'audio-progress') {
      state.audioStatus[msg.scene] = msg.status === 'done' ? 'done' : 'generating';
      renderAudioScenes();
      if (msg.scene === msg.total && msg.status === 'done') {
        toast('All voiceovers generated!', 'success');
        dom.btnGenerateAudio.disabled = false;
        dom.generateAudioSpinner.classList.add('hidden');
        updateStepperAccess();
      }
    } else if (msg.type === 'shot-planning-progress') {
      if (msg.status === 'done') {
        toast(`Scene ${msg.scene} — ${msg.shotCount} shots planned`, 'success');
        // Reload project to get updated shot data
        reloadProjectScenes();
      } else {
        toast(`Planning shots for Scene ${msg.scene}...`, 'info');
      }
    } else if (msg.type === 'shot-planning-complete') {
      toast('All video scene shots planned!', 'success');
    } else if (msg.type === 'shot-planning-error') {
      toast(`Shot planning failed for Scene ${msg.scene}: ${msg.error}`, 'error');
    }
  }

  async function reloadProjectScenes() {
    if (!state.currentProject) return;
    try {
      const project = await api(`/api/projects/${state.currentProject.id}`);
      if (project && project.scenes) {
        state.scenes = normalizeScenes(project.scenes);
        state.scenes.forEach((s, i) => {
          const num = i + 1;
          state.videoStatus[num] = (s.clips && s.clips.length > 0) || !!s.videoFile;
        });
        renderVideoScenes();
      }
    } catch {}
  }

  // ─────────────────────────────────────
  // NAVIGATION
  // ─────────────────────────────────────
  function setPhase(num) {
    if (num === state.currentPhase) return;
    const stepEl = $(`.stepper__step[data-phase="${num}"]`, dom.stepper);
    if (stepEl && stepEl.classList.contains('disabled')) {
      toast('Complete the previous phase first.', 'info');
      return;
    }
    state.currentPhase = num;

    // Stepper UI
    $$('.stepper__step', dom.stepper).forEach(s => {
      const p = +s.dataset.phase;
      s.classList.toggle('active', p === num);
    });

    // Phase panels
    $$('.phase', dom.phaseContainer).forEach(p => {
      p.classList.toggle('active', +p.dataset.phase === num);
    });

    // Lazy-load phase-specific data
    if (num === 3) { loadVoiceboxStatus(); loadVoiceProfiles(); renderAudioScenes(); }
    if (num === 4) { renderVideoScenes(); }
    if (num === 5) { updateRenderPanel(); }
  }

  function updateStepperAccess() {
    const hasProject = !!state.currentProject;
    const hasResearch = !!state.researchText;
    const hasScenes = state.scenes.length > 0;
    const hasAudio = Object.values(state.audioStatus).some(s => s === 'done');
    const hasVideo = Object.values(state.videoStatus).some(Boolean);

    const access = [
      true,           // Phase 1 always accessible
      hasResearch,    // Phase 2
      hasScenes,      // Phase 3
      hasScenes,      // Phase 4
      hasAudio && hasVideo, // Phase 5
    ];

    $$('.stepper__step', dom.stepper).forEach(s => {
      const p = +s.dataset.phase;
      const accessible = hasProject && access[p - 1];
      s.classList.toggle('disabled', !accessible);

      // Mark completed
      if (p === 1 && hasResearch) s.classList.add('completed');
      else if (p === 1) s.classList.remove('completed');

      if (p === 2 && hasScenes) s.classList.add('completed');
      else if (p === 2) s.classList.remove('completed');

      if (p === 3 && hasAudio) s.classList.add('completed');
      else if (p === 3) s.classList.remove('completed');

      if (p === 4 && hasVideo) s.classList.add('completed');
      else if (p === 4) s.classList.remove('completed');

      if (p === 5 && hasAudio) s.classList.add('completed');
      else if (p === 5) s.classList.remove('completed');
    });
  }

  // ─────────────────────────────────────
  // PROJECTS
  // ─────────────────────────────────────
  async function loadProjects() {
    try {
      const data = await api('/api/projects');
      state.projects = Array.isArray(data) ? data : data.projects || [];
      renderProjectList();
    } catch {
      state.projects = [];
      renderProjectList();
    }
  }

  function renderProjectList() {
    if (state.projects.length === 0) {
      dom.projectList.innerHTML = '<li class="sidebar__empty">No projects yet</li>';
      return;
    }
    dom.projectList.innerHTML = state.projects.map(p => `
      <li class="sidebar__project-item ${state.currentProject && state.currentProject.id === p.id ? 'active' : ''}"
          data-id="${p.id}">
        <span class="project-name" title="${esc(p.name)}">${esc(p.name)}</span>
        <button class="btn-delete-project" data-id="${p.id}" title="Delete">&times;</button>
      </li>
    `).join('');

    // Event listeners
    $$('.sidebar__project-item', dom.projectList).forEach(li => {
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-delete-project')) return;
        loadProject(li.dataset.id);
      });
    });
    $$('.btn-delete-project', dom.projectList).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProject(btn.dataset.id);
      });
    });
  }

  async function loadProject(id) {
    try {
      const project = await api(`/api/projects/${id}`);
      state.currentProject = project;
      state.scenes = normalizeScenes(project.scenes);
      state.researchText = project.researchText || project.research || '';
      state.audioStatus = {};
      state.videoStatus = {};
      state.renderStatus = project.renderStatus || 'idle';

      // Reconstruct audio/video status from project data
      state.scenes.forEach((s, i) => {
        const num = i + 1;
        state.audioStatus[num] = s.audioGenerated ? 'done' : 'pending';
        state.videoStatus[num] = (s.clips && s.clips.length > 0) || !!s.videoFile || !!s.videoUploaded;
      });

      dom.projectTitle.textContent = project.name || 'Untitled Project';
      dom.researchText.value = state.researchText;
      dom.learningObjective.value = project.learningObjective || '';

      // Show research preview if present
      if (state.researchText) {
        showResearchPreview(state.researchText);
      } else {
        dom.researchPreview.classList.add('hidden');
      }

      renderProjectList();
      renderScenes();
      updateStepperAccess();
      setPhase(1);
      toast(`Loaded: ${project.name}`, 'success');
    } catch {}
  }

  async function deleteProject(id) {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await api(`/api/projects/${id}`, { method: 'DELETE' });
      if (state.currentProject && state.currentProject.id === id) {
        state.currentProject = null;
        state.scenes = [];
        state.researchText = '';
        dom.projectTitle.textContent = 'Select or create a project';
        resetAllPhases();
      }
      toast('Project deleted', 'success');
      loadProjects();
    } catch {}
  }

  function resetAllPhases() {
    dom.researchText.value = '';
    dom.researchPreview.classList.add('hidden');
    dom.learningObjective.value = '';
    dom.scenesContainer.innerHTML = '<div class="empty-state"><span class="empty-state__icon">🎞</span><p>No scenes yet.</p></div>';
    dom.scenesActions.classList.add('hidden');
    state.audioStatus = {};
    state.videoStatus = {};
    state.renderStatus = 'idle';
    updateStepperAccess();
  }

  // ─────────────────────────────────────
  // MODAL — New Project
  // ─────────────────────────────────────
  function openModal() {
    dom.modalNewProject.classList.remove('hidden');
    dom.newProjectName.value = '';
    dom.newProjectObjective.value = '';
    setTimeout(() => dom.newProjectName.focus(), 100);
  }
  function closeModal() { dom.modalNewProject.classList.add('hidden'); }

  async function createProject() {
    const name = dom.newProjectName.value.trim();
    if (!name) { toast('Enter a project name', 'error'); return; }
    try {
      const project = await api('/api/projects', {
        method: 'POST',
        body: { name, learningObjective: dom.newProjectObjective.value.trim() },
      });
      closeModal();
      toast(`Created: ${name}`, 'success');
      await loadProjects();
      loadProject(project.id);
    } catch {}
  }

  // ─────────────────────────────────────
  // PHASE 1 — Research
  // ─────────────────────────────────────
  function showResearchPreview(text) {
    dom.researchPreview.classList.remove('hidden');
    dom.researchPreviewText.textContent = text.length > 3000 ? text.slice(0, 3000) + '…' : text;
    dom.researchWordCount.textContent = wordCount(text).toLocaleString() + ' words';
  }

  async function saveResearch(text) {
    if (!state.currentProject) { toast('Select a project first', 'error'); return; }
    try {
      await api(`/api/projects/${state.currentProject.id}/research`, {
        method: 'POST',
        body: { text },
      });
      state.researchText = text;
      showResearchPreview(text);
      flashSave();
      toast('Research saved', 'success');
      updateStepperAccess();
    } catch {}
  }

  async function uploadResearchFile(file) {
    if (!state.currentProject) { toast('Select a project first', 'error'); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
      await api(`/api/projects/${state.currentProject.id}/research`, {
        method: 'POST',
        body: formData,
      });
      // Also read file text locally for preview
      const reader = new FileReader();
      reader.onload = (e) => {
        state.researchText = e.target.result;
        dom.researchText.value = state.researchText;
        showResearchPreview(state.researchText);
        updateStepperAccess();
      };
      reader.readAsText(file);
      dom.researchFileName.classList.remove('hidden');
      dom.researchFileName.textContent = `📄 ${file.name}`;
      flashSave();
      toast('File uploaded', 'success');
    } catch {}
  }

  async function startGoogleAuth() {
    try {
      const data = await api('/auth/google/url');
      if (data.url) {
        const popup = window.open(data.url, 'Google Auth', 'width=500,height=600');
        // Poll for completion
        const check = setInterval(() => {
          try {
            if (popup.closed) {
              clearInterval(check);
              loadGoogleDocs();
            }
          } catch { clearInterval(check); }
        }, 500);
      }
    } catch {}
  }

  async function loadGoogleDocs() {
    try {
      const data = await api('/api/google/docs');
      const docs = data.docs || [];
      dom.googleDocSelect.innerHTML = '<option value="">— Choose a Google Doc —</option>' +
        docs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
      dom.googleDocsPicker.classList.remove('hidden');
      dom.btnGoogleAuth.textContent = '✓ Connected';
      dom.btnGoogleAuth.disabled = true;
    } catch {
      toast('Connect to Google first', 'error');
    }
  }

  async function importGoogleDoc() {
    const docId = dom.googleDocSelect.value;
    if (!docId || !state.currentProject) return;
    try {
      const data = await api(`/api/projects/${state.currentProject.id}/import-google-doc`, {
        method: 'POST',
        body: { docId },
      });
      state.researchText = data.text || data.research || '';
      dom.researchText.value = state.researchText;
      showResearchPreview(state.researchText);
      toast('Google Doc imported!', 'success');
      updateStepperAccess();
    } catch {}
  }

  // ─────────────────────────────────────
  // PHASE 2 — Script
  // ─────────────────────────────────────
  async function generateScript() {
    const objective = dom.learningObjective.value.trim();
    if (!objective) { toast('Enter a learning objective', 'error'); return; }
    if (!state.currentProject) { toast('Select a project first', 'error'); return; }

    dom.btnGenerateScript.disabled = true;
    dom.generateScriptSpinner.classList.remove('hidden');

    try {
      const data = await api(`/api/projects/${state.currentProject.id}/generate-script`, {
        method: 'POST',
        body: { learningObjective: objective },
      });
      state.scenes = normalizeScenes(data.scenes || data);
      renderScenes();
      dom.scenesActions.classList.remove('hidden');
      toast(`Generated ${state.scenes.length} scenes!`, 'success');
      updateStepperAccess();
    } catch {} finally {
      dom.btnGenerateScript.disabled = false;
      dom.generateScriptSpinner.classList.add('hidden');
    }
  }

  function renderScenes() {
    if (!state.scenes.length) {
      dom.scenesContainer.innerHTML = '<div class="empty-state"><span class="empty-state__icon">🎞</span><p>No scenes yet. Enter a learning objective and generate your script.</p></div>';
      dom.scenesActions.classList.add('hidden');
      return;
    }
    dom.scenesActions.classList.remove('hidden');
    dom.scenesContainer.innerHTML = state.scenes.map((scene, i) => {
      const num = i + 1;
      return `
        <div class="scene-card" data-scene="${num}">
          <div class="scene-card__header">
            <div class="scene-card__num">${num}</div>
            <input class="scene-card__title-input" value="${esc(scene.title || `Scene ${num}`)}" data-field="title" data-index="${i}" />
            <div class="scene-card__badges">
              ${scene.visualType ? `<span class="badge badge--violet">${esc(scene.visualType)}</span>` : ''}
            </div>
            <button class="scene-card__delete" data-index="${i}" title="Remove scene">&times;</button>
          </div>
          <div class="scene-card__body">
            <div>
              <div class="scene-card__narration-label">
                <span class="label-sm">Narration</span>
                <span class="text-xs text-muted">${wordCount(scene.narration || '')} words</span>
              </div>
              <textarea class="scene-card__narration" data-field="narration" data-index="${i}">${esc(scene.narration || '')}</textarea>
            </div>
            <div class="scene-card__flow-section">
              <div class="scene-card__flow-label">
                <span class="label-sm">Flow Prompt</span>
                <button class="btn-copy" data-copy="${esc(scene.flowPrompt || '')}" title="Copy to clipboard">📋 Copy</button>
              </div>
              <textarea class="scene-card__flow-prompt" readonly rows="3">${esc(scene.flowPrompt || '')}</textarea>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Wire up inline editing
    $$('.scene-card__title-input', dom.scenesContainer).forEach(input => {
      input.addEventListener('change', () => {
        state.scenes[+input.dataset.index].title = input.value;
      });
    });
    $$('.scene-card__narration', dom.scenesContainer).forEach(ta => {
      ta.addEventListener('input', () => {
        state.scenes[+ta.dataset.index].narration = ta.value;
      });
    });
    $$('.scene-card__delete', dom.scenesContainer).forEach(btn => {
      btn.addEventListener('click', () => {
        state.scenes.splice(+btn.dataset.index, 1);
        renderScenes();
        updateStepperAccess();
      });
    });

    // Copy buttons
    $$('.btn-copy', dom.scenesContainer).forEach(btn => {
      btn.addEventListener('click', () => copyText(btn, btn.dataset.copy));
    });
  }

  async function saveScenes() {
    if (!state.currentProject) return;
    try {
      await api(`/api/projects/${state.currentProject.id}/scenes`, {
        method: 'PUT',
        body: { scenes: state.scenes },
      });
      flashSave();
      toast('Scenes saved', 'success');
    } catch {}
  }

  function addScene() {
    state.scenes.push({
      title: `Scene ${state.scenes.length + 1}`,
      narration: '',
      flowPrompt: '',
      visualType: 'custom',
    });
    renderScenes();
  }

  // ─────────────────────────────────────
  // PHASE 3 — Audio
  // ─────────────────────────────────────
  async function loadVoiceboxStatus() {
    try {
      const data = await api('/api/voicebox/status');
      const online = data.status === 'online' || data.online === true;
      dom.voiceboxStatus.className = `status-badge status-badge--${online ? 'online' : 'offline'}`;
      dom.voiceboxStatus.innerHTML = `<span class="status-badge__dot"></span> Voicebox ${online ? 'Online' : 'Offline'}`;
    } catch {
      dom.voiceboxStatus.className = 'status-badge status-badge--offline';
      dom.voiceboxStatus.innerHTML = '<span class="status-badge__dot"></span> Voicebox Offline';
    }
  }

  async function loadVoiceProfiles() {
    try {
      const data = await api('/api/voicebox/profiles');
      state.voiceProfiles = data.profiles || data || [];
      dom.voiceProfileSelect.innerHTML = state.voiceProfiles.length
        ? state.voiceProfiles.map(p => `<option value="${p.id}">${esc(p.name || p.id)}</option>`).join('')
        : '<option value="">No profiles available</option>';
      if (state.voiceProfiles.length) {
        state.selectedProfileId = state.voiceProfiles[0].id;
        dom.btnGenerateAudio.disabled = false;
      }
    } catch {
      dom.voiceProfileSelect.innerHTML = '<option value="">Could not load profiles</option>';
    }
  }

  function renderAudioScenes() {
    if (!state.scenes.length) {
      dom.audioScenesContainer.innerHTML = '<div class="empty-state"><span class="empty-state__icon">🔇</span><p>Generate a script first, then come here to create voiceovers.</p></div>';
      return;
    }

    dom.audioScenesContainer.innerHTML = state.scenes.map((scene, i) => {
      const num = i + 1;
      const status = state.audioStatus[num] || 'pending';
      const statusBadge = status === 'done'
        ? '<span class="badge badge--success">✓ Done</span>'
        : status === 'generating'
        ? '<span class="badge badge--warning"><span class="spinner-sm spinner"></span> Generating</span>'
        : '<span class="badge badge--pending">Pending</span>';

      const audioPlayer = status === 'done'
        ? `<div class="audio-player-wrap" style="display:flex;align-items:center;gap:10px;">
            <audio controls preload="none" src="/api/projects/${state.currentProject.id}/audio/${num}" style="flex:1;"></audio>
            <button class="btn-regen-audio" data-scene="${num}" title="Regenerate this audio" style="padding:6px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:var(--text-muted);cursor:pointer;font-size:0.85rem;white-space:nowrap;">🔄 Regen</button>
           </div>`
        : '';

      return `
        <div class="scene-card" data-scene="${num}">
          <div class="scene-card__header">
            <div class="scene-card__num">${num}</div>
            <span style="flex:1; font-weight:600;">${esc(scene.title || `Scene ${num}`)}</span>
            <div class="audio-status">${statusBadge}</div>
          </div>
          <div class="scene-card__body">
            <div class="text-sm text-muted" style="line-height:1.6">${esc((scene.narration || '').slice(0, 200))}${(scene.narration || '').length > 200 ? '…' : ''}</div>
            ${audioPlayer}
          </div>
        </div>
      `;
    }).join('');

    // Wire up regenerate buttons
    $$('.btn-regen-audio', dom.audioScenesContainer).forEach(btn => {
      btn.addEventListener('click', async () => {
        const sceneNum = +btn.dataset.scene;
        const profileId = dom.voiceProfileSelect?.value || state.currentProject?.voiceProfileId;
        if (!profileId) { toast('Select a voice profile first', 'error'); return; }

        btn.disabled = true;
        btn.textContent = '⏳ ...';
        state.audioStatus[sceneNum] = 'generating';
        renderAudioScenes();

        try {
          await api(`/api/projects/${state.currentProject.id}/regenerate-audio/${sceneNum}`, {
            method: 'POST',
            body: { profileId },
          });
          toast(`Regenerating audio for Scene ${sceneNum}...`, 'info');
        } catch (err) {
          toast(`Failed: ${err.message}`, 'error');
          state.audioStatus[sceneNum] = 'done';
          renderAudioScenes();
        }
      });
    });
  }

  async function generateAudio() {
    if (!state.currentProject || !state.scenes.length) return;
    const profileId = dom.voiceProfileSelect.value;
    if (!profileId) { toast('Select a voice profile', 'error'); return; }

    dom.btnGenerateAudio.disabled = true;
    dom.generateAudioSpinner.classList.remove('hidden');

    // Mark all as generating
    state.scenes.forEach((_, i) => { state.audioStatus[i + 1] = 'generating'; });
    renderAudioScenes();

    try {
      await api(`/api/projects/${state.currentProject.id}/generate-audio`, {
        method: 'POST',
        body: { profileId },
      });
      // If no WebSocket, poll or assume done
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        state.scenes.forEach((_, i) => { state.audioStatus[i + 1] = 'done'; });
        renderAudioScenes();
        dom.btnGenerateAudio.disabled = false;
        dom.generateAudioSpinner.classList.add('hidden');
        toast('All voiceovers generated!', 'success');
        updateStepperAccess();
      }
      // Otherwise, WS messages will update status
    } catch {
      dom.btnGenerateAudio.disabled = false;
      dom.generateAudioSpinner.classList.add('hidden');
    }
  }

  // ─────────────────────────────────────
  // PHASE 4 — Video
  // ─────────────────────────────────────
  // ─────────────────────────────────────
  function renderVideoScenes() {
    if (!state.scenes.length) {
      dom.videoScenesContainer.innerHTML = '<div class="empty-state"><span class="empty-state__icon">📹</span><p>Generate a script first, then upload Flow-generated video clips here.</p></div>';
      return;
    }

    // Check if any scenes need planning (video OR still)
    const hasUnplanned = state.scenes.some(s => s.audioDuration > 0 && !s.shotsPlanned);

    const headerHtml = hasUnplanned
      ? `<div style="display:flex;justify-content:flex-end;margin-bottom:16px;">
           <button class="btn btn--primary" id="btn-plan-all-shots">🎬 Plan All Prompts</button>
         </div>`
      : '';

    dom.videoScenesContainer.innerHTML = headerHtml + state.scenes.map((scene, i) => {
      const num = i + 1;
      const isStill = scene.mediaType === 'still_image';
      const mediaLabel = isStill ? 'Still Image' : 'Video';
      const mediaIcon = isStill ? '🖼️' : '🎞';
      const mediaBadgeClass = isStill ? 'badge--bronze' : 'badge--cyan';

      const audioDuration = scene.audioDuration || 0;

      // ── Per-shot prompts for video scenes ──
      const shots = scene.shots || [];
      const imagePrompts = scene.imagePrompts || [];
      const hasShotPlan = (shots.length > 0 || imagePrompts.length > 0) && scene.shotsPlanned;

      let promptSection = '';
      if (isStill && hasShotPlan && imagePrompts.length > 0) {
        // Still image WITH multi-prompt plan
        const imagesHtml = imagePrompts.map(img => `
          <div class="shot-prompt-card" style="padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span class="badge badge--bronze" style="font-size:.7rem;">Image ${img.image_number}</span>
              <span class="badge" style="font-size:.7rem;background:rgba(139,92,246,0.15);color:#8B5CF6;">${img.display_duration}s</span>
              <span style="font-size:.75rem;color:var(--text-muted);">🎬 ${esc(img.ken_burns_direction)}</span>
            </div>
            <p class="text-sm text-muted" style="line-height:1.5;margin-bottom:8px;">${esc(img.prompt || 'No prompt')}</p>
            <button class="btn-copy-large" data-copy="${esc(img.prompt || '')}" style="font-size:.8rem;padding:4px 12px;">📋 Copy</button>
          </div>
        `).join('');

        promptSection = `
          <div class="video-scene-card__prompt">
            <div class="flex-between mb-2">
              <span class="label-sm">Image Prompts (${imagePrompts.length} images · ~${audioDuration.toFixed(0)}s total)</span>
              <button class="btn-replan btn--sm" data-scene="${num}" style="font-size:.75rem;padding:4px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-muted);cursor:pointer;">↻ Re-plan</button>
            </div>
            ${imagesHtml}
          </div>`;
      } else if (isStill) {
        // Still image WITHOUT plan yet — show original single prompt + plan button
        const kenBurnsInfo = scene.kenBurnsDirection
          ? `<div class="ken-burns-info" style="margin-top:8px;padding:8px 12px;background:rgba(150,99,39,0.15);border-radius:6px;font-size:0.85rem;">
              <strong>🎬 Camera Movement:</strong> ${esc(scene.kenBurnsDirection)}
             </div>`
          : '';
        promptSection = `
          <div class="video-scene-card__prompt">
            <div class="flex-between mb-2">
              <span class="label-sm">Image Generation Prompt (1 of 1)</span>
            </div>
            <p class="text-sm text-muted mb-3" style="line-height:1.6">${esc(scene.flowPrompt || 'No prompt available')}</p>
            <button class="btn-copy-large" data-copy="${esc(scene.flowPrompt || '')}">📋 Copy Prompt</button>
            ${kenBurnsInfo}
            ${audioDuration > 0
              ? `<button class="btn btn--primary btn-plan-scene" data-scene="${num}" style="margin-top:12px;">🖼️ Generate ${Math.max(2, Math.ceil(audioDuration / 5))} Image Prompts (${audioDuration.toFixed(1)}s)</button>`
              : ''
            }
          </div>`;
      } else if (hasShotPlan) {
        // Video with shot plan: show per-shot prompts
        const shotsHtml = shots.map((shot, si) => `
            <div class="shot-prompt-card" style="padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;margin-bottom:8px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <span class="badge badge--cyan" style="font-size:.7rem;">Shot ${shot.shot_number}</span>
                <span class="badge" style="font-size:.7rem;background:rgba(139,92,246,0.15);color:#8B5CF6;">${shot.duration}s</span>
                ${shot.shot_type ? `<span style="font-size:.75rem;color:var(--text-muted);">${esc(shot.shot_type)}</span>` : ''}
              </div>
              <p class="text-sm text-muted" style="line-height:1.5;margin-bottom:8px;">${esc(shot.flow_prompt || 'No prompt')}</p>
              <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn-copy-large" data-copy="${esc(shot.flow_prompt || '')}" style="font-size:.8rem;padding:4px 12px;">📋 Copy</button>
                ${shot.audio_cues ? `<span style="font-size:.75rem;color:var(--bronze-light);">🔊 ${esc(shot.audio_cues)}</span>` : ''}
              </div>
            </div>`
        ).join('');

        const breakdownHtml = scene.shotBreakdown
          ? `<details style="margin-top:12px;">
               <summary style="cursor:pointer;font-size:.85rem;color:var(--cyan);font-weight:600;">📄 View Full Cinematic Breakdown (CSV)</summary>
               <pre style="margin-top:8px;padding:12px;background:rgba(0,0,0,0.3);border-radius:6px;font-size:.75rem;overflow-x:auto;white-space:pre-wrap;color:var(--text-muted);">${esc(scene.shotBreakdown)}</pre>
             </details>`
          : '';

        promptSection = `
          <div class="video-scene-card__prompt">
            <div class="flex-between mb-2">
              <span class="label-sm">Shot Plan (${shots.length} shots · ${shots.reduce((s, sh) => s + sh.duration, 0)}s total)</span>
              <button class="btn-replan btn--sm" data-scene="${num}" style="font-size:.75rem;padding:4px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-muted);cursor:pointer;">↻ Re-plan</button>
            </div>
            ${shotsHtml}
            ${breakdownHtml}
          </div>`;
      } else {
        // Video without shot plan: show original prompt + plan button
        promptSection = `
          <div class="video-scene-card__prompt">
            <div class="flex-between mb-2">
              <span class="label-sm">Scene Direction</span>
            </div>
            <p class="text-sm text-muted mb-3" style="line-height:1.6">${esc(scene.flowPrompt || 'No prompt available')}</p>
            ${audioDuration > 0
              ? `<button class="btn btn--primary btn-plan-scene" data-scene="${num}" style="margin-top:8px;">🎬 Plan Shots for This Scene (${audioDuration.toFixed(1)}s)</button>`
              : '<p class="text-sm" style="color:var(--bronze);">⚠️ Generate audio first to plan shots</p>'
            }
          </div>`;
      }

      return `
        <div class="scene-card" data-scene="${num}">
          <div class="scene-card__header">
            <div class="scene-card__num">${num}</div>
            <span style="flex:1; font-weight:600;">${esc(scene.title || `Scene ${num}`)}</span>
            <span class="badge ${mediaBadgeClass}">${mediaLabel}</span>
            ${audioDuration ? `<span class="duration-badge">⏱ ${audioDuration.toFixed(1)}s</span>` : ''}
            ${hasShotPlan
              ? (isStill
                ? `<span class="badge" style="background:rgba(150,99,39,0.15);color:#966327;">${imagePrompts.length} images</span>`
                : `<span class="badge" style="background:rgba(139,92,246,0.15);color:#8B5CF6;">${shots.length} shots</span>`)
              : ''}
          </div>
          <div class="scene-card__body">
            ${promptSection}
          </div>
        </div>
      `;
    }).join('');

    // Copy buttons
    $$('.btn-copy-large', dom.videoScenesContainer).forEach(btn => {
      btn.addEventListener('click', () => copyText(btn, btn.dataset.copy));
    });

    // Plan shots for individual scenes
    $$('.btn-plan-scene', dom.videoScenesContainer).forEach(btn => {
      btn.addEventListener('click', async () => {
        const sceneNum = +btn.dataset.scene;
        btn.disabled = true;
        btn.textContent = '⏳ Planning shots...';
        try {
          await api(`/api/projects/${state.currentProject.id}/plan-shots/${sceneNum}`, { method: 'POST' });
          toast(`Planning shots for Scene ${sceneNum}...`, 'info');
        } catch (err) {
          toast(`Shot planning failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = `🎬 Plan Shots for This Scene`;
        }
      });
    });

    // Re-plan button
    $$('.btn-replan', dom.videoScenesContainer).forEach(btn => {
      btn.addEventListener('click', async () => {
        const sceneNum = +btn.dataset.scene;
        btn.disabled = true;
        btn.textContent = '⏳ Re-planning...';
        try {
          await api(`/api/projects/${state.currentProject.id}/plan-shots/${sceneNum}`, { method: 'POST' });
          toast(`Re-planning shots for Scene ${sceneNum}...`, 'info');
        } catch (err) {
          toast(`Re-planning failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = '↻ Re-plan';
        }
      });
    });

    // Plan all shots button
    const planAllBtn = document.getElementById('btn-plan-all-shots');
    if (planAllBtn) {
      planAllBtn.addEventListener('click', async () => {
        planAllBtn.disabled = true;
        planAllBtn.textContent = '⏳ Planning all shots...';
        try {
          await api(`/api/projects/${state.currentProject.id}/plan-shots`, { method: 'POST' });
          toast('Planning shots for all video scenes...', 'info');
        } catch (err) {
          toast(`Shot planning failed: ${err.message}`, 'error');
          planAllBtn.disabled = false;
          planAllBtn.textContent = '🎬 Plan All Shots';
        }
      });
    }
  }



  // ─────────────────────────────────────
  // PHASE 5 — Export
  // ─────────────────────────────────────
  function triggerDownload(url, fallbackName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackName || '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ─────────────────────────────────────
  // CLIPBOARD
  // ─────────────────────────────────────
  async function copyText(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = '✓ Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig; }, 1800);
    } catch {
      toast('Could not copy to clipboard', 'error');
    }
  }

  // ─────────────────────────────────────
  // ESCAPE HTML
  // ─────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ─────────────────────────────────────
  // EVENT BINDINGS
  // ─────────────────────────────────────
  function bindEvents() {
    // Sidebar
    dom.btnNewProject.addEventListener('click', openModal);
    dom.btnRefresh.addEventListener('click', loadProjects);
    dom.btnSidebarToggle.addEventListener('click', () => {
      dom.sidebar.classList.toggle('collapsed');
      dom.sidebar.classList.toggle('open');
    });

    // Stepper
    $$('.stepper__step', dom.stepper).forEach(step => {
      step.addEventListener('click', () => setPhase(+step.dataset.phase));
    });

    // Modal
    dom.btnCreateProject.addEventListener('click', createProject);
    dom.btnCancelProject.addEventListener('click', closeModal);
    $('.modal__close', dom.modalNewProject).addEventListener('click', closeModal);
    $('.modal__backdrop', dom.modalNewProject).addEventListener('click', closeModal);
    dom.newProjectName.addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

    // Phase 1 — Research
    dom.researchText.addEventListener('input', () => {
      dom.btnSaveResearch.disabled = !dom.researchText.value.trim();
    });
    dom.btnSaveResearch.addEventListener('click', () => saveResearch(dom.researchText.value.trim()));
    dom.btnGoogleAuth.addEventListener('click', startGoogleAuth);
    dom.googleDocSelect.addEventListener('change', () => {
      dom.btnImportGdoc.disabled = !dom.googleDocSelect.value;
    });
    dom.btnImportGdoc.addEventListener('click', importGoogleDoc);

    // File drop zone
    dom.researchDropzone.addEventListener('click', () => dom.researchFileInput.click());
    dom.researchDropzone.addEventListener('dragover', (e) => {
      e.preventDefault(); dom.researchDropzone.classList.add('dragover');
    });
    dom.researchDropzone.addEventListener('dragleave', () => dom.researchDropzone.classList.remove('dragover'));
    dom.researchDropzone.addEventListener('drop', (e) => {
      e.preventDefault(); dom.researchDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) uploadResearchFile(e.dataTransfer.files[0]);
    });
    dom.researchFileInput.addEventListener('change', () => {
      if (dom.researchFileInput.files.length) uploadResearchFile(dom.researchFileInput.files[0]);
    });

    // Phase 2 — Script
    dom.btnGenerateScript.addEventListener('click', generateScript);
    dom.btnSaveScenes.addEventListener('click', saveScenes);
    dom.btnAddScene.addEventListener('click', addScene);

    // Phase 3 — Audio
    dom.voiceProfileSelect.addEventListener('change', () => {
      state.selectedProfileId = dom.voiceProfileSelect.value;
    });
    dom.btnGenerateAudio.addEventListener('click', generateAudio);

    // Phase 5 — Export
    dom.btnDlScript?.addEventListener('click', () => {
      if (!state.currentProject) { toast('Open a project first', 'error'); return; }
      triggerDownload(`/api/projects/${state.currentProject.id}/download-script`, 'script.txt');
    });
    dom.btnDlAudio?.addEventListener('click', () => {
      if (!state.currentProject) { toast('Open a project first', 'error'); return; }
      triggerDownload(`/api/projects/${state.currentProject.id}/download-audio-bundle`, 'audio.zip');
    });
    dom.btnDlChart?.addEventListener('click', () => {
      if (!state.currentProject) { toast('Open a project first', 'error'); return; }
      triggerDownload(`/api/projects/${state.currentProject.id}/download-shot-chart`, 'shot_chart.csv');
    });
  }

  // ─────────────────────────────────────
  // INIT
  // ─────────────────────────────────────
  function init() {
    bindEvents();
    loadProjects();
    connectWS();
    updateStepperAccess();
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

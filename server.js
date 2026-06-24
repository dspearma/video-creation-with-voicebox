require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { WebSocketServer } = require('ws');

// Lib modules
const projectManager = require('./lib/project-manager');
const googleAuth = require('./lib/google-auth');
const googleDocs = require('./lib/google-docs-reader');
const scriptGenerator = require('./lib/script-generator');
const voiceboxClient = require('./lib/voicebox-client');
const renderer = require('./lib/renderer');
const shotPlanner = require('./lib/shot-planner');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);

// WebSocket server for real-time progress
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config
const upload = multer({
  dest: path.join(__dirname, 'temp_uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max for video files
});

// ─── PROJECT ROUTES ──────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  res.json(projectManager.listProjects());
});

app.post('/api/projects', (req, res) => {
  const { name, learningObjective } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const project = projectManager.createProject(name, learningObjective || '');
  res.json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const project = projectManager.loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  const deleted = projectManager.deleteProject(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Project not found' });
  res.json({ success: true });
});

// ─── RESEARCH ROUTES ─────────────────────────────────────────────

// Save research text (paste or file upload)
app.post('/api/projects/:id/research', upload.single('file'), async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let text = '';

    if (req.file) {
      // Handle file upload
      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileBuf = fs.readFileSync(req.file.path);

      if (ext === '.pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(fileBuf);
        text = pdfData.text;
      } else {
        // .txt, .md, .docx (treat as plain text)
        text = fileBuf.toString('utf-8');
      }

      // Clean up temp file
      fs.unlinkSync(req.file.path);
    } else if (req.body.text) {
      text = req.body.text;
    } else {
      return res.status(400).json({ error: 'No research text or file provided' });
    }

    project.researchText = text.trim();
    projectManager.saveProject(project.id, project);
    res.json({ success: true, textLength: project.researchText.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GOOGLE AUTH ROUTES ──────────────────────────────────────────

app.get('/auth/google/url', (req, res) => {
  const url = googleAuth.getAuthUrl();
  if (!url) {
    return res.status(501).json({
      error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env',
    });
  }
  res.json({ url });
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    await googleAuth.handleCallback(code);
    // Redirect back to the app
    res.send(`
      <html><body>
        <script>window.close(); window.opener && window.opener.postMessage('google-auth-success', '*');</script>
        <p>Authentication successful! You can close this window.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/google/status', (req, res) => {
  res.json({ authenticated: googleAuth.isAuthenticated() });
});

// ─── GOOGLE DOCS ROUTES ─────────────────────────────────────────

app.get('/api/google/docs', async (req, res) => {
  try {
    if (!googleAuth.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Google' });
    }
    const docs = await googleDocs.listGoogleDocs();
    res.json({ docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/import-google-doc', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { docId } = req.body;
    if (!docId) return res.status(400).json({ error: 'docId is required' });

    const doc = await googleDocs.readGoogleDoc(docId);
    project.researchText = doc.text;
    projectManager.saveProject(project.id, project);

    res.json({ success: true, title: doc.title, textLength: doc.text.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCRIPT GENERATION ROUTES ────────────────────────────────────

app.post('/api/projects/:id/generate-script', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.researchText) {
      return res.status(400).json({ error: 'No research text imported yet' });
    }

    const learningObjective =
      req.body.learningObjective || project.learningObjective || 'Create an educational video';

    project.learningObjective = learningObjective;
    const scenes = await scriptGenerator.generateScript(
      project.researchText,
      learningObjective
    );

    project.scenes = scenes;
    projectManager.saveProject(project.id, project);

    res.json({ success: true, scenes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update scenes (reorder, edit text, etc.)
app.put('/api/projects/:id/scenes', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    project.scenes = req.body.scenes || req.body;
    projectManager.saveProject(project.id, project);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── VOICEBOX ROUTES ─────────────────────────────────────────────

app.get('/api/voicebox/status', async (req, res) => {
  const status = await voiceboxClient.checkStatus();
  res.json(status);
});

app.get('/api/voicebox/profiles', async (req, res) => {
  try {
    const profiles = await voiceboxClient.listProfiles();
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate voiceovers for all scenes sequentially
app.post('/api/projects/:id/generate-audio', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.scenes || project.scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes to generate audio for' });
    }

    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    project.voiceProfileId = profileId;

    // Respond immediately — generation happens in background
    res.json({ success: true, message: 'Audio generation started' });

    // Generate audio for each scene sequentially
    const audioDir = projectManager.getProjectPath(project.id, 'audio');
    for (let i = 0; i < project.scenes.length; i++) {
      const scene = project.scenes[i];
      const sceneNum = scene.scene_number || (i + 1);
      const outputPath = path.join(audioDir, `scene_${sceneNum}.wav`);

      // Skip scenes that already have audio on disk
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        // Recover metadata if it wasn't saved previously
        if (!scene.audioFile) {
          scene.audioFile = `scene_${sceneNum}.wav`;
          try {
            scene.audioDuration = await voiceboxClient.getAudioDuration(outputPath);
          } catch { scene.audioDuration = null; }
          projectManager.saveProject(project.id, project);
        }
        broadcast({
          type: 'audio-progress',
          projectId: project.id,
          scene: sceneNum,
          total: project.scenes.length,
          status: 'done',
          duration: scene.audioDuration || null,
        });
        continue;
      }

      broadcast({
        type: 'audio-progress',
        projectId: project.id,
        scene: sceneNum,
        total: project.scenes.length,
        status: 'generating',
      });

      try {
        await voiceboxClient.generateAudio(scene.narration, profileId, outputPath);

        // Get audio duration
        const duration = await voiceboxClient.getAudioDuration(outputPath);

        scene.audioFile = `scene_${sceneNum}.wav`;
        scene.audioDuration = duration;

        broadcast({
          type: 'audio-progress',
          projectId: project.id,
          scene: sceneNum,
          total: project.scenes.length,
          status: 'done',
          duration,
        });
      } catch (err) {
        scene.audioFile = null;
        scene.audioDuration = null;

        broadcast({
          type: 'audio-progress',
          projectId: project.id,
          scene: sceneNum,
          total: project.scenes.length,
          status: 'error',
          error: err.message,
        });
      }

      // Save progress after each scene
      projectManager.saveProject(project.id, project);
    }

    broadcast({
      type: 'audio-complete',
      projectId: project.id,
    });
  } catch (err) {
    broadcast({
      type: 'audio-error',
      error: err.message,
    });
  }
});

// Serve audio files
app.get('/api/projects/:id/audio/:sceneNum', (req, res) => {
  const filePath = projectManager.getProjectPath(
    req.params.id,
    'audio',
    `scene_${req.params.sceneNum}.wav`
  );
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Audio not found' });
  res.sendFile(filePath);
});

// ─── REGENERATE SINGLE SCENE AUDIO ──────────────────────────────

app.post('/api/projects/:id/regenerate-audio/:sceneNum', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sceneNum = parseInt(req.params.sceneNum, 10);
    const scene = project.scenes.find(
      (s) => (s.scene_number || (project.scenes.indexOf(s) + 1)) === sceneNum
    );
    if (!scene) return res.status(404).json({ error: 'Scene not found' });

    const profileId = req.body.profileId || project.voiceProfileId;
    if (!profileId) return res.status(400).json({ error: 'No voice profile specified' });

    // Delete existing audio file
    const audioDir = projectManager.getProjectPath(project.id, 'audio');
    const outputPath = path.join(audioDir, `scene_${sceneNum}.wav`);
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    // Clear metadata and save
    scene.audioFile = null;
    scene.audioDuration = null;
    projectManager.saveProject(project.id, project);

    // Respond immediately
    res.json({ success: true, message: `Regenerating audio for scene ${sceneNum}` });

    // Background generation
    broadcast({
      type: 'audio-progress',
      projectId: project.id,
      scene: sceneNum,
      total: project.scenes.length,
      status: 'generating',
    });

    try {
      await voiceboxClient.generateAudio(scene.narration, profileId, outputPath);
      const duration = await voiceboxClient.getAudioDuration(outputPath);

      scene.audioFile = `scene_${sceneNum}.wav`;
      scene.audioDuration = duration;
      projectManager.saveProject(project.id, project);

      broadcast({
        type: 'audio-progress',
        projectId: project.id,
        scene: sceneNum,
        total: project.scenes.length,
        status: 'done',
        duration,
      });
    } catch (err) {
      scene.audioFile = null;
      scene.audioDuration = null;
      projectManager.saveProject(project.id, project);

      broadcast({
        type: 'audio-progress',
        projectId: project.id,
        scene: sceneNum,
        total: project.scenes.length,
        status: 'error',
        error: err.message,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DOWNLOAD SCRIPT AS TXT ─────────────────────────────────────

app.get('/api/projects/:id/download-script', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const title = project.name || 'Untitled Project';
    let text = `${title}\n${'='.repeat(title.length)}\n\n`;

    (project.scenes || []).forEach((scene, i) => {
      const sceneNum = scene.scene_number || (i + 1);
      const sceneTitle = scene.title || `Scene ${sceneNum}`;
      text += `Scene ${sceneNum}: ${sceneTitle}\n`;
      text += `${'-'.repeat(`Scene ${sceneNum}: ${sceneTitle}`.length)}\n`;
      text += `${scene.narration || ''}\n\n`;
    });

    const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_script.txt"`);
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DOWNLOAD AUDIO BUNDLE AS ZIP ───────────────────────────────

app.get('/api/projects/:id/download-audio-bundle', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_audio.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => res.status(500).json({ error: err.message }));
    archive.pipe(res);

    const audioDir = projectManager.getProjectPath(project.id, 'audio');
    (project.scenes || []).forEach((scene, i) => {
      if (!scene.audioFile) return;
      const sceneNum = scene.scene_number || (i + 1);
      const sceneTitle = (scene.title || 'Untitled').replace(/[^a-zA-Z0-9_-]/g, '_');
      const paddedNum = String(sceneNum).padStart(2, '0');
      const filePath = path.join(audioDir, scene.audioFile);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: `Scene_${paddedNum}_${sceneTitle}.wav` });
      }
    });

    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DOWNLOAD SHOT CHART AS CSV ─────────────────────────────────

app.get('/api/projects/:id/download-shot-chart', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    function csvEscape(val) {
      if (val == null) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    const header = 'Scene,Title,Type,Duration(s),Narration,Shot#,Shot Duration(s),Shot Type,Flow Prompt,Audio Cues';
    const rows = [header];

    (project.scenes || []).forEach((scene, i) => {
      const sceneNum = scene.scene_number || (i + 1);
      const sceneTitle = scene.title || '';
      const mediaType = scene.media_type || scene.mediaType || 'video';
      const duration = scene.audioDuration || '';
      const narration = scene.narration || '';

      if (scene.shots && scene.shots.length > 0) {
        // Video scenes with multi-shot plan
        scene.shots.forEach((shot, si) => {
          rows.push([
            csvEscape(sceneNum),
            csvEscape(sceneTitle),
            csvEscape(mediaType),
            csvEscape(duration),
            csvEscape(si === 0 ? narration : ''),
            csvEscape(shot.shot_number || si + 1),
            csvEscape(shot.duration || ''),
            csvEscape(shot.shot_type || ''),
            csvEscape(shot.flow_prompt || shot.flowPrompt || ''),
            csvEscape(shot.audio_cues || shot.audioCues || ''),
          ].join(','));
        });
      } else if (scene.imagePrompts && scene.imagePrompts.length > 0) {
        // Still image scenes with multi-image prompts
        scene.imagePrompts.forEach((img, ii) => {
          rows.push([
            csvEscape(sceneNum),
            csvEscape(sceneTitle),
            csvEscape(mediaType),
            csvEscape(duration),
            csvEscape(ii === 0 ? narration : ''),
            csvEscape(img.image_number || ii + 1),
            csvEscape(img.display_duration || ''),
            csvEscape(`Still Image - ${img.ken_burns_direction || 'static'}`),
            csvEscape(img.prompt || ''),
            csvEscape(''),
          ].join(','));
        });
      } else {
        // Unplanned scene — single prompt
        rows.push([
          csvEscape(sceneNum),
          csvEscape(sceneTitle),
          csvEscape(mediaType),
          csvEscape(duration),
          csvEscape(narration),
          csvEscape(''),
          csvEscape(''),
          csvEscape(''),
          csvEscape(scene.flow_prompt || scene.flowPrompt || ''),
          csvEscape(''),
        ].join(','));
      }
    });

    const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_shot_chart.csv"`);
    res.send(rows.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SHOT PLANNING ROUTES ────────────────────────────────────────

// Plan shots for all video scenes (requires audio durations)
app.post('/api/projects/:id/plan-shots', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.scenes || project.scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes to plan' });
    }

    // Find scenes that need planning (video AND still_image)
    const planScenes = project.scenes.filter(s => {
      const mediaType = s.media_type || s.mediaType || 'video';
      const duration = s.audioDuration || 0;
      return duration > 0 && !s.shotsPlanned;
    });

    if (planScenes.length === 0) {
      return res.status(400).json({ error: 'No scenes need planning. All scenes are already planned or missing audio.' });
    }

    res.json({ success: true, message: `Planning prompts for ${planScenes.length} scenes...`, totalScenes: planScenes.length });

    // Process in background
    for (let i = 0; i < planScenes.length; i++) {
      const scene = planScenes[i];
      const sceneNum = scene.scene_number || (project.scenes.indexOf(scene) + 1);
      const mediaType = scene.media_type || scene.mediaType || 'video';

      broadcast({
        type: 'shot-planning-progress',
        projectId: project.id,
        scene: sceneNum,
        total: planScenes.length,
        current: i + 1,
        status: 'planning',
      });

      try {
        if (mediaType === 'still_image') {
          const result = await shotPlanner.generateStillImagePrompts(scene, scene.audioDuration);
          scene.imagePrompts = result.imagePrompts;
          scene.shotsPlanned = true;
          projectManager.saveProject(project.id, project);

          broadcast({
            type: 'shot-planning-progress',
            projectId: project.id,
            scene: sceneNum,
            total: planScenes.length,
            current: i + 1,
            status: 'done',
            shotCount: result.imagePrompts.length,
          });
        } else {
          const durations = shotPlanner.planShotDurations(scene.audioDuration);
          const result = await shotPlanner.generateShotPrompts(scene, durations);

          scene.shots = result.shots;
          scene.shotBreakdown = result.breakdown;
          scene.shotsPlanned = true;
          projectManager.saveProject(project.id, project);

          broadcast({
            type: 'shot-planning-progress',
            projectId: project.id,
            scene: sceneNum,
            total: planScenes.length,
            current: i + 1,
            status: 'done',
            shotCount: result.shots.length,
          });
        }
      } catch (err) {
        console.error(`Planning failed for scene ${sceneNum}:`, err.message);
        broadcast({
          type: 'shot-planning-error',
          projectId: project.id,
          scene: sceneNum,
          error: err.message,
        });
      }

      // Delay between scenes to avoid Gemini rate limits
      if (i < planScenes.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    broadcast({
      type: 'shot-planning-complete',
      projectId: project.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plan shots/images for a single scene (works for both video and still_image)
app.post('/api/projects/:id/plan-shots/:sceneNum', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sceneNum = parseInt(req.params.sceneNum, 10);
    const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
    if (!scene) return res.status(404).json({ error: `Scene ${sceneNum} not found` });

    const duration = scene.audioDuration || 0;
    if (duration <= 0) {
      return res.status(400).json({ error: 'Scene has no audio duration. Generate audio first.' });
    }

    const mediaType = scene.media_type || scene.mediaType || 'video';

    if (mediaType === 'still_image') {
      const imageCount = Math.max(2, Math.ceil(duration / 5));
      res.json({ success: true, message: `Generating ${imageCount} image prompts for scene ${sceneNum}...` });

      try {
        const result = await shotPlanner.generateStillImagePrompts(scene, duration);
        scene.imagePrompts = result.imagePrompts;
        scene.shotsPlanned = true;
        projectManager.saveProject(project.id, project);

        broadcast({
          type: 'shot-planning-progress',
          projectId: project.id,
          scene: sceneNum,
          total: 1,
          current: 1,
          status: 'done',
          shotCount: result.imagePrompts.length,
        });
      } catch (err) {
        console.error(`Image prompt planning failed for scene ${sceneNum}:`, err.message);
        broadcast({
          type: 'shot-planning-error',
          projectId: project.id,
          scene: sceneNum,
          error: err.message,
        });
      }
    } else {
      const durations = shotPlanner.planShotDurations(duration);
      res.json({ success: true, message: `Planning ${durations.length} shots for scene ${sceneNum}...`, shotDurations: durations });

      try {
        const result = await shotPlanner.generateShotPrompts(scene, durations);
        scene.shots = result.shots;
        scene.shotBreakdown = result.breakdown;
        scene.shotsPlanned = true;
        projectManager.saveProject(project.id, project);

        broadcast({
          type: 'shot-planning-progress',
          projectId: project.id,
          scene: sceneNum,
          total: 1,
          current: 1,
          status: 'done',
          shotCount: result.shots.length,
        });
      } catch (err) {
        console.error(`Shot planning failed for scene ${sceneNum}:`, err.message);
        broadcast({
          type: 'shot-planning-error',
          projectId: project.id,
          scene: sceneNum,
          error: err.message,
        });
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get shot breakdown for a scene
app.get('/api/projects/:id/scenes/:sceneNum/shots', (req, res) => {
  const project = projectManager.loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sceneNum = parseInt(req.params.sceneNum, 10);
  const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
  if (!scene) return res.status(404).json({ error: `Scene ${sceneNum} not found` });

  res.json({
    sceneNum,
    audioDuration: scene.audioDuration || 0,
    shotsPlanned: !!scene.shotsPlanned,
    shots: scene.shots || [],
    breakdown: scene.shotBreakdown || null,
  });
});

// ─── VIDEO/CLIP UPLOAD ROUTES ────────────────────────────────────

// Upload a clip to a scene (appends to clips array)
app.post(
  '/api/projects/:id/scenes/:sceneNum/upload-clip',
  upload.single('file'),
  async (req, res) => {
    try {
      const project = projectManager.loadProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const sceneNum = parseInt(req.params.sceneNum, 10);
      const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
      if (!scene) return res.status(404).json({ error: `Scene ${sceneNum} not found` });

      // Initialize clips array if needed
      if (!Array.isArray(scene.clips)) scene.clips = [];

      const clipNum = scene.clips.length + 1;
      const ext = path.extname(req.file.originalname).toLowerCase() || '.mp4';
      const filename = `scene_${sceneNum}_clip_${clipNum}${ext}`;
      const destPath = projectManager.getProjectPath(req.params.id, 'video', filename);

      fs.renameSync(req.file.path, destPath);

      // Get clip duration via ffprobe
      let duration = 0;
      try {
        duration = await require('./lib/renderer').getMediaDuration(destPath);
      } catch { /* duration unknown */ }

      scene.clips.push({ clipNumber: clipNum, file: filename, duration });
      // Keep legacy field updated (first clip or null)
      scene.videoFile = scene.clips.length > 0 ? scene.clips[0].file : null;
      projectManager.saveProject(project.id, project);

      res.json({
        success: true,
        sceneNum,
        clipNumber: clipNum,
        filename,
        duration,
        totalClips: scene.clips.length,
        totalClipDuration: scene.clips.reduce((s, c) => s + (c.duration || 0), 0),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Legacy single-upload endpoint (redirects to clip upload)
app.post(
  '/api/projects/:id/scenes/:sceneNum/upload-video',
  upload.single('video'),
  (req, res, next) => {
    // Rewrite to clip upload
    req.file = req.file || (req.files && req.files[0]);
    if (req.file) {
      // Forward to clip upload handler by re-calling
      req.url = `/api/projects/${req.params.id}/scenes/${req.params.sceneNum}/upload-clip`;
    }
    next();
  }
);

// List clips for a scene
app.get('/api/projects/:id/scenes/:sceneNum/clips', (req, res) => {
  const project = projectManager.loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sceneNum = parseInt(req.params.sceneNum, 10);
  const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
  if (!scene) return res.status(404).json({ error: `Scene ${sceneNum} not found` });

  const clips = scene.clips || [];
  res.json({
    sceneNum,
    clips,
    totalClipDuration: clips.reduce((s, c) => s + (c.duration || 0), 0),
    audioDuration: scene.audioDuration || 0,
  });
});

// Delete a specific clip
app.delete('/api/projects/:id/scenes/:sceneNum/clips/:clipNum', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sceneNum = parseInt(req.params.sceneNum, 10);
    const clipNum = parseInt(req.params.clipNum, 10);
    const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
    if (!scene || !scene.clips) return res.status(404).json({ error: 'Clip not found' });

    const clipIdx = scene.clips.findIndex(c => c.clipNumber === clipNum);
    if (clipIdx === -1) return res.status(404).json({ error: 'Clip not found' });

    // Delete file
    const filePath = projectManager.getProjectPath(req.params.id, 'video', scene.clips[clipIdx].file);
    try { fs.unlinkSync(filePath); } catch {}

    scene.clips.splice(clipIdx, 1);
    // Renumber remaining clips
    scene.clips.forEach((c, i) => { c.clipNumber = i + 1; });
    scene.videoFile = scene.clips.length > 0 ? scene.clips[0].file : null;
    projectManager.saveProject(project.id, project);

    res.json({ success: true, remainingClips: scene.clips.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a specific clip file
app.get('/api/projects/:id/scenes/:sceneNum/clips/:clipNum/file', (req, res) => {
  const project = projectManager.loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sceneNum = parseInt(req.params.sceneNum, 10);
  const clipNum = parseInt(req.params.clipNum, 10);
  const scene = project.scenes.find(s => (s.scene_number || 0) === sceneNum);
  if (!scene || !scene.clips) return res.status(404).json({ error: 'Clip not found' });

  const clip = scene.clips.find(c => c.clipNumber === clipNum);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });

  const filePath = projectManager.getProjectPath(req.params.id, 'video', clip.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// Legacy: Serve video/image files (backwards compatible)
app.get('/api/projects/:id/video/:sceneNum', (req, res) => {
  const sceneNum = req.params.sceneNum;
  const videoDir = projectManager.getProjectPath(req.params.id, 'video');
  const exts = ['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.bmp'];
  for (const ext of exts) {
    const filePath = path.join(videoDir, `scene_${sceneNum}${ext}`);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
  }
  // Try first clip
  const project = projectManager.loadProject(req.params.id);
  if (project) {
    const scene = project.scenes.find(s => (s.scene_number || 0) === +sceneNum);
    if (scene && scene.clips && scene.clips.length > 0) {
      const clipPath = projectManager.getProjectPath(req.params.id, 'video', scene.clips[0].file);
      if (fs.existsSync(clipPath)) return res.sendFile(clipPath);
    }
  }
  return res.status(404).json({ error: 'Media not found' });
});

// ─── RENDER ROUTES ───────────────────────────────────────────────

app.post('/api/projects/:id/render', async (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.scenes || project.scenes.length === 0) {
      return res.status(400).json({ error: 'No scenes to render' });
    }

    // Validate all scenes have audio and media
    for (const scene of project.scenes) {
      const num = scene.scene_number;
      if (!scene.audioFile) {
        return res.status(400).json({ error: `Scene ${num} is missing audio` });
      }
      const hasClips = scene.clips && scene.clips.length > 0;
      if (!hasClips && !scene.videoFile) {
        return res.status(400).json({ error: `Scene ${num} is missing ${(scene.media_type === 'still_image') ? 'image' : 'video clips'}` });
      }
    }

    project.renderStatus = 'rendering';
    projectManager.saveProject(project.id, project);

    // Respond immediately
    res.json({ success: true, message: 'Rendering started' });

    // Render in background
    const outputDir = projectManager.getProjectPath(project.id);
    try {
      const result = await renderer.renderProject(project.scenes, outputDir, (scene, total, status) => {
        broadcast({
          type: 'render-progress',
          projectId: project.id,
          scene,
          total,
          status,
        });
      });

      project.renderStatus = 'done';
      project.renderOutputs = {
        video: result.video,
        vocalTrack: result.vocalTrack,
        sfxTrack: result.sfxTrack,
        captions: result.captions,
        totalDuration: result.totalDuration,
      };
      projectManager.saveProject(project.id, project);

      broadcast({
        type: 'render-complete',
        projectId: project.id,
        outputs: {
          hasVideo: !!result.video,
          hasVocalTrack: !!result.vocalTrack,
          hasSfxTrack: !!result.sfxTrack,
          hasCaptions: !!result.captions,
          totalDuration: result.totalDuration,
        },
      });
    } catch (err) {
      project.renderStatus = 'error';
      projectManager.saveProject(project.id, project);

      broadcast({
        type: 'render-error',
        projectId: project.id,
        error: err.message,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download final rendered video
app.get('/api/projects/:id/download', (req, res) => {
  const filePath = projectManager.getProjectPath(req.params.id, 'output', 'final_video.mp4');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Final video not found. Render first.' });
  }
  res.download(filePath, 'educational_video.mp4');
});

// Download vocal track
app.get('/api/projects/:id/download/vocal', (req, res) => {
  const filePath = projectManager.getProjectPath(req.params.id, 'output', 'vocal_track.wav');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Vocal track not found. Render first.' });
  }
  res.download(filePath, 'vocal_track.wav');
});

// Download SFX track
app.get('/api/projects/:id/download/sfx', (req, res) => {
  const filePath = projectManager.getProjectPath(req.params.id, 'output', 'sfx_track.wav');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'SFX track not found. This video may not have background audio.' });
  }
  res.download(filePath, 'sfx_track.wav');
});

// Download SRT captions
app.get('/api/projects/:id/download/captions', (req, res) => {
  const filePath = projectManager.getProjectPath(req.params.id, 'output', 'captions.srt');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Captions not found. Render first.' });
  }
  res.download(filePath, 'captions.srt');
});

// Generate captions independently (without full render)
app.post('/api/projects/:id/captions', (req, res) => {
  try {
    const project = projectManager.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const scenesWithAudio = (project.scenes || []).filter(s => s.narration && s.audioDuration > 0);
    if (scenesWithAudio.length === 0) {
      return res.status(400).json({ error: 'No scenes with audio to generate captions for' });
    }

    const captions = require('./lib/captions');
    const outputDir = projectManager.getProjectPath(project.id, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const srtPath = path.join(outputDir, 'captions.srt');
    captions.generateSrt(project.scenes, srtPath);

    res.json({ success: true, path: srtPath, message: 'Captions generated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║  Educational Video Generator                 ║`);
  console.log(`  ║  Running at http://localhost:${PORT}            ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);

  // Check Voicebox status on startup
  voiceboxClient.checkStatus().then((status) => {
    if (status.online) {
      console.log('  ✅ Voicebox is running at', process.env.VOICEBOX_URL || 'http://localhost:17493');
    } else {
      console.log('  ⚠️  Voicebox is not running. Start it before generating audio.');
    }
  });

  // Check Google auth status
  if (googleAuth.isAuthenticated()) {
    console.log('  ✅ Google account connected');
  } else if (process.env.GOOGLE_CLIENT_ID) {
    console.log('  ⚠️  Google OAuth configured but not authenticated. Sign in from the app.');
  } else {
    console.log('  ⚠️  Google OAuth not configured. Set GOOGLE_CLIENT_ID in .env for Docs import.');
  }

  // Check Gemini API key
  if (process.env.GEMINI_API_KEY) {
    console.log('  ✅ Gemini API key configured');
  } else {
    console.log('  ⚠️  GEMINI_API_KEY not set. Script generation will not work.');
  }

  console.log('');
});

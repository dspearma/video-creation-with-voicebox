const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Extract audio from a video file to a separate WAV file.
 * Returns null if the video has no audio stream.
 *
 * @param {string} videoPath - Path to the video file
 * @param {string} outputPath - Path for the extracted audio
 * @returns {Promise<string|null>} The output file path, or null if no audio
 */
function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    // First check if video has an audio stream
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'json', videoPath],
      (err, stdout) => {
        if (err) return resolve(null); // No audio
        try {
          const info = JSON.parse(stdout);
          if (!info.streams || info.streams.length === 0) return resolve(null);
        } catch { return resolve(null); }

        // Extract audio
        execFile(
          'ffmpeg',
          ['-y', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outputPath],
          (err2) => {
            if (err2) return resolve(null); // Failed to extract, no audio
            resolve(outputPath);
          }
        );
      }
    );
  });
}

/**
 * Merge a video with narration audio, preserving the original video audio as SFX.
 * Produces THREE outputs:
 * 1. merged video (narration only) for the main render
 * 2. extracted SFX audio (from original video)
 * 3. vocal audio (narration) is already available as the input audio
 *
 * @param {string} videoPath - Path to the Flow video clip (may have SFX audio)
 * @param {string} audioPath - Path to the Voicebox narration audio
 * @param {string} mergedOutputPath - Path for the merged video output
 * @param {string} sfxOutputPath - Path for the extracted SFX audio
 * @returns {Promise<{merged: string, sfx: string|null}>}
 */
async function mergeSceneWithSfx(videoPath, audioPath, mergedOutputPath, sfxOutputPath) {
  // Extract SFX audio from original video
  const sfxPath = await extractAudio(videoPath, sfxOutputPath);

  // Merge video with narration (replacing original audio)
  await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',       // Video from Flow
        '-map', '1:a:0',       // Audio from Voicebox narration
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        mergedOutputPath,
      ],
      (err, stdout, stderr) => {
        if (err) reject(new Error(`FFmpeg merge failed: ${stderr || err.message}`));
        else resolve();
      }
    );
  });

  return { merged: mergedOutputPath, sfx: sfxPath };
}

/**
 * Apply a Ken Burns effect to a still image with narration audio.
 * Still images have no SFX audio.
 *
 * @param {string} imagePath - Path to the still image
 * @param {string} audioPath - Path to the Voicebox narration audio
 * @param {string} outputPath - Path for the output video
 * @param {number} duration - Duration in seconds
 * @param {string} direction - Ken Burns direction hint
 * @returns {Promise<string>} The output file path
 */
function kenBurnsFromImage(imagePath, audioPath, outputPath, duration, direction = 'zoom_in') {
  return new Promise((resolve, reject) => {
    const d = (direction || '').toLowerCase();
    let zoomExpr, xExpr, yExpr;

    if (d.includes('zoom out') || d.includes('pull back')) {
      zoomExpr = `if(eq(on,1),1.5,max(zoom-0.0005,1.001))`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `ih/2-(ih/zoom/2)`;
    } else if (d.includes('pan left') || d.includes('pan right')) {
      const panRight = d.includes('right');
      zoomExpr = '1.1';
      const totalFrames = Math.max(Math.floor(duration * 25), 1);
      xExpr = panRight
        ? `(iw-iw/zoom)*on/${totalFrames}`
        : `(iw-iw/zoom)*(1-on/${totalFrames})`;
      yExpr = `ih/2-(ih/zoom/2)`;
    } else {
      zoomExpr = `if(eq(on,1),1,min(zoom+0.0005,1.4))`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `ih/2-(ih/zoom/2)`;
    }

    const totalFrames = Math.max(Math.ceil(duration * 25), 1);

    execFile(
      'ffmpeg',
      [
        '-y',
        '-loop', '1',
        '-i', imagePath,
        '-i', audioPath,
        '-filter_complex',
        `[0:v]scale=3840:2160,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=1920x1080:fps=25[v]`,
        '-map', '[v]',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-t', String(duration),
        '-movflags', '+faststart',
        outputPath,
      ],
      { maxBuffer: 50 * 1024 * 1024 },
      (err) => {
        if (err) reject(new Error(`FFmpeg Ken Burns failed: ${err.message}`));
        else resolve(outputPath);
      }
    );
  });
}

/**
 * Get the duration of a media file in seconds using ffprobe.
 */
function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const info = JSON.parse(stdout);
          resolve(Math.round(parseFloat(info.format.duration) * 100) / 100);
        } catch (e) { reject(e); }
      }
    );
  });
}

/**
 * Concatenate audio files with proper padding for timing alignment.
 *
 * @param {Array<{path: string, startTime: number, duration: number}>} audioSegments
 * @param {string} outputPath - Path for the output audio file
 * @param {number} totalDuration - Total duration of the final video
 * @returns {Promise<string>}
 */
function concatenateAudioTrack(audioSegments, outputPath, totalDuration) {
  return new Promise((resolve, reject) => {
    if (audioSegments.length === 0) {
      // Generate silence
      execFile('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
        '-t', String(totalDuration), '-acodec', 'pcm_s16le', outputPath
      ], (err) => {
        if (err) reject(err); else resolve(outputPath);
      });
      return;
    }

    // Build a complex filter to place each audio segment at its start time
    const inputs = [];
    const filters = [];

    for (let i = 0; i < audioSegments.length; i++) {
      inputs.push('-i', audioSegments[i].path);
      // Pad with delay to align to the correct start time
      const delayMs = Math.round(audioSegments[i].startTime * 1000);
      filters.push(`[${i}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
    }

    // Mix all delayed tracks together
    const mixInputs = audioSegments.map((_, i) => `[a${i}]`).join('');
    filters.push(`${mixInputs}amix=inputs=${audioSegments.length}:duration=longest:dropout_transition=0[out]`);

    const args = [
      '-y',
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[out]',
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-t', String(totalDuration),
      outputPath,
    ];

    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Audio concatenation failed: ${stderr || err.message}`));
      else resolve(outputPath);
    });
  });
}

/**
 * Concatenate video files using the concat demuxer.
 */
async function concatenateScenes(videoPaths, outputPath, onProgress = null) {
  if (videoPaths.length === 0) throw new Error('No video files');
  if (videoPaths.length === 1) {
    fs.copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  const tempDir = path.dirname(outputPath);
  const normalizedPaths = [];

  for (let i = 0; i < videoPaths.length; i++) {
    if (onProgress) onProgress(i + 1, videoPaths.length, 'normalizing');
    const normalizedPath = path.join(tempDir, `_norm_${i}.mp4`);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-i', videoPaths[i],
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-r', '30', '-s', '1920x1080', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', normalizedPath,
      ], (err, stdout, stderr) => {
        if (err) reject(new Error(`Normalize failed scene ${i + 1}: ${stderr || err.message}`));
        else resolve();
      });
    });
    normalizedPaths.push(normalizedPath);
  }

  const concatListPath = path.join(tempDir, '_concat_list.txt');
  const concatContent = normalizedPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf-8');

  if (onProgress) onProgress(videoPaths.length, videoPaths.length, 'concatenating');

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c', 'copy', '-movflags', '+faststart', outputPath,
    ], (err, stdout, stderr) => {
      if (err) reject(new Error(`Concat failed: ${stderr || err.message}`));
      else resolve();
    });
  });

  for (const p of normalizedPaths) { try { fs.unlinkSync(p); } catch {} }
  try { fs.unlinkSync(concatListPath); } catch {}
  return outputPath;
}

/**
 * Full render pipeline with dual audio tracks and SRT captions.
 *
 * Outputs:
 * - final_video.mp4       — video with narration audio only
 * - vocal_track.wav        — isolated narration track
 * - sfx_track.wav          — isolated background/SFX track from Flow videos
 * - captions.srt           — subtitle file
 *
 * @param {Array} scenes - Array of scene objects
 * @param {string} outputDir - Project directory
 * @param {function} onProgress - Callback(scene, total, status)
 * @returns {Promise<object>} Paths to all output files
 */
async function renderProject(scenes, outputDir, onProgress = null) {
  const mergedPaths = [];
  const vocalSegments = [];   // {path, startTime, duration}
  const sfxSegments = [];     // {path, startTime, duration}
  let currentTime = 0;

  const outputSubDir = path.join(outputDir, 'output');
  if (!fs.existsSync(outputSubDir)) fs.mkdirSync(outputSubDir, { recursive: true });

  const sfxDir = path.join(outputDir, 'sfx');
  if (!fs.existsSync(sfxDir)) fs.mkdirSync(sfxDir, { recursive: true });

  // Phase 1: Merge each scene, extract SFX
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneNum = scene.scene_number || (i + 1);

    if (onProgress) onProgress(sceneNum, scenes.length, 'merging');

    const audioPath = path.join(outputDir, 'audio', `scene_${sceneNum}.wav`);
    const mergedPath = path.join(outputSubDir, `merged_${sceneNum}.mp4`);
    const sfxPath = path.join(sfxDir, `sfx_${sceneNum}.wav`);

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Missing audio for scene ${sceneNum}`);
    }

    // Get narration duration for timing
    const narrationDuration = await getMediaDuration(audioPath);

    // Track vocal segment
    vocalSegments.push({
      path: audioPath,
      startTime: currentTime,
      duration: narrationDuration,
    });

    const mediaType = scene.media_type || scene.mediaType || 'video';

    if (mediaType === 'still_image') {
      // Find image file
      const imageDir = path.join(outputDir, 'video');
      const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
      let imagePath = null;
      for (const ext of imageExts) {
        const candidate = path.join(imageDir, `scene_${sceneNum}${ext}`);
        if (fs.existsSync(candidate)) { imagePath = candidate; break; }
      }
      if (!imagePath) {
        const mp4Path = path.join(imageDir, `scene_${sceneNum}.mp4`);
        if (fs.existsSync(mp4Path)) {
          const result = await mergeSceneWithSfx(mp4Path, audioPath, mergedPath, sfxPath);
          if (result.sfx) {
            const sfxDur = await getMediaDuration(result.sfx);
            sfxSegments.push({ path: result.sfx, startTime: currentTime, duration: sfxDur });
          }
          mergedPaths.push(mergedPath);
          currentTime += narrationDuration;
          continue;
        }
        throw new Error(`Missing image for scene ${sceneNum}`);
      }

      // Still images have no SFX
      const kenBurnsDir = scene.ken_burns_direction || scene.kenBurnsDirection || 'slow zoom in';
      await kenBurnsFromImage(imagePath, audioPath, mergedPath, narrationDuration, kenBurnsDir);
    } else {
      // Video scene — extract SFX from Flow video
      const videoPath = path.join(outputDir, 'video', `scene_${sceneNum}.mp4`);
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Missing video for scene ${sceneNum}`);
      }

      const result = await mergeSceneWithSfx(videoPath, audioPath, mergedPath, sfxPath);
      if (result.sfx) {
        const sfxDur = await getMediaDuration(result.sfx);
        sfxSegments.push({ path: result.sfx, startTime: currentTime, duration: sfxDur });
      }
    }

    mergedPaths.push(mergedPath);
    currentTime += narrationDuration;
  }

  const totalDuration = currentTime;

  // Phase 2: Concatenate video scenes
  if (onProgress) onProgress(scenes.length, scenes.length, 'concatenating');
  const finalVideoPath = path.join(outputSubDir, 'final_video.mp4');
  await concatenateScenes(mergedPaths, finalVideoPath, (s, t, status) => {
    if (onProgress) onProgress(s, t, status);
  });

  // Phase 3: Build isolated vocal track
  if (onProgress) onProgress(scenes.length, scenes.length, 'building vocal track');
  const vocalTrackPath = path.join(outputSubDir, 'vocal_track.wav');
  await concatenateAudioTrack(vocalSegments, vocalTrackPath, totalDuration);

  // Phase 4: Build isolated SFX track (if any SFX exists)
  const sfxTrackPath = path.join(outputSubDir, 'sfx_track.wav');
  if (sfxSegments.length > 0) {
    if (onProgress) onProgress(scenes.length, scenes.length, 'building sfx track');
    await concatenateAudioTrack(sfxSegments, sfxTrackPath, totalDuration);
  }

  // Phase 5: Generate SRT captions
  if (onProgress) onProgress(scenes.length, scenes.length, 'generating captions');
  const captions = require('./captions');
  const srtPath = path.join(outputSubDir, 'captions.srt');
  captions.generateSrt(scenes, srtPath);

  // Clean up intermediate merged files
  for (const p of mergedPaths) {
    try { fs.unlinkSync(p); } catch {}
  }

  return {
    video: finalVideoPath,
    vocalTrack: vocalTrackPath,
    sfxTrack: sfxSegments.length > 0 ? sfxTrackPath : null,
    captions: srtPath,
    totalDuration,
  };
}

module.exports = {
  mergeSceneWithSfx,
  concatenateScenes,
  concatenateAudioTrack,
  getMediaDuration,
  kenBurnsFromImage,
  extractAudio,
  renderProject,
};

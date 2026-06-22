const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VOICEBOX_BASE = process.env.VOICEBOX_URL || 'http://localhost:17493';

/**
 * Make an HTTP request to the Voicebox API.
 * Returns a Promise that resolves with parsed JSON or raw Buffer.
 */
function vbRequest(method, urlPath, body = null, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, VOICEBOX_BASE);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'X-Voicebox-Client-Id': 'edu-video-generator',
      },
      timeout,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';

        if (res.statusCode >= 400) {
          let errMsg;
          try {
            errMsg = JSON.parse(raw.toString()).detail || raw.toString();
          } catch {
            errMsg = raw.toString();
          }
          reject(new Error(`Voicebox ${res.statusCode}: ${errMsg}`));
          return;
        }

        // If response is JSON, parse it
        if (contentType.includes('application/json')) {
          try {
            resolve(JSON.parse(raw.toString()));
          } catch {
            resolve(raw.toString());
          }
        } else {
          // Binary audio response
          resolve(raw);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Voicebox request timed out'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Check if Voicebox is running and healthy.
 */
async function checkStatus() {
  try {
    const result = await vbRequest('GET', '/health', null, 5000);
    return { online: true, data: result };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

/**
 * List available voice profiles from Voicebox.
 * Returns array of profile objects with id, name, voice_type, etc.
 */
async function listProfiles() {
  const result = await vbRequest('GET', '/profiles');
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.profiles)) return result.profiles;
  if (result && Array.isArray(result.data)) return result.data;
  return [];
}

/**
 * Poll generation status until completed or failed.
 * Uses /history/{id} endpoint (REST) instead of /generate/{id}/status (SSE).
 *
 * @param {string} generationId - The generation ID to poll
 * @param {number} maxWaitMs - Maximum time to wait (default 10 min for CPU)
 * @returns {Promise<object>} The final generation status
 */
async function waitForGeneration(generationId, maxWaitMs = 600000) {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds — CPU generation is slow

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const status = await vbRequest('GET', `/history/${generationId}`, null, 15000);

      if (status.status === 'completed') {
        return status;
      }
      if (status.status === 'failed' || status.status === 'error') {
        throw new Error(`Voicebox generation failed: ${status.error || 'Unknown error'}`);
      }
      // Still generating, continue polling
    } catch (err) {
      // If it's a generation failure, propagate immediately
      if (err.message.includes('generation failed')) throw err;
      // Otherwise (network timeout, etc.), keep polling
      console.error(`[Voicebox] Poll error for ${generationId}: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`Voicebox generation timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Generate TTS audio for a given text using a voice profile.
 * Saves the output audio to the specified file path.
 *
 * @param {string} text - The narration text to synthesize
 * @param {string} profileId - The Voicebox voice profile ID
 * @param {string} outputPath - Absolute path to save the audio file
 * @param {number} retries - Number of retry attempts (default 3)
 * @returns {Promise<string>} The output file path
 */
async function generateAudio(text, profileId, outputPath, retries = 3) {
  // Strip any SSML tags that Voicebox doesn't support
  const cleanText = text
    .replace(/<break\s+time=['"][^'"]*['"]\s*\/>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[pause\]/gi, '')
    .replace(/\[(serious|passionate|analytical|urgent|informative|descriptive|somber|empathetic|scholarly|triumphant)\]/gi, '')
    .trim();

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Step 1: Submit generation request
      const result = await vbRequest('POST', '/generate', {
        text: cleanText,
        profile_id: profileId,
      });

      const generationId = result.id;
      if (!generationId) {
        throw new Error('No generation ID returned: ' + JSON.stringify(result).slice(0, 200));
      }

      // Step 2: If status is not yet completed, poll until done
      if (result.status !== 'completed') {
        await waitForGeneration(generationId);
      }

      // Step 3: Fetch the audio binary
      const audioData = await vbRequest('GET', `/audio/${generationId}`, null, 60000);
      if (Buffer.isBuffer(audioData)) {
        // Ensure output directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputPath, audioData);
        return outputPath;
      }

      // If audio_path is returned in the generation response, copy from there
      if (result.audio_path && fs.existsSync(result.audio_path)) {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.copyFileSync(result.audio_path, outputPath);
        return outputPath;
      }

      throw new Error('Could not retrieve audio for generation ' + generationId);
    } catch (err) {
      lastError = err;
      console.error(`[Voicebox] Attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) {
        // Exponential backoff: 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Get the duration of an audio file in seconds using ffprobe.
 *
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<number>} Duration in seconds
 */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        filePath,
      ],
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const info = JSON.parse(stdout);
          const duration = parseFloat(info.format.duration);
          if (isNaN(duration)) {
            reject(new Error('Could not parse audio duration'));
          } else {
            resolve(Math.round(duration * 100) / 100); // 2 decimal places
          }
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

/**
 * Generate a silence audio file of the given duration.
 * Used to insert pauses between narration segments.
 *
 * @param {number} durationSeconds - Duration of silence
 * @param {string} outputPath - Path to save the silence file
 * @returns {Promise<string>} The output file path
 */
function generateSilence(durationSeconds, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y',
        '-f', 'lavfi',
        '-i', `anullsrc=r=44100:cl=mono`,
        '-t', String(durationSeconds),
        '-q:a', '9',
        '-acodec', 'pcm_s16le',
        outputPath,
      ],
      (err) => {
        if (err) return reject(err);
        resolve(outputPath);
      }
    );
  });
}

module.exports = {
  checkStatus,
  listProfiles,
  generateAudio,
  getAudioDuration,
  generateSilence,
};

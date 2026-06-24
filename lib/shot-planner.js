const { GoogleGenAI } = require('@google/genai');

/**
 * Available Flow clip durations in seconds.
 */
const FLOW_DURATIONS = [4, 6, 8, 10];

/**
 * Break a scene duration into optimal shot lengths using available Flow durations.
 * Prefers varied shot lengths for visual interest.
 *
 * @param {number} totalDuration - Total scene duration in seconds
 * @returns {number[]} Array of shot durations that sum to >= totalDuration
 */
function planShotDurations(totalDuration) {
  if (totalDuration <= 0) return [];

  // For short scenes (<=10s), use a single clip
  if (totalDuration <= 10) {
    return [getFlowClipLength(totalDuration)];
  }

  const shots = [];
  let remaining = totalDuration;

  // Use a cinematic rhythm: longer establishing → medium → varies → closing
  // Prefer 8s and 6s as the workhorse lengths, with 4s for quick cuts
  // and 10s for establishing/dramatic moments
  while (remaining > 0) {
    let pick;

    if (shots.length === 0 && remaining >= 8) {
      // First shot: establishing — prefer 8 or 10
      pick = remaining >= 14 ? 10 : 8;
    } else if (remaining <= 4) {
      // Last bit: use smallest clip, will be trimmed
      pick = 4;
    } else if (remaining <= 6) {
      pick = 6;
    } else if (remaining <= 8) {
      pick = 8;
    } else if (remaining <= 10) {
      pick = 10;
    } else {
      // Middle shots: alternate between 6 and 8 for rhythm
      const rhythm = [8, 6, 8, 6, 10, 6, 8, 4];
      const idx = shots.length % rhythm.length;
      pick = rhythm[idx];

      // But don't overshoot by too much — if remaining is close, use it
      if (remaining - pick < 4 && remaining <= 10) {
        pick = getFlowClipLength(remaining);
      }
    }

    shots.push(pick);
    remaining -= pick;

    // Safety: if remaining is very small (< 2s), absorb into last shot
    if (remaining > 0 && remaining < 2) {
      // Replace last shot with a longer one to cover the remainder
      const lastShot = shots.pop();
      const needed = lastShot + remaining;
      shots.push(getFlowClipLength(needed));
      remaining = 0;
    }
  }

  return shots;
}

/**
 * Get the smallest Flow clip length that covers the target duration.
 *
 * @param {number} targetSec - Target duration in seconds
 * @returns {number} The Flow clip length to produce (4, 6, 8, or 10)
 */
function getFlowClipLength(targetSec) {
  for (const d of FLOW_DURATIONS) {
    if (d >= targetSec) return d;
  }
  return 10; // Max
}

/**
 * Generate multi-shot cinematic breakdown for a scene using Gemini.
 * Returns sections A-D as CSV plus individual shot prompts.
 *
 * @param {object} scene - Scene object with narration, flow_prompt, etc.
 * @param {number[]} shotDurations - Array of planned shot durations
 * @returns {Promise<object>} { breakdown: string, shots: Array<{duration, prompt}> }
 */
async function generateShotPrompts(scene, shotDurations) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const client = new GoogleGenAI({ apiKey });

  const totalDuration = shotDurations.reduce((a, b) => a + b, 0);
  const shotList = shotDurations.map((d, i) => `Shot ${i + 1}: ${d} seconds`).join('\n');

  const prompt = `You are a cinematic director creating a multi-shot video sequence for an educational history video. The scene must be broken into exactly ${shotDurations.length} shots that will be generated individually in Google Flow and stitched together.

SCENE CONTEXT:
- Title: ${scene.title || 'Untitled'}
- Narration (voiceover that plays over these shots): "${scene.narration || ''}"
- Original visual direction: ${scene.flow_prompt || scene.flowPrompt || ''}
- Total scene duration: ${totalDuration} seconds

SHOT DURATIONS (these are FIXED — do not change them):
${shotList}

MANDATORY RULES:
- Keep subjects, clothing, environment, and lighting CONSISTENT across ALL shots.
- Maintain the EXACT race and skin complexion of characters across every shot.
- Structure the shots into a four-beat cinematic arc: Setup → Escalation → Turning Point → Resolution.
- CRITICAL AUDIO RULE: ABSOLUTELY NO verbal dialog or monolog. Only ambient/action sound effects (e.g., "Door slams shut", "leaves rustling in the wind", "footsteps on stone").

OUTPUT FORMAT — Output the following sections in this exact order, formatting Sections A through D entirely as a single CSV code snippet:

\`\`\`csv
Section,Field,Value
A - Scene Breakdown,Subjects,"[Describe all subjects with explicit race, skin complexion, physical traits, clothing]"
A - Scene Breakdown,Environment,"[Vivid environment description — terrain, architecture, vegetation, weather]"
A - Scene Breakdown,Lighting,"[Lighting conditions — time of day, light quality, shadows, color temperature]"
A - Scene Breakdown,Visual Anchors,"[Key visual elements that must appear consistently across shots]"
B - Theme & Story,Theme,"[Concise thematic statement]"
B - Theme & Story,Logline,"[One-sentence cinematic logline]"
B - Theme & Story,Emotional Arc,"Setup: [beat 1] → Escalation: [beat 2] → Turning Point: [beat 3] → Resolution: [beat 4]"
C - Cinematic Approach,Shot Progression,"[Describe how shots flow from wide to close etc.]"
C - Cinematic Approach,Camera Strategy,"[Camera movement patterns and lens choices]"
C - Cinematic Approach,Depth of Field,"[Shallow for close-ups, deep for wide shots]"
C - Cinematic Approach,Lighting Strategy,"[How lighting reinforces the emotional arc]"
D - Keyframe ${1},Duration,"${shotDurations[0]}s"
D - Keyframe ${1},Shot Type,"[e.g., Wide establishing shot]"
D - Keyframe ${1},Composition,"[Framing and subject placement]"
D - Keyframe ${1},Action,"[What happens in this shot]"
D - Keyframe ${1},Camera Movement,"[Static, dolly, pan, etc.]"
D - Keyframe ${1},Lens/DOF,"[Lens mm and depth of field]"
D - Keyframe ${1},Lighting/Color,"[Lighting and color grade for this shot]"
D - Keyframe ${1},Audio Cues,"[Ambient/SFX only — NO dialog]"
D - Keyframe ${1},Flow Prompt,"[COMPLETE Google Flow prompt for this shot — must be fully self-contained with all subject, environment, lighting, camera details]"
${shotDurations.slice(1).map((d, i) => `D - Keyframe ${i + 2},Duration,"${d}s"
D - Keyframe ${i + 2},Shot Type,"[Shot type]"
D - Keyframe ${i + 2},Composition,"[Framing]"
D - Keyframe ${i + 2},Action,"[Action]"
D - Keyframe ${i + 2},Camera Movement,"[Camera movement]"
D - Keyframe ${i + 2},Lens/DOF,"[Lens and DOF]"
D - Keyframe ${i + 2},Lighting/Color,"[Lighting]"
D - Keyframe ${i + 2},Audio Cues,"[SFX only]"
D - Keyframe ${i + 2},Flow Prompt,"[COMPLETE Flow prompt]"`).join('\n')}
\`\`\`

IMPORTANT for Flow Prompts:
- Each Flow Prompt must be FULLY SELF-CONTAINED — it will be used independently.
- Include ALL character details (race, skin, clothing, physique) in EVERY prompt.
- Include ALL environment details in EVERY prompt.
- Specify camera angle, movement, lens, and lighting in EVERY prompt.
- Each prompt should describe exactly what happens in that specific time window.
- Use 16:9 composition.
`;
  // Call Gemini with retry logic for 503/429 errors
  let text;
  const maxRetries = 3;
  const retryDelays = [5000, 15000, 30000]; // 5s, 15s, 30s backoff
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          temperature: 0.7,
        },
      });
      text = response.text;
      break;
    } catch (err) {
      const errMsg = err.message || '';
      const is503or429 = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand');
      if (is503or429 && attempt < maxRetries) {
        const delay = retryDelays[attempt] || 30000;
        console.log(`Shot planning: Gemini returned 503/429, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err; // Non-retryable or max retries exhausted
    }
  }

  if (!text) throw new Error('Gemini returned empty response after retries');

  // ── Robust line-by-line CSV parser ──
  // Gemini outputs CSV with rows like:
  //   D - Keyframe 1,Flow Prompt,"The actual prompt text here"
  // Values may or may not be quoted, and may span formatting variations.

  const lines = text.split('\n');

  /**
   * Extract a field value for a given keyframe number and field name.
   * Searches lines for pattern: D - Keyframe N,FieldName,"value" or D - Keyframe N,FieldName,value
   */
  function extractField(keyframeNum, fieldName) {
    const fieldLower = fieldName.toLowerCase();
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // Normalize: check if line contains both "Keyframe <N>" and the field name
      const lower = line.toLowerCase();
      // Match patterns like "d - keyframe 1" or "d-keyframe 1" or "d - keyframe1"
      const keyframePattern = new RegExp(`keyframe\\s*${keyframeNum}\\b`, 'i');
      if (!keyframePattern.test(line)) continue;
      if (!lower.includes(fieldLower.replace(/\//g, '/'))) continue;

      // Found the right line — extract the value after the second comma
      // Format: Section,Field,"Value" or Section,Field,Value
      const firstComma = line.indexOf(',');
      if (firstComma === -1) continue;
      const secondComma = line.indexOf(',', firstComma + 1);
      if (secondComma === -1) continue;

      let value = line.substring(secondComma + 1).trim();

      // Strip surrounding quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith('"')) {
        // Multi-line quoted value — collect until closing quote
        value = value.slice(1);
        for (let lj = li + 1; lj < lines.length && lj < li + 10; lj++) {
          if (lines[lj].trimEnd().endsWith('"')) {
            value += ' ' + lines[lj].trimEnd().slice(0, -1);
            break;
          } else {
            value += ' ' + lines[lj].trim();
          }
        }
      }

      // Unescape doubled quotes
      value = value.replace(/""/g, '"').trim();
      return value;
    }
    return '';
  }

  // Parse each shot
  const shots = [];
  for (let i = 0; i < shotDurations.length; i++) {
    const keyframeNum = i + 1;

    const flowPrompt = extractField(keyframeNum, 'Flow Prompt');
    const audioCues = extractField(keyframeNum, 'Audio Cues');
    const shotType = extractField(keyframeNum, 'Shot Type');
    const composition = extractField(keyframeNum, 'Composition');
    const action = extractField(keyframeNum, 'Action');
    const cameraMovement = extractField(keyframeNum, 'Camera Movement');

    // Build the complete prompt with audio cues baked in
    let completePrompt = flowPrompt;
    if (audioCues && !completePrompt.toLowerCase().includes(audioCues.toLowerCase().substring(0, 20))) {
      completePrompt += ` AUDIO: ${audioCues}`;
    }

    shots.push({
      shot_number: keyframeNum,
      duration: shotDurations[i],
      flow_clip_length: shotDurations[i],
      shot_type: shotType,
      audio_cues: audioCues,
      flow_prompt: completePrompt,
      file: null,
      status: 'pending',
    });
  }

  return {
    breakdown: text,
    shots,
  };
}

/**
 * Generate multiple still image prompts for a scene.
 * 1 image per ~5 seconds of scene duration.
 *
 * @param {object} scene - Scene object
 * @param {number} audioDuration - Scene duration in seconds
 * @returns {Promise<object>} { imagePrompts: Array<{number, prompt, kenBurns}> }
 */
async function generateStillImagePrompts(scene, audioDuration) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const client = new GoogleGenAI({ apiKey });
  const imageCount = Math.max(2, Math.ceil(audioDuration / 5));

  const prompt = `You are an art director creating a series of ${imageCount} still images for an educational history video scene. These images will be displayed sequentially with Ken Burns (pan/zoom) effects over narration audio lasting ${audioDuration.toFixed(1)} seconds (~5 seconds per image).

SCENE CONTEXT:
- Title: ${scene.title || 'Untitled'}
- Narration (voiceover): "${scene.narration || ''}"
- Original visual direction: ${scene.flow_prompt || scene.flowPrompt || ''}
- Ken Burns direction hint: ${scene.ken_burns_direction || scene.kenBurnsDirection || 'varied'}

REQUIREMENTS:
- Generate exactly ${imageCount} image prompts
- Each image should show a DIFFERENT composition/angle/detail of the same scene
- Vary the shot types across the sequence:
  * Wide establishing shots (showing full environment)
  * Medium shots (subject in context)
  * Close-up shots (faces, hands, objects, textures)
  * Detail shots (artifacts, inscriptions, architectural details)
  * Environmental/atmospheric shots (landscapes, skies, surroundings)
- Keep subjects, clothing, environment, and lighting CONSISTENT across all images
- Maintain EXACT race, skin complexion, and physical traits across images
- Each prompt must be FULLY SELF-CONTAINED for AI image generation
- Specify a Ken Burns camera direction for each (e.g., "slow zoom in", "pan left to right", "slow zoom out", "pan right to left", "slow push in from top")
- Use 16:9 aspect ratio

OUTPUT FORMAT — Return EXACTLY ${imageCount} image entries in this format, one per line:
IMAGE 1|[Ken Burns direction]|[Complete, detailed image generation prompt]
IMAGE 2|[Ken Burns direction]|[Complete, detailed image generation prompt]
...

Each prompt should be 2-4 sentences describing the exact image: subject appearance (race, skin, clothing), environment, lighting, composition, camera angle.
Do NOT include any other text, headers, or explanations — only the IMAGE lines.`;

  // Call with retry
  let text;
  const maxRetries = 3;
  const retryDelays = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { temperature: 0.7 },
      });
      text = response.text;
      break;
    } catch (err) {
      const errMsg = err.message || '';
      const isRetryable = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('UNAVAILABLE');
      if (isRetryable && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelays[attempt] || 30000));
        continue;
      }
      throw err;
    }
  }

  if (!text) throw new Error('Gemini returned empty response');

  // Parse IMAGE N|kenBurns|prompt lines
  const imagePrompts = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^IMAGE\s*(\d+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/i);
    if (match) {
      imagePrompts.push({
        image_number: parseInt(match[1], 10),
        ken_burns_direction: match[2].trim(),
        prompt: match[3].trim(),
        display_duration: Math.round(audioDuration / imageCount * 10) / 10,
      });
    }
  }

  // Fallback: if parsing got fewer than expected, try to salvage
  if (imagePrompts.length === 0) {
    // Try splitting by numbered lines
    const numbered = text.split(/\n(?=\d+[\.\)]\s)/);
    for (let i = 0; i < numbered.length && imagePrompts.length < imageCount; i++) {
      const chunk = numbered[i].trim();
      if (chunk.length > 20) {
        imagePrompts.push({
          image_number: imagePrompts.length + 1,
          ken_burns_direction: 'slow zoom in',
          prompt: chunk,
          display_duration: Math.round(audioDuration / imageCount * 10) / 10,
        });
      }
    }
  }

  return { imagePrompts };
}

module.exports = {
  FLOW_DURATIONS,
  planShotDurations,
  getFlowClipLength,
  generateShotPrompts,
  generateStillImagePrompts,
};

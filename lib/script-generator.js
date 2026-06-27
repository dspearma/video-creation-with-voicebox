const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// Load the prompt template
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'afrocentric-education.json');

/**
 * Generate a structured scene-by-scene script from research text and a learning objective.
 * Uses Gemini with structured JSON output to enforce the scene schema.
 *
 * @param {string} researchText - The imported research/outline text
 * @param {string} learningObjective - The specific learning goal for this video
 * @param {string} format - The script format: 'standard' or 'short'
 * @returns {Promise<Array>} Array of scene objects
 */
async function generateScript(researchText, learningObjective, format = 'standard') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // Load template
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));

  const client = new GoogleGenAI({ apiKey });

  let systemPrompt = template.gemini_script_system_prompt;
  let userPrompt = '';

  if (format === 'short') {
    // Override system prompt with short-form specific role and vertical instructions
    systemPrompt = `You are an expert short-form video scriptwriter, cinematic director, and content strategist specializing in educational YouTube Shorts, TikToks, and Instagram Reels. Your task is to process provided academic source material, generate 10 unique carousel/video concepts, and then develop one of those concepts into a detailed storyboard and script.

=== SKIN TONE RULES (CRITICAL — ANTI-DEFAULT PROTOCOL) ===
AI image and video models will default to white/European phenotypes unless explicitly directed otherwise. For EVERY human character in EVERY visual prompt, you MUST:
- Explicitly describe their skin tone using specific, vivid language (e.g., 'deep mahogany-brown skin', 'warm copper-brown complexion', 'rich dark-brown skin with warm undertones', 'deep umber complexion'). NEVER leave skin tone unspecified.
- Make skin tones culturally and regionally appropriate to the historical context (e.g., West African, East African, North African, Afro-Caribbean, African American).
- Describe hair texture and style explicitly (e.g., 'close-cropped natural hair', 'thick shoulder-length locs', 'neatly twisted protective style').
- Failure to specify skin tone for any human character is a CRITICAL ERROR.

=== GENERAL VISUAL RULES ===
- Use the brand hex palette: Bronze (#966327), White (#FFFFFF), Black (#000000), Olive (#303015)
- All visuals must be 9:16 vertical ratio (for short-form)
- Environments must be Afrocentric — avoid Eurocentric academic backgrounds
- Transform abstract concepts into dynamic visual metaphors
- Do NOT include SSML tags in narration text
- Include natural pause points in narration via punctuation and sentence structure`;

    userPrompt = `
LEARNING OBJECTIVE: ${learningObjective}

TARGET AUDIENCE: ${template.target_audience}

BRAND COLOR PALETTE:
- Bronze: ${template.brand_palette.bronze}
- White: ${template.brand_palette.white}
- Black: ${template.brand_palette.black}
- Olive: ${template.brand_palette.olive}

VISUAL TYPES TO USE: ${template.visual_types.join(', ')}

RESEARCH MATERIAL:
---
${researchText}
---

Based on the research material above, follow this workflow:
1. Brainstorm 10 unique, compelling short-form video/carousel concepts that would achieve the learning objective for 8th graders.
2. Select the absolute best, most engaging concept.
3. Develop that selected concept into a detailed vertical (9:16) storyboard and script consisting of exactly 13 to 16 slides/scenes (1 Title Card + 12 to 15 Storyboard Slides).

SLIDE-BY-SLIDE INSTRUCTIONS:
- Slide 1 (Title Card):
  - Visual: VERTICAL 9:16 FORMAT. A highly detailed, cinematic description of the background imagery (e.g., "A sweeping drone shot of...", "Slow-motion close-up of..."). Place Professor Darius (African-American host, deep brown skin tone, close-cropped natural black hair, wearing stylish contemporary field clothing consistent with the setting) in the context of the setting walking and interacting with the environment. Describe clothing and actions consistent with the setting.
  - Narration (Monologue): MUST start exactly with: "Hey folks! I'm Professor Darius. In this video we discuss [insert topic/hook based on chosen concept]..." Keep narration to approximately 20 words.
  - On-Screen Text: Bold text that acts as the presentation title (max 3-5 words).
- Slides 2+ (Storyboard Slides):
  - Visuals: VERTICAL 9:16 FORMAT. A highly detailed, cinematic description of the background imagery (e.g., "A sweeping drone shot of...", "Slow-motion close-up of...").
  - CRITICAL VISUAL RULE: DO NOT INCLUDE "PROFESSOR DARIUS" OR "HOST" IN ANY VISUAL DESCRIPTIONS FOR SLIDES 2+. They should focus on historical events, environment, artifacts, maps, or metaphors without the host.
  - Narration: Approximately 20 words of voiceover script per slide.
  - On-Screen Text: Minimalist, bold text that acts as a hook for the slide (max 3-5 words).

MEDIA TYPE / CREDIT OPTIMIZATION (CRITICAL):
To conserve generation credits, each scene must specify a media_type of either "video" or "still_image".
- RATIO: Use approximately 1 video scene for every 1-2 still_image scenes (roughly 35-50% video, 50-65% still_image) to keep pacing engaging.
- ALWAYS VIDEO: Any scene with @me/Professor Darius (Slide 1) MUST be media_type "video".
- USE VIDEO FOR: Slide 1 (host intro), key dramatic moments, climactic reveals.
- USE STILL_IMAGE FOR: Expository scenes, maps, establishing shots, and narration-driven slides where a powerful single image with Ken Burns camera movement is sufficient.

Return a JSON object with a "scenes" array matching the schema.
`;
  } else {
    // Standard long-form prompt
    userPrompt = `
LEARNING OBJECTIVE: ${learningObjective}

TARGET AUDIENCE: ${template.target_audience}

BRAND COLOR PALETTE:
- Bronze: ${template.brand_palette.bronze}
- White: ${template.brand_palette.white}
- Black: ${template.brand_palette.black}
- Olive: ${template.brand_palette.olive}

VISUAL TYPES TO USE: ${template.visual_types.join(', ')}

VISUAL STYLE GUIDELINES:
- Setting: ${template.visual_style.setting}
- Color Guidance: ${template.visual_style.color_guidance}
- Human Representation: ${template.visual_style.human_representation}
- Animation Style: ${template.visual_style.animation_style}

RESEARCH MATERIAL:
---
${researchText}
---

Based on the research material above, generate a complete scene-by-scene video script that achieves the learning objective.

CRITICAL WORD COUNT REQUIREMENT: The total narration text across ALL scenes combined MUST be at least 1,500 words. Aim for 1,500-1,800 words total. This is non-negotiable.

SCENE STRUCTURE:
- Generate 15-25 scenes to reach the word count target
- Each scene should have 4-8 sentences of narration (roughly 60-100 words per scene)
- Begin with a high-intensity hook scene (15-20 seconds worth) that challenges a widely held misconception or presents a compelling mystery
- Include deep-dive historical interjections with exact dates, specific names, localized terminology, and primary source context
- Frame content through an Afrocentric historiographical lens emphasizing active strategic agency, economic leverage, and complex political structures
- End with a powerful closing scene and call to action

CONTENT DEPTH:
- Dig deep into the research to extract granular, specific details — not surface-level summaries
- Introduce curiosity loops: pose a specific mystery or paradox early and delay resolution until later scenes
- Every claim should be supported with specific evidence from the research material
- Transform abstract concepts into dynamic, relatable visual metaphors for 8th graders

MEDIA TYPE / CREDIT OPTIMIZATION (CRITICAL):
To conserve generation credits, each scene must specify a media_type of either "video" or "still_image".
- RATIO: Approximately 1 video scene for every 3 still_image scenes (roughly 25% video, 75% still).
- ALWAYS VIDEO: Any scene with @me MUST be media_type "video". These are the most impactful and require motion.
- USE VIDEO FOR: Opening hook, key dramatic moments, climactic reveals, closing call-to-action — moments where motion creates emotional impact.
- USE STILL_IMAGE FOR: Expository scenes, charts, maps, establishing shots, text overlays, and narration-driven scenes where a powerful single image with slow cinematic camera movement is sufficient.
- For still_image scenes: The flow_prompt should describe a single powerful composition (not multiple shots). Also set ken_burns_direction to describe the camera movement to apply (e.g., "slow zoom in on the central figure", "slow pan left to right across the landscape", "gradual pull back to reveal the full scene").
- For video scenes: The flow_prompt describes motion, interaction, and dynamic camera work as usual.

Return a JSON object with a "scenes" array. Each scene must follow the exact structure specified.

`;
  }

  // Define the scene output schema
  const sceneSchema = {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scene_number: {
              type: 'integer',
              description: 'Sequential scene/slide number starting from 1',
            },
            title: {
              type: 'string',
              description: 'Short descriptive title for this scene/slide',
            },
            narration: {
              type: 'string',
              description:
                format === 'short' 
                  ? 'The spoken narration voiceover monologue (aim for approximately 20 words).'
                  : 'The spoken narration text (4-8 sentences, approximately 60-100 words). Do NOT include SSML tags. Write naturally with punctuation for pacing. Be substantive and detailed — avoid surface-level summaries.',
            },
            on_screen_text: {
              type: 'string',
              description: 'Bold minimalist text displayed on screen as a hook or title (max 3-5 words).',
            },
            pacing_notes: {
              type: 'string',
              description:
                'Emotional tone and delivery guidance, e.g. "serious, measured pace" or "passionate, building energy"',
            },
            flow_prompt: {
              type: 'string',
              description:
                format === 'short'
                  ? 'Vivid visual prompt in VERTICAL 9:16 FORMAT describing the background imagery. Slide 1 must describe Professor Darius. Slides 2+ must NOT describe host/Professor Darius.'
                  : 'A detailed Google Flow visual prompt. For @me scenes: place @me IN THE ACTION at a historical/archaeological site (NOT in a studio). Describe: (1) SETTING — vivid environment with terrain, vegetation, architecture, weather; (2) CLOTHING — specific contemporary field-appropriate attire described in detail; (3) INTERACTION — @me actively engaging with environment (walking, kneeling, gesturing); (4) CAMERA MOVEMENT — shot type and camera behavior; (5) ACCESSORIES — contextual props; (6) ENERGY — mood and physicality. For ALL human characters: MUST explicitly describe skin tone (e.g. deep mahogany-brown skin, warm copper-brown complexion) and hair texture. Specify brand hex colors and 16:9 composition.',
            },
            visual_type: {
              type: 'string',
              description:
                'One of: Video Host Narration, Cinematic Scene, Illustrative Chart, Text Overlay',
              enum: [
                'Video Host Narration',
                'Cinematic Scene',
                'Illustrative Chart',
                'Text Overlay',
              ],
            },
            media_type: {
              type: 'string',
              description:
                'Whether this scene should be generated as a video clip or a still image with Ken Burns camera movement. Scenes with @me MUST be video. Maintain roughly 1:3 video-to-still ratio.',
              enum: ['video', 'still_image'],
            },
            ken_burns_direction: {
              type: 'string',
              description:
                'Only for still_image scenes. Describes the slow cinematic camera movement to apply, e.g. "slow zoom in on the central figure", "slow pan left to right across the landscape", "gradual pull back to reveal the full scene". Leave empty for video scenes.',
            },
            brand_colors_used: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Array of hex color codes from the brand palette used in this scene',
            },
          },
          required: [
            'scene_number',
            'title',
            'narration',
            'on_screen_text',
            'pacing_notes',
            'flow_prompt',
            'visual_type',
            'media_type',
            'brand_colors_used',
          ],
        },
      },
    },
    required: ['scenes'],
  };

  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
      responseSchema: sceneSchema,
      temperature: 0.8,
    },
  });

  const text = response.text;
  const parsed = JSON.parse(text);

  if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
    throw new Error('Gemini response did not contain a valid scenes array');
  }

  // Ensure scene numbers are sequential
  parsed.scenes.forEach((scene, i) => {
    scene.scene_number = i + 1;
    // Initialize production state fields
    scene.audioFile = null;
    scene.audioDuration = null;
    scene.videoFile = null;
  });

  return parsed.scenes;
}

module.exports = { generateScript };

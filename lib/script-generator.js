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
 * @returns {Promise<Array>} Array of scene objects
 */
async function generateScript(researchText, learningObjective) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // Load template
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));

  const client = new GoogleGenAI({ apiKey });

  const systemPrompt = template.gemini_script_system_prompt;

  const userPrompt = `
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
              description: 'Sequential scene number starting from 1',
            },
            title: {
              type: 'string',
              description: 'Short descriptive title for this scene',
            },
            narration: {
              type: 'string',
              description:
                'The spoken narration text (4-8 sentences, approximately 60-100 words). Do NOT include SSML tags. Write naturally with punctuation for pacing. Be substantive and detailed — avoid surface-level summaries.',
            },
            pacing_notes: {
              type: 'string',
              description:
                'Emotional tone and delivery guidance, e.g. "serious, measured pace" or "passionate, building energy"',
            },
            flow_prompt: {
              type: 'string',
              description:
                'A detailed Google Flow visual prompt. For @me scenes: place @me IN THE ACTION at a historical/archaeological site (NOT in a studio). Describe: (1) SETTING — vivid environment with terrain, vegetation, architecture, weather; (2) CLOTHING — specific contemporary field-appropriate attire described in detail; (3) INTERACTION — @me actively engaging with environment (walking, kneeling, gesturing); (4) CAMERA MOVEMENT — shot type and camera behavior; (5) ACCESSORIES — contextual props; (6) ENERGY — mood and physicality. For ALL human characters: MUST explicitly describe skin tone (e.g. deep mahogany-brown skin, warm copper-brown complexion) and hair texture. Specify brand hex colors and 16:9 composition.',
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

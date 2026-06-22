const fs = require('fs');
const path = require('path');

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 *
 * @param {number} totalSeconds - Time in seconds (e.g. 127.45)
 * @returns {string} Formatted timestamp like "00:02:07,450"
 */
function formatSrtTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds % 1) * 1000);

  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    ',' +
    String(millis).padStart(3, '0')
  );
}

/**
 * Split narration text into subtitle-sized segments.
 * Splits on sentence boundaries (. ! ?), keeping segments under ~80 chars.
 * Falls back to comma/clause splits for very long sentences.
 *
 * @param {string} text - The full narration text
 * @returns {string[]} Array of subtitle segments
 */
function splitIntoSegments(text) {
  if (!text || text.trim().length === 0) return [];

  const maxChars = 80;
  const segments = [];

  // First split by sentence-ending punctuation
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.length <= maxChars) {
      segments.push(trimmed);
    } else {
      // Split long sentences at commas, semicolons, or dashes
      const clauses = trimmed.split(/(?<=[,;:])\s+|(?<=\s[-–—])\s+/);
      let buffer = '';

      for (const clause of clauses) {
        if (buffer.length + clause.length + 1 > maxChars && buffer.length > 0) {
          segments.push(buffer.trim());
          buffer = clause;
        } else {
          buffer += (buffer ? ' ' : '') + clause;
        }
      }
      if (buffer.trim()) {
        segments.push(buffer.trim());
      }
    }
  }

  return segments;
}

/**
 * Generate an SRT caption file from scene data.
 *
 * Each scene's narration is split into subtitle segments, with timing
 * proportionally distributed across the scene's audio duration.
 *
 * @param {Array} scenes - Array of scene objects with narration and audioDuration
 * @param {string} outputPath - Path to write the .srt file
 * @returns {string} The output file path
 */
function generateSrt(scenes, outputPath) {
  let subtitleIndex = 1;
  let currentTime = 0; // Running clock in seconds
  const lines = [];

  for (const scene of scenes) {
    const narration = scene.narration || '';
    const duration = scene.audioDuration || 0;

    if (!narration.trim() || duration <= 0) {
      currentTime += duration;
      continue;
    }

    const segments = splitIntoSegments(narration);
    if (segments.length === 0) {
      currentTime += duration;
      continue;
    }

    // Distribute duration proportionally by character count
    const totalChars = segments.reduce((sum, s) => sum + s.length, 0);

    for (const segment of segments) {
      const segDuration = (segment.length / totalChars) * duration;
      // Minimum 1.5s per subtitle, max = whatever remains
      const actualDuration = Math.max(segDuration, 1.5);

      const startTime = currentTime;
      const endTime = currentTime + actualDuration;

      lines.push(String(subtitleIndex));
      lines.push(`${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}`);
      lines.push(segment);
      lines.push(''); // Blank line separator

      subtitleIndex++;
      currentTime = endTime;
    }

    // If proportional timing overran the scene duration, clamp
    const sceneEnd = currentTime - (currentTime - (scenes.indexOf(scene) === 0 ? 0 : currentTime)) + duration;
    // Actually just advance to scene end
    const sceneStart = currentTime - segments.reduce((sum, s) => {
      const segDur = (s.length / totalChars) * duration;
      return sum + Math.max(segDur, 1.5);
    }, 0);
    currentTime = sceneStart + duration;
  }

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
  return outputPath;
}

/**
 * Simpler SRT generator — one subtitle per scene.
 * Good as a fallback when word-level timing isn't needed.
 *
 * @param {Array} scenes - Array of scene objects
 * @param {string} outputPath - Path for the .srt file
 * @returns {string} The output file path
 */
function generateSimpleSrt(scenes, outputPath) {
  let subtitleIndex = 1;
  let currentTime = 0;
  const lines = [];

  for (const scene of scenes) {
    const narration = scene.narration || '';
    const duration = scene.audioDuration || 0;

    if (!narration.trim() || duration <= 0) {
      currentTime += duration;
      continue;
    }

    // Split into subtitle-sized chunks
    const segments = splitIntoSegments(narration);
    const totalChars = segments.reduce((sum, s) => sum + s.length, 0);

    for (const segment of segments) {
      const segDuration = Math.max((segment.length / totalChars) * duration, 1.2);
      const startTime = currentTime;
      const endTime = currentTime + segDuration;

      lines.push(String(subtitleIndex));
      lines.push(`${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}`);
      lines.push(segment);
      lines.push('');

      subtitleIndex++;
      currentTime = endTime;
    }

    // Reset to scene boundary
    const expectedEnd = currentTime;
    currentTime = expectedEnd;
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
  return outputPath;
}

module.exports = {
  generateSrt,
  generateSimpleSrt,
  formatSrtTime,
  splitIntoSegments,
};
